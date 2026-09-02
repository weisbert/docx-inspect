// boot.js -- startup, hash routing and the global error trap for Report Workbench.
//
// Loaded once from index.html as <script type="module" src="js/boot.js">. The
// vendored libraries are plain <script> tags in the shell, so they have already
// set window.preact / window.preactHooks / window.htm by the time a module runs.
//
// What this file owns:
//   * the hash router (#/ and #/r/<dir>?node=<id>)
//   * the global error trap -- the app must never white-screen
//   * the unload guard -- a page that goes away inside the save debounce must
//     not take the edit with it
//   * lazily importing the view module for the current route
//   * the startup fetches (/api/version, /api/tree) and loading a report's
//     project + config when the route points at one
//
// Everything else lives in store.js, api.js, util.js and views/.

import { store, useStore } from './store.js';
import * as api from './api.js';
import * as diag from './diag.js';

/* ------------------------------------------------------------------ *
 * environment
 * ------------------------------------------------------------------ */

const preact = window.preact;
const preactHooks = window.preactHooks;
const htm = window.htm;

// If the shell failed to load a vendor script there is nothing to render with.
// Say so in plain DOM rather than dying silently.
if (!preact || !preactHooks || !htm) {
  const host = document.getElementById('app') || document.body;
  const box = document.createElement('div');
  box.className = 'rw-boot-error';
  box.textContent = 'Something went wrong';
  const detail = document.createElement('div');
  detail.className = 'rw-boot-error-detail';
  detail.textContent = 'The interface libraries did not load.';
  box.appendChild(detail);
  host.appendChild(box);
  throw new Error('v2 shell: preact / hooks / htm not present on window');
}

const h = preact.h;
const render = preact.render;
const Fragment = preact.Fragment;
const html = htm.bind(h);
const { useEffect, useState } = preactHooks;

/* ------------------------------------------------------------------ *
 * routing
 * ------------------------------------------------------------------ */

// A report `dir` is a PATH -- '1108/CLKDIV_5G/CDR'. It goes into the hash one
// segment at a time so a slash stays a separator and everything else (spaces,
// '#', '?', '%') survives the round trip.
export function encodeDir(dir) {
  return String(dir || '')
    .split('/')
    .filter((seg) => seg !== '')
    .map(encodeURIComponent)
    .join('/');
}

export function decodeDir(text) {
  return String(text || '')
    .split('/')
    .filter((seg) => seg !== '')
    .map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch (err) {
        return seg; // a malformed escape stays literal rather than throwing
      }
    })
    .join('/');
}

const HOME_ROUTE = { view: 'home', dir: null, node: null };

// From the frozen string list, plus the two ways past it.
const STAYING_PUT = 'Staying in this report — leaving now would discard the change that is not saved';
const STAYING_PUT_BODY = 'Nothing was written and nothing was loaded over the edit. Retry runs the '
  + 'save again and then leaves; Leave and discard throws the edit away on purpose.';
const RETRY_LEAVE = 'Retry';
const LEAVE_DISCARD = 'Leave and discard';

// A report whose file cannot be read. The parser's own words go to Copy
// details; the screen gets a sentence somebody can act on.
const UNREADABLE_TITLE = 'This report cannot be opened';
const UNREADABLE_MESSAGE = 'Its project.json is not valid JSON — the file was probably edited by '
  + 'hand or cut off. Fix the file, or copy a snapshot from its _autosave folder over it, then '
  + 'open the report again.';

// '#/r/1108/CLKDIV_5G/CDR?node=sec-3' -> {view:'editor', dir:'...', node:'sec-3'}
export function parseHash(rawHash) {
  let hash = String(rawHash || '');
  if (hash.charAt(0) === '#') hash = hash.slice(1);
  if (!hash || hash === '/') return Object.assign({}, HOME_ROUTE);

  let path = hash;
  let query = '';
  const qi = hash.indexOf('?');
  if (qi >= 0) {
    path = hash.slice(0, qi);
    query = hash.slice(qi + 1);
  }
  if (path.charAt(0) === '/') path = path.slice(1);

  const params = new URLSearchParams(query);
  const node = params.get('node');

  if (path === '' || path === 'home') return Object.assign({}, HOME_ROUTE);
  if (path.startsWith('r/')) {
    const dir = decodeDir(path.slice(2));
    if (!dir) return Object.assign({}, HOME_ROUTE);
    return { view: 'editor', dir: dir, node: node || null };
  }
  // An address nobody claims goes home rather than showing an empty frame.
  return Object.assign({}, HOME_ROUTE);
}

