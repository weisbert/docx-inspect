// store.js -- the single reactive state container for the v2 interface.
//
// It is deliberately tiny: a plain object, a set of subscribers, and three ways
// to change it. No proxies, no immutability library, no dependencies beyond the
// preact hooks global (read lazily, so this module also imports cleanly outside
// a browser).
//
//   store.get()            -> the whole state object
//   store.set(patch)       -> shallow-merge patch, then notify
//   store.update(fn)       -> fn(draft) mutates a SHALLOW clone, then notify
//   store.subscribe(fn)    -> returns an unsubscribe function
//   useStore(selector)     -> preact hook, re-renders when the selection changes
//
// "Shallow" is literal: update() clones the top level only, so mutating
// draft.project.outline mutates the live outline as well. That is intentional --
// the project document is large and is edited in place.
//
// DIRTY TRACKING NEVER DEPENDS ON OBJECT IDENTITY
// ----------------------------------------------
// The project document is edited in place, so `state.project === theProjectWeSent`
// is true even when the outline underneath it has changed. This module used to
// decide "did anything change while the PUT was in flight?" with exactly that
// comparison, and the answer was always "no": an edit typed during a slow save
// was dropped, the indicator still read `Saved HH:MM`, and no further save was
// ever scheduled.
//
// The rule now, and the one every view codes against:
//
//   * the store carries a monotonic `rev` counter;
//   * store.markDirty() bumps `rev` and sets `dirty`;
//   * a save captures `rev` when it serialises the document, and on completion
//     clears `dirty` ONLY when state.rev still equals the captured value --
//     otherwise `dirty` stays set and another save is scheduled;
//   * store.saveNow() flushes any pending save and resolves when the disk is
//     current.
//
// So an in-place mutation followed by store.markDirty() is safe, and so is the
// other style -- replacing the reference and writing store.set({project, dirty:
// true}) -- because set() bumps `rev` too whenever a patch turns `dirty` on.
//
// A SAVE CARRIES ITS OWN DESTINATION
// ----------------------------------
// A save is a pair (document, destination) fixed at the moment the document is
// taken. `state.projectDir` is the report the in-memory document BELONGS to; it
// is set when a document is loaded and changes only when another document is
// loaded. `state.route.dir` is where the user is LOOKING, and during a switch
// the two are different -- the route moves the instant the address changes,
// while the document is still the previous report's until its replacement has
// been fetched.
//
// Every step of a save uses the captured destination and nothing downstream
// re-reads it from live state. Reading `route.dir` when the PUT was issued is
// what once wrote one report's document into another report's file, and the
// optimistic-concurrency token that caught it was then dropped by the retry to
// force the write through. The token is never dropped: a 409 means the
// destination moved under us, and the answer to that is to say so, not to
// overwrite.

import * as api from './api.js';

/* ------------------------------------------------------------------ *
 * state shape
 * ------------------------------------------------------------------ */

// The frozen contract plus four additions, all additive so nothing that reads
// only the contract keys can break:
//   banners  -- app-level error/attention messages raised by the global error
//               trap and by failed background work
//   booting  -- true until the first startup fetches have settled
//   version  -- the payload of GET /api/version
//   savedAt  -- epoch seconds of the last successful save, for `Saved HH:MM`
//   rev      -- monotonic edit counter; see the dirty-tracking note above. It is
//               never persisted and never compared across reports, only against
//               the value a save captured moments earlier.
//   projectDir -- the report `project` was loaded from, and the ONLY destination
//               a save of it may be written to. Never `route.dir`.
function initialState() {
  return {
    route: { view: 'home', dir: null, node: null },
    tree: null,
    project: null,
    projectDir: null,
    cfg: null,
    dirty: false,
    rev: 0,
    // 'blocked' is a save the store will not attempt again on its own: the
    // file changed under this window, so only a fresh read starts it again.
    saveState: 'saved', // 'saved' | 'saving' | 'retrying' | 'blocked'
    savedAt: null,
    warnings: [],
    overlay: null,
    toast: null,
    banners: [],
    booting: true,
    version: null,
    ui: {
      rightTab: 'preview', // 'preview' | 'check' | 'exchange' | 'history'
      rightOpen: true,
      assetsOpen: false,
      previewFidelity: 'approximate', // 'approximate' | 'proof'
      follow: true,
      lastNode: {}, // dir -> node id, so reopening a report lands where you left
    },
  };
}

