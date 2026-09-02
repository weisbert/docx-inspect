/*
 * Report Workbench v2 - text exchange, package import, three-way merge, history.
 *
 * This screen carries the only outbound channel this tool has. The work machine
 * can pull code and can send plain TEXT back; images never come back. Every
 * surface here is shaped by that, and by one rule: the tool never loses an edit
 * in either direction, and never hides one it is about to drop.
 *
 * Four surfaces, exported for the editor to mount:
 *
 *   SyncDrawer     494px  outbound: what changed, copy it, take a package back
 *   ImportDialog   820px  a package's facts, its baseline verdict, its manifest
 *   MergeModal    1180px  the three-way merge, one decision per touched passage
 *   HistoryDrawer  494px  ONE timeline: snapshots, exchanges, restores
 *
 * Nothing here writes project.json on its own. The endpoints that do
 * (/api/merge3-apply, /api/apply-update, /api/paste-import) are reached only
 * from an explicit button, and each documented refusal is surfaced rather than
 * forced past:
 *
 *   truncated (409)    the package looks cut off mid-copy. Stop BEFORE the
 *                      merge screen, name what looks missing, and offer the
 *                      override with the number of sections it removes. The
 *                      override does not dismiss the warning: it travels with
 *                      the package to the merge screen and on to Apply, and it
 *                      travels with a re-comparison too.
 *   stale_merge (409)  project.json changed while the user was deciding. Say
 *                      that nothing was written and offer to compare again.
 *                      There is deliberately no force here.
 *   token missing      a different fault with the same recovery, and it gets
 *                      its own words: a comparison with no fingerprint is not
 *                      a report that moved.
 *   deletions          sections the merge drops without asking. Listed above
 *                      the fold, always: a deletion nobody was shown is
 *                      indistinguishable from lost work.
 *
 * The baseline verdict has THREE states, because /api/merge3 checks no ancestor
 * of its own and this is the only guard on that path: matches, mismatched, and
 * unknown. Unknown is not reassurance, and no fingerprint the package did not
 * declare is ever printed as though it had.
 *
 * Every operation here reads or replaces project.json ON DISK, so each one
 * flushes the editor's pending save first -- see flushEdits -- and every one of
 * them STOPS when that flush does not land. A document that exists only in this
 * page is a hard stop, not a warning: the server would read the older file,
 * snapshot that same older file, and the re-read afterwards would replace the
 * edit on screen with what it read, so the edit would exist nowhere. The screen
 * names the operation that did not happen, says why, and offers to go ahead
 * without the edit -- which is a real thing to want, and is therefore a button
 * the user presses rather than a choice made for them.
 *
 * `merged` and `token` from /api/merge3 travel back to /api/merge3-apply
 * VERBATIM. `merged` carries the conflict markers the apply resolves against
 * and `token` is the whole stale-merge guard; neither is ever rebuilt here.
 *
 * Every user-facing string lives in TEXT below and comes from the frozen
 * string list. No other line in this file may contain one.
 */

import {
  html, useState, useEffect, useMemo, useRef, useCallback,
  Button, Dialog, Drawer, Banner, Pill, EmptyState, Chips, Spinner,
} from '../components/index.js';
import { store, useStore } from '../store.js';
import * as api from '../api.js';
import { formatBytes, relativeTime, classNames } from '../util.js';

/* ================================================================== *
 * Frozen strings
 * ================================================================== */

const TEXT = {
  /* -- exchange drawer -- */
  exchange: 'Text exchange',
  channel: 'The channel carries plain text only',
  lastExchange: 'Last exchange',
  changesSince: 'Changes since',
  suggested: 'Suggested',
  copyChanges: 'Copy changes',
  copySuggestion: (size, pct) =>
    'Copy the changes (' + size + ', ' + pct + '% smaller than the whole report)',
  copyWhole: (size) => 'Copy whole report (' + size + ')',
  copied: 'Copied — paste it into the assistant conversation',
  noBaselineTitle: 'No baseline yet',
  noBaselineBody:
    'This report has never been exchanged, so there is nothing to compare against. Copy the '
    + 'whole report this first time; the baseline is recorded automatically and later exchanges '
    + 'can carry just the changes.',
  notSmaller:
    'The changes are not smaller than the whole report — copy the whole report instead',
  noChanges: 'No changes since the last exchange',
  neverExchanged: 'Never exchanged',
  sectionsSince: (n) => n + ' sections changed since',
  dropHere: 'Drop the returned package here',
  dropKinds: '.zip or a single .md — or choose a file',
  chooseFile: 'Choose a file',
  orPaste: 'Or paste text',
  pastePlaceholder: 'Paste the returned text here',
  useText: 'Use this text',
  promise:
    'Non-overlapping edits merge on their own. Only a passage both sides changed stops to '
    + 'ask you. Nothing is ever overwritten silently.',
  whichChanged: 'Which sections changed',
  notesCarried: (n) => 'Notes carried along · ' + n,
  exchangeHistory: 'Exchange history',
  rollBack: 'Roll back',
  toolVersion: 'Tool version',
  localAvailable: (a, b) => 'Local ' + a + ' → available ' + b,
  pullRestart: 'Pull and restart',
  seeChanged: 'See what changed',
  restartHeld: 'Not restarted — this report is not saved',
  restartHeldBody:
    'The last save did not reach the disk, so restarting now would discard the edits that '
    + 'exist only in this page. The save keeps retrying; restart once it reports Saved.',
  restartAnyway: 'Restart anyway — the unsaved edits are lost',
  nSections: (n) => n + ' sections',
  nBlocks: (n) => n + ' blocks',

  /* -- event names, shared by the exchange list and the history timeline -- */
  evApplied: 'Applied an update package',
  evPasted: 'Replaced from pasted text',
  evMerged: 'Merged a returned package',
  evRestored: 'Restored a snapshot',
  evSnapshot: 'Automatic snapshot',

  /* -- import dialog -- */
  importTitle: 'Apply an external update',
  importSub: 'The baseline is checked first, then the manifest, then the comparison',
  pkgMeta: (size, when) => size + ' · created ' + when,
  baseOk: 'The baseline matches',
  baseOkBody: (baseline) =>
    'The package is based on ' + baseline + ', which is the state this machine last sent. '
    + 'Safe to merge.',
  baseBad: 'The baseline does not match — stopped',
  baseBadBody: (theirs, ours) =>
    'The package is based on ' + theirs + ", but this machine's baseline is already " + ours
    + '. Merging now would overwrite everything changed in between, so Continue is disabled. '
    + 'Either use the snapshot the package names as the common ancestor — the extra local '
    + 'changes then appear in the conflict list one by one — or send the changes again so '
    + 'the other side works from the current report.',
  useSnapshot: (when) => 'Use the ' + when + ' snapshot as the ancestor',
  sendAgain: 'Send the changes again',
  baseUnknown: 'The common ancestor could not be checked',
  baseUnknownTheirs:
    'This package does not name the state it was cut from, so there is nothing to check '
    + "this machine's baseline against. The comparison still runs and every passage both "
    + 'sides changed still stops to ask you, but nothing here shows the two sides started '
    + 'from the same report. Read what the package contains before you continue.',
  baseUnknownOurs: (theirs) =>
    'The package names ' + theirs + ' as the state it was cut from, but this machine could '
    + 'not read its own baseline fingerprint, so the two cannot be compared. The comparison '
    + 'still runs and every passage both sides changed still stops to ask you, but nothing '
    + 'here shows the two sides started from the same report.',
  baseNoneTitle: 'No baseline to compare against',
  baseNoneBody:
    'This report has never been exchanged, so there is no common ancestor to merge from. The '
    + 'package replaces this report in full. A snapshot is taken first, and the baseline is '
    + 'recorded so the next exchange can carry just the changes.',
  replaceReport: 'Replace the report',
  manifestTitle: 'What the package contains',
  colFile: 'File',
  colGoesTo: 'Goes to',
  colSize: 'Size',
  colStatus: 'Status',
  stAccepted: 'Accepted',
  stRejected: 'Rejected — fixed template section',
  stConfirm: 'Needs confirmation',
  changesTitle: 'What applying it changes',
  changesCaveat: 'These numbers are computed from the package and nothing has been written yet',
  before: 'Before',
  after: 'After',
  rowSections: 'Sections',
  rowBlocks: 'Blocks',
  continueCompare: (n) => 'Continue · compare ' + n + ' passages',
  continueBlocked: 'Continue · disabled, baseline does not match',
  applyPackage: 'Apply the package',
  cutTitle: 'This package looks cut off',
  cutBody: (missing, total) =>
    'It is missing ' + missing + ' of the ' + total + ' sections it was cut from. That usually '
    + 'means the copy stopped early, not that those sections were deleted.',
  copyAgain: 'Copy the package again',
  mergeAnyway: 'Merge it anyway — the deletions are real',
  overrideWarn: (missing) =>
    'Merging it as it stands removes those ' + missing + ' sections from this report. A '
    + 'snapshot is taken first, so this can be undone.',

  /* -- merge modal -- */
  mergeSub: 'What we last exchanged, what you have now, and what came back',
  autoPill: (n) => 'Merged automatically · ' + n,
  pendingPill: (n) => 'Needs your decision · ' + n,
  touches: (n) => 'This package touches ' + n + ' passages',
  ancestor: (when) => 'At the last exchange (common ancestor) · ' + when,
  mineCol: 'Your version',
  theirsCol: 'The returned version',
  keepMine: 'Keep mine',
  keepTheirs: 'Keep theirs',
  keepBoth: 'Keep both, one after the other',
  scope: 'Only the sections this package touched change; everything else is left alone',
  undoMerge: 'Undo the whole merge',
  applyN: (n) => 'Apply · ' + n + ' decided',
  removedBy: (n) => 'Removed by the package · ' + n,
  removedBody:
    'Deleted on the other side and not changed here, so the merge removes them without asking. '
    + 'Applying is undoable — a snapshot is taken first.',
  editedHereDeletedThere: 'Edited here, deleted on the other side',
  deletedHereEditedThere: 'Deleted here, edited on the other side',
  staleTitle: 'The report changed while you were deciding',
  staleBody:
    'Nothing was written. This report was saved somewhere else after the comparison started, '
    + 'and applying now would erase that, so the merge stopped instead. Compare again to work '
    + 'from the current report — the decisions are the only thing lost.',
  tokenTitle: 'The comparison lost the fingerprint it needs',
  tokenBody:
    'Nothing was written. Applying replaces the whole report, so it is only allowed to run '
    + 'against the fingerprint the comparison recorded, and this comparison carries none. '
    + 'Compare again to rebuild it — the decisions are the only thing lost.',
  compareAgain: 'Compare again',

  /* -- history drawer -- */
  history: 'History',
  historySub: 'One timeline: snapshots, exchanges, restores',
  historyModel: 'No Save button — every change is kept, and a restore can itself be undone',
  fAll: 'All',
  fExchanges: 'Exchanges',
  fRestores: 'Restores',
  restoreState: 'Restore this state',
  tagExchange: 'Exchange',
  tagRestore: 'Restore',
  tagSnapshot: 'Snapshot',

  /* -- an operation held back because the document is not on disk --
   * The frozen counterpart of the restart trio above: the same fact, the same
   * voice, one title per operation because "Not restored" and "Not merged" are
   * not the same sentence to the person reading it. Two bodies, because the
   * comparison reads the file and the other five replace it, and those are two
   * different things to be told. */
  holdRestore: 'Not restored — this report is not saved',
  holdRollback: 'Not rolled back — this report is not saved',
  holdApply: 'Not applied — this report is not saved',
  holdReplace: 'Not replaced — this report is not saved',
  holdMerge: 'Not merged — this report is not saved',
  holdCompare: 'Not compared — this report is not saved',
  holdWriteBody:
    'Nothing was written. The last save did not reach the disk, so the edits on screen exist '
    + 'only in this page, and this replaces the file they never reached — the snapshot taken '
    + 'first would be a copy of that same file, so nothing would be holding them afterwards. '
    + 'The save keeps retrying; try again once it reports Saved.',
  holdReadBody:
    'Nothing was written, and nothing will be. The last save did not reach the disk, so the '
    + 'file this comparison reads as your version is the older one and the edits on screen are '
    + 'not in it. The save keeps retrying; compare once it reports Saved.',
  holdRestoreAnyway: 'Restore anyway — the unsaved edits are lost',
  holdRollbackAnyway: 'Roll back anyway — the unsaved edits are lost',
  holdApplyAnyway: 'Apply anyway — the unsaved edits are lost',
  holdReplaceAnyway: 'Replace anyway — the unsaved edits are lost',
  holdMergeAnyway: 'Merge anyway — the unsaved edits are lost',
  holdCompareAnyway: 'Compare anyway — your version will be the older file',

  /* -- shared -- */
  wrong: 'Something went wrong',
  retry: 'Retry',
  nothingHere: 'Nothing here yet',
  loading: 'Loading…',
  close: 'Close',
  cancel: 'Cancel',
  cover: 'Cover and metadata',
  section: 'Section',
  sections: 'Sections',
};