export function routeHref(route) {
  const r = route || HOME_ROUTE;
  if (r.view === 'editor' && r.dir) {
    const node = r.node ? '?' + new URLSearchParams({ node: String(r.node) }).toString() : '';
    return '#/r/' + encodeDir(r.dir) + node;
  }
  return '#/';
}

// The one way to change screens. Writing location.hash fires hashchange, which
// applyHash() turns back into store.route -- so navigation, the browser Back
// button and a pasted address all take the same path.
export function navigate(route) {
  const href = routeHref(route);
  if (window.location.hash === href) {
    applyHash(); // same address, e.g. a re-click; make sure the state matches
    return;
  }
  window.location.hash = href;
}

function sameRoute(a, b) {
  return !!a && !!b && a.view === b.view && a.dir === b.dir && a.node === b.node;
}

// Leaving a report is the one navigation that can lose work, so it WAITS.
//
// The flush used to be fired and forgotten, with the route changing on the very
// next line. That is not a race the save loop can win: it suspends on the save
// in flight, and by the time it resumes the route has already moved -- to the
// shelf, where there is no report at all. The pending edit was then stranded in
// memory, dirty forever, and re-entering the report re-read the file over it.
//
// So: flush first, and only then move. If the flush could not get the document
// to disk, do not move at all -- loading the next report replaces the document
// in memory, and the edit would be gone with nothing left that could write it.
//
// The refusal is not a wall. It offers Retry (the save again, then the same
// address) and Leave and discard (the edit is dropped on purpose, then the
// address). Both are the user's decision; neither is taken on their behalf.
let applyGen = 0;

function refuseToLeave(wanted, dir) {
  store.pushBanner({
    level: 'error',
    code: 'leave-blocked',
    dir: dir,
    title: STAYING_PUT,
    message: STAYING_PUT_BODY,
    actions: [
      {
        label: RETRY_LEAVE,
        level: 'primary',
        onClick: () => {
          // Setting the hash re-enters applyHash, which flushes again first.
          if (window.location.hash === wanted) applyHash();
          else window.location.hash = wanted;
        },
      },
      {
        label: LEAVE_DISCARD,
        level: 'danger',
        onClick: () => {
          store.discardEdits();
          store.dismissBannerCode('leave-blocked');
          if (window.location.hash === wanted) applyHash();
          else window.location.hash = wanted;
        },
      },
    ],
  });
}

async function applyHash() {
  const token = (applyGen += 1);
  let next = parseHash(window.location.hash);
  const current = store.get().route;
  if (sameRoute(current, next)) return;

  if (current && current.dir && current.dir !== next.dir) {
    const wanted = window.location.hash;
    let flushed = true;
    try {
      await store.saveNow();
    } catch (err) {
      flushed = false;
    }
    // Another address arrived while we were waiting; that call owns the screen.
    if (token !== applyGen) return;
    if (!flushed) {
      refuseToLeave(wanted, current.dir);
      const back = routeHref(store.get().route);
      if (window.location.hash !== back) window.location.hash = back;
      return;
    }
    // The address bar may have moved on while the save was running; the newest
    // address is the one the user asked for.
    next = parseHash(window.location.hash);
    if (sameRoute(store.get().route, next)) return;
  }

  // A banner belongs to the report it was raised on. Moving to another report
  // -- or to the shelf -- drops the ones that were about the report being
  // left; a load that failed in A must not stay pinned above B.
  if (!current || current.dir !== next.dir) store.clearReportBanners(next.dir);

  store.set({ route: next });
  diag.setRoute(next.view + (next.dir ? ' ' + next.dir : '') + (next.node ? '  node=' + next.node : ''));
  if (next.view === 'editor' && next.dir) {
    if (next.node) store.rememberNode(next.dir, next.node);
    loadReport(next.dir); // a no-op when this report is already loaded
  } else if (next.view !== 'editor') {
    loadedDir = null; // re-read on the way back in, in case the shelf changed it
  }
}