/* ------------------------------------------------------------------ *
 * persistence (a small slice of ui only)
 * ------------------------------------------------------------------ */

const STORAGE_KEY = 'rw.ui';
const PERSISTED_UI = ['rightTab', 'rightOpen', 'assetsOpen', 'previewFidelity', 'lastNode'];

// Every storage access is wrapped: a private window, a blocked third-party
// context or a full quota must never stop the app from starting.
function readPersisted() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (err) {
    return null;
  }
}

function writePersisted(ui) {
  try {
    const slice = {};
    for (let i = 0; i < PERSISTED_UI.length; i++) {
      const key = PERSISTED_UI[i];
      if (ui[key] !== undefined) slice[key] = ui[key];
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(slice));
  } catch (err) {
    /* storage is a convenience, never a requirement */
  }
}

/* ------------------------------------------------------------------ *
 * the observable
 * ------------------------------------------------------------------ */

let state = initialState();
const subscribers = new Set();
let notifying = false;
let bannerSeq = 0;

// A subscriber is allowed to write back to the store. Rather than re-entering
// the loop (which would recurse without bound) the write is coalesced: the flag
// makes the outer call run one more pass, up to a small cap so a subscriber that
// writes on every notification cannot spin the tab.
let pendingNotify = false;
const MAX_NOTIFY_PASSES = 8;

function notify() {
  if (notifying) {
    pendingNotify = true;
    return;
  }
  notifying = true;
  try {
    let passes = 0;
    do {
      pendingNotify = false;
      passes += 1;
      // iterate a copy: a subscriber may unsubscribe itself while running
      const list = Array.from(subscribers);
      for (let i = 0; i < list.length; i++) {
        try {
          list[i](state);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[store] subscriber failed', err);
        }
      }
    } while (pendingNotify && passes < MAX_NOTIFY_PASSES);
  } finally {
    notifying = false;
    pendingNotify = false;
  }
  afterChange();
}