/* ================================================================== *
 * Pure helpers
 * ================================================================== */

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const nodesOf = (v) => (Array.isArray(v) ? v.filter(isObj) : []);
const blocksOf = (n) => (Array.isArray(n && n.blocks) ? n.blocks : []);
const errText = (err) => String((err && err.message) || err || '');

// A short, comparable form of a fingerprint. The full sha is 64 characters of
// noise and the only thing the user needs to see is whether two of them differ.
function shortSha(sha) {
  const s = String(sha == null ? '' : sha);
  return s ? s.slice(0, 12) : '';
}

function countProject(project) {
  let sections = 0;
  let blocks = 0;
  const walk = (list) => {
    for (const node of nodesOf(list)) {
      sections += 1;
      blocks += blocksOf(node).length;
      walk(node.children);
    }
  };
  walk(project && project.outline);
  return { sections: sections, blocks: blocks };
}

// node id -> '2.1', the same numbering the outline shows.
function locationIndex(project) {
  const map = new Map();
  const walk = (list, prefix) => {
    nodesOf(list).forEach((node, i) => {
      const loc = prefix + (i + 1);
      if (node.id) map.set(String(node.id), loc);
      walk(node.children, loc + '.');
    });
  };
  walk(project && project.outline, '');
  return map;
}

// Every section of a report, flattened, keyed by id and by title. Used to pair
// an incoming section with its local counterpart the way the merge does.
function sectionIndex(project) {
  const byId = new Map();
  const byTitle = new Map();
  const walk = (list) => {
    for (const node of nodesOf(list)) {
      if (node.id) byId.set(String(node.id), node);
      const title = String(node.title == null ? '' : node.title).trim();
      if (title && !byTitle.has(title)) byTitle.set(title, node);
      walk(node.children);
    }
  };
  walk(project && project.outline);
  return { byId: byId, byTitle: byTitle };
}

// Section notes travel with the document but never render into it: they are how
// a section is explained to the other side without the explanation landing in
// the report.
function collectNotes(project) {
  const out = [];
  const walk = (list, prefix) => {
    nodesOf(list).forEach((node, i) => {
      const loc = prefix + (i + 1);
      const note = node.note == null ? node.notes : node.note;
      if (typeof note === 'string' && note.trim()) {
        out.push({ loc: loc, title: String(node.title || ''), note: note.trim() });
      }
      walk(node.children, loc + '.');
    });
  };
  walk(project && project.outline, '');
  return out;
}

// The readable content of one section's own fields, for the merge columns.
// Deliberately plain text: this is a comparison, not a preview.
function describeOwn(own) {
  if (!isObj(own)) return own === undefined || own === null ? '' : String(own);
  const lines = [];
  if (own.title) lines.push(String(own.title));
  for (const block of blocksOf(own)) {
    if (!isObj(block)) continue;
    if (block.type === 'para') {
      const runs = Array.isArray(block.runs) ? block.runs : [];
      lines.push(runs.map((r) => String((r && r.t) || '')).join(''));
    } else if (block.type === 'image' || block.type === 'imagegrid') {
      lines.push(String(block.caption || block.file || ''));
    } else if (block.type === 'table' || block.type === 'datatable') {
      lines.push(String(block.caption || ''));
    }
  }
  const text = lines.filter((l) => l !== '').join('\n');
  if (text) return text;
  try {
    return JSON.stringify(own, null, 1);
  } catch (err) {
    return '';
  }
}

// A conflict's two sides are a node's own fields for a section conflict and a
// bare value for a top-level one, so both shapes go through one printer.
function conflictSide(entry, side) {
  if (!entry) return '';
  if (entry.kind === 'children') {
    const order = entry[side + '_order'];
    if (Array.isArray(order)) return order.join('\n');
  }
  const value = entry[side];
  if (value === undefined || value === null) return '';
  if (isObj(value) || Array.isArray(value)) return describeOwn(value);
  return String(value);
}

// What changed about one conflict, in the vocabulary the rest of the interface
// uses. Never the raw field names the merge library reports.
function conflictDetail(entry) {
  switch (entry && entry.kind) {
    case 'blocks': return TEXT.rowBlocks;
    case 'children': return TEXT.sections;
    case 'meta': return TEXT.cover;
    case 'removed': return TEXT.editedHereDeletedThere;
    case 'deleted': return TEXT.deletedHereEditedThere;
    default: return TEXT.section;
  }
}

// The cut-off refusal, rendered wherever it still applies. It is drawn once on
// the screen that refuses and again on every screen the user reaches by
// overriding it, because the count in overrideWarn is the only thing that tells
// a genuine bulk deletion apart from a paste that stopped early -- and it is
// worth nothing if it is not on screen when the button is pressed.
// `action` is the override button, present only while the override is still
// available; once taken, the warning stands on its own.
function truncationBanner(cut, action) {
  if (!cut) return null;
  const missing = cut.missing == null ? 0 : cut.missing;
  const total = cut.total == null ? 0 : cut.total;
  return html`
    <${Banner} level="error" title=${TEXT.cutTitle} action=${action || null}>
      <div>${TEXT.cutBody(missing, total)}</div>
      ${cut.detail ? html`<div class="rw-meta">${String(cut.detail)}</div>` : null}
      <div class="rw-sync__warnline">${TEXT.overrideWarn(missing)}</div>
    <//>`;
}

/* -- clipboard ------------------------------------------------------
 * The page is served from 127.0.0.1 so the async clipboard is available, but a
 * lost focus or a hardened profile can still refuse it. The textarea fallback
 * keeps the one outbound channel working. */