// Installed on the store so views can navigate without importing boot.js (which
// would make a cycle: boot dynamically imports the views).
store.navigate = navigate;
store.routeHref = routeHref;
// "Load theirs" and every other on-purpose re-read go through the same guarded
// loader as a route change, so a superseded read still lands on the floor.
store.reloadReport = (dir) => loadReport(dir, true);

/* ------------------------------------------------------------------ *
 * global error trap
 * ------------------------------------------------------------------ */

function describe(err) {
  if (!err) return 'unknown error';
  if (typeof err === 'string') return err;
  if (err.message) return String(err.message);
  try {
    return JSON.stringify(err).slice(0, 400);
  } catch (e) {
    return String(err);
  }
}

let trapped = 0;
const TRAP_LIMIT = 20; // a runaway loop must not fill the screen with banners

function trap(err, source) {
  // eslint-disable-next-line no-console
  console.error('[workbench] ' + source, err);
  // saveNow() rejects when it could not write, and the save loop has already
  // said so on screen. A caller that lets that rejection escape (Ctrl+S is one)
  // must not raise a second banner for the same failure.
  if (err && err.alreadyReported) return;
  diag.note(source, describe(err));
  if (trapped >= TRAP_LIMIT) return;
  trapped += 1;
  try {
    store.pushBanner({ level: 'error', code: source, message: describe(err) });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[workbench] the error trap itself failed', e);
  }
}

function installErrorTrap() {
  window.addEventListener('error', (event) => {
    trap(event && (event.error || event.message), 'script');
  });
  window.addEventListener('unhandledrejection', (event) => {
    trap(event && event.reason, 'promise');
  });
}

// Not every fault raises a banner -- something that came out wrong, something
// that took a minute, something that only looks odd -- and those are exactly
// the ones that cost the most to describe in words. Ctrl+Alt+D copies the same
// diagnostics the banner offers, at any moment, from any screen.
function installDiagnosticsKey() {
  window.addEventListener('keydown', (event) => {
    if (!event.ctrlKey || !event.altKey || event.shiftKey) return;
    if (String(event.key || '').toLowerCase() !== 'd') return;
    event.preventDefault();
    diag.copyReport({ asked: 'Ctrl+Alt+D' }).then((ok) => {
      store.pushBanner({
        level: ok ? 'done' : 'error',
        code: 'diagnostics',
        title: ok ? 'Diagnostics copied' : 'Could not reach the clipboard',
        message: ok
          ? 'Paste it wherever you are reporting this. It carries the version, '
            + 'the screen you are on and the last requests -- no report content.'
          : 'The browser refused the clipboard. Open the console (F12) and copy '
            + 'the text logged there instead.',
      });
      if (!ok) {
        // eslint-disable-next-line no-console
        console.log(diag.report({ asked: 'Ctrl+Alt+D' }));
      }
    });
  });
}

/* ------------------------------------------------------------------ *
 * the unload guard
 * ------------------------------------------------------------------ */

// A keystroke is on disk 800ms later. A refresh, a tab close or an in-app
// reload inside that window used to take the edit with it, silently: nothing
// asked, nothing written, and the file still holding the previous state.
//
// Flushing is always attempted, because a write that lands needs no prompt.
// And it lands: the PUT is on the wire before the page is torn down, and the
// server writes whether or not anybody is left to read the answer -- measured
// in a real browser, for a navigation, a tab close and a window close, with a
// document of several hundred KB (test_v2_save_conflict.js keeps the proof).
// So the debounce window alone earns no prompt.
//
// The prompt is kept for the cases the flush cannot cover: a write already in
// flight (a second edit typed during it has no request of its own yet), one
// that failed and is waiting to retry, and one the loop has stopped because
// the file moved or is gone. There the question is the only thing standing
// between the edit and the void, and the prompt is telling the truth.
function outstandingEdit() {
  const s = store.get();
  return !!(s.dirty && s.project && s.projectDir);
}

function editAtRisk() {
  const s = store.get();
  return s.saveState === 'saving' || s.saveState === 'retrying' || s.saveState === 'blocked';
}