export const store = {
  get() {
    return state;
  },

  // A patch that turns `dirty` on is an edit, so it bumps `rev` as markDirty()
  // does -- a view that edits by replacing the project reference and writing
  // store.set({project, dirty: true}) is then just as safe as one that mutates
  // in place. Pass an explicit `rev` to opt out (the save loop does).
  set(patch) {
    if (!patch) return state;
    const next = Object.assign({}, state, patch);
    if (patch.dirty === true && patch.rev === undefined) next.rev = state.rev + 1;
    state = next;
    if (patch.ui) writePersisted(state.ui);
    notify();
    return state;
  },

  update(fn) {
    const draft = Object.assign({}, state);
    fn(draft);
    state = draft;
    writePersisted(state.ui);
    notify();
    return state;
  },

  subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    subscribers.add(fn);
    return () => {
      subscribers.delete(fn);
    };
  },

  /* ---- convenience wrappers used across the views ---- */

  // Merge into state.ui and persist the whitelisted keys.
  setUi(patch) {
    return store.set({ ui: Object.assign({}, state.ui, patch || {}) });
  },

  // Remember which section a report was last open at.
  rememberNode(dir, node) {
    if (!dir) return;
    const lastNode = Object.assign({}, state.ui.lastNode || {});
    if (node) lastNode[dir] = node;
    else delete lastNode[dir];
    store.setUi({ lastNode: lastNode });
  },

  lastNodeFor(dir) {
    return (state.ui.lastNode || {})[dir] || null;
  },

  // Raise an app-level banner. level: 'error' | 'attention' | 'done'.
  //
  // A banner carrying a `code` is a KIND of problem, not an occurrence of one.
  // A failing save reports itself on every attempt and the autosave loop re-arms
  // on every notification, so appending would grow the stack without bound --
  // five identical banners in twelve seconds, until the app is pushed off the
  // screen. A second banner with a code already on screen updates that banner in
  // place instead: same id, so it does not re-animate or move, with the newest
  // message, the newest time and a count of how many attempts it stands for.
  pushBanner(banner) {
    const incoming = banner || {};
    const code = incoming.code;
    if (code) {
      const at = state.banners.findIndex((b) => b.code === code);
      if (at >= 0) {
        const prev = state.banners[at];
        const merged = Object.assign({}, prev, incoming, {
          id: prev.id,
          at: Date.now() / 1000,
          count: (prev.count || 1) + 1,
        });
        const banners = state.banners.slice();
        banners[at] = merged;
        store.set({ banners: banners });
        return prev.id;
      }
    }
    bannerSeq += 1;
    const entry = Object.assign({ id: 'b' + bannerSeq, level: 'error', at: Date.now() / 1000 }, incoming);
    store.set({ banners: state.banners.concat([entry]) });
    return entry.id;
  },

  dismissBanner(id) {
    store.set({ banners: state.banners.filter((b) => b.id !== id) });
  },

  clearBanners() {
    if (state.banners.length) store.set({ banners: [] });
  },

  showToast(toast) {
    store.set({ toast: toast || null });
  },

  hideToast() {
    if (state.toast) store.set({ toast: null });
  },

  // Routing is owned by boot.js, which installs the real implementations here so
  // views can navigate without importing boot.js (and without a module cycle).
  // Until then these are safe no-ops.
  navigate(/* route */) {},
  routeHref(/* route */) {
    return '#/';
  },

  // Restore the persisted ui slice. Called once by boot.js before the first render.
  restoreUi() {
    const saved = readPersisted();
    if (!saved) return;
    const ui = Object.assign({}, state.ui);
    for (let i = 0; i < PERSISTED_UI.length; i++) {
      const key = PERSISTED_UI[i];
      if (saved[key] !== undefined) ui[key] = saved[key];
    }
    if (!ui.lastNode || typeof ui.lastNode !== 'object') ui.lastNode = {};
    state = Object.assign({}, state, { ui: ui });
  },

  /* ---- saving ---- */

  // Mark the in-memory project as changed. The autosave loop below picks it up.
  //
  // This is safe after an IN-PLACE mutation: it bumps `rev`, and `rev` -- not
  // the identity of state.project -- is what a save in flight compares itself
  // against when it decides whether the document is now newer than the bytes it
  // just wrote.
  markDirty() {
    store.set({ dirty: true, rev: state.rev + 1 });
  },

  // Replace the project wholesale (an import, a restore, a merge) without
  // marking it dirty -- the copy on disk is already the one being shown.
  //
  // This is the ONLY place the destination of a save is decided. `meta.dir` is
  // the report the document was read from; a caller that re-reads the report it
  // is already showing (an asset rename, a merge) may leave it out and the
  // destination stands. Only when nothing has ever been loaded is the route
  // consulted, and even then it is read HERE, at load time, and captured -- not
  // at the moment some later PUT goes out.
  setProject(project, meta) {
    const info = meta || {};
    const dir = info.dir != null && info.dir !== ''
      ? String(info.dir)
      : (state.projectDir || (state.route && state.route.dir) || null);
    const movedReport = dir !== state.projectDir;
    store.set({
      project: project,
      projectDir: dir,
      dirty: false,
      saveState: 'saved',
      savedAt: info.mtime == null ? state.savedAt : info.mtime,
    });
    // The token belongs to a file, so it never crosses reports: loading another
    // report starts with that report's own mtime, or with none at all.
    if (movedReport) lastSavedAt = info.mtime == null ? null : info.mtime;
    else if (info.mtime != null) lastSavedAt = info.mtime;
    // A fresh read is also the recovery from a conflict: this document now
    // matches the file, so saving it is allowed again.
    if (movedReport || info.mtime != null) saveBlocked = null;
    // No rev bump: this document came FROM the disk, so nothing is outstanding.
    // A save still in flight will see an unchanged rev and clear `dirty`, which
    // is the right answer -- the bytes it wrote have just been superseded by the
    // ones the caller loaded.
  },

  // Flush every pending write and resolve once the disk is current. Callers
  // await this before a server-side file operation (export, exchange, an asset
  // rename) so the server reads the document the screen is showing.
  //
  // IT TELLS THE TRUTH. Six callers treat it as a barrier before something
  // destructive or irreversible -- an export, a History restore, a roll back, a
  // merge, an applied package, a pasted replacement, an asset rename and an
  // asset delete -- and each of them then hands the server a file it believes
  // holds what the screen shows. So:
  //
  //   * it resolves ONLY when the document is genuinely on disk, with
  //     {ok: true, dir, savedAt} for a caller that wants to check rather than
  //     rely on the absence of a throw;
  //   * it REJECTS with a SaveFailedError when it could not get there --
  //     the server refused, or there is no destination to write to. The error
  //     carries `code` ('save-failed' or 'save-conflict') and
  //     `alreadyReported`, because the save loop has already raised the banner.
  //
  // A barrier that resolves while `dirty` is still true is worse than no
  // barrier: it turns "your edit is safe" into a promise nothing kept.
  saveNow() {
    return flushSaves().then(() => {
      if (!state.dirty) {
        return { ok: true, dir: state.projectDir, savedAt: state.savedAt };
      }
      // A conflict is only this document's conflict when it is this document's
      // destination that is blocked.
      const conflict = !!saveBlocked && saveBlocked === state.projectDir;
      throw new SaveFailedError(
        conflict ? SAVE_CONFLICT_MESSAGE : SAVE_FAILED_MESSAGE,
        conflict ? 'save-conflict' : 'save-failed'
      );
    });
  },

  // Test seam: drop everything back to the startup state. Bumping the
  // generation makes any save still on the wire land on the floor rather than
  // writing its result into the state that replaced it.
  reset() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    saveGen += 1;
    savePending = false;
    savePromise = null;
    saveAgain = false;
    saveFailed = false;
    saveBlocked = null;
    lastSavedAt = null;
    state = initialState();
    notify();
  },
};

