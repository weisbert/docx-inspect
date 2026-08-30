// views/assets.js -- the asset tray that sits under the block canvas.
//
// Why this screen exists, in one line: figures only ever arrive here as files,
// and the text channel carries no pictures in either direction. When a draft
// goes out and comes back edited, a figure is referred to by its file NAME
// alone. So the tray's real job is not to look pretty -- it is to make names and
// usage visible, and to make renaming cheap and safe. The footer sentence says
// exactly that and is not decoration.
//
// Two heights, both driven by store.ui.assetsOpen:
//   collapsed  37px  Assets · counts · the three most recent thumbnails · Expand
//   expanded  236px  header (search, tag filters, Add files, Collapse)
//                    + a horizontally scrolling row of 172px cards
//                    + the footer note
//
// What it owns
//   * GET /api/assets            the file list, sizes, dimensions, tags, usage
//   * POST /api/asset-tag        tags
//   * POST /api/asset-rename     rename the file AND repoint every reference,
//                                in one server-side operation, with an Undo
//   * POST /api/asset-delete     move an UNUSED file to the report's trash;
//                                the server refuses a used one
//   * POST /api/image            storing a pasted or dropped picture
//   Images are served by api.imgUrl() from the one file route the server has.
//
// What it hands to the editor (js/views/editor.js) rather than doing itself:
//   * inserting into a block. The tray sets a drag payload and calls back;
//     the editor decides where content lands, because it owns the outline.
//
// No user-facing string is invented here: every one comes from the frozen
// string list.

import { store, useStore } from '../store.js';
import * as api from '../api.js';
import { formatBytes } from '../util.js';
import {
  Button, IconButton, SearchInput, Chips, Dialog, EmptyState, Spinner, Toast,
  html, cx, useState, useEffect, useRef, useMemo, useCallback,
} from '../components/index.js';

/* ------------------------------------------------------------------ *
 * cross-view contract
 * ------------------------------------------------------------------ */

// Payload type set on a card drag. The editor reads it with readAssetDrag()
// when something is dropped on a figure block or into prose. 'text/plain' is
// set alongside it -- carrying 'images/<name>' -- so a drop into a plain text
// field degrades to the file name rather than to nothing.
export const ASSET_DRAG_MIME = 'application/x-rw-asset';

// Fired on window after a picture is stored, so a view that is not holding the
// tray's props can still react. detail: {dir, file, source:'paste'|'drop'|'pick'}
export const ASSET_STORED_EVENT = 'rw:asset-stored';

// Fired on window by anyone who changed images/ behind the tray's back. The
// mounted tray re-reads the list.
export const ASSETS_CHANGED_EVENT = 'rw:assets-changed';

export function notifyAssetsChanged() {
  try {
    window.dispatchEvent(new CustomEvent(ASSETS_CHANGED_EVENT));
  } catch (err) {
    /* a browser without CustomEvent simply keeps the list it has */
  }
}

// Read a card drag payload. Returns {file, name, w, h} or null.
export function readAssetDrag(ev) {
  const dt = ev && (ev.dataTransfer || (ev.originalEvent && ev.originalEvent.dataTransfer));
  if (!dt) return null;
  let raw = '';
  try {
    raw = dt.getData(ASSET_DRAG_MIME) || '';
  } catch (err) {
    raw = '';
  }
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.file) return parsed;
    } catch (err) {
      /* fall through to the plain-text form */
    }
  }
  let text = '';
  try {
    text = dt.getData('text/plain') || '';
  } catch (err) {
    text = '';
  }
  const rel = normaliseAssetPath(text);
  return rel ? { file: rel, name: baseName(rel), w: null, h: null } : null;
}

/* ------------------------------------------------------------------ *
 * paths
 * ------------------------------------------------------------------ */

// An image must live in the project's images/ directory and be referenced as
// 'images/<name>'. This is enforced at the point of insertion, not at export
// time: content_lint already errors on a path outside images/, and the tray must
// never be able to create that state. Anything else returns null.
export function normaliseAssetPath(value) {
  const raw = String(value == null ? '' : value).replace(/\\/g, '/').trim();
  if (!raw) return null;
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return null;
  const parts = raw.split('/').filter((p) => p !== '');
  if (parts.length && parts[0].toLowerCase() === 'images') parts.shift();
  if (parts.length !== 1) return null;
  const base = parts[0];
  if (base === '.' || base === '..') return null;
  return 'images/' + base;
}

function baseName(rel) {
  const parts = String(rel || '').split('/');
  return parts[parts.length - 1] || '';
}

/* ------------------------------------------------------------------ *
 * flushing before a server-side rewrite
 * ------------------------------------------------------------------ */