async function copyToClipboard(text) {
  const payload = String(text == null ? '' : text);
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(payload);
      return true;
    }
  } catch (err) {
    /* fall through to the textarea */
  }
  try {
    const box = document.createElement('textarea');
    box.value = payload;
    box.setAttribute('readonly', '');
    box.style.position = 'fixed';
    box.style.top = '-1000px';
    document.body.appendChild(box);
    box.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(box);
    return !!ok;
  } catch (err) {
    return false;
  }
}

/* -- the whole report, as text ---------------------------------------
 * The in-memory document, whole, on the clipboard. This is the drawer's own
 * "Copy whole report", and it is also what a blocked save offers as "Copy my
 * version" -- the same bytes from the same place, so the text the user rescues
 * from a conflict is exactly the text the exchange channel would carry. It
 * reads memory, not disk, on purpose: the point is the version the disk does
 * NOT hold. -> true when the clipboard took it. */
export async function copyWholeReport() {
  const text = JSON.stringify(store.get().project || {}, null, 2);
  return copyToClipboard(text);
}

/* -- flushing before a write ----------------------------------------
 * Every server-side operation on this screen reads or replaces the project.json
 * ON DISK, and each one is followed by a re-read that replaces what is in
 * memory. An edit the autosave loop still owes is therefore neither part of
 * what the server works from nor preserved by the refresh -- and because the
 * server snapshots the file it is about to overwrite, it is not in History
 * either. So the disk is made current FIRST.
 *
 * store.saveNow() is the contract for that: it flushes any pending save and
 * resolves once the disk holds what the screen is showing, whether the edit
 * replaced the project reference or mutated the outline in place.
 *
 * -> true when the disk now holds what the screen shows, false when it does
 * not. EVERY caller honours that answer. There is no operation on this screen
 * that is safe to run on top of a document the disk does not hold: the ones
 * that write replace the file the edit never reached, and the one that only
 * reads computes its merge from that same older file. A verdict that is
 * computed and then dropped is worse than no verdict at all, because the
 * barrier then looks present.
 *
 * Every way saveNow can report a failure is treated as one: a rejection, an
 * explicit failure it resolves with, and the document still being dirty
 * afterwards, which is the ground truth whichever of the two it chose. A store
 * too old to have the method saves nothing and owes nothing, so it answers true
 * rather than blocking the button. */
async function flushEdits() {
  try {
    if (!store || typeof store.saveNow !== 'function') return true;
    const answer = await store.saveNow();
    if (answer && answer.ok === false) return false;
    const current = typeof store.get === 'function' ? store.get() : null;
    return !(current && current.dirty);
  } catch (err) {
    /* the save loop raises its own banner; the caller decides what to do */
    return false;
  }
}

/* -- the barrier in front of a write --------------------------------
 * flushEdits says whether the disk holds what the screen shows; this is what
 * every caller does with that answer.
 *
 *   guard(op, job)   run `job` only if the flush lands. If it does not, the job
 *                    does NOT run and `held` names the operation that did not
 *                    happen.
 *   retry()          try the same job again, barrier and all -- the save loop
 *                    keeps retrying in the background, so this is the way out
 *                    once it succeeds.
 *   proceed()        run the held job WITHOUT the barrier. Losing an edit to a
 *                    restore is a legitimate thing to want; taking it silently
 *                    is not. This is only ever reached from the danger button.
 *   clear()          drop the refusal because its inputs changed underneath it.
 *
 * The returned object is rebuilt on every render, so it must never appear in a
 * dependency array -- take `guard`, which is stable for the life of the view. */
function useSaveBarrier() {
  const [held, setHeld] = useState(null);

  const guard = useCallback(async (op, job) => {
    if (await flushEdits()) {
      setHeld(null);
      await job();
      return true;
    }
    setHeld({ op: op, job: job });
    return false;
  }, []);

  const retry = useCallback(() => {
    if (held) guard(held.op, held.job);
  }, [held, guard]);

  const proceed = useCallback(() => {
    const pending = held;
    setHeld(null);
    if (pending) pending.job();
  }, [held]);

  const clear = useCallback(() => setHeld(null), []);

  return { held: held, guard: guard, retry: retry, proceed: proceed, clear: clear };
}

// What each held operation is called, and what going ahead without the edit
// costs. The comparison writes nothing, so it gets the other body and the other
// warning: what it loses is not the edit but the truth of what it compared.
const HOLD = {
  restore: { title: TEXT.holdRestore, body: TEXT.holdWriteBody, anyway: TEXT.holdRestoreAnyway },
  rollback: { title: TEXT.holdRollback, body: TEXT.holdWriteBody, anyway: TEXT.holdRollbackAnyway },
  apply: { title: TEXT.holdApply, body: TEXT.holdWriteBody, anyway: TEXT.holdApplyAnyway },
  replace: { title: TEXT.holdReplace, body: TEXT.holdWriteBody, anyway: TEXT.holdReplaceAnyway },
  merge: { title: TEXT.holdMerge, body: TEXT.holdWriteBody, anyway: TEXT.holdMergeAnyway },
  compare: { title: TEXT.holdCompare, body: TEXT.holdReadBody, anyway: TEXT.holdCompareAnyway },
};

// The refusal on screen: which operation did not happen, why, and the only two
// ways past it. The second one is a danger button and is never pressed on the
// user's behalf.
function holdBanner(barrier, busy) {
  const held = barrier && barrier.held;
  if (!held) return null;
  const words = HOLD[held.op] || HOLD.apply;
  return html`
    <${Banner} level="error" title=${words.title}
               action=${html`
                 <div class="rw-sync__actions rw-sync__actions--tight">
                   <${Button} disabled=${!!busy} onClick=${barrier.retry}>${TEXT.retry}<//>
                   <${Button} level="danger" disabled=${!!busy} onClick=${barrier.proceed}>
                     ${words.anyway}
                   <//>
                 </div>`}>
      ${words.body}
    <//>`;
}

/* -- refreshing after a write --------------------------------------
 * Every path that writes project.json ends here. boot.js owns loading, and
 * loadReport(dir, true) re-reads without marking the document dirty; the direct
 * fetch is the fallback if that import ever fails, because leaving stale state
 * on screen after a merge is worse than either. */
async function refreshReport(dir) {
  if (!dir) return;
  try {
    const boot = await import('../boot.js');
    if (boot && typeof boot.loadReport === 'function') {
      await boot.loadReport(dir, true);
      return;
    }
  } catch (err) {
    /* fall through */
  }
  try {
    const payload = await api.getProject(dir);
    const project = payload && payload.project ? payload.project : payload;
    store.setProject(project, (payload && payload.meta_info) || {});
  } catch (err) {
    store.pushBanner({ level: 'error', code: 'sync-refresh', message: errText(err) });
  }
}

/* ================================================================== *
 * Reading an inbound package
 * ================================================================== */

// The returned text arrives by hand: pasted into a chat, saved to a file,
// wrapped in a code fence. Try the whole body, then a fenced block, then the
// outermost braces, and take the first thing that parses to an object.
function parseLooseJson(text) {
  const raw = String(text == null ? '' : text);
  const attempts = [raw.trim()];
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) attempts.push(String(fence[1]).trim());
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) attempts.push(raw.slice(first, last + 1));
  for (const attempt of attempts) {
    if (!attempt) continue;
    try {
      const value = JSON.parse(attempt);
      if (isObj(value)) return value;
    } catch (err) {
      /* try the next shape */
    }
  }
  return null;
}

/* -- zip, read in the browser ---------------------------------------
 * A package can be a .zip, and the dialog promises that nothing is written
 * before Continue. So the archive is read here rather than posted to find out
 * what is in it. The central directory alone gives every entry's name and size
 * with no decompression at all, so even a build without DecompressionStream
 * still shows a real manifest; only reading an entry's CONTENT needs inflate. */
function readZipDirectory(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const decoder = new TextDecoder('utf-8');
  let eocd = -1;
  const floor = Math.max(0, bytes.length - 66000);
  for (let i = bytes.length - 22; i >= floor; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip archive');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50) break;
    const nameLen = view.getUint16(p + 28, true);
    const entry = {
      method: view.getUint16(p + 10, true),
      csize: view.getUint32(p + 20, true),
      size: view.getUint32(p + 24, true),
      offset: view.getUint32(p + 42, true),
      name: decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen)),
    };
    if (!entry.name.endsWith('/')) entries.push(entry);
    p += 46 + nameLen + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
  }
  return { bytes: bytes, view: view, entries: entries };
}

async function zipEntryText(zip, entry) {
  const o = entry.offset;
  if (zip.view.getUint32(o, true) !== 0x04034b50) throw new Error('damaged zip entry');
  const start = o + 30 + zip.view.getUint16(o + 26, true) + zip.view.getUint16(o + 28, true);
  const raw = zip.bytes.subarray(start, start + entry.csize);
  if (entry.method === 0) return new TextDecoder('utf-8').decode(raw);
  if (entry.method === 8 && typeof DecompressionStream === 'function') {
    const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return await new Response(stream).text();
  }
  throw new Error('unsupported zip compression');
}

function toBase64(bytes) {
  let out = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(out);
}