/* ------------------------------------------------------------------ *
 * autosave loop
 * ------------------------------------------------------------------ */

const SAVE_DEBOUNCE_MS = 800;
const RETRY_DELAY_MS = 1500;
// saveNow() alternates between "wait for the save in flight" and "start the one
// the edits since then need". Two passes is the normal maximum; the cap only
// stops a pathological caller that edits from inside a subscriber.
const MAX_FLUSH_PASSES = 8;

// The two messages the save loop puts on screen, from 02_GLOSSARY_EN.md.
const SAVE_FAILED_MESSAGE = 'Not saved — the change is only in this window until the save succeeds';
const SAVE_CONFLICT_MESSAGE = 'This report was changed somewhere else — nothing was written';

// What saveNow() rejects with. `alreadyReported` marks the failure as one the
// save loop has already put on screen, so a caller (and boot.js's global
// rejection trap) can stay quiet rather than raising a second banner for it.
export class SaveFailedError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SaveFailedError';
    this.code = code || 'save-failed';
    this.alreadyReported = true;
  }
}

let saveTimer = null;
let savePending = false; // a save is in flight
let savePromise = null; // the promise of that save; it never rejects
let saveAgain = false; // a save was asked for while one was in flight
let saveFailed = false; // the last attempt exhausted its retry
let saveBlocked = null; // the destination a 409 stopped us writing to
let lastSavedAt = null; // mtime token for optimistic concurrency
let saveGen = 0; // bumped by reset(); a save from an older generation is dropped

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    runSave();
  }, SAVE_DEBOUNCE_MS);
}