function flushOnTheWayOut() {
  if (!outstandingEdit()) return false;
  try {
    const flushing = store.saveNow();
    if (flushing && typeof flushing.catch === 'function') flushing.catch(() => {});
  } catch (err) {
    /* the save loop reports itself; there is no screen left to report to */
  }
  return true;
}

function installUnloadGuard() {
  // Hiding the tab is the last moment a write is reliably allowed to start, and
  // no question can be asked there -- so this one only flushes.
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushOnTheWayOut();
  });
  window.addEventListener('pagehide', () => {
    flushOnTheWayOut();
  });
  window.addEventListener('beforeunload', (event) => {
    // Read BEFORE the flush: the flush itself turns a pending edit into a
    // write in flight, and that is the one case that needs no question.
    const atRisk = editAtRisk();
    if (!flushOnTheWayOut()) return; // nothing outstanding: never interrupt
    if (!atRisk) return; // the flush just sent it: the write lands on its own
    // The browser shows its own wording here; a page cannot choose it.
    event.preventDefault();
    event.returnValue = '';
  });
}

/* ------------------------------------------------------------------ *
 * lazy view loading
 * ------------------------------------------------------------------ */

// Only the two top-level screens are imported here. The editor imports table,
// preview, sync and assets itself.
const VIEW_MODULES = {
  home: './views/home.js',
  editor: './views/editor.js',
};

const viewCache = new Map(); // view name -> {component} | {missing: reason}

function pickComponent(mod) {
  if (!mod) return null;
  const named = mod.default || mod.View || mod.Home || mod.Editor;
  if (typeof named === 'function') return named;
  const keys = Object.keys(mod);
  for (let i = 0; i < keys.length; i++) {
    if (typeof mod[keys[i]] === 'function') return mod[keys[i]];
  }
  return null;
}

// The view files are written by other agents and may not exist yet. A missing
// module must degrade to a named placeholder, never to a blank page or a boot
// failure -- and once the file lands it is picked up with no change here.
async function loadView(name) {
  if (viewCache.has(name)) return viewCache.get(name);
  const path = VIEW_MODULES[name];
  if (!path) {
    const entry = { missing: name };
    viewCache.set(name, entry);
    return entry;
  }
  let entry;
  try {
    const mod = await import(path);
    const component = pickComponent(mod);
    entry = component ? { component: component } : { missing: name };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[workbench] view not available yet: ' + name, err);
    entry = { missing: name };
  }
  viewCache.set(name, entry);
  return entry;
}

/* ------------------------------------------------------------------ *
 * chrome rendered by boot itself
 * ------------------------------------------------------------------ */

// Deliberately self-contained: components/Banner.js belongs to another agent and
// may not exist yet, and the error surface is the one thing that has to work
// even when everything else is broken. The class names follow the token sheet so
// css/app.css can style it.
function BootBanners() {
  const banners = useStore((s) => s.banners);
  const [copied, setCopied] = useState(0);
  if (!banners || !banners.length) return null;

  // WHY THERE IS A COPY BUTTON HERE
  //   The only way a fault gets from this machine to whoever can fix it is a
  //   human retyping it, and what survives that trip is "it broke". One click
  //   puts the whole picture -- version, address, the requests that failed and
  //   the ones that never came back -- on the clipboard as plain text.
  const copy = (banner) => {
    const detail = banner.detail ? ' -- ' + String(banner.detail) : '';
    diag.copyReport({ banner: (banner.code || 'error') + ': ' + banner.message + detail })
      .then((ok) => setCopied(ok ? Date.now() : -1));
  };

  const tone = (level) =>
    (level === 'attention' ? 'attention' : level === 'done' ? 'done' : 'blocking');
  const glyph = (level) => (level === 'attention' ? '!' : level === 'done' ? '✓' : '✕');

  // A banner may carry its own ways out ({label, level, onClick}); they come
  // before the two every banner has. The handler gets the banner, so a store
  // action can tell which report it was pressed for.
  const actionsOf = (b) => (Array.isArray(b.actions) ? b.actions : []).map((a, i) => html`
    <button key=${'a' + i} type="button"
            class=${'rw-btn rw-btn--' + (a.level || 'secondary')}
            onClick=${() => { if (typeof a.onClick === 'function') a.onClick(b); }}>
      ${a.label}
    </button>`);

  return html`
    <div class="rw-banners">
      ${banners.map(
        (b) => html`
          <div class=${'rw-banner rw-banner--' + tone(b.level)} key=${b.id} role="alert"
               data-code=${b.code || ''}>
            <span class="rw-banner__glyph" aria-hidden="true">${glyph(b.level)}</span>
            <div class="rw-banner__body">
              <div class="rw-banner__title">
                ${b.title || (b.level === 'done' ? 'Done' : 'Something went wrong')}
              </div>
              <div class="rw-banner__message">${b.message}</div>
            </div>
            <div class="rw-banner__actions">
              ${actionsOf(b)}
              <button class="rw-btn rw-btn--tertiary" type="button" onClick=${() => copy(b)}>
                ${copied > 0 ? 'Copied' : copied < 0 ? 'Copy failed' : 'Copy details'}
              </button>
              <button class="rw-btn rw-btn--tertiary" type="button"
                      onClick=${() => store.dismissBanner(b.id)}>Close</button>
            </div>
          </div>
        `
      )}
    </div>
  `;
}