// A returned report must never rewrite a section whose body is fixed template
// text: that text is not editable here, so an edit to it upstream is not an
// edit the merge may take. The local version is put back before the merge sees
// it, which is what makes the manifest's "rejected" row true rather than a
// label on something that happened anyway.
function protectFixedBodies(incoming, local) {
  const index = sectionIndex(local);
  const rejected = [];
  const clone = JSON.parse(JSON.stringify(incoming));
  const walk = (list, prefix) => {
    nodesOf(list).forEach((node, i) => {
      const loc = prefix + (i + 1);
      const id = node.id == null ? '' : String(node.id);
      const title = String(node.title == null ? '' : node.title).trim();
      const mine = index.byId.get(id) || index.byTitle.get(title);
      if (mine && mine.fixed_body) {
        for (const key of Object.keys(node)) {
          if (key !== 'children') delete node[key];
        }
        for (const key of Object.keys(mine)) {
          if (key !== 'children') node[key] = JSON.parse(JSON.stringify(mine[key]));
        }
        rejected.push({ loc: loc, title: title || id });
      }
      walk(node.children, loc + '.');
    });
  };
  walk(clone.outline, '');
  return { project: clone, rejected: rejected };
}

// -> {kind, name, size, created, incoming, diff, zipB64, entries, note,
//     declaredBase, manifest}
//
// kind is 'report'  a whole returned report -> three-way merge
//         'diff'    an op-diff cut against the baseline -> /api/apply-update
//         'bundle'  a zip with no readable report for this report -> the same
async function readPackage(file, dir, project) {
  const name = String((file && file.name) || '');
  const created = file && file.lastModified ? file.lastModified / 1000 : Date.now() / 1000;
  const lower = name.toLowerCase();

  if (lower.endsWith('.zip')) {
    const buffer = await file.arrayBuffer();
    const zip = readZipDirectory(buffer);
    const base = { name: name, size: buffer.byteLength, created: created, entries: zip.entries };
    let manifest = null;
    const manifestEntry = zip.entries.find((e) => e.name === 'update.json');
    if (manifestEntry) {
      try {
        manifest = JSON.parse(await zipEntryText(zip, manifestEntry));
      } catch (err) {
        manifest = null;
      }
    }
    base.note = String((manifest && manifest.note) || '');
    base.declaredBase = declaredBaseOf(manifest, dir);
    const target = zip.entries.find(
      (e) => e.name === dir + '/project.json' || e.name === 'project.json');
    if (target) {
      try {
        const incoming = parseLooseJson(await zipEntryText(zip, target));
        if (incoming && Array.isArray(incoming.outline)) {
          return Object.assign(base, { kind: 'report', incoming: incoming });
        }
      } catch (err) {
        /* fall through to the bundle path */
      }
    }
    return Object.assign(base, { kind: 'bundle', zipB64: toBase64(zip.bytes) });
  }

  const text = await file.text();
  return packageFromText(name, text, created);
}

function packageFromText(name, text, created) {
  const parsed = parseLooseJson(text);
  const size = new Blob([String(text == null ? '' : text)]).size;
  if (!parsed) throw new Error('no report or update found in this text');
  if (Array.isArray(parsed.outline)) {
    return {
      kind: 'report', name: name, size: size, created: created,
      incoming: parsed, declaredBase: parsed.base_sha || null, note: '',
    };
  }
  if (parsed._reportdiff) {
    return {
      kind: 'diff', name: name, size: size, created: created,
      diff: parsed, declaredBase: parsed.base_sha || null, note: '',
    };
  }
  throw new Error('no report or update found in this text');
}

// A bundle names the state it was cut from once for the whole package and,
// optionally, again per report. The per-report one wins.
function declaredBaseOf(manifest, dir) {
  if (!isObj(manifest)) return null;
  const projects = isObj(manifest.projects) ? manifest.projects : {};
  const own = projects[dir];
  if (isObj(own) && own.base_sha) return String(own.base_sha);
  return manifest.base_sha ? String(manifest.base_sha) : null;
}

// The manifest table: one row per file the package carries, plus a row for
// every section the fixed-body guard put back.
function buildManifest(pkg, dir, rejected) {
  const rows = [];
  if (Array.isArray(pkg.entries) && pkg.entries.length) {
    // An archive lists every member. A package that goes through the merge
    // writes ONE file -- this report -- so nothing else in it can be called
    // accepted; the images and any second report need their own decision.
    const report = dir + '/project.json';
    for (const entry of pkg.entries) {
      if (entry.name === 'update.json') continue;
      const accepted = pkg.kind === 'report'
        ? entry.name === report
        : entry.name === report || entry.name.indexOf(dir + '/') === 0;
      rows.push({
        file: entry.name,
        goesTo: entry.name,
        size: formatBytes(entry.size),
        status: accepted ? TEXT.stAccepted : TEXT.stConfirm,
      });
    }
  } else {
    rows.push({
      file: pkg.name || dir,
      goesTo: dir + '/project.json',
      size: formatBytes(pkg.size),
      status: TEXT.stAccepted,
    });
  }
  for (const item of rejected || []) {
    rows.push({
      file: item.title,
      goesTo: dir + ' · ' + item.loc,
      size: '',
      status: TEXT.stRejected,
    });
  }
  return rows;
}

/* ================================================================== *
 * The exchange drawer
 * ================================================================== */

const EXCHANGE_REASONS = {
  preapply: TEXT.evApplied,
  prebaseline: TEXT.evApplied,
  prepaste: TEXT.evPasted,
  premerge: TEXT.evMerged,
};

function eventOf(snapshot) {
  const reason = String((snapshot && snapshot.reason) || '');
  if (EXCHANGE_REASONS[reason]) {
    return { kind: 'exchange', tag: TEXT.tagExchange, title: EXCHANGE_REASONS[reason] };
  }
  if (reason === 'prerestore') {
    return { kind: 'restore', tag: TEXT.tagRestore, title: TEXT.evRestored };
  }
  return { kind: 'snapshot', tag: TEXT.tagSnapshot, title: TEXT.evSnapshot };
}

// The changed-section list, read out of the op-diff the server just computed.
// The size is what that section contributes to the package, which is the number
// that decides whether the incremental channel is worth using.
function changedSections(diffText, project) {
  const rows = [];
  if (!diffText) return rows;
  let diff = null;
  try {
    diff = JSON.parse(diffText);
  } catch (err) {
    return rows;
  }
  const locations = locationIndex(project);
  const sizeOf = (value) => {
    try {
      return formatBytes(JSON.stringify(value).length);
    } catch (err) {
      return '';
    }
  };
  if (diff.meta) {
    rows.push({ loc: '', title: TEXT.cover, detail: TEXT.cover, size: sizeOf(diff.meta) });
  }
  if (Array.isArray(diff.outline)) {
    rows.push({
      loc: '', title: TEXT.sections, detail: TEXT.nSections(diff.outline.length),
      size: sizeOf(diff.outline),
    });
  }
  for (const op of (Array.isArray(diff.ops) ? diff.ops : [])) {
    const id = op.node_id == null ? '' : String(op.node_id);
    let detail = TEXT.section;
    if (op.op === 'set_children') detail = TEXT.sections;
    else if (isObj(op.fields) && Object.prototype.hasOwnProperty.call(op.fields, 'blocks')) {
      detail = TEXT.rowBlocks;
    }
    rows.push({
      loc: locations.get(id) || '',
      title: String(op.title || id),
      detail: detail,
      size: sizeOf(op),
    });
  }
  return rows;
}

function findReportRow(tree, dir) {
  for (const project of ((tree && tree.projects) || [])) {
    for (const mod of (project.modules || [])) {
      for (const report of (mod.reports || [])) {
        if (report.dir === dir) return report;
      }
    }
  }
  return null;
}