async function attemptSave(dir, project) {
  const result = await api.saveProject(dir, project, { savedAt: lastSavedAt });
  if (result && result.mtime != null) lastSavedAt = result.mtime;
  else if (result && result.saved_at != null) lastSavedAt = result.saved_at;
  return result;
}

// Is (document, destination) still the pair the store holds? A save is only
// ever issued for the document that is loaded, into the report it came from.
function destinationIsCurrent(dir, project) {
  return state.projectDir === dir && state.project === project;
}

// Start a save if one is warranted. Returns the promise of whichever save is
// now in flight, so a caller can await the disk; it resolves rather than
// rejecting, because a failed save is reported through the banner, the
// `retrying` state and saveNow()'s rejection, not through this promise.
function runSave() {
  const snapshot = state;
  // The destination comes from the DOCUMENT, not from the route. The two differ
  // for as long as a report switch takes to fetch the next document, and every
  // save scheduled inside that window used to be addressed to the report the
  // user had just moved to.
  const dir = snapshot.projectDir;
  if (!dir || !snapshot.project || !snapshot.dirty) return Promise.resolve(null);
  // A conflict means the file moved under us. Writing again would overwrite
  // whatever moved it, so nothing goes out until the document is re-read.
  if (saveBlocked === dir) return Promise.resolve(null);
  if (savePending) {
    saveAgain = true;
    return savePromise || Promise.resolve(null);
  }
  savePending = true;
  saveFailed = false;
  // The revision the bytes about to go over the wire correspond to. Anything
  // that bumps state.rev after this line is NOT in this PUT.
  savePromise = performSave(dir, snapshot.project, snapshot.rev, saveGen);
  return savePromise;
}

async function performSave(dir, project, revAtSerialise, gen) {
  store.set({ saveState: 'saving' });
  try {
    const result = await attemptSave(dir, project);
    finishSave(dir, revAtSerialise, gen, null);
    return result;
  } catch (err) {
    if (gen !== saveGen) {
      abandonSave();
      return null;
    }
    // 409: the file changed on disk since the token was issued -- a second
    // window, an applied package, or a save addressed at the wrong report. The
    // token is the only thing that catches that, so it is never dropped and the
    // write is never repeated without it. Say so and stop.
    if (err && err.status === 409) {
      saveBlocked = dir;
      finishSave(dir, revAtSerialise, gen, err);
      return null;
    }
    // One automatic retry, for a server that was briefly not there.
    store.set({ saveState: 'retrying' });
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    // The pair may have come apart while we waited: the document was replaced,
    // or another report was loaded. Re-sending these bytes now would write them
    // somewhere they do not belong.
    if (gen !== saveGen || !destinationIsCurrent(dir, project)) {
      abandonSave();
      return null;
    }
    try {
      const result = await attemptSave(dir, project);
      finishSave(dir, revAtSerialise, gen, null);
      return result;
    } catch (err2) {
      if (err2 && err2.status === 409) saveBlocked = dir;
      finishSave(dir, revAtSerialise, gen, err2);
      return null;
    }
  }
}

// A save that can no longer be completed for the document it was taken from.
// Nothing is written and nothing is claimed; whatever is loaded now decides what
// happens next.
function abandonSave() {
  savePending = false;
  savePromise = null;
  saveAgain = false;
  saveFailed = false;
  if (state.dirty && state.projectDir) scheduleSave();
}