function ViewPlaceholder(props) {
  return html`
    <div class="rw-placeholder">
      <div class="rw-placeholder-title">This screen is not available yet</div>
      <div class="rw-placeholder-detail">${VIEW_MODULES[props.view] || props.view}</div>
    </div>
  `;
}

function BootSpinner() {
  return html`<div class="rw-boot-spinner" aria-live="polite">Loading…</div>`;
}

function App() {
  const route = useStore((s) => s.route);
  const booting = useStore((s) => s.booting);
  const [entry, setEntry] = useState(null);

  useEffect(() => {
    let live = true;
    setEntry(null);
    loadView(route.view).then((loaded) => {
      if (live) setEntry(loaded);
    });
    return () => {
      live = false;
    };
  }, [route.view]);

  let body;
  if (!entry) body = html`<${BootSpinner} />`;
  else if (entry.component) body = html`<${entry.component} route=${route} />`;
  else body = html`<${ViewPlaceholder} view=${route.view} />`;

  return html`
    <${Fragment}>
      <${BootBanners} />
      <div class="rw-view ${booting ? 'is-booting' : ''}">${body}</div>
    <//>
  `;
}

/* ------------------------------------------------------------------ *
 * data loading
 * ------------------------------------------------------------------ */

// GET /api/tree is new; a server that predates it answers 404. Rather than
// showing an empty shelf, fold the flat /api/projects listing into the same
// shape so the home screen works either way. A flat folder name becomes a
// one-module project of its own.
function treeFromProjects(payload) {
  const projects = new Map();
  const list = (payload && payload.projects) || [];
  for (let i = 0; i < list.length; i++) {
    const entry = list[i] || {};
    const dir = String(entry.dir || '');
    if (!dir) continue;
    const parts = dir.split('/').filter((s) => s !== '');
    const projectId = parts.length >= 3 ? parts[0] : parts[0] || dir;
    const moduleId = parts.length >= 3 ? parts[1] : parts[0] || dir;
    const stage = parts.length >= 3 ? parts[2] : parts[parts.length - 1] || '';
    if (!projects.has(projectId)) {
      projects.set(projectId, { id: projectId, name: projectId, modules: new Map() });
    }
    const project = projects.get(projectId);
    if (!project.modules.has(moduleId)) {
      project.modules.set(moduleId, { id: moduleId, name: moduleId, reports: [] });
    }
    project.modules.get(moduleId).reports.push({
      dir: dir,
      stage: stage,
      name: entry.title || stage || dir,
      mtime: entry.mtime || null,
      overSpec: null,
      exchange: null,
    });
  }
  return {
    projects: Array.from(projects.values()).map((p) =>
      Object.assign({}, p, { modules: Array.from(p.modules.values()) })
    ),
    degraded: true,
  };
}

export async function refreshTree() {
  try {
    const tree = await api.getTree();
    store.set({ tree: tree });
    return tree;
  } catch (err) {
    if (!err || err.status !== 404) {
      // eslint-disable-next-line no-console
      console.warn('[workbench] /api/tree failed, falling back', err);
    }
    try {
      const tree = treeFromProjects(await api.getProjects());
      store.set({ tree: tree });
      return tree;
    } catch (err2) {
      store.set({ tree: { projects: [] } });
      trap(err2, 'tree');
      return null;
    }
  }
}