export function SyncDrawer(props) {
  const dir = props.dir || (store.get().route || {}).dir || '';
  const project = useStore((s) => s.project);
  const tree = useStore((s) => s.tree);
  const version = useStore((s) => s.version);

  const [diff, setDiff] = useState(null);
  const [busy, setBusy] = useState(true);
  const [failure, setFailure] = useState('');
  const [copied, setCopied] = useState(false);
  const [snapshots, setSnapshots] = useState([]);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [pkg, setPkg] = useState(null);
  const [pkgError, setPkgError] = useState('');
  const [showChanges, setShowChanges] = useState(false);
  const [restartHeld, setRestartHeld] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const fileRef = useRef(null);
  const barrier = useSaveBarrier();

  const reload = useCallback(async () => {
    if (!dir) return;
    setBusy(true);
    setFailure('');
    try {
      const answer = await api.copyDiff(dir, store.get().project || {});
      setDiff(answer);
    } catch (err) {
      setFailure(errText(err));
    }
    try {
      const answer = await api.getAutosaves(dir);
      setSnapshots((answer && answer.autosaves) || []);
    } catch (err) {
      setSnapshots([]);
    }
    setBusy(false);
  }, [dir]);

  useEffect(() => { reload(); }, [reload]);

  // Switching report throws away whatever was half-read for the previous one: a
  // package belongs to the report it was dropped on and to no other.
  useEffect(() => {
    setPkg(null);
    setPkgError('');
    setPasteOpen(false);
    setPasteText('');
  }, [dir]);

  const row = useMemo(() => findReportRow(tree, dir), [tree, dir]);
  const notes = useMemo(() => collectNotes(project), [project]);
  const changed = useMemo(
    () => changedSections(diff && diff.diff_text, project), [diff, project]);

  const noBaseline = !!(diff && diff.no_baseline);
  const empty = !!(diff && diff.empty);
  const smaller = !!(diff && diff.smaller);
  const fullBytes = (diff && diff.full_chars)
    || (project ? JSON.stringify(project).length : 0);
  const diffBytes = (diff && diff.diff_chars) || 0;
  const pct = fullBytes && diffBytes ? Math.max(0, Math.round((1 - diffBytes / fullBytes) * 100)) : 0;

  const lastExchangeAt = (row && row.exchange && row.exchange.last)
    || (snapshots.filter((s) => eventOf(s).kind === 'exchange')[0] || {}).mtime
    || null;
  const lastExchangeEvent = eventOf(snapshots.filter((s) => eventOf(s).kind === 'exchange')[0]);

  let suggestion = TEXT.noChanges;
  if (noBaseline) suggestion = TEXT.noBaselineTitle;
  else if (!empty && smaller) suggestion = TEXT.copySuggestion(formatBytes(diffBytes), pct);
  else if (!empty && !smaller) suggestion = TEXT.notSmaller;

  const flash = () => {
    setCopied(true);
    window.setTimeout(() => setCopied(false), 6000);
  };

  const onCopyChanges = async () => {
    if (!diff || !diff.diff_text) return;
    if (await copyToClipboard(diff.diff_text)) flash();
  };

  const onCopyWhole = async () => {
    if (await copyWholeReport()) flash();
  };

  // Restarting throws the page away, and with it every edit that has not
  // reached the disk. It is the one control here that writes nothing itself,
  // which is exactly why it was the one without a flush: the edit is not lost
  // by a server that refuses it, it is lost by the reload, silently, and the
  // snapshot the next write would have taken is a copy of the file the edit
  // never reached. So the disk is made current first, and a restart that cannot
  // be made safe is not taken on the user's behalf -- it is named, and left to
  // them.
  const pullAndRestart = async () => {
    setRestartHeld(false);
    setRestarting(true);
    const landed = await flushEdits();
    if (!landed) {
      setRestarting(false);
      setRestartHeld(true);
      return;
    }
    window.location.reload();
  };

  // A roll back replaces project.json and the refresh that follows replaces
  // what is in memory, so an edit the save loop still owes is in neither
  // afterwards. It runs behind the barrier, and when the barrier holds it does
  // not run at all.
  const rollBackNow = async () => {
    try {
      await api.rollback(dir);
      await refreshReport(dir);
      reload();
    } catch (err) {
      setFailure(errText(err));
    }
  };

  const takeFile = async (file) => {
    if (!file) return;
    setPkgError('');
    try {
      setPkg(await readPackage(file, dir, store.get().project || {}));
    } catch (err) {
      setPkgError(errText(err));
    }
  };

  const takeText = () => {
    setPkgError('');
    try {
      setPkg(packageFromText('', pasteText, Date.now() / 1000));
      setPasteOpen(false);
    } catch (err) {
      setPkgError(errText(err));
    }
  };

  const onDrop = (ev) => {
    const files = ev && ev.dataTransfer ? ev.dataTransfer.files : null;
    if (files && files.length) { takeFile(files[0]); return; }
    const text = ev && ev.dataTransfer ? ev.dataTransfer.getData('text/plain') : '';
    if (text) {
      try {
        setPkg(packageFromText('', text, Date.now() / 1000));
      } catch (err) {
        setPkgError(errText(err));
      }
    }
  };

  const exchanges = snapshots.filter((s) => eventOf(s).kind === 'exchange').slice(0, 6);
  const localVersion = String((version && version.local) || '');
  const availableVersion = String((version && version.available) || localVersion);
  const hasUpdate = !!(version && (version.needsRestart
    || (version.available && version.available !== version.local)));
  const versionChanges = (version && Array.isArray(version.changes)) ? version.changes : [];

  return html`
    <${Drawer} title=${TEXT.exchange} subtitle=${TEXT.channel}
               closeLabel=${TEXT.close} onClose=${props.onClose}>
      <div class="rw-sync">

        <div class="rw-sync__kv">
          <div class="rw-sync__k">${TEXT.lastExchange}</div>
          <div class="rw-sync__v">
            ${lastExchangeAt
              ? relativeTime(lastExchangeAt) + ' · ' + lastExchangeEvent.title
              : TEXT.neverExchanged}
          </div>
          <div class="rw-sync__k">${TEXT.changesSince}</div>
          <div class="rw-sync__v">
            ${busy ? TEXT.loading
              : (changed.length ? TEXT.sectionsSince(changed.length) : TEXT.noChanges)}
          </div>
          <div class="rw-sync__k">${TEXT.suggested}</div>
          <div class="rw-sync__v">${busy ? TEXT.loading : suggestion}</div>
        </div>

        ${failure ? html`
          <${Banner} level="error" title=${TEXT.wrong}
                     action=${html`<${Button} onClick=${reload}>${TEXT.retry}<//>`}>
            ${failure}
          <//>` : null}

        ${noBaseline ? html`
          <${Banner} level="warn" title=${TEXT.noBaselineTitle}>${TEXT.noBaselineBody}<//>`
          : null}

        <div class="rw-sync__actions">
          <${Button} level="primary" disabled=${busy || noBaseline || empty || !smaller}
                     onClick=${onCopyChanges}>${TEXT.copyChanges}<//>
          <${Button} onClick=${onCopyWhole}>${TEXT.copyWhole(formatBytes(fullBytes))}<//>
        </div>

        ${copied ? html`<${Banner} level="done">${TEXT.copied}<//>` : null}

        <div class="rw-sync__group">
          <div
            class=${classNames('rw-empty', 'rw-empty--sm')}
            onDragOver=${(ev) => ev.preventDefault()}
            onDrop=${(ev) => { ev.preventDefault(); onDrop(ev); }}
          >
            <div class="rw-empty__title">${TEXT.dropHere}</div>
            <div>${TEXT.dropKinds}</div>
            <div class="rw-sync__actions">
              <${Button} onClick=${() => fileRef.current && fileRef.current.click()}>
                ${TEXT.chooseFile}
              <//>
              <${Button} level="tertiary" onClick=${() => setPasteOpen(!pasteOpen)}>
                ${TEXT.orPaste}
              <//>
            </div>
            <input
              ref=${fileRef}
              type="file"
              class="rw-hidden"
              accept=".zip,.md,.json,.txt"
              onChange=${(ev) => {
                const file = ev.target.files && ev.target.files[0];
                ev.target.value = '';
                takeFile(file);
              }}
            />
          </div>

          ${pasteOpen ? html`
            <div class="rw-sync__group">
              <textarea
                class="rw-textarea rw-sync__paste"
                placeholder=${TEXT.pastePlaceholder}
                value=${pasteText}
                onInput=${(ev) => setPasteText(ev.target.value)}
              ></textarea>
              <div class="rw-sync__actions">
                <${Button} level="primary" disabled=${!pasteText.trim()} onClick=${takeText}>
                  ${TEXT.useText}
                <//>
              </div>
            </div>` : null}

          ${pkgError ? html`<${Banner} level="error" title=${TEXT.wrong}>${pkgError}<//>` : null}

          <div class="rw-sync__promise">${TEXT.promise}</div>
        </div>

        <div class="rw-sync__group">
          <div class="rw-sync__title">${TEXT.whichChanged}</div>
          ${changed.length ? changed.map((item, i) => html`
            <div class="rw-sync__item" key=${'ch' + i}>
              <div class="rw-sync__itemmain">
                <div class="rw-strong rw-truncate">
                  ${item.loc ? item.loc + ' ' : ''}${item.title}
                </div>
                <div class="rw-meta">${item.detail}</div>
              </div>
              <div class="rw-sync__size">${item.size}</div>
            </div>`)
            : html`<div class="rw-meta">${TEXT.noChanges}</div>`}
        </div>

        ${notes.length ? html`
          <div class="rw-sync__group">
            <div class="rw-sync__title">${TEXT.notesCarried(notes.length)}</div>
            ${notes.map((item, i) => html`
              <div class="rw-sync__note" key=${'note' + i}>
                <div class="rw-strong rw-truncate">${item.loc} ${item.title}</div>
                <div>${item.note}</div>
              </div>`)}
          </div>` : null}

        <div class="rw-sync__group">
          <div class="rw-sync__title">${TEXT.exchangeHistory}</div>
          ${holdBanner(barrier, busy)}
          ${exchanges.length ? exchanges.map((snapshot, i) => html`
            <div class="rw-sync__item" key=${snapshot.name}>
              <div class="rw-sync__itemmain">
                <div class="rw-strong">${eventOf(snapshot).title}</div>
                <div class="rw-meta">${relativeTime(snapshot.mtime)}</div>
              </div>
              ${i === 0 ? html`
                <${Button} level="tertiary"
                           onClick=${() => barrier.guard('rollback', rollBackNow)}>
                  ${TEXT.rollBack}
                <//>` : null}
            </div>`)
            : html`<div class="rw-meta">${TEXT.neverExchanged}</div>`}
        </div>

        <div class="rw-sync__group">
          <div class="rw-sync__title">${TEXT.toolVersion}</div>
          <div class="rw-meta">${TEXT.localAvailable(localVersion, availableVersion)}</div>
          <div class="rw-sync__actions">
            <${Button} disabled=${!hasUpdate || restarting}
                       onClick=${pullAndRestart}>${TEXT.pullRestart}<//>
            <${Button} level="tertiary" disabled=${!versionChanges.length}
                       onClick=${() => setShowChanges(!showChanges)}>${TEXT.seeChanged}<//>
          </div>
          ${restartHeld ? html`
            <${Banner} level="error" title=${TEXT.restartHeld}
                       action=${html`
                         <${Button} level="danger"
                                    onClick=${() => window.location.reload()}>
                           ${TEXT.restartAnyway}
                         <//>`}>
              ${TEXT.restartHeldBody}
            <//>` : null}
          ${showChanges && versionChanges.length ? html`
            <div class="rw-meta">
              ${versionChanges.map((line, i) => html`<div key=${'v' + i}>${String(line)}</div>`)}
            </div>` : null}
        </div>
      </div>

      ${pkg ? html`
        <${ImportDialog}
          dir=${dir}
          pkg=${pkg}
          baseline=${{ none: noBaseline, sha: baselineShaOf(diff) }}
          onClose=${() => setPkg(null)}
          onDone=${async () => {
            setPkg(null);
            await refreshReport(dir);
            reload();
          }}
        />` : null}
    <//>`;
}

// The local baseline's fingerprint, which the op-diff the server just computed
// carries in its head. There is no separate endpoint for it, and asking for one
// would be a second reading of the same file.
function baselineShaOf(diff) {
  if (!diff || !diff.diff_text) return '';
  try {
    return String(JSON.parse(diff.diff_text).base_sha || '');
  } catch (err) {
    return '';
  }
}

/* ================================================================== *
 * The import dialog
 * ================================================================== */

export function ImportDialog(props) {
  const dir = props.dir;
  const pkg = props.pkg || {};
  const baseline = props.baseline || {};
  const project = useStore((s) => s.project);

  const [merge, setMerge] = useState(null);
  const [truncated, setTruncated] = useState(null);
  // The refusal the user pushed past. It is NOT cleared by the override -- a
  // package that looked cut off still looks cut off, and the sentence naming
  // how many sections the merge removes has to be on screen at the moment the
  // button that removes them is pressed.
  const [overridden, setOverridden] = useState(null);
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  const [merging, setMerging] = useState(false);
  const barrier = useSaveBarrier();
  const guard = barrier.guard;

  // The fixed-body guard runs before anything else looks at the package, so
  // every count and every row below describes what would actually be merged.
  const guarded = useMemo(() => {
    if (pkg.kind !== 'report' || !pkg.incoming) return { project: null, rejected: [] };
    return protectFixedBodies(pkg.incoming, project || {});
  }, [pkg, project]);

  const incoming = guarded.project;
  const manifest = useMemo(
    () => buildManifest(pkg, dir, guarded.rejected), [pkg, dir, guarded]);

  const declared = pkg.declaredBase ? shortSha(pkg.declaredBase) : '';
  const ours = shortSha(baseline.sha);

  // Three states, not two. /api/merge3 performs no ancestor check of its own,
  // so this is the only baseline guard on the whole-report merge path, and a
  // guard whose unknown case falls through to "matches" guards nothing: a
  // returned report pasted as text is a bare project.json and names no
  // ancestor at all, which is the common case, not the exotic one. Unknown is
  // therefore its own answer -- said plainly, never dressed up as agreement.
  //
  //   none      this report has never been exchanged -> full replace
  //   ok        both fingerprints are present and identical
  //   mismatch  both are present and differ -> hard stop
  //   unknown   one of them is missing: the package declares no ancestor, or
  //             this machine could not read its own baseline fingerprint
  const verdict = (() => {
    if (baseline.none) return 'none';
    if (!pkg.declaredBase) return 'unknown';
    if (!baseline.sha) return 'unknown';
    return pkg.declaredBase === baseline.sha ? 'ok' : 'mismatch';
  })();

  const runCompare = useCallback(async (allowBulkDelete) => {
    setBusy(true);
    setFailure('');
    try {
      const answer = await api.merge3(dir, incoming, { allowBulkDelete: !!allowBulkDelete });
      // Only a comparison that came back clears the refusal screen; a failed
      // override leaves the user looking at what they were asked about.
      setTruncated(null);
      setMerge(answer);
    } catch (err) {
      if (err instanceof api.TruncatedPackageError) setTruncated(err.truncated || {});
      else setFailure(errText(err));
    }
    setBusy(false);
  }, [dir, incoming]);

  // The merge's "mine" side is the project.json on disk. The comparison writes
  // nothing, but an edit the save loop still owes is not in the file it reads,
  // so what it would put in front of the user is a comparison of the older
  // document -- with every conflict decided against a version of "mine" that is
  // not the one on screen. That is a stop too, and it says which one it is.
  const compare = useCallback((allowBulkDelete) => {
    if (!incoming) return Promise.resolve(false);
    return guard('compare', () => runCompare(allowBulkDelete));
  }, [incoming, guard, runCompare]);

  // "The deletions are real." The refusal is remembered, not dismissed.
  const overrideTruncation = useCallback(() => {
    setOverridden(truncated || {});
    compare(true);
  }, [truncated, compare]);

  // A new package is a new comparison: never inherit the previous one's answer,
  // its conflict list, its refusal or the screen it had reached.
  useEffect(() => {
    setMerge(null);
    setMerging(false);
    setTruncated(null);
    setOverridden(null);
    setFailure('');
    barrier.clear();
  }, [pkg, barrier.clear]);

  // An unchecked ancestor is not a reason to refuse the comparison -- merge3
  // writes nothing and every passage both sides changed still stops to ask.
  // It is a reason not to call the result safe, which the banner below does.
  useEffect(() => {
    if ((verdict === 'ok' || verdict === 'unknown') && pkg.kind === 'report') compare(false);
  }, [verdict, pkg, compare]);

  const before = useMemo(() => countProject(project), [project]);
  const after = useMemo(
    () => countProject(merge && merge.merged ? merge.merged : incoming), [merge, incoming]);

  // apply-update rewrites project.json and onDone re-reads it, so an edit that
  // is only in memory is gone both ways. Held unless the disk is current.
  const runApplyPackage = async () => {
    setBusy(true);
    setFailure('');
    try {
      if (pkg.kind === 'diff') await api.applyUpdate(dir, { diff: pkg.diff });
      else await api.applyUpdate(dir, { name: pkg.name || 'update.zip', zip_b64: pkg.zipB64 });
      if (props.onDone) await props.onDone();
    } catch (err) {
      setFailure(errText(err));
      setBusy(false);
    }
  };

  const applyPackage = () => guard('apply', runApplyPackage);

  // A full replace is snapshotted server-side; the snapshot has to hold the
  // edits that are only in memory, or they are in no version of anything --
  // which is exactly why this one is held rather than reported afterwards.
  const runReplaceReport = async () => {
    setBusy(true);
    setFailure('');
    try {
      await api.pasteImport(dir, JSON.stringify(incoming, null, 2));
      if (props.onDone) await props.onDone();
    } catch (err) {
      setFailure(errText(err));
      setBusy(false);
    }
  };

  const replaceReport = () => guard('replace', runReplaceReport);

  /* -- the cut-off package: stop before the merge screen -- */
  if (truncated) {
    const missing = truncated.missing == null ? 0 : truncated.missing;
    const total = truncated.total == null ? 0 : truncated.total;
    return html`
      <${Dialog} title=${TEXT.importTitle} subtitle=${TEXT.importSub} width=${820}
                 closeLabel=${TEXT.close} scrimCloses=${false} onClose=${props.onClose}
                 footer=${html`
                   <${Button} level="primary" onClick=${props.onClose}>${TEXT.copyAgain}<//>`}
                 footerLeft=${html`
                   <${Button} level="danger" disabled=${busy} onClick=${overrideTruncation}>
                     ${TEXT.mergeAnyway}
                   <//>`}>
        <div class="rw-sync">
          <${Banner} level="error" title=${TEXT.cutTitle}>${TEXT.cutBody(missing, total)}<//>
          ${truncated.detail ? html`<div class="rw-meta">${String(truncated.detail)}</div>` : null}
          <div class="rw-sync__warnline">${TEXT.overrideWarn(missing)}</div>
        </div>
      <//>`;
  }

  /* -- the merge screen, once the user has pressed Continue -- */
  if (merging && merge) {
    return html`
      <${MergeModal}
        dir=${dir}
        incoming=${incoming}
        result=${merge}
        truncated=${overridden}
        onClose=${props.onClose}
        onApplied=${props.onDone}
      />`;
  }

  const footer = (() => {
    if (verdict === 'mismatch') {
      return html`<${Button} level="primary" disabled=${true}>${TEXT.continueBlocked}<//>`;
    }
    if (verdict === 'none') {
      return html`
        <${Button} level="primary" disabled=${busy || !incoming} onClick=${replaceReport}>
          ${TEXT.replaceReport}
        <//>`;
    }
    if (pkg.kind === 'report') {
      return html`
        <${Button} level="primary" disabled=${busy || !merge}
                   onClick=${() => setMerging(true)}>
          ${TEXT.continueCompare(merge ? merge.conflicts.length : 0)}
        <//>`;
    }
    return html`
      <${Button} level="primary" disabled=${busy} onClick=${applyPackage}>
        ${TEXT.applyPackage}
      <//>`;
  })();

  return html`
    <${Dialog} title=${TEXT.importTitle} subtitle=${TEXT.importSub} width=${820}
               closeLabel=${TEXT.close} scrimCloses=${false} onClose=${props.onClose}
               footer=${footer}
               footerLeft=${html`
                 <${Button} level="tertiary" onClick=${props.onClose}>${TEXT.cancel}<//>`}>
      <div class="rw-sync">

        <div class="rw-sync__group">
          <div class="rw-panel-title">${pkg.name || dir}</div>
          <div class="rw-meta">
            ${TEXT.pkgMeta(formatBytes(pkg.size), relativeTime(pkg.created))}
          </div>
          ${pkg.note ? html`<div class="rw-meta">${pkg.note}</div>` : null}
        </div>

        ${truncationBanner(overridden)}

        ${verdict === 'ok' && !overridden ? html`
          <${Banner} level="done" title=${TEXT.baseOk}>
            ${TEXT.baseOkBody(declared)}
          <//>` : null}

        ${verdict === 'unknown' ? html`
          <${Banner} level="warn" title=${TEXT.baseUnknown}>
            ${declared ? TEXT.baseUnknownOurs(declared) : TEXT.baseUnknownTheirs}
          <//>` : null}

        ${verdict === 'none' ? html`
          <${Banner} level="warn" title=${TEXT.baseNoneTitle}>${TEXT.baseNoneBody}<//>` : null}

        ${verdict === 'mismatch' ? html`
          <${Banner} level="error" title=${TEXT.baseBad}>
            <div>${TEXT.baseBadBody(declared, ours)}</div>
            <div class="rw-sync__actions rw-sync__actions--tight">
              <${Button} onClick=${props.onClose}>
                ${TEXT.useSnapshot(relativeTime(pkg.created))}
              <//>
              <${Button} onClick=${props.onClose}>${TEXT.sendAgain}<//>
            </div>
          <//>` : null}

        ${holdBanner(barrier, busy)}

        ${failure ? html`<${Banner} level="error" title=${TEXT.wrong}>${failure}<//>` : null}

        <div class="rw-sync__group">
          <div class="rw-sync__title">${TEXT.manifestTitle}</div>
          <table class="rw-sync__table">
            <thead>
              <tr>
                <th>${TEXT.colFile}</th>
                <th>${TEXT.colGoesTo}</th>
                <th>${TEXT.colSize}</th>
                <th>${TEXT.colStatus}</th>
              </tr>
            </thead>
            <tbody>
              ${manifest.map((rowItem, i) => html`
                <tr key=${'m' + i}>
                  <td class="rw-truncate">${rowItem.file}</td>
                  <td class="rw-truncate rw-dim">${rowItem.goesTo}</td>
                  <td class="rw-sync__size">${rowItem.size}</td>
                  <td class=${rowItem.status === TEXT.stAccepted ? '' : 'rw-warn'}>
                    ${rowItem.status}
                  </td>
                </tr>`)}
            </tbody>
          </table>
        </div>

        ${incoming ? html`
          <div class="rw-sync__group">
            <div class="rw-sync__title">${TEXT.changesTitle}</div>
            <table class="rw-sync__table">
              <thead>
                <tr>
                  <th></th>
                  <th>${TEXT.before}</th>
                  <th>${TEXT.after}</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>${TEXT.rowSections}</td>
                  <td class="rw-sync__size">${before.sections}</td>
                  <td class="rw-sync__size">${after.sections}</td>
                </tr>
                <tr>
                  <td>${TEXT.rowBlocks}</td>
                  <td class="rw-sync__size">${before.blocks}</td>
                  <td class="rw-sync__size">${after.blocks}</td>
                </tr>
              </tbody>
            </table>
            <div class="rw-meta">${TEXT.changesCaveat}</div>
          </div>` : null}

        ${busy ? html`<div class="rw-sync__busy"><${Spinner} /> ${TEXT.loading}</div>` : null}
      </div>
    <//>`;
}

/* ================================================================== *
 * The three-way merge
 * ================================================================== */

export function MergeModal(props) {
  const dir = props.dir;
  const [result, setResult] = useState(props.result || null);
  const [choices, setChoices] = useState({});
  const [selected, setSelected] = useState('');
  // '' | 'stale' | 'token'. Two different refusals with two different causes:
  // a report that moved is not a comparison that lost its fingerprint, and
  // telling the user the first when it was the second is simply untrue.
  const [refusal, setRefusal] = useState('');
  // The cut-off refusal still in force: inherited when the user overrode it in
  // the import dialog, or raised here if a fresh comparison hits one.
  const [cut, setCut] = useState(props.truncated || null);
  const [overrode, setOverrode] = useState(!!props.truncated);
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  const barrier = useSaveBarrier();
  const tree = useStore((s) => s.tree);

  const conflicts = (result && result.conflicts) || [];
  const deletions = (result && result.deletions) || [];

  useEffect(() => {
    if (!selected && conflicts.length) setSelected(String(conflicts[0].id));
  }, [conflicts, selected]);

  const decided = conflicts.filter((c) => choices[String(c.id)]).length;
  const allDecided = decided === conflicts.length;
  // Applying is blocked while a refusal stands, and while a cut-off package is
  // waiting to be answered -- in that state `result` describes a comparison the
  // server has since refused, so it is not a thing to write.
  const blocked = !!refusal || (!!cut && !overrode);

  const exchangeAt = useMemo(() => {
    const row = findReportRow(tree, dir);
    return row && row.exchange ? row.exchange.last : null;
  }, [tree, dir]);

  // Compare again: the recovery from both documented apply refusals. It re-runs
  // the merge against the report as it is now and rebuilds the screen from that
  // answer. Never a force, and never the old `merged` object.
  //
  // It carries the bulk-delete override with it. A package the user has already
  // said is a real deletion is still that package on the second comparison, and
  // re-posting without the override would meet the same 409 the override exists
  // to answer -- which would turn the one recovery button on this screen into a
  // dead end. The override is still only ever sent because the user chose it.
  const runCompareAgain = async (wantBulk) => {
    setBusy(true);
    setFailure('');
    try {
      const answer = await api.merge3(dir, props.incoming, { allowBulkDelete: wantBulk });
      setResult(answer);
      setChoices({});
      setSelected('');
      setRefusal('');
      if (wantBulk) setOverrode(true);
      else { setCut(null); setOverrode(false); }
    } catch (err) {
      // A truncation can be raised here too -- the baseline may have moved
      // since the first comparison -- so it is answered here rather than
      // funnelled into the generic banner as an unexplained failure.
      if (err instanceof api.TruncatedPackageError) {
        setCut(err.truncated || {});
        setOverrode(false);
      } else {
        setFailure(errText(err));
      }
    }
    setBusy(false);
  };

  // The comparison reads project.json from disk, so it is held for the same
  // reason the import dialog's first comparison is: a merge computed from a
  // file that is missing the edit on screen is not the merge the user is
  // looking at.
  const compareAgain = (allowBulkDelete) => {
    const wantBulk = allowBulkDelete === undefined ? overrode : !!allowBulkDelete;
    return barrier.guard('compare', () => runCompareAgain(wantBulk));
  };

  // Applying replaces project.json wholesale. Anything the autosave loop still
  // owes has to reach disk first: it is not in `merged`, and the refresh that
  // follows would drop it. If landing it moves the report out from under the
  // merge, the token guard refuses and says so -- which is the outcome that
  // keeps the edit, not the one that loses it. If it cannot land at all, the
  // apply does not run: the token would still match the untouched file, so
  // nothing downstream would catch it.
  const runApply = async () => {
    setBusy(true);
    setFailure('');
    try {
      // merged and token go back exactly as they arrived.
      await api.merge3Apply(dir, {
        merged: result.merged,
        token: result.token,
        choices: conflicts.map((c) => ({ id: c.id, choice: choices[String(c.id)] || 'mine' })),
      });
      if (props.onApplied) await props.onApplied();
    } catch (err) {
      if (err instanceof api.MergeTokenMissingError) setRefusal('token');
      else if (err instanceof api.StaleMergeError) setRefusal('stale');
      else setFailure(errText(err));
      setBusy(false);
    }
  };

  const apply = () => barrier.guard('merge', runApply);

  // A held apply describes the decisions as they stood when the button was
  // pressed. Change one, or take a fresh comparison, and it is no longer that
  // operation -- so the refusal goes rather than sitting there offering to run
  // something the user has since changed.
  useEffect(() => { barrier.clear(); }, [choices, result, barrier.clear]);

  const entry = conflicts.find((c) => String(c.id) === selected) || null;
  const pick = (choice) => {
    if (!entry) return;
    setChoices(Object.assign({}, choices, { [String(entry.id)]: choice }));
  };
  const current = entry ? choices[String(entry.id)] : '';

  return html`
    <${Dialog} title=${TEXT.importTitle} subtitle=${TEXT.mergeSub} width=${1180}
               closeLabel=${TEXT.close} scrimCloses=${false} onClose=${props.onClose}
               footerLeft=${html`
                 <div class="rw-sync__footnote">
                   <span class="rw-meta">${TEXT.scope}</span>
                   <${Button} level="tertiary" onClick=${props.onClose}>${TEXT.undoMerge}<//>
                 </div>`}
               footer=${html`
                 <${Button} level="primary" disabled=${busy || blocked || !allDecided}
                            onClick=${apply}>${TEXT.applyN(decided)}<//>`}>
      <div class="rw-sync rw-sync__merge">

        <div class="rw-sync__pills">
          <${Pill} tone="good">${TEXT.autoPill((result && result.auto) || 0)}<//>
          <${Pill} tone="warn">${TEXT.pendingPill(conflicts.length - decided)}<//>
          <span class="rw-meta">${TEXT.touches(conflicts.length)}</span>
        </div>

        ${truncationBanner(cut, overrode ? null : html`
          <${Button} level="danger" disabled=${busy} onClick=${() => compareAgain(true)}>
            ${TEXT.mergeAnyway}
          <//>`)}

        ${refusal ? html`
          <${Banner} level="error"
                     title=${refusal === 'token' ? TEXT.tokenTitle : TEXT.staleTitle}
                     action=${html`
                       <${Button} disabled=${busy} onClick=${() => compareAgain()}>
                         ${TEXT.compareAgain}
                       <//>`}>
            ${refusal === 'token' ? TEXT.tokenBody : TEXT.staleBody}
          <//>` : null}

        ${holdBanner(barrier, busy)}

        ${failure ? html`<${Banner} level="error" title=${TEXT.wrong}>${failure}<//>` : null}

        ${deletions.length ? html`
          <div class="rw-sync__group">
            <div class="rw-sync__title">${TEXT.removedBy(deletions.length)}</div>
            <div class="rw-meta">${TEXT.removedBody}</div>
            ${deletions.map((item, i) => html`
              <div class="rw-sync__item" key=${'d' + i}>
                <div class="rw-sync__itemmain">
                  <div class="rw-strong rw-truncate">
                    ${item.loc ? item.loc + ' ' : ''}${item.title}
                  </div>
                  <div class="rw-meta">
                    ${item.kind === 'section'
                      ? TEXT.nSections(item.sections || 1)
                      : TEXT.nBlocks(item.blocks || 0)}
                  </div>
                </div>
                <div class="rw-sync__size">${TEXT.nBlocks(item.blocks || 0)}</div>
              </div>`)}
          </div>` : null}

        <div class="rw-merge">
          <div class="rw-merge__list">
            ${conflicts.length ? conflicts.map((item) => {
              const id = String(item.id);
              const done = !!choices[id];
              return html`
                <button
                  type="button"
                  key=${id}
                  class=${classNames('rw-merge__item', id === selected && 'rw-merge__item--on',
                                     done ? 'rw-merge__item--auto' : 'rw-merge__item--decide')}
                  onClick=${() => setSelected(id)}
                >
                  <span class="rw-dot ${done ? 'rw-dot--filled' : 'rw-dot--bad'}">
                    ${done ? '✓' : '!'}
                  </span>
                  <span class="rw-sync__itemmain">
                    <span class="rw-strong rw-truncate">
                      ${item.loc ? item.loc + ' ' : ''}${item.title || item.id}
                    </span>
                    <span class="rw-meta">${conflictDetail(item)}</span>
                  </span>
                </button>`;
            }) : html`<div class="rw-meta">${TEXT.nothingHere}</div>`}
          </div>

          <div class="rw-sync__panes">
            <div class="rw-merge__pane">
              <div class="rw-merge__panehead">
                ${TEXT.ancestor(exchangeAt ? relativeTime(exchangeAt) : TEXT.neverExchanged)}
              </div>
              <div class="rw-merge__text rw-sync__body">${conflictSide(entry, 'base')}</div>
            </div>

            <div class="rw-sync__cols">
              <div class="rw-merge__pane">
                <div class="rw-sync__colhead">
                  <span class="rw-sync__mark rw-sync__mark--mine"></span>
                  <span class="rw-merge__panehead">${TEXT.mineCol}</span>
                </div>
                <div class="rw-merge__text rw-merge__text--mine rw-sync__body">
                  ${conflictSide(entry, 'mine')}
                </div>
                <${Button} level=${current === 'mine' ? 'primary' : 'secondary'}
                           disabled=${!entry} onClick=${() => pick('mine')}>
                  ${TEXT.keepMine}
                <//>
              </div>
              <div class="rw-merge__pane">
                <div class="rw-sync__colhead">
                  <span class="rw-sync__mark rw-sync__mark--theirs"></span>
                  <span class="rw-merge__panehead">${TEXT.theirsCol}</span>
                </div>
                <div class="rw-merge__text rw-merge__text--theirs rw-sync__body">
                  ${conflictSide(entry, 'theirs')}
                </div>
                <${Button} level=${current === 'theirs' ? 'primary' : 'secondary'}
                           disabled=${!entry} onClick=${() => pick('theirs')}>
                  ${TEXT.keepTheirs}
                <//>
              </div>
            </div>

            <${Button} block=${true} level=${current === 'both' ? 'primary' : 'secondary'}
                       disabled=${!entry} onClick=${() => pick('both')}>
              ${TEXT.keepBoth}
            <//>
          </div>
        </div>
      </div>
    <//>`;
}

/* ================================================================== *
 * The history drawer
 * ================================================================== */

// Three filters, and no Trash. A deleted report is not in this report's history:
// deleting happens on the shelf, what it produces is listed on the shelf, and this
// drawer is reached from inside a report -- which is precisely the door a deleted
// report no longer opens. The chip that used to sit here rendered a hard-coded
// empty state whatever was in the trash, which is worse than not offering it.
const FILTERS = [
  { value: 'all', label: TEXT.fAll },
  { value: 'exchange', label: TEXT.fExchanges },
  { value: 'restore', label: TEXT.fRestores },
];

export function HistoryDrawer(props) {
  const dir = props.dir || (store.get().route || {}).dir || '';
  const [filter, setFilter] = useState('all');
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(true);
  const [failure, setFailure] = useState('');
  const barrier = useSaveBarrier();

  const reload = useCallback(async () => {
    if (!dir) return;
    setBusy(true);
    setFailure('');
    try {
      const answer = await api.getAutosaves(dir);
      setItems((answer && answer.autosaves) || []);
    } catch (err) {
      setFailure(errText(err));
      setItems([]);
    }
    setBusy(false);
  }, [dir]);

  useEffect(() => { reload(); }, [reload]);

  const rows = useMemo(() => items.map((snapshot) => {
    const event = eventOf(snapshot);
    return {
      name: snapshot.name,
      mtime: snapshot.mtime,
      size: snapshot.size,
      kind: event.kind,
      tag: event.tag,
      title: event.title,
    };
  }), [items]);

  const newestExchange = rows.filter((r) => r.kind === 'exchange')[0];
  const shown = filter === 'all' ? rows : rows.filter((r) => r.kind === filter);

  // The server snapshots project.json before it overwrites it, which is what
  // makes a restore undoable -- so the edits that are only in memory have to be
  // in that file first. When they cannot be, the restore does not run: it is
  // the one operation on this screen that no amount of history can undo, since
  // the snapshot it would take is a copy of the file the edit never reached.
  const runRestore = async (name) => {
    try {
      await api.autosaveRestore(dir, name);
      await refreshReport(dir);
      reload();
    } catch (err) {
      setFailure(errText(err));
    }
  };

  const restore = (name) => barrier.guard('restore', () => runRestore(name));

  const runRollBack = async () => {
    try {
      await api.rollback(dir);
      await refreshReport(dir);
      reload();
    } catch (err) {
      setFailure(errText(err));
    }
  };

  const rollBack = () => barrier.guard('rollback', runRollBack);

  return html`
    <${Drawer} title=${TEXT.history} subtitle=${TEXT.historySub}
               closeLabel=${TEXT.close} onClose=${props.onClose}>
      <div class="rw-sync">
        <div class="rw-meta">${TEXT.historyModel}</div>

        <${Chips} value=${filter} options=${FILTERS} ariaLabel=${TEXT.history}
                  onChange=${(next) => setFilter(next)} />

        ${failure ? html`
          <${Banner} level="error" title=${TEXT.wrong}
                     action=${html`<${Button} onClick=${reload}>${TEXT.retry}<//>`}>
            ${failure}
          <//>` : null}

        ${holdBanner(barrier, false)}

        ${busy ? html`<div class="rw-sync__busy"><${Spinner} /> ${TEXT.loading}</div>` : null}

        <div class="rw-timeline">
          ${shown.length ? shown.map((item) => html`
            <div class="rw-timeline__item" key=${item.name}>
              <div class="rw-timeline__when">${relativeTime(item.mtime)}</div>
              <div class="rw-timeline__body">
                <div class="rw-timeline__title">${item.title}</div>
                <div class="rw-meta">${formatBytes(item.size)}</div>
              </div>
              <${Pill} tone=${item.kind === 'exchange' ? 'note' : 'neutral'}>${item.tag}<//>
              ${newestExchange && item.name === newestExchange.name
                ? html`<${Button} level="tertiary" onClick=${rollBack}>${TEXT.rollBack}<//>`
                : html`<${Button} level="tertiary" onClick=${() => restore(item.name)}>
                         ${TEXT.restoreState}
                       <//>`}
            </div>`)
            : (busy ? null : html`<${EmptyState} title=${TEXT.nothingHere} />`)}
        </div>
      </div>
    <//>`;
}

/* ================================================================== *
 * Default export
 *
 * The editor mounts one of the two drawers. `panel` names which; when it is
 * absent the store's overlay does, so either wiring works.
 * ================================================================== */

export function Sync(props) {
  const overlay = useStore((s) => s.overlay);
  const panel = props.panel || overlay;
  if (panel === 'history') return html`<${HistoryDrawer} ...${props} />`;
  if (panel === 'exchange' || panel === 'sync') return html`<${SyncDrawer} ...${props} />`;
  return null;
}

export default Sync;