// A rename rewrites every reference in the project.json ON DISK and this view
// then re-reads it; a delete decides whether the file is still pointed at by
// reading that same file. Neither is a question the file can answer while a
// newer document sits unsaved in this window: a rename judged against a stale
// file repoints the references that file happens to hold and the re-read then
// throws the unsaved ones away, which is how a figure ends up pointing at
// nothing. So the disk is made current FIRST, and the verdict is honoured.
//
// -> true when the disk now holds what the screen shows, false when it does
// not. Every way saveNow can report a failure is treated as one: a rejection,
// an explicit failure it resolves with, and the document still being dirty
// afterwards, which is the ground truth whichever of the two it chose. A store
// too old to have the method saves nothing and owes nothing, so it answers true
// rather than blocking the control.
//
// This is the same helper, word for word, that the exchange screen and the
// export flush with. All three make the same promise, so all three keep the
// same contract.
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

// What the tray says when it will not run one of those two operations. The
// exchange screen names its own refusal the same way -- what did not happen,
// then why, then what makes it possible again -- because they are the same
// fact wearing two verbs.
// There is deliberately no "do it anyway" here, unlike the export and the
// exchange screen's restart: going ahead would repoint the references a stale
// file happens to hold, and the re-read that follows would drop the ones that
// were only in this window. That is not a cost the user can weigh, so it is
// not offered. Retry is the only way through, and it is the save loop's job.
const HELD = {
  rename: {
    title: 'Not renamed — this report is not saved',
    body: 'Renaming rewrites every reference to the file in the report, so it only runs '
      + 'against a report file that holds what the screen shows. The save keeps retrying; '
      + 'rename once it reports Saved.',
  },
  delete: {
    title: 'Not deleted — this report is not saved',
    body: 'Deleting is refused for a file the report still points at, and that is read from '
      + 'the report file, so it only runs against one that holds what the screen shows. The '
      + 'save keeps retrying; delete once it reports Saved.',
  },
};

// Middle truncation, done in markup rather than with an ellipsis, so the
// extension always stays on screen: '4_1_waveform_div8.png' shows as
// '4_1_wavefo…8.png' instead of losing the '.png' that names the file.
// The two halves are rendered as adjacent spans with NO whitespace between them
// in the template -- a newline there becomes a real space inside the file name.
function splitForTruncation(name) {
  const text = String(name || '');
  const dot = text.lastIndexOf('.');
  const ext = dot > 0 ? text.slice(dot) : '';
  const tailLen = Math.min(text.length, ext.length + 2);
  return { head: text.slice(0, text.length - tailLen), tail: text.slice(text.length - tailLen) };
}

/* ------------------------------------------------------------------ *
 * usage -- derived, never stored
 * ------------------------------------------------------------------ */

// Mirrors store/assets_store.py :: usage_map(). It is recomputed here, from the
// live in-memory document, so a figure added a moment ago and not yet flushed
// still counts as a use. It is NOT allowed to decide that a file is unused --
// see decorateAssets below for why that direction is unsafe.
//
// The section number is the 1-based index path of the outline node ('4.1'),
// which is how every heading is numbered in the rendered document.
//
// Returns Map<'images/<name>', [{section, title, node, block}]> in document
// order, one entry per use, so a file placed twice lists twice.
export function computeAssetUsage(project) {
  const map = new Map();

  const walk = (nodes, prefix) => {
    const list = nodes || [];
    for (let i = 0; i < list.length; i++) {
      const node = list[i];
      if (!node || typeof node !== 'object') continue;
      const num = prefix.concat([String(i + 1)]);
      const section = num.join('.');
      const blocks = node.blocks || [];
      for (let b = 0; b < blocks.length; b++) {
        const block = blocks[b];
        if (!block || typeof block !== 'object') continue;
        let files = null;
        if (block.type === 'image') files = [block.file];
        else if (block.type === 'imagegrid') {
          files = (block.items || []).map((it) => (it && it.file) || '');
        } else continue;
        for (let f = 0; f < files.length; f++) {
          const rel = normaliseAssetPath(files[f]);
          if (!rel) continue;
          if (!map.has(rel)) map.set(rel, []);
          map.get(rel).push({
            section: section,
            title: node.title || '',
            node: node.id || '',
            block: block.id || '',
          });
        }
      }
      walk(node.children, num);
    }
  };

  walk((project || {}).outline, []);
  return map;
}

// The section number a node sits at, used to name a newly stored file the way
// the rest of the pool is named. '0' when the node cannot be found.
function sectionNumberFor(project, nodeId) {
  if (!nodeId) return '0';
  let found = '';
  const walk = (nodes, prefix) => {
    const list = nodes || [];
    for (let i = 0; i < list.length && !found; i++) {
      const node = list[i];
      if (!node || typeof node !== 'object') continue;
      const num = prefix.concat([String(i + 1)]);
      if (node.id === nodeId) {
        found = num.join('.');
        return;
      }
      walk(node.children, num);
    }
  };
  walk((project || {}).outline, []);
  return found || '0';
}