async function loadVersion() {
  try {
    const version = await api.getVersion();
    store.set({ version: version });
    diag.setVersion(version);
  } catch (err) {
    // A server without /api/version is simply a server with no update to report.
    store.set({ version: null });
  }
}

let loadingDir = null;
let loadedDir = null;

// A load only counts while it is still the newest one asked for. applyHash has
// carried this guard from the start; loadReport is the call that actually
// replaces the document, and it had none -- so a read the user had already
// moved on from could still land:
//
//     #/r/A    GET A ... slow
//     #/r/B    GET B ... fast, lands, B is on screen
//              A answers  -> setProject(A) over the top of it
//
// leaving the user reading A while the address bar, the route and the outline
// all say B -- and, because the save destination travels with the document,
// writing the next keystroke into A. So every await below is followed by the
// same question, and a superseded load returns without touching anything.
let loadGen = 0;

// Load a report's document and its template config. Both land in the store, so
// every view reads the same copy and store.js can autosave it.
//
// Loading is skipped when this report is already in memory: moving between its
// sections must never re-fetch, or an edit made a moment ago and not yet flushed
// by the autosave loop would be thrown away. Pass force to re-read on purpose
// (after a restore, a merge or an applied package).
export async function loadReport(dir, force) {
  if (!dir || loadingDir === dir) return;
  if (!force && loadedDir === dir && store.get().project) return;
  const token = (loadGen += 1);
  loadingDir = dir;
  try {
    const payload = await api.getProject(dir);
    if (token !== loadGen) return;      // another report was asked for; drop this
    const project = payload && payload.project ? payload.project : payload;
    const meta = (payload && payload.meta_info) || {};
    // The destination travels WITH the document: every save of it is addressed
    // to the report it was read from, whatever the route says later.
    store.setProject(project, Object.assign({}, meta, { dir: dir }));
    let cfg = null;
    try {
      cfg = await api.getConfig(dir, project && project.template);
    } catch (err) {
      if (token === loadGen) trap(err, 'config');
    }
    if (token !== loadGen) return;
    store.set({ cfg: cfg });
    loadedDir = dir;
  } catch (err) {
    // A read that failed after being superseded says nothing about the report
    // now on screen, so it neither clears it nor raises a banner over it.
    if (token !== loadGen) return;
    loadedDir = null;
    store.set({ project: null, projectDir: null });
    // A file the server could not parse is a fact about the file, said in
    // words somebody can act on; the parser's own text travels with Copy
    // details rather than being the whole message.
    if (err && err.payload && typeof err.payload === 'object' && err.payload.unreadable) {
      diag.note('project', describe(err));
      store.pushBanner({
        level: 'error',
        code: 'project',
        dir: dir,
        title: UNREADABLE_TITLE,
        message: UNREADABLE_MESSAGE,
        detail: String(err.payload.detail || err.message || ''),
      });
      return;
    }
    trap(err, 'project');
  } finally {
    // Only the newest load owns the in-flight slot; an older one finishing must
    // not declare the newer one finished with it.
    if (token === loadGen) loadingDir = null;
  }
}

/* ------------------------------------------------------------------ *
 * startup
 * ------------------------------------------------------------------ */

function mountPoint() {
  let host = document.getElementById('app');
  if (!host) {
    host = document.createElement('div');
    host.id = 'app';
    document.body.appendChild(host);
  }
  return host;
}

async function start() {
  installErrorTrap();
  installDiagnosticsKey();
  installUnloadGuard();
  store.restoreUi();

  // Route first, so the very first paint is already the right screen.
  const initial = parseHash(window.location.hash);
  store.set({ route: initial });
  window.addEventListener('hashchange', applyHash);

  // Paint immediately -- a slow or missing server must not leave a blank page.
  render(html`<${App} />`, mountPoint());

  const work = [loadVersion(), refreshTree()];
  if (initial.view === 'editor' && initial.dir) {
    if (initial.node) store.rememberNode(initial.dir, initial.node);
    work.push(loadReport(initial.dir));
  }
  await Promise.allSettled(work);
  store.set({ booting: false });
}

start().catch((err) => trap(err, 'startup'));