// The end of one save. `dirty` is cleared ONLY when nothing has changed since
// the PUT was serialised -- compared by revision, never by object identity, so
// an in-place edit typed during the save is not mistaken for no edit at all --
// and only when this save's destination is still the loaded document's, so a
// write that finished after the user moved on says nothing about the report now
// on screen.
function finishSave(dir, revAtSerialise, gen, err) {
  savePending = false;
  savePromise = null;
  if (gen !== saveGen) return;
  const current = state.projectDir === dir;
  const changedSince = state.rev !== revAtSerialise;

  if (err) {
    saveFailed = current;
    if (!current) return;
    // The document stays dirty and stays in memory; the next edit, or the next
    // scheduled pass, tries again -- unless a conflict stopped the loop, in
    // which case only a fresh read of the report starts it again, and saying
    // 'retrying' would promise an attempt that is never going to come.
    const conflict = !!(err && err.status === 409);
    store.set({ saveState: conflict ? 'blocked' : 'retrying' });
    store.pushBanner({
      level: 'error',
      code: conflict ? 'save-conflict' : 'save-failed',
      message: conflict ? SAVE_CONFLICT_MESSAGE : SAVE_FAILED_MESSAGE,
      detail: err && err.message ? String(err.message) : String(err),
    });
    return;
  }

  saveFailed = false;
  if (!current) {
    // The bytes landed in the right file, but that file is no longer the one on
    // screen. Nothing here may touch this document's dirty flag.
    saveAgain = false;
    return;
  }
  store.set({
    saveState: 'saved',
    savedAt: Date.now() / 1000,
    // `rev` is passed through unchanged so writing dirty:true here is not itself
    // counted as a new edit.
    dirty: changedSince,
    rev: state.rev,
  });
  if (saveAgain || changedSince) {
    saveAgain = false;
    scheduleSave();
  }
}

// Write everything outstanding, then resolve. Each pass either waits for the
// save in flight or starts the one the current state needs; the loop ends when
// the document is clean, or when it cannot be written -- an attempt has
// exhausted its retry, a conflict has stopped the loop, or there is no
// destination. It never blocks the caller forever; saveNow() turns a loop that
// ended with the document still dirty into a rejection.
async function flushSaves() {
  let last = null;
  let tries = 0;
  for (let pass = 0; pass < MAX_FLUSH_PASSES; pass++) {
    if (savePending) {
      await savePromise;
      continue;
    }
    if (!state.dirty) return last;
    // A server that is refusing writes must not hold the caller forever -- but
    // it gets one attempt from this flush first, whatever happened before it.
    if (saveFailed && tries > 0) return last;
    if (saveBlocked && saveBlocked === state.projectDir) return last;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    tries += 1;
    last = await runSave();
  }
  return last;
}

// Runs after every notification: any state that is dirty and belongs to a
// loaded report schedules a save, so a view only has to set `dirty` (or call
// store.markDirty()) and the persistence happens on its own. The report is the
// one the DOCUMENT came from -- leaving for the shelf does not strand the edit,
// and does not aim it at wherever the user went.
function afterChange() {
  if (state.dirty && state.project && state.projectDir && !savePending
      && saveBlocked !== state.projectDir) {
    scheduleSave();
  }
}

/* ------------------------------------------------------------------ *
 * preact binding
 * ------------------------------------------------------------------ */

function hooks() {
  const h = typeof window !== 'undefined' ? window.preactHooks : null;
  if (!h) throw new Error('preact hooks are not loaded');
  return h;
}

const identity = (s) => s;

// useStore(selector) re-renders the component whenever the selected slice
// changes by Object.is. Pass a selector that returns a stable reference (a slice
// of state, not a freshly built object) or the component re-renders every time.
export function useStore(selector) {
  const H = hooks();
  const select = typeof selector === 'function' ? selector : identity;

  if (typeof H.useSyncExternalStore === 'function') {
    return H.useSyncExternalStore(store.subscribe, () => select(store.get()));
  }

  const [, bump] = H.useState(0);
  const selectRef = H.useRef(select);
  selectRef.current = select;
  const valueRef = H.useRef();
  valueRef.current = select(store.get());

  H.useEffect(
    () =>
      store.subscribe(() => {
        const next = selectRef.current(store.get());
        if (!Object.is(next, valueRef.current)) {
          valueRef.current = next;
          bump((n) => n + 1);
        }
      }),
    []
  );

  return valueRef.current;
}

export default store;