/* ------------------------------------------------------------------ *
 * storing a picture
 * ------------------------------------------------------------------ */

// The server's image route accepts PNG only, so anything else is re-encoded in
// the browser before it is sent. That keeps one rule on disk (every stored file
// is a PNG under images/) instead of two.
async function toPngBlob(file) {
  if (file && file.type === 'image/png') return file;
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  if (bitmap.close) bitmap.close();
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((out) => (out ? resolve(out) : reject(new Error('the picture could not be read'))), 'image/png');
  });
  return blob;
}

function isImageFile(file) {
  return !!file && typeof file.type === 'string' && file.type.indexOf('image/') === 0;
}

// Pull the image files out of a clipboard or drag payload.
function imageFilesFrom(dataTransfer) {
  const out = [];
  if (!dataTransfer) return out;
  const files = dataTransfer.files;
  if (files && files.length) {
    for (let i = 0; i < files.length; i++) if (isImageFile(files[i])) out.push(files[i]);
    if (out.length) return out;
  }
  const items = dataTransfer.items;
  if (items && items.length) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item && item.kind === 'file') {
        const file = item.getAsFile();
        if (isImageFile(file)) out.push(file);
      }
    }
  }
  return out;
}

// Store one or more pictures into <report>/images/ and return the stored paths.
// Exported so the editor can reuse the exact same path for a drop on a figure
// card, rather than growing a second one that names files differently.
export async function storeImageFiles(dir, files, options) {
  const opt = options || {};
  const stored = [];
  const list = Array.prototype.slice.call(files || []);
  for (let i = 0; i < list.length; i++) {
    const file = list[i];
    if (!isImageFile(file)) continue;
    const png = await toPngBlob(file);
    const stem = String(file.name || '').replace(/\.[^.]+$/, '');
    const answer = await api.putImage(dir, opt.section == null ? '0' : opt.section, stem || null, png);
    const rel = normaliseAssetPath(answer && answer.file);
    if (rel) stored.push(rel);
  }
  return stored;
}

/* ------------------------------------------------------------------ *
 * usage: pairing the list with a document
 * ------------------------------------------------------------------ */

// Decide, per file, where it is used and whether it is unused at all.
//
// There are two sources and they are NOT interchangeable:
//
//   asset.uses   comes back with GET /api/assets. The server derived it from
//                the project.json of the very report whose images/ it scanned,
//                so the pair (file list, usage) is always internally coherent.
//   live         is computed here from the document in memory. That document
//                belongs to whatever report the editor last loaded, which
//                during a report switch is still the PREVIOUS one.
//
// So the rule is asymmetric, and deliberately so: the server's answer decides
// whether a file is unused, and the live document may only ADD uses (a figure
// inserted a moment ago and not yet saved). A stale document can then make a
// file look used when it is free -- harmless, the delete control simply stays
// hidden -- but it can never make a file that IS in use look unused, which is
// what previously offered a destructive control on every card of a report the
// tray had not finished switching to.
//
// `uses` prefers the server's list when it has one, because its section numbers
// belong to the same report as the files being listed.
export function decorateAssets(assets, project) {
  const live = computeAssetUsage(project);
  return (assets || []).map((a) => {
    const reported = Array.isArray(a.uses) ? a.uses : [];
    const here = live.get(a.file) || [];
    return Object.assign({}, a, {
      uses: reported.length ? reported : here,
      unused: reported.length === 0 && here.length === 0,
    });
  });
}

/* ------------------------------------------------------------------ *
 * the tray
 * ------------------------------------------------------------------ */

const TAG_LIMIT = 24;

function matches(asset, query, tags) {
  if (tags.length) {
    const own = (asset.tags || []).map((t) => String(t).toLowerCase());
    for (let i = 0; i < tags.length; i++) {
      if (own.indexOf(String(tags[i]).toLowerCase()) === -1) return false;
    }
  }
  if (!query) return true;
  const needle = query.toLowerCase();
  if (baseName(asset.file).toLowerCase().indexOf(needle) !== -1) return true;
  const own = asset.tags || [];
  for (let i = 0; i < own.length; i++) {
    if (String(own[i]).toLowerCase().indexOf(needle) !== -1) return true;
  }
  return false;
}

export function AssetTray(props) {
  const opts = props || {};
  const routeDir = useStore((s) => s.route && s.route.dir);
  const routeNode = useStore((s) => s.route && s.route.node);
  const storeProject = useStore((s) => s.project);
  const savedAt = useStore((s) => s.savedAt);
  const ui = useStore((s) => s.ui);

  const dir = opts.dir || routeDir || null;
  const project = opts.project === undefined ? storeProject : opts.project;
  const open = opts.open === undefined ? !!(ui && ui.assetsOpen) : !!opts.open;

  const [assets, setAssets] = useState([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [tagFilter, setTagFilter] = useState([]);
  const [renaming, setRenaming] = useState(null);   // {file, draft}
  const [tagging, setTagging] = useState(null);     // {file, draft}
  const [confirmDelete, setConfirmDelete] = useState(null);  // the asset, once asked about
  const [held, setHeld] = useState(null);           // 'rename' | 'delete', when the disk is behind
  const [dragOver, setDragOver] = useState(false);
  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState('');

  const pickerRef = useRef(null);
  const stripRef = useRef(null);
  const liveRef = useRef({ dir: dir, node: routeNode, onFill: opts.onFill });
  liveRef.current = { dir: dir, node: routeNode, onFill: opts.onFill };

  /* ---- loading ------------------------------------------------------ */

  const reload = useCallback(async (target) => {
    const where = target || liveRef.current.dir;
    if (!where) {
      setAssets([]);
      return;
    }
    setLoading(true);
    try {
      const payload = await api.getAssets(where);
      const list = (payload && payload.assets) || [];
      if (liveRef.current.dir === where) setAssets(list);
    } catch (err) {
      store.pushBanner({ level: 'error', code: 'assets', message: err && err.message ? err.message : String(err) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setQuery('');
    setTagFilter([]);
    setRenaming(null);
    setTagging(null);
    setConfirmDelete(null);
    setHeld(null);
    // The old report's files are dropped before the new report's arrive. Holding
    // them for the length of one fetch would show cards whose thumbnails 404 and
    // whose usage belongs to a document that is no longer on screen.
    setAssets([]);
    reload(dir);
  }, [dir]);

  useEffect(() => {
    const onChanged = () => reload();
    window.addEventListener(ASSETS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(ASSETS_CHANGED_EVENT, onChanged);
  }, []);

  // The server's usage is read from project.json on disk, so it lags by exactly
  // one autosave. Re-reading the list whenever a save lands keeps "unused" from
  // staying stale after the user removes the last figure block that used a file.
  const firstSave = useRef(true);
  useEffect(() => {
    if (firstSave.current) { firstSave.current = false; return; }
    if (liveRef.current.dir) reload(liveRef.current.dir);
  }, [savedAt]);

  /* ---- storing: paste anywhere, drop anywhere ----------------------- */

  const intake = useCallback(async (files, source) => {
    const where = liveRef.current.dir;
    if (!where || !files.length) return;
    setBusy(source);
    try {
      const section = sectionNumberFor(store.get().project, liveRef.current.node);
      const stored = await storeImageFiles(where, files, { section: section });
      if (!stored.length) return;
      await reload(where);
      // The caret may be sitting in an empty figure block; the editor owns that
      // decision, so it is told and left to make it.
      const fill = liveRef.current.onFill;
      if (typeof fill === 'function') fill(stored[0], { source: source });
      for (let i = 0; i < stored.length; i++) {
        try {
          window.dispatchEvent(new CustomEvent(ASSET_STORED_EVENT, {
            detail: { dir: where, file: stored[i], source: source },
          }));
        } catch (err) {
          /* the tray has already refreshed; the event is a courtesy */
        }
      }
      setToast({ text: 'Stored in images/' });
    } catch (err) {
      store.pushBanner({ level: 'error', code: 'asset-store', message: err && err.message ? err.message : String(err) });
    } finally {
      setBusy('');
    }
  }, [reload]);

  useEffect(() => {
    const onPaste = (ev) => {
      if (!liveRef.current.dir) return;
      const files = imageFilesFrom(ev.clipboardData);
      if (!files.length) return;         // plain text paste is none of our business
      ev.preventDefault();
      intake(files, 'paste');
    };
    const onDragOver = (ev) => {
      if (!liveRef.current.dir) return;
      const dt = ev.dataTransfer;
      if (!dt || !dt.types || Array.prototype.indexOf.call(dt.types, 'Files') === -1) return;
      ev.preventDefault();
      dt.dropEffect = 'copy';
    };
    const onDrop = (ev) => {
      // A card or a figure block that handled the drop itself has already called
      // preventDefault; the tray only picks up what nothing else claimed.
      if (ev.defaultPrevented || !liveRef.current.dir) return;
      const files = imageFilesFrom(ev.dataTransfer);
      if (!files.length) return;
      ev.preventDefault();
      setDragOver(false);
      intake(files, 'drop');
    };
    document.addEventListener('paste', onPaste);
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('drop', onDrop);
    return () => {
      document.removeEventListener('paste', onPaste);
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('drop', onDrop);
    };
  }, [intake]);

  /* ---- refreshing the document after a server-side rewrite ---------- */

  // asset-rename rewrites project.json on disk. Re-read it rather than leaving
  // the in-memory copy pointing at a file name that no longer exists -- and do
  // it with setProject, which does NOT mark the document dirty, because the copy
  // on disk is already the one being shown.
  const refreshProject = useCallback(async (where) => {
    try {
      const payload = await api.getProject(where);
      const doc = payload && payload.project ? payload.project : payload;
      store.setProject(doc, (payload && payload.meta_info) || {});
    } catch (err) {
      store.pushBanner({ level: 'error', code: 'project', message: err && err.message ? err.message : String(err) });
    }
  }, []);

  /* ---- rename ------------------------------------------------------- */

  const commitRename = useCallback(async (asset, nextName) => {
    const where = liveRef.current.dir;
    setRenaming(null);
    const wanted = String(nextName || '').trim();
    if (!where || !wanted || wanted === baseName(asset.file)) return;
    // The rename rewrites project.json server-side and this view then re-reads
    // it, so anything the autosave loop still owes has to reach disk FIRST or
    // the re-read would quietly throw those edits away. When it cannot get
    // there, the rename does not run: it is named and left to the user, rather
    // than repointing the references of a file that is already behind.
    if (!(await flushEdits())) {
      setHeld({ op: 'rename', retry: () => commitRename(asset, wanted) });
      return;
    }
    try {
      // One operation: the file on disk and every reference to it move together.
      // Doing them as two calls is exactly how a figure ends up pointing at
      // nothing. A collision gets a numeric suffix, server side.
      const answer = await api.assetRename(where, asset.file, wanted);
      const landed = normaliseAssetPath(answer && answer.file) || asset.file;
      await refreshProject(where);
      await reload(where);
      // Undo is a rename in the other direction, held back for the same reason,
      // and named so its own retry can re-enter it.
      const undoRename = async () => {
        setToast(null);
        if (!(await flushEdits())) {
          setHeld({ op: 'rename', retry: undoRename });
          return;
        }
        try {
          await api.assetRename(where, landed, baseName(asset.file));
          await refreshProject(where);
          await reload(where);
        } catch (err) {
          store.pushBanner({ level: 'error', code: 'asset-rename', message: err && err.message ? err.message : String(err) });
        }
      };
      setToast({
        text: 'Renamed to ' + baseName(landed),
        action: 'Undo',
        onAction: undoRename,
      });
    } catch (err) {
      store.pushBanner({ level: 'error', code: 'asset-rename', message: err && err.message ? err.message : String(err) });
    }
  }, [reload, refreshProject]);

  /* ---- tags --------------------------------------------------------- */

  const writeTags = useCallback(async (asset, tags) => {
    const where = liveRef.current.dir;
    if (!where) return;
    const next = tags.slice(0, TAG_LIMIT);
    setAssets((list) => list.map((a) => (a.file === asset.file ? Object.assign({}, a, { tags: next }) : a)));
    try {
      await api.assetTag(where, asset.file, next);
    } catch (err) {
      store.pushBanner({ level: 'error', code: 'asset-tag', message: err && err.message ? err.message : String(err) });
      reload(where);
    }
  }, [reload]);

  /* ---- delete ------------------------------------------------------- */

  // Deleting takes three separate agreements, because a lost figure cannot be
  // recovered from the text channel -- the assistant never had the picture:
  //   1. the card offers the control only when this report says the file is
  //      unused (decorateAssets: the server's answer decides that, not a
  //      document that may belong to another report);
  //   2. the user confirms a dialog naming the file;
  //   3. the server checks usage again against project.json and refuses a file
  //      that is still pointed at, whatever the browser believed.
  // Anything pending is flushed first, so step 3 judges the report as edited
  // rather than as last saved -- and when the flush cannot get there, step 3
  // would be judging a file that is already behind, so the delete does not run
  // at all. It is named, the way the rename above is named.
  const removeAsset = useCallback(async (asset) => {
    const where = liveRef.current.dir;
    setConfirmDelete(null);
    if (!where || !asset) return;
    if (!(await flushEdits())) {
      setHeld({ op: 'delete', retry: () => removeAsset(asset) });
      return;
    }
    try {
      await api.request('POST', '/api/asset-delete', { body: { dir: where, file: asset.file } });
      await reload(where);
      setToast({ text: 'Moved ' + baseName(asset.file) + ' to the trash' });
    } catch (err) {
      store.pushBanner({ level: 'error', code: 'asset-delete', message: err && err.message ? err.message : String(err) });
      // Whatever the refusal was, the list on screen is now the suspect one.
      reload(where);
    }
  }, [reload]);

  /* ---- derived ------------------------------------------------------ */

  const decorated = useMemo(() => decorateAssets(assets, project), [assets, project]);

  const tagOptions = useMemo(() => {
    const counts = new Map();
    for (let i = 0; i < decorated.length; i++) {
      const own = decorated[i].tags || [];
      for (let t = 0; t < own.length; t++) {
        const tag = String(own[t]);
        counts.set(tag, (counts.get(tag) || 0) + 1);
      }
    }
    return Array.from(counts.keys()).sort().map((tag) => ({ value: tag, label: tag, count: counts.get(tag) }));
  }, [decorated]);

  const shown = useMemo(
    () => decorated.filter((a) => matches(a, query.trim(), tagFilter)),
    [decorated, query, tagFilter]
  );

  const unusedCount = decorated.reduce((n, a) => n + (a.unused ? 1 : 0), 0);
  const countLine = decorated.length + ' files · ' + unusedCount + ' unused';

  /* ---- handlers ----------------------------------------------------- */

  const toggle = () => {
    if (typeof opts.onToggle === 'function') opts.onToggle(!open);
    else store.setUi({ assetsOpen: !open });
  };

  const pickFiles = (ev) => {
    const files = imageFilesFrom({ files: ev.currentTarget.files });
    ev.currentTarget.value = '';
    if (files.length) intake(files, 'pick');
  };

  const jumpTo = (use) => {
    if (!dir || !use || !use.node) return;
    store.navigate({ view: 'editor', dir: dir, node: use.node });
  };

  const dragStart = (asset, ev) => {
    const dt = ev.dataTransfer;
    if (!dt) return;
    try {
      dt.setData(ASSET_DRAG_MIME, JSON.stringify({
        file: asset.file, name: baseName(asset.file), w: asset.w, h: asset.h,
      }));
      dt.setData('text/plain', asset.file);
    } catch (err) {
      /* a browser that refuses a custom type still carries the text form */
    }
    dt.effectAllowed = 'copy';
    if (typeof opts.onDragAsset === 'function') opts.onDragAsset(asset);
  };

  // A horizontal strip with a vertical wheel is a dead end on a trackpad-less
  // desktop, so a plain wheel scrolls it sideways.
  const wheel = (ev) => {
    const el = stripRef.current;
    if (!el || ev.deltaY === 0 || ev.shiftKey) return;
    if (el.scrollWidth <= el.clientWidth) return;
    el.scrollLeft += ev.deltaY;
    ev.preventDefault();
  };

  if (!dir) return null;

  const picker = html`
    <input ref=${pickerRef} type="file" accept="image/*" multiple hidden onChange=${pickFiles} />`;

  const toastNode = toast ? html`
    <${Toast}
      text=${toast.text}
      action=${toast.action || null}
      onAction=${toast.onAction || null}
      onDismiss=${() => setToast(null)}
    />` : null;

  // Naming the file in the confirmation is the whole point of it: the cards are
  // 172px wide and their names are middle-truncated, so "the one I clicked" is
  // not a thing the user can be sure of until it is spelled out.
  const confirmNode = confirmDelete ? html`
    <${Dialog}
      title="Delete file"
      width=${420}
      onClose=${() => setConfirmDelete(null)}
      footer=${html`
        <${Button} onClick=${() => setConfirmDelete(null)}>Cancel<//>
        <${Button} level="danger" onClick=${() => removeAsset(confirmDelete)}>Move to trash<//>`}
    >
      <div>This moves ${baseName(confirmDelete.file)} to the trash. Nothing in this report points at it.</div>
    <//>` : null;

  // A refusal has to be as visible as the thing it refused. The cards are
  // 172px wide and the tray can be collapsed to a 37px strip, so there is
  // nowhere in it a message would reliably be read -- and "Something went
  // wrong" over the save loop's own sentence is not the same fact as "the
  // rename did not happen". This says which operation did not run, why, and
  // what makes it possible again.
  const heldNode = held && HELD[held.op] ? html`
    <${Dialog}
      title=${HELD[held.op].title}
      width=${460}
      onClose=${() => setHeld(null)}
      footer=${html`
        <${Button} onClick=${() => { setHeld(null); if (held.retry) held.retry(); }}>Retry<//>
        <${Button} onClick=${() => setHeld(null)}>Close<//>`}
    >
      <div>${HELD[held.op].body}</div>
    <//>` : null;

  /* ---- collapsed ---------------------------------------------------- */

  if (!open) {
    const recent = decorated.slice(0, 3);
    return html`
      <div class="rw-assets">
        <div class="rw-assets__bar">
          <span class="rw-assets__label">Assets</span>
          <span class="rw-assets__count">${countLine}</span>
          <div class="rw-assets__thumbs">
            ${recent.map((a) => html`
              <img class="rw-assets__mini" key=${a.file} src=${api.imgUrl(dir, a.file, a.added)}
                   alt=${baseName(a.file)} title=${baseName(a.file)} />`)}
          </div>
          <span class="rw-assets__grow rw-assets__hint">
            Drag onto a figure block or into the text to insert · Ctrl+V stores directly
          </span>
          ${busy ? html`<${Spinner} />` : null}
          <${Button} level="tertiary" glyph="⌃" onClick=${toggle}>Expand<//>
        </div>
        ${picker}
        ${toastNode}
        ${confirmNode}
        ${heldNode}
      </div>`;
  }

  /* ---- expanded ----------------------------------------------------- */

  const emptyPool = html`
    <${EmptyState}
      className="rw-assets__empty"
      compact=${true}
      title="Nothing here yet"
      body="Paste a screenshot with Ctrl+V, or drop a file"
      onDrop=${(ev) => {
        const files = imageFilesFrom(ev.dataTransfer);
        if (files.length) intake(files, 'drop');
      }}
    />`;

  const emptySearch = html`
    <${EmptyState} className="rw-assets__empty" compact=${true} title="No results">
      <${Button} level="tertiary" onClick=${() => { setQuery(''); setTagFilter([]); }}>Clear the search<//>
    <//>`;

  return html`
    <div class=${cx('rw-assets', dragOver && 'rw-assets--over')}
         onDragEnter=${(ev) => {
           const dt = ev.dataTransfer;
           if (dt && dt.types && Array.prototype.indexOf.call(dt.types, 'Files') !== -1) setDragOver(true);
         }}
         onDragLeave=${(ev) => { if (ev.currentTarget === ev.target) setDragOver(false); }}
         onDrop=${() => setDragOver(false)}>
      <div class="rw-assets__panel">
        <div class="rw-assets__head">
          <span class="rw-assets__label">Assets</span>
          <span class="rw-assets__count">${countLine}</span>
          <div class="rw-assets__search">
            <${SearchInput}
              small=${true}
              value=${query}
              placeholder="Search by file name or tag"
              onInput=${(text) => setQuery(text)}
            />
          </div>
          <div class="rw-assets__filters">
            <${Chips} multi=${true} value=${tagFilter} options=${tagOptions}
                      onChange=${(next) => setTagFilter(next)} />
          </div>
          <span class="rw-assets__grow"></span>
          ${loading || busy ? html`<${Spinner} />` : null}
          <${Button} level="secondary" glyph="+"
                     onClick=${() => pickerRef.current && pickerRef.current.click()}>Add files<//>
          <${Button} level="tertiary" glyph="⌄" onClick=${toggle}>Collapse<//>
        </div>

        <div class="rw-assets__strip" ref=${stripRef} onWheel=${wheel}>
          ${decorated.length === 0
            ? (loading ? html`<div class="rw-assets__empty rw-assets__loading">Loading…</div>` : emptyPool)
            : (shown.length === 0
              ? emptySearch
              : shown.map((asset) => html`
                  <${AssetCard}
                    key=${asset.file}
                    dir=${dir}
                    asset=${asset}
                    renaming=${renaming && renaming.file === asset.file ? renaming : null}
                    tagging=${tagging && tagging.file === asset.file ? tagging : null}
                    onRenameStart=${() => setRenaming({ file: asset.file, draft: baseName(asset.file) })}
                    onRenameDraft=${(text) => setRenaming({ file: asset.file, draft: text })}
                    onRenameCancel=${() => setRenaming(null)}
                    onRenameCommit=${(text) => commitRename(asset, text)}
                    onTagStart=${() => setTagging({ file: asset.file, draft: '' })}
                    onTagDraft=${(text) => setTagging({ file: asset.file, draft: text })}
                    onTagCancel=${() => setTagging(null)}
                    onTagCommit=${(text) => {
                      setTagging(null);
                      const tag = String(text || '').trim();
                      if (!tag) return;
                      const own = asset.tags || [];
                      if (own.some((t) => String(t).toLowerCase() === tag.toLowerCase())) return;
                      writeTags(asset, own.concat([tag]));
                    }}
                    onTagRemove=${(tag) => writeTags(asset, (asset.tags || []).filter((t) => t !== tag))}
                    onJump=${jumpTo}
                    onDelete=${() => { if (asset.unused) setConfirmDelete(asset); }}
                    onDragStart=${(ev) => dragStart(asset, ev)}
                  />`))}
        </div>

        <div class="rw-assets__note">
          The assistant cannot see images — it refers to them by file name, so a clear name is
          what keeps a returned draft pointing at the right figure
        </div>
      </div>
      ${picker}
      ${toastNode}
      ${confirmNode}
      ${heldNode}
    </div>`;
}

/* ------------------------------------------------------------------ *
 * one card
 * ------------------------------------------------------------------ */

function AssetCard(props) {
  const {
    dir, asset, renaming, tagging,
    onRenameStart, onRenameDraft, onRenameCancel, onRenameCommit,
    onTagStart, onTagDraft, onTagCancel, onTagCommit, onTagRemove,
    onJump, onDelete, onDragStart,
  } = props;

  const name = baseName(asset.file);
  const parts = splitForTruncation(name);
  const uses = asset.uses || [];
  const sections = [];
  for (let i = 0; i < uses.length; i++) {
    if (sections.indexOf(uses[i].section) === -1) sections.push(uses[i].section);
  }
  const dims = asset.w && asset.h ? asset.w + ' × ' + asset.h + ' · ' : '';

  // One flat array of keyed children. Nested arrays holding a conditional null
  // beside a keyed element are what makes preact lose track of a node when a
  // newly stored file is inserted at the head of the card list.
  const usageNodes = [];
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    if (i) usageNodes.push(html`<span key=${'sep-' + section}>, </span>`);
    usageNodes.push(html`
      <button type="button" class="rw-asset__link" key=${'use-' + section}
              onClick=${() => onJump(uses.filter((u) => u.section === section)[0])}
      >${section}</button>`);
  }

  // An inline editor commits on Enter and on blur, and Enter removes the input,
  // which fires blur straight after -- so without this the same rename is posted
  // twice, and the second one refers to a file that no longer exists.
  const renameInput = useRef(null);
  const renameDone = useRef(false);
  useEffect(() => {
    if (renaming && renameInput.current) {
      renameDone.current = false;
      renameInput.current.focus();
      renameInput.current.select();
    }
  }, [!!renaming]);

  const tagInput = useRef(null);
  const tagDone = useRef(false);
  useEffect(() => {
    if (tagging && tagInput.current) {
      tagDone.current = false;
      tagInput.current.focus();
    }
  }, [!!tagging]);

  return html`
    <div class="rw-asset" draggable=${true} onDragStart=${onDragStart} title=${name}>
      <div class="rw-asset__thumbwrap">
        <img class="rw-asset__thumb" src=${api.imgUrl(dir, asset.file, asset.added)} alt=${name} draggable=${false} />
        ${asset.unused
          ? html`<span class="rw-asset__use rw-asset__use--unused">Not used yet</span>`
          : html`<span class="rw-asset__use">Used in ${sections[0]}</span>`}
      </div>

      ${renaming ? html`
        <input
          ref=${renameInput}
          class="rw-asset__rename"
          value=${renaming.draft}
          aria-label="Rename"
          onInput=${(ev) => onRenameDraft(ev.currentTarget.value)}
          onKeyDown=${(ev) => {
            if (ev.key === 'Enter') {
              ev.preventDefault();
              renameDone.current = true;
              onRenameCommit(ev.currentTarget.value);
            } else if (ev.key === 'Escape') {
              ev.preventDefault();
              renameDone.current = true;
              onRenameCancel();
            }
          }}
          onBlur=${(ev) => { if (!renameDone.current) { renameDone.current = true; onRenameCommit(ev.currentTarget.value); } }}
        />`
        : html`
        <div class="rw-asset__name">
          <span class="rw-asset__namehead">${parts.head}</span><span class="rw-asset__nametail">${parts.tail}</span>
          <span class="rw-asset__tools">
            <${IconButton} glyph="✎" small=${true} title="Rename" onClick=${onRenameStart} />
            ${asset.unused ? html`
              <${IconButton} glyph="✕" small=${true} danger=${true}
                             title="Only a file nothing points at can be deleted"
                             onClick=${onDelete} />` : null}
          </span>
        </div>`}

      <div class="rw-asset__meta">${dims}${formatBytes(asset.bytes)}</div>

      <div class="rw-asset__tags">
        <span class="rw-asset__taglist">
          ${(asset.tags || []).map((tag) => html`
            <span class="rw-chip" key=${tag}>
              ${tag}
              <span class="rw-chip__x" role="button" title="Close"
                    onClick=${() => onTagRemove(tag)}>✕</span>
            </span>`)}
        </span>
        ${tagging ? html`
          <input
            ref=${tagInput}
            class="rw-asset__taginput"
            value=${tagging.draft}
            aria-label="Add a tag"
            onInput=${(ev) => onTagDraft(ev.currentTarget.value)}
            onKeyDown=${(ev) => {
              if (ev.key === 'Enter') {
                ev.preventDefault();
                tagDone.current = true;
                onTagCommit(ev.currentTarget.value);
              } else if (ev.key === 'Escape') {
                ev.preventDefault();
                tagDone.current = true;
                onTagCancel();
              }
            }}
            onBlur=${(ev) => { if (!tagDone.current) { tagDone.current = true; onTagCommit(ev.currentTarget.value); } }}
          />`
          : html`<button type="button" class="rw-chip rw-chip--add" onClick=${onTagStart}>+ Add a tag</button>`}
      </div>

      <div class="rw-asset__usageline">
        ${asset.unused ? null : html`<span>Used in </span>`}
        ${usageNodes}
      </div>
    </div>`;
}

export default AssetTray;
