/*
 * Report Workbench v2 - the block cards.
 *
 * Owner of every block CARD in the editor's centre column: the prose card, the
 * figure card, the figure grid card, the chrome around a table card, and the
 * cover form. The table BODY belongs to js/views/table.js and is imported
 * defensively - a missing module degrades to a placeholder, it never breaks
 * the card.
 *
 * There is exactly ONE canvas and js/views/editor.js draws it. This file draws
 * no canvas of its own: it publishes BlockCard, which editor.js puts in each
 * slot, plus the pure card rules editor.js calls (moveCardBySpan). A second
 * canvas here would mean every fix had to be remembered twice.
 *
 * What this file does NOT own: the editor frame, the insert seams, the outline
 * rail, the section bar, the format toolbar and the right panel
 * (js/views/editor.js), the grid itself (js/views/table.js), the asset tray
 * (js/views/assets.js).
 *
 * Persistence rule, from the front-end contract: a view never fetches or PUTs
 * project.json. It mutates store.project in place and commits through the one
 * helper below, commitEdit(), which bumps the store revision; store.js debounces
 * the save and the server keeps its own rolling snapshot. An in-place mutation
 * that does not commit is invisible to the save loop -- see commitEdit().
 *
 * Every user-facing string in this file is a verbatim entry of the frozen
 * string list. None is composed at the call site beyond the {n} substitutions
 * the list itself defines.
 *
 * CSS: no class is introduced here. Everything composes from what css/app.css
 * already defines - .rw-canvas, .rw-card, .rw-prose, .rw-figure,
 * .rw-figgrid, .rw-caption, .rw-numchip, .rw-ref, .rw-drop, .rw-empty,
 * .rw-input, .rw-select, .rw-field, .rw-formgrid, .rw-menu - plus inline
 * geometry where the spec names an exact pixel width.
 */

import { store, useStore } from '../store.js';
import * as api from '../api.js';
import { computeCaptionNumbers, groupBlocks } from '../util.js';
import { Button, IconButton, Field, Banner, Dialog } from '../components/index.js';

const preact = globalThis.preact;
const preactHooks = globalThis.preactHooks;
const html = globalThis.htm.bind(preact.h);
const Fragment = preact.Fragment;
const { useState, useEffect, useLayoutEffect, useRef, useMemo } = preactHooks;

/* ------------------------------------------------------------------ *
 * Frozen strings
 *
 * One table, so a reader can check the whole view against the glossary
 * without reading the code. The functions are the {n} forms.
 * ------------------------------------------------------------------ */

const T = {
  prose: 'Prose',
  figure: 'Figure',
  figureGrid: 'Figure grid',
  table: 'Table',
  complianceTable: 'Compliance table',
  paragraphs: (n) => n + ' paragraphs',
  width: (n) => 'Width ' + n + ' cm',
  columns: 'Columns',
  replace: 'Replace',
  caption: 'Caption',
  addCaption: 'Add a caption',
  subCaption: 'Sub-caption',
  subCaptions: 'Sub-captions',
  moveUp: 'Move up',
  moveDown: 'Move down',
  duplicate: 'Duplicate',
  deleteBlock: 'Delete block',
  dropHint: 'Paste a screenshot with Ctrl+V, or drop a file',
  storedIn: 'Stored in images/',
  crossReference: 'Cross-reference',
  pickTarget: 'Pick a figure or table to point at',
  exportXlsx: 'Export .xlsx',
  editingMarks: 'Editing marks',
  more: 'More',
  close: 'Close',
  fixedTemplateText: 'Fixed template text',
  figuresAndColumns: (n, cols) => n + ' figures · ' + cols + ' columns',
  tableShape: (cols, rows) => cols + ' columns × ' + rows + ' rows',
  notAvailable: 'This screen is not available yet',
  nothingHere: 'Nothing here yet',
  /* cover and metadata */
  documentInformation: 'Document information',
  reportTitle: 'Report title',
  documentNumber: 'Document number',
  version: 'Version',
  secrecy: 'Secrecy',
  date: 'Date',
  stage: 'Stage',
  signatures: 'Signatures',
  author: 'Author',
  reviewers: 'Reviewers',
  approver: 'Approver',
  add: 'Add',
  remove: 'Remove',
  revisionHistory: 'Revision history',
  addRow: 'Add a row',
  note: 'Note',
  deleteRow: 'Delete row',
  required: 'Required',
  notFilled: 'Not filled — export will report an error',
  requiredEmpty: (n, list) => n + ' required fields are empty: ' + list,
  carryOver: 'Carry over from the previous report',
};

/* The node id the editor routes to for the cover form. */
export const COVER_NODE = 'cover';

/* ------------------------------------------------------------------ *
 * small helpers
 * ------------------------------------------------------------------ */

// The same shape the legacy editor writes, so ids stay recognisable in both.
export function uid() {
  return 'n-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}

function cx() {
  const out = [];
  for (let i = 0; i < arguments.length; i++) if (arguments[i]) out.push(arguments[i]);
  return out.join(' ');
}

function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function deepCopy(value) {
  return JSON.parse(JSON.stringify(value));
}

// An image is referenced as 'images/<name>' and nothing else. An absolute path,
// or one that climbs out of the report, is rejected outright rather than
// repaired: a path the export cannot read is worse than no figure at all.
export function toImagesPath(file) {
  const raw = String(file == null ? '' : file).replace(/\\/g, '/').trim();
  if (!raw) return '';
  if (/^[a-zA-Z]:/.test(raw) || raw.charAt(0) === '/') return '';
  if (raw.split('/').indexOf('..') >= 0) return '';
  const name = raw.slice(raw.lastIndexOf('/') + 1);
  if (!name) return '';
  return 'images/' + name;
}

function pushError(err) {
  const message = err && err.message ? String(err.message) : String(err || '');
  store.pushBanner({ level: 'error', code: 'blocks', message: message });
}

/* ------------------------------------------------------------------ *
 * committing an edit
 * ------------------------------------------------------------------ */

// EVERY edit this file makes goes through here, and every edit this file makes
// is IN PLACE: the outline is large, other views hold the same references, and
// re-creating it on each keystroke would move the caret.
//
// In-place editing is only safe because the store tracks changes by revision,
// not by object identity (see the note at the top of js/store.js): markDirty()
// bumps store `rev`, and a save in flight compares `rev`, so an edit typed while
// a slow PUT is on the wire keeps the document dirty and reaches the next PUT.
//
// The one thing a caller must not do is mutate and stay silent. Mutate, then
// call this, on the same tick.
function commitEdit() {
  store.markDirty();
}

/* ------------------------------------------------------------------ *
 * moving a card
 * ------------------------------------------------------------------ */

// The block ranges of a section, one entry per CARD, in document order.
// A prose card covers a run of paragraphs; every other block is its own card.
function cardRanges(blocks) {
  return groupBlocks(blocks).map((card) => (card.kind === 'prose'
    ? { start: card.start, span: card.blocks.length }
    : { start: card.idx, span: 1 }));
}

// The blocks that BEGIN a card, by identity, in the order-independent form the
// stamper below needs: a block that headed a card before a move has to head one
// after it, wherever it lands.
function cardHeads(blocks) {
  const heads = new Set();
  groupBlocks(blocks).forEach((card) => {
    heads.add(blocks[card.kind === 'prose' ? card.start : card.idx]);
  });
  return heads;
}

// Keep the boundary a move is about to destroy.
//
// groupBlocks reads a paragraph WITHOUT cardStart as a continuation of the
// paragraph above it. So when a move makes two prose runs adjacent -- move a
// figure out from between them, or move a prose card up against another one --
// the second run is swallowed by the first: three cards become two. That is the
// exact dual of landing inside a card, it survives the save the same way, and
// the opposite move does not undo it, because by then the document no longer
// records that there was a boundary there.
//
// The rule is therefore symmetric with the landing rule: a block that headed a
// card BEFORE the move and now follows a paragraph is stamped cardStart, and
// nothing else is touched. A stamp is never removed -- a cardStart that has
// become redundant is indistinguishable from one the author asked for.
//
// The block is COPIED, not mutated: `list` shares its block objects with the
// caller's array, and a move that may still be discarded must not edit the
// document it was computed from.
function keepCardStarts(list, heads) {
  for (let i = 1; i < list.length; i++) {
    const block = list[i];
    if (!block || block.type !== 'para' || block.cardStart) continue;
    const above = list[i - 1];
    if (!above || above.type !== 'para') continue;
    if (!heads.has(block)) continue;
    list[i] = Object.assign({}, block, { cardStart: true });
  }
  return list;
}

// Move the card that begins at `startIndex` one card up (direction -1) or one
// card down (direction +1).
//
// A card is a RANGE, so the destination is the neighbouring CARD's far edge --
// never `startIndex - 1` / `startIndex + 1`. Moving by a single block offset
// lands the card INSIDE a multi-paragraph prose card and splits it in two, and
// the split survives the save, so there is nothing to undo it later.
//
// `count` is the caller's idea of the card's span; the span actually used is the
// one groupBlocks reports for that boundary, because the card is the unit and a
// caller working from a stale render must not be able to cut one in half.
//
// Both card boundaries are preserved, not just the one the card lands on: see
// keepCardStarts() above for the welding half of the rule. Because both halves
// hold, the move is its own inverse over the card structure -- down then up
// gives back the cards it started with, in the order it started with.
//
// Returns a NEW array, or the SAME array when the move is a no-op: at either
// end of the section, or when `startIndex` is not a card boundary.
export function moveCardBySpan(blocks, startIndex, count, direction) {
  const list = Array.isArray(blocks) ? blocks : [];
  const start = Number(startIndex);
  const step = Number(direction) < 0 ? -1 : 1;
  if (!list.length || !(start >= 0) || start >= list.length) return blocks;

  const cards = cardRanges(list);
  let at = -1;
  for (let i = 0; i < cards.length; i++) if (cards[i].start === start) { at = i; break; }
  if (at < 0) return blocks;
  const to = at + step;
  if (to < 0 || to >= cards.length) return blocks;

  const span = cards[at].span || (count > 0 ? count : 1);
  const moving = list.slice(start, start + span);
  const rest = list.slice(0, start).concat(list.slice(start + span));
  // Up: land on the neighbour's first block. Down: land just past its last one.
  // Both are expressed in the ORIGINAL indices and then corrected for the span
  // that has been lifted out, which only shifts positions after `start`.
  const dest = step < 0
    ? cards[to].start
    : cards[to].start + cards[to].span - span;
  const heads = cardHeads(list);
  return keepCardStarts(rest.slice(0, dest).concat(moving, rest.slice(dest)), heads);
}

/* ------------------------------------------------------------------ *
 * block factories
 * ------------------------------------------------------------------ */

const AXES_FALLBACK = ['MIN', 'TYP', 'MAX', 'NTWC'];

function complianceAxes(cfg) {
  const comp = (cfg && cfg.compliance) || {};
  const axes = comp.axis_labels;
  return Array.isArray(axes) && axes.length ? axes.slice() : AXES_FALLBACK.slice();
}

function settingKind(cfg) {
  const comp = (cfg && cfg.compliance) || {};
  const kinds = comp.setting_kinds;
  return Array.isArray(kinds) && kinds.length ? kinds[0] : 'common_setting';
}

function complianceRow(cat, item, unit, kind) {
  return {
    cat: cat || '', item: item || '', unit: unit || '', kind: kind || 'result',
    spec: null, spec_mtm: [null, null, null], sim_mtm: [null, null, null],
    spec_ntwc: null, sim_ntwc: null, limit: null, sim_span: false,
  };
}

// A compliance table is never created without its setting rows. That is the
// structural fix for the recurring "this table states no test conditions"
// problem, and it must not be weakened.
function defaultSettingRows(cfg) {
  const kind = settingKind(cfg);
  const comp = (cfg && cfg.compliance) || {};
  const spec = Array.isArray(comp.default_setting_rows) ? comp.default_setting_rows : null;
  if (spec && spec.length) {
    return spec.map((row) => complianceRow(row.cat, row.item, row.unit, row.kind || kind));
  }
  return [complianceRow('', '', '', kind)];
}

export function makeBlock(type, cfg) {
  if (type === 'para') {
    // A freshly inserted or pasted text block is its OWN card: cardStart is
    // written at creation so it never merges into the text above it.
    return { type: 'para', list: null, runs: [{ t: '' }], cardStart: true };
  }
  if (type === 'image') {
    return { type: 'image', id: uid(), file: '', caption: '', width_cm: 15.5, size: 'full' };
  }
  if (type === 'imagegrid') {
    return {
      type: 'imagegrid', id: uid(), cols: 2, caption: '', width_cm: 15.5,
      sub_captions: false, items: [],
    };
  }
  if (type === 'table') {
    return {
      type: 'table', id: uid(), caption: '', header_rows: 1,
      rows: [['', '', ''], ['', '', ''], ['', '', '']], merges: [], col_w: null,
    };
  }
  if (type === 'datatable') {
    return {
      type: 'datatable', id: uid(), kind: 'compliance', caption: '',
      data: {
        spec_name: 'Spec',
        sims: [{ key: 'sim', title: '', stage: '', axes: complianceAxes(cfg) }],
        rows: defaultSettingRows(cfg).concat([complianceRow('', '', '', 'result')]),
      },
    };
  }
  return null;
}

// Instantiate a template preset. Kept close to what the legacy editor writes so
// a preset started in either interface exports identically.
export function makeTableFromPreset(preset, cfg) {
  const p = preset || {};
  const base = p.base || 'compliance';
  if (base === 'plain') {
    const rows = Array.isArray(p.rows) && p.rows.length
      ? p.rows.map((row) => (Array.isArray(row) ? row.slice() : [String(row)]))
      : [['', ''], ['', '']];
    const block = {
      type: 'table', id: uid(), caption: p.caption || '',
      header_rows: p.header_rows == null ? 1 : p.header_rows,
      rows: rows, merges: Array.isArray(p.merges) ? deepCopy(p.merges) : [],
      col_w: p.col_w || null,
    };
    if (p.header_fill) block.header_fill = p.header_fill;
    if (p.row_fills) block.row_fills = deepCopy(p.row_fills);
    return block;
  }
  const axes = complianceAxes(cfg);
  const taken = Object.create(null);
  const simSpec = Array.isArray(p.sims) && p.sims.length
    ? p.sims
    : [{ title: '', stage: '', axes: axes.slice() }];
  const sims = simSpec.map((sim) => {
    const stem = String(sim.stage || 'g').toLowerCase() || 'g';
    let key = stem;
    let n = 2;
    while (taken[key]) { key = stem + n; n += 1; }
    taken[key] = true;
    return {
      key: key, title: sim.title || '', stage: sim.stage || '',
      axes: (Array.isArray(sim.axes) ? sim.axes : axes).slice(),
    };
  });
  const kind = settingKind(cfg);
  const fromSpec = (list, defaultKind) => (list || []).map(
    (row) => complianceRow(row.cat, row.item, row.unit, row.kind || defaultKind)
  );
  let settings = fromSpec(p.setting_rows, kind);
  if (!settings.length) settings = defaultSettingRows(cfg);
  let results = fromSpec(p.result_rows, 'result');
  if (!results.length) results = [complianceRow('', '', '', 'result')];
  return {
    type: 'datatable', id: uid(), kind: 'compliance', caption: p.caption || '',
    data: {
      spec_name: p.spec_name == null ? 'Spec' : p.spec_name,
      sims: sims,
      rows: settings.concat(results),
    },
  };
}

/* ------------------------------------------------------------------ *
 * prose: runs <-> contenteditable HTML
 *
 * A run is {t, b, i, color, ref}. A run carrying `ref` has no text of its own:
 * it renders as an accent chip showing the target's live number, exactly as the
 * engine renders it as a Word REF field.
 * ------------------------------------------------------------------ */

function runsToHtml(runs, numbers) {
  const list = runs || [];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const run = list[i];
    if (!run) continue;
    if (run.ref) {
      const entry = numbers && numbers.get ? numbers.get(run.ref) : null;
      const label = entry && entry.label ? entry.label : String(run.ref);
      out.push('<span class="rw-ref" contenteditable="false" data-ref="'
        + escapeHtml(run.ref) + '">' + escapeHtml(label) + '</span>');
      continue;
    }
    let text = escapeHtml(run.t || '');
    if (!text) continue;
    text = text.replace(/\n/g, '<br>');
    if (run.color) text = '<span style="color:#' + escapeHtml(run.color) + '">' + text + '</span>';
    if (run.i) text = '<i>' + text + '</i>';
    if (run.b) text = '<b>' + text + '</b>';
    out.push(text);
  }
  return out.join('');
}

function colorFromStyle(style) {
  const match = /color:\s*#?([0-9a-fA-F]{6})/.exec(String(style || ''));
  return match ? match[1].toUpperCase() : null;
}

// One paragraph element -> runs[]. Walks text nodes and tracks b / i / colour,
// treating a reference chip as atomic.
function elementToRuns(root) {
  const runs = [];
  const push = (text, state) => {
    if (!text) return;
    const run = { t: text };
    if (state.b) run.b = true;
    if (state.i) run.i = true;
    if (state.color) run.color = state.color;
    const last = runs[runs.length - 1];
    if (last && !last.ref && !!last.b === !!run.b && !!last.i === !!run.i
        && (last.color || null) === (run.color || null)) {
      last.t += text;
    } else {
      runs.push(run);
    }
  };
  const walk = (node, state) => {
    const children = node.childNodes;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child.nodeType === 3) {
        push(String(child.nodeValue).replace(/ /g, ' '), state);
        continue;
      }
      if (child.nodeType !== 1) continue;
      if (child.getAttribute && child.getAttribute('data-ref')) {
        runs.push({ ref: child.getAttribute('data-ref') });
        continue;
      }
      const tag = child.tagName.toLowerCase();
      if (tag === 'br') { push('\n', state); continue; }
      const next = { b: state.b, i: state.i, color: state.color };
      if (tag === 'b' || tag === 'strong') next.b = true;
      if (tag === 'i' || tag === 'em') next.i = true;
      const color = colorFromStyle(child.getAttribute('style') || '');
      if (color) next.color = color;
      walk(child, next);
    }
  };
  walk(root, { b: false, i: false, color: null });
  const cleaned = runs.filter((run) => run.ref || run.t !== '');
  return cleaned.length ? cleaned : [{ t: '' }];
}

// blocks[] -> the card's contenteditable HTML. Consecutive list paragraphs
// share one <ul>/<ol> so pressing Enter inside a list stays inside the list.
// data-src carries the source index, which is how an edited paragraph keeps the
// keys the model already had on it.
export function proseToHtml(blocks, numbers) {
  const list = blocks || [];
  const out = [];
  let open = null;
  for (let i = 0; i < list.length; i++) {
    const block = list[i] || {};
    const kind = block.list === 'bullet' || block.list === 'number' ? block.list : null;
    const inner = runsToHtml(block.runs, numbers) || '<br>';
    if (kind) {
      const tag = kind === 'bullet' ? 'ul' : 'ol';
      if (open !== tag) {
        if (open) out.push('</' + open + '>');
        out.push('<' + tag + '>');
        open = tag;
      }
      out.push('<li data-src="' + i + '">' + inner + '</li>');
      continue;
    }
    if (open) { out.push('</' + open + '>'); open = null; }
    out.push('<p data-src="' + i + '">' + inner + '</p>');
  }
  if (open) out.push('</' + open + '>');
  return out.join('');
}

// The contenteditable back to blocks[]. Paragraph identity is recovered through
// data-src: the first element claiming an index keeps that block's other keys,
// anything else is a new paragraph. A new paragraph carries NO cardStart, so
// Enter inside a card continues the card instead of splitting it.
export function readProseDom(root, blocks) {
  const source = blocks || [];
  const claimed = Object.create(null);
  const out = [];

  const take = (element, listKind) => {
    const raw = element.getAttribute ? element.getAttribute('data-src') : null;
    const index = raw == null ? -1 : parseInt(raw, 10);
    let base = null;
    if (index >= 0 && index < source.length && !claimed[index]) {
      claimed[index] = true;
      base = Object.assign({}, source[index]);
    }
    const block = base || { type: 'para' };
    block.type = 'para';
    block.runs = elementToRuns(element);
    block.list = listKind;
    if (!base) delete block.cardStart;
    if (listKind == null) delete block.level;
    out.push(block);
  };

  const children = root ? root.childNodes : [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.nodeType === 3) {
      const text = String(child.nodeValue || '').trim();
      if (!text) continue;
      out.push({ type: 'para', list: null, runs: [{ t: String(child.nodeValue) }] });
      continue;
    }
    if (child.nodeType !== 1) continue;
    const tag = child.tagName.toLowerCase();
    if (tag === 'ul' || tag === 'ol') {
      const kind = tag === 'ul' ? 'bullet' : 'number';
      const items = child.children;
      for (let j = 0; j < items.length; j++) take(items[j], kind);
      continue;
    }
    if (tag === 'br') continue;
    take(child, null);
  }
  if (!out.length) out.push({ type: 'para', list: null, runs: [{ t: '' }] });
  // The card keeps its boundary: the first paragraph of an edited card carries
  // cardStart from now on, which preserves exactly the grouping on screen.
  out[0].cardStart = true;
  return out;
}

/* ------------------------------------------------------------------ *
 * images
 * ------------------------------------------------------------------ */

// The image endpoint stores PNG only, so anything dropped is decoded and
// re-encoded in the browser. The server answers with the stored 'images/<name>'
// path, which is the only path ever written into the document.
function fileToPngBase64(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth || image.width;
        canvas.height = image.naturalHeight || image.height;
        canvas.getContext('2d').drawImage(image, 0, 0);
        const data = canvas.toDataURL('image/png');
        URL.revokeObjectURL(url);
        resolve(data.slice(data.indexOf(',') + 1));
      } catch (err) {
        URL.revokeObjectURL(url);
        reject(err);
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(file && file.name ? String(file.name) : ''));
    };
    image.src = url;
  });
}

async function storeImage(dir, section, file) {
  const base64 = await fileToPngBase64(file);
  const name = String((file && file.name) || 'image').replace(/\.[^.]+$/, '') + '.png';
  const result = await api.putImage(dir, section || '', name, base64);
  const stored = toImagesPath(result && result.file);
  if (!stored) throw new Error(String((result && result.file) || ''));
  return stored;
}

function imageFilesFrom(transfer) {
  const out = [];
  if (!transfer) return out;
  const files = transfer.files;
  if (files && files.length) {
    for (let i = 0; i < files.length; i++) {
      if (String(files[i].type || '').indexOf('image/') === 0) out.push(files[i]);
    }
    if (out.length) return out;
  }
  const items = transfer.items;
  if (items && items.length) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file' && String(item.type || '').indexOf('image/') === 0) {
        const file = item.getAsFile();
        if (file) out.push(file);
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * popup menu
 *
 * A local popup rather than components/Menu.js: a card sits inside a
 * position:relative seam, and this menu is placed in viewport coordinates.
 * The markup and classes are the shared ones.
 * ------------------------------------------------------------------ */

const MENU_EDGE = 8;

export function PopMenu(props) {
  const { x = 0, y = 0, items = [], onClose, width = 210 } = props || {};
  const boxRef = useRef(null);
  const [pos, setPos] = useState({ left: x, top: y, ready: false });

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    let left = x;
    let top = y;
    if (left + box.offsetWidth > window.innerWidth - MENU_EDGE) left = x - box.offsetWidth;
    if (left < MENU_EDGE) left = MENU_EDGE;
    if (top + box.offsetHeight > window.innerHeight - MENU_EDGE) top = y - box.offsetHeight;
    if (top < MENU_EDGE) top = MENU_EDGE;
    setPos({ left: left, top: top, ready: true });
  }, [x, y, items.length]);

  useEffect(() => {
    const away = (event) => {
      const box = boxRef.current;
      if (box && box.contains(event.target)) return;
      if (onClose) onClose();
    };
    const key = (event) => { if (event.key === 'Escape' && onClose) onClose(); };
    document.addEventListener('mousedown', away, true);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('mousedown', away, true);
      document.removeEventListener('keydown', key, true);
    };
  }, [onClose]);

  const style = {
    position: 'fixed',
    left: pos.left + 'px',
    top: pos.top + 'px',
    minWidth: width + 'px',
    visibility: pos.ready ? 'visible' : 'hidden',
  };

  return html`
    <div ref=${boxRef} class="rw-menu" role="menu" style=${style}>
      ${items.map((item, i) => html`
        ${item.separatorBefore ? html`<div class="rw-menu__sep" role="separator"></div>` : null}
        <button
          type="button"
          key=${item.label + i}
          class=${cx('rw-menu__item', item.danger && 'rw-menu__item--danger')}
          role="menuitem"
          disabled=${item.disabled || null}
          onClick=${() => { if (onClose) onClose(); if (item.onClick) item.onClick(); }}
        >
          <span>${item.label}</span>
          ${item.key ? html`<span class="rw-menu__key">${item.key}</span>` : null}
        </button>`)}
    </div>`;
}

const DRAG_TYPE = 'application/x-rw-block';

/* ------------------------------------------------------------------ *
 * card shell
 * ------------------------------------------------------------------ */

function CardHead(props) {
  const {
    marker, type, meta, numberLabel, extra, index, first, last, api: acts, menuItems,
  } = props;
  const [menu, setMenu] = useState(null);

  return html`
    <div class="rw-card__head" draggable="true"
         onDragStart=${(event) => {
           event.dataTransfer.setData(DRAG_TYPE, String(index));
           event.dataTransfer.effectAllowed = 'move';
           if (acts.onDragState) acts.onDragState(true);
         }}
         onDragEnd=${() => { if (acts.onDragState) acts.onDragState(false); }}>
      <span class=${cx('rw-card__marker', marker)}></span>
      <span class="rw-card__type">${type}</span>
      ${numberLabel ? html`<span class="rw-numchip">${numberLabel}</span>` : null}
      ${meta ? html`<span class="rw-card__meta">${meta}</span>` : null}
      ${extra}
      <span class="rw-card__tools">
        <${IconButton} glyph="↑" title=${T.moveUp} className="rw-iconbtn--sm"
                       disabled=${first} onClick=${() => acts.move(index, -1)} />
        <${IconButton} glyph="↓" title=${T.moveDown} className="rw-iconbtn--sm"
                       disabled=${last} onClick=${() => acts.move(index, 1)} />
        <${IconButton} glyph="⧉" title=${T.duplicate} className="rw-iconbtn--sm"
                       onClick=${() => acts.duplicate(index)} />
        <${IconButton} glyph="✕" title=${T.deleteBlock} className="rw-iconbtn--sm" danger=${true}
                       onClick=${() => acts.remove(index)} />
        <${IconButton} glyph="⋮" title=${T.more} className="rw-iconbtn--sm"
                       onClick=${(event) => {
                         const box = event.currentTarget.getBoundingClientRect();
                         setMenu({ x: box.left, y: box.bottom + 4 });
                       }} />
      </span>
      ${menu ? html`
        <${PopMenu} x=${menu.x} y=${menu.y} onClose=${() => setMenu(null)}
                    items=${(menuItems || []).concat([
                      { label: T.moveUp, disabled: first, onClick: () => acts.move(index, -1), separatorBefore: (menuItems || []).length > 0 },
                      { label: T.moveDown, disabled: last, onClick: () => acts.move(index, 1) },
                      { label: T.duplicate, onClick: () => acts.duplicate(index) },
                      { label: T.deleteBlock, danger: true, key: 'Delete', onClick: () => acts.remove(index) },
                    ])} />` : null}
    </div>`;
}

/* A caption row: the live number chip and the caption input. */
function CaptionRow(props) {
  const { numberLabel, value, onChange } = props;
  return html`
    <div class="rw-caption">
      ${numberLabel ? html`
        <span class="rw-numchip" style=${{ flex: '0 0 auto', whiteSpace: 'nowrap' }}>${numberLabel}</span>`
        : null}
      <input class="rw-input" type="text" value=${value || ''} placeholder=${T.addCaption}
             aria-label=${T.caption} onInput=${(event) => onChange(event.currentTarget.value)} />
    </div>`;
}

/* ------------------------------------------------------------------ *
 * prose card
 * ------------------------------------------------------------------ */

export function ProseCard(props) {
  const { blocks, numbers, index, first, last, acts, selected, marks } = props;
  const boxRef = useRef(null);
  const focusedRef = useRef(false);
  const wanted = useMemo(() => proseToHtml(blocks, numbers), [blocks, numbers]);
  const [markup, setMarkup] = useState(wanted);
  const [picker, setPicker] = useState(false);

  // The contenteditable is only rewritten while it is NOT focused. While the
  // caret is inside it the DOM is the truth and the model follows it, which is
  // what keeps the caret from jumping on every keystroke.
  useEffect(() => {
    if (!focusedRef.current && wanted !== markup) setMarkup(wanted);
  }, [wanted]);

  const commit = () => {
    const box = boxRef.current;
    if (!box) return;
    acts.replaceProse(index, readProseDom(box, blocks));
  };

  const insertRef = (targetId) => {
    const box = boxRef.current;
    if (!box) return;
    const selection = window.getSelection();
    const entry = numbers && numbers.get ? numbers.get(targetId) : null;
    const chip = document.createElement('span');
    chip.className = 'rw-ref';
    chip.setAttribute('contenteditable', 'false');
    chip.setAttribute('data-ref', targetId);
    chip.textContent = entry && entry.label ? entry.label : targetId;
    if (selection && selection.rangeCount && box.contains(selection.anchorNode)) {
      const range = selection.getRangeAt(0);
      range.deleteContents();
      range.insertNode(chip);
      range.setStartAfter(chip);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    } else {
      const last = box.lastElementChild || box;
      last.appendChild(chip);
    }
    commit();
    setMarkup(proseToHtml(blocks, numbers));
  };

  return html`
    <div class=${cx('rw-card', selected && 'rw-card--selected')} data-block=${index}>
      <${CardHead} marker="rw-card__marker--prose" type=${T.prose}
                   meta=${T.paragraphs(blocks.length)} index=${index} first=${first} last=${last} api=${acts}
                   menuItems=${[
                     { label: T.crossReference, onClick: () => setPicker(true) },
                     { label: T.editingMarks, onClick: () => acts.toggleMarks() },
                   ]} />
      <div class="rw-card__body">
        <div
          ref=${boxRef}
          class=${cx('rw-prose', marks && 'rw-prose--marks')}
          contenteditable="true"
          spellcheck="false"
          onFocus=${() => { focusedRef.current = true; }}
          onBlur=${() => {
            // Leaving the card hands authority back to the model: commit what
            // the DOM says, then let the parent redraw so the markup, the
            // paragraph count and the caption numbers all agree again.
            focusedRef.current = false;
            commit();
            acts.changed();
          }}
          onInput=${commit}
          onClick=${(event) => {
            const chip = event.target && event.target.closest ? event.target.closest('.rw-ref') : null;
            if (chip) acts.selectBlockId(chip.getAttribute('data-ref'));
          }}
          dangerouslySetInnerHTML=${{ __html: markup }}
        ></div>
      </div>
      ${picker ? html`
        <${RefPicker} numbers=${numbers} onClose=${() => setPicker(false)}
                      onPick=${(id) => { setPicker(false); insertRef(id); }} />` : null}
    </div>`;
}

function RefPicker(props) {
  const { numbers, onPick, onClose } = props;
  const entries = [];
  if (numbers && numbers.forEach) {
    numbers.forEach((value, key) => entries.push({ id: key, label: value.label }));
  }
  return html`
    <${Dialog} title=${T.crossReference} subtitle=${T.pickTarget} width=${420} onClose=${onClose}
               footer=${html`<${Button} onClick=${onClose}>${T.close}<//>`}>
      ${entries.length ? html`
        <div class="rw-chips">
          ${entries.map((entry) => html`
            <button type="button" class="rw-chip rw-chip--add" key=${entry.id}
                    onClick=${() => onPick(entry.id)}>${entry.label}</button>`)}
        </div>` : html`<div class="rw-meta">${T.nothingHere}</div>`}
    <//>`;
}

/* ------------------------------------------------------------------ *
 * figure card
 * ------------------------------------------------------------------ */

const WIDTH_OPTIONS = [5, 7.5, 10, 12, 15.5];

export function FigureCard(props) {
  const { block, index, first, last, acts, numbers, selected, dir } = props;
  const [over, setOver] = useState(false);
  const [size, setSize] = useState(null);
  const fileRef = useRef(null);
  const entry = numbers && numbers.get ? numbers.get(block.id) : null;
  const label = entry ? entry.label : '';

  const take = (files) => {
    const file = files && files[0];
    if (!file) return;
    storeImage(dir, acts.sectionId, file).then((stored) => {
      block.file = stored;
      acts.changed();
    }, pushError);
  };

  const meta = block.file
    ? block.file.slice('images/'.length) + (size ? '  ' + size.w + ' × ' + size.h : '')
    : '';

  return html`
    <div class=${cx('rw-card', selected && 'rw-card--selected')} data-block=${index}>
      <${CardHead} marker="rw-card__marker--figure" type=${T.figure} numberLabel=${label}
                   meta=${meta} index=${index} first=${first} last=${last} api=${acts}
                   menuItems=${[{ label: T.replace, onClick: () => fileRef.current && fileRef.current.click() }]}
                   extra=${html`
        <${Fragment}>
          <select class="rw-select rw-select--bar" style=${{ width: '128px', marginLeft: '6px' }}
                  aria-label=${T.width(block.width_cm || 15.5)}
                  value=${String(block.width_cm == null ? 15.5 : block.width_cm)}
                  onChange=${(event) => { block.width_cm = parseFloat(event.currentTarget.value); acts.changed(); }}>
            ${WIDTH_OPTIONS.map((w) => html`<option value=${String(w)} key=${w}>${T.width(w)}</option>`)}
          </select>
          <${Button} level="tertiary" onClick=${() => fileRef.current && fileRef.current.click()}>${T.replace}<//>
        <//>`} />
      <div class="rw-card__body">
        <input ref=${fileRef} type="file" accept="image/*" class="rw-hidden"
               onChange=${(event) => { take(event.currentTarget.files); event.currentTarget.value = ''; }} />
        ${block.file ? html`
          <div class="rw-figure">
            <img class="rw-figure__img" src=${api.imgUrl(dir, block.file)} alt=${block.caption || ''}
                 style=${{ width: (block.width_cm || 15.5) * 26 + 'px' }}
                 onLoad=${(event) => {
                   const node = event.currentTarget;
                   setSize({ w: node.naturalWidth, h: node.naturalHeight });
                 }} />
            <div style=${{ width: '100%' }}>
              <${CaptionRow} numberLabel=${label} value=${block.caption}
                             onChange=${(value) => { block.caption = value; acts.changed(); }} />
              <div class="rw-micro" style=${{ paddingLeft: '2px' }}>${T.storedIn}</div>
            </div>
          </div>` : html`
          <div class=${cx('rw-empty', over && 'rw-empty--over')} tabIndex="0"
               onDragOver=${(event) => { event.preventDefault(); if (!over) setOver(true); }}
               onDragLeave=${() => setOver(false)}
               onDrop=${(event) => { event.preventDefault(); setOver(false); take(imageFilesFrom(event.dataTransfer)); }}
               onPaste=${(event) => take(imageFilesFrom(event.clipboardData))}
               onClick=${() => fileRef.current && fileRef.current.click()}>
            <div class="rw-empty__title">${T.dropHint}</div>
            <div class="rw-micro">${T.storedIn}</div>
          </div>`}
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ *
 * figure grid card
 * ------------------------------------------------------------------ */

export function FigureGridCard(props) {
  const { block, index, first, last, acts, numbers, selected, dir } = props;
  const entry = numbers && numbers.get ? numbers.get(block.id) : null;
  const label = entry ? entry.label : '';
  const items = Array.isArray(block.items) ? block.items : (block.items = []);
  const cols = Math.max(1, parseInt(block.cols, 10) || 2);
  const [over, setOver] = useState(-1);
  const fileRef = useRef(null);
  const slotRef = useRef(-1);

  // One trailing empty cell is always offered, so there is always somewhere to
  // drop the next figure.
  const cellCount = Math.max(items.length + 1, cols);

  const take = (slot, files) => {
    const file = files && files[0];
    if (!file) return;
    storeImage(dir, acts.sectionId, file).then((stored) => {
      while (items.length <= slot) items.push({ file: '', sub: '' });
      items[slot] = Object.assign({}, items[slot], { file: stored });
      acts.changed();
    }, pushError);
  };

  return html`
    <div class=${cx('rw-card', selected && 'rw-card--selected')} data-block=${index}>
      <${CardHead} marker="rw-card__marker--figure" type=${T.figureGrid} numberLabel=${label}
                   meta=${T.figuresAndColumns(items.filter((it) => it && it.file).length, cols)}
                   index=${index} first=${first} last=${last} api=${acts}
                   menuItems=${[{
                     label: T.subCaptions,
                     onClick: () => { block.sub_captions = !block.sub_captions; acts.changed(); },
                   }]}
                   extra=${html`
        <select class="rw-select rw-select--bar" style=${{ width: '72px', marginLeft: '6px' }}
                aria-label=${T.columns} title=${T.columns} value=${String(cols)}
                onChange=${(event) => { block.cols = parseInt(event.currentTarget.value, 10); acts.changed(); }}>
          ${[1, 2, 3, 4].map((n) => html`<option value=${String(n)} key=${n}>${n}</option>`)}
        </select>`} />
      <div class="rw-card__body">
        <input ref=${fileRef} type="file" accept="image/*" class="rw-hidden"
               onChange=${(event) => {
                 take(slotRef.current, event.currentTarget.files);
                 event.currentTarget.value = '';
               }} />
        <div class="rw-figgrid" style=${{ gridTemplateColumns: 'repeat(' + cols + ', 1fr)' }}>
          ${Array.from({ length: cellCount }, (unused, slot) => {
            const item = items[slot] || {};
            return html`
              <div class="rw-figgrid__cell" key=${slot}>
                <div class=${cx('rw-drop', over === slot && 'rw-drop--over')}
                     style=${{ display: 'grid', placeItems: 'center', minHeight: '92px', padding: '6px' }}
                     onDragOver=${(event) => { event.preventDefault(); if (over !== slot) setOver(slot); }}
                     onDragLeave=${() => setOver(-1)}
                     onDrop=${(event) => {
                       event.preventDefault(); setOver(-1);
                       take(slot, imageFilesFrom(event.dataTransfer));
                     }}
                     onPaste=${(event) => take(slot, imageFilesFrom(event.clipboardData))}
                     tabIndex="0"
                     onClick=${() => { slotRef.current = slot; if (fileRef.current) fileRef.current.click(); }}>
                  ${item.file
                    ? html`<img class="rw-figure__img" src=${api.imgUrl(dir, item.file)} alt=${item.sub || ''}
                                style=${{ maxHeight: '150px' }} />`
                    : html`<span class="rw-micro">${T.dropHint}</span>`}
                </div>
                ${block.sub_captions ? html`
                  <input class="rw-input" type="text" value=${item.sub || ''} aria-label=${T.subCaption}
                         placeholder=${T.subCaption}
                         onInput=${(event) => {
                           while (items.length <= slot) items.push({ file: '', sub: '' });
                           items[slot] = Object.assign({}, items[slot], { sub: event.currentTarget.value });
                           acts.changed();
                         }} />` : null}
              </div>`;
          })}
        </div>
        <div style=${{ marginTop: '9px' }}>
          <${CaptionRow} numberLabel=${label} value=${block.caption}
                         onChange=${(value) => { block.caption = value; acts.changed(); }} />
        </div>
        <div class="rw-micro">${T.storedIn}</div>
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ *
 * table card
 *
 * The chrome is ours; the grid is js/views/table.js. That module is imported
 * lazily and defensively: while it is missing the card still shows its header,
 * its caption and its shape, and says so where the grid would be.
 * ------------------------------------------------------------------ */

let tableModule = null;

function loadTableModule() {
  if (!tableModule) {
    tableModule = import('./table.js').then((mod) => mod || null, () => null);
  }
  return tableModule;
}

// Body-shaped exports first, whole-card exports last: this file already draws
// the card head, so a body renderer is preferred over one that draws its own.
const TABLE_EXPORTS = [
  'TableBody', 'TableGrid', 'TableEditor', 'ComplianceGrid', 'BlockTable',
  'TableBlock', 'TableCard', 'default',
];

function pickTableRenderer(mod) {
  if (!mod) return null;
  for (let i = 0; i < TABLE_EXPORTS.length; i++) {
    const found = mod[TABLE_EXPORTS[i]];
    if (typeof found === 'function') return found;
  }
  return null;
}

export function TableCard(props) {
  const { block, index, first, last, acts, numbers, selected, dir, cfg, node } = props;
  const [renderer, setRenderer] = useState(null);
  const entry = numbers && numbers.get ? numbers.get(block.id) : null;
  const label = entry ? entry.label : '';
  const compliance = block.type === 'datatable';

  useEffect(() => {
    let live = true;
    loadTableModule().then((mod) => {
      if (live) setRenderer(() => pickTableRenderer(mod));
    });
    return () => { live = false; };
  }, []);

  let cols = 0;
  let rows = 0;
  if (compliance) {
    const data = block.data || {};
    const sims = Array.isArray(data.sims) ? data.sims : [];
    rows = Array.isArray(data.rows) ? data.rows.length : 0;
    cols = 3 + sims.reduce((sum, sim) => sum + ((sim.axes || []).length || 0), 0);
  } else {
    const grid = Array.isArray(block.rows) ? block.rows : [];
    rows = grid.length;
    cols = grid.reduce((max, row) => Math.max(max, (row || []).length), 0);
  }

  const download = () => {
    api.exportXlsx(dir, block).then((result) => {
      if (!result || !result.xlsx_b64) return;
      const bytes = atob(result.xlsx_b64);
      const buffer = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) buffer[i] = bytes.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = result.filename || 'table.xlsx';
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    }, pushError);
  };

  return html`
    <div class=${cx('rw-card', selected && 'rw-card--selected')} data-block=${index}>
      <${CardHead} marker="rw-card__marker--table" type=${compliance ? T.complianceTable : T.table}
                   numberLabel=${label} meta=${T.tableShape(cols, rows)}
                   index=${index} first=${first} last=${last} api=${acts}
                   menuItems=${[{ label: T.exportXlsx, onClick: download }]}
                   extra=${html`
        <span style=${{ marginLeft: '6px' }}>
          <${Button} level="tertiary" glyph="⬇" onClick=${download}>${T.exportXlsx}<//>
        </span>`} />
      <div class="rw-card__body rw-card__body--flush">
        ${renderer
          ? html`<${renderer} dir=${dir} block=${block} cfg=${cfg} node=${node}
                              onChange=${() => acts.changed()} />`
          : html`<div class="rw-empty rw-empty--sm"><div class="rw-empty__title">${T.notAvailable}</div></div>`}
      </div>
      <div class="rw-card__foot">
        <${CaptionRow} numberLabel=${label} value=${block.caption}
                       onChange=${(value) => { block.caption = value; acts.changed(); }} />
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ *
 * cover and metadata
 * ------------------------------------------------------------------ */

const COVER_FALLBACK_FIELDS = [
  { key: 'title', required: true },
  { key: 'doc_no', required: false },
  { key: 'version', required: false },
  { key: 'secrecy', required: false },
  { key: 'date', required: false },
  { key: 'stage', required: false },
  { key: 'author', required: false },
  { key: 'reviewers', required: false },
  { key: 'approver', required: false },
];

const COVER_LABELS = {
  title: T.reportTitle,
  doc_no: T.documentNumber,
  version: T.version,
  secrecy: T.secrecy,
  date: T.date,
  stage: T.stage,
  author: T.author,
  reviewers: T.reviewers,
  approver: T.approver,
};

const WIDE = { width: '404px', maxWidth: '100%' };
const SHORT = { width: '196px', maxWidth: '100%' };

function coverFields(cfg) {
  const cover = (cfg && cfg.cover) || {};
  const fields = Array.isArray(cover.fields) ? cover.fields : null;
  if (!fields || !fields.length) return COVER_FALLBACK_FIELDS;
  const seen = Object.create(null);
  const out = [];
  fields.forEach((field) => {
    if (!field || !field.key || seen[field.key]) return;
    if (!COVER_LABELS[field.key]) return;
    seen[field.key] = true;
    out.push({ key: field.key, required: !!field.required });
  });
  COVER_FALLBACK_FIELDS.forEach((field) => {
    if (!seen[field.key]) out.push(field);
  });
  return out;
}

function isEmptyValue(value) {
  if (value == null) return true;
  if (Array.isArray(value)) return !value.filter((entry) => String(entry || '').trim()).length;
  return !String(value).trim();
}

// The module's most recent OTHER report, from the shelf tree already in memory.
function previousReport(tree, dir) {
  const projects = (tree && tree.projects) || [];
  for (let i = 0; i < projects.length; i++) {
    const modules = (projects[i] && projects[i].modules) || [];
    for (let j = 0; j < modules.length; j++) {
      const reports = (modules[j] && modules[j].reports) || [];
      if (!reports.some((report) => report && report.dir === dir)) continue;
      const others = reports
        .filter((report) => report && report.dir && report.dir !== dir)
        .sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
      return others.length ? others[0] : null;
    }
  }
  return null;
}

export function CoverForm(props) {
  const { project, dir, cfg } = props;
  const tree = useStore((state) => state.tree);
  const [, bump] = useState(0);
  const meta = project.meta || (project.meta = {});
  const fields = coverFields(cfg);
  // Commit an in-place edit of meta and redraw this form. Every field below
  // writes straight into `meta` and then commits; nothing here rebuilds the
  // document, so commitEdit -- and the store revision it bumps -- is the ONLY
  // signal that anything changed.
  const changed = () => { commitEdit(); bump((n) => n + 1); };

  const missing = fields.filter((field) => field.required && isEmptyValue(meta[field.key]));
  const source = previousReport(tree, dir);

  const carryOver = () => {
    if (!source) return;
    api.getProject(source.dir).then((payload) => {
      const other = (payload && payload.project) || payload;
      const otherMeta = (other && other.meta) || {};
      missing.forEach((field) => {
        const value = otherMeta[field.key];
        if (!isEmptyValue(value)) meta[field.key] = Array.isArray(value) ? value.slice() : value;
      });
      changed();
    }, pushError);
  };

  const text = (key, style) => {
    const invalid = fields.some((field) => field.key === key && field.required)
      && isEmptyValue(meta[key]);
    return html`
      <${Field} label=${COVER_LABELS[key]} required=${fields.some((f) => f.key === key && f.required)}
                requiredLabel=${T.required} invalid=${invalid}
                hint=${invalid ? T.notFilled : null}>
        ${(id) => html`
          <input id=${id} class=${cx('rw-input', invalid && 'rw-input--invalid')} type="text"
                 style=${style} value=${meta[key] == null ? '' : String(meta[key])}
                 onInput=${(event) => { meta[key] = event.currentTarget.value; commitEdit(); }}
                 onBlur=${changed} />`}
      <//>`;
  };

  const reviewers = Array.isArray(meta.reviewers) ? meta.reviewers : (meta.reviewers = []);
  const revisions = Array.isArray(meta.revisions) ? meta.revisions : (meta.revisions = []);

  return html`
    <div class="rw-canvas">
      <div class="rw-canvas__inner">
        ${missing.length ? html`
          <div style=${{ marginBottom: '12px' }}>
            <${Banner} level="warn" className="rw-banner--attention"
                       action=${source ? html`
                         <${Button} onClick=${carryOver}>${T.carryOver}<//>` : null}>
              ${T.requiredEmpty(missing.length, missing.map((f) => COVER_LABELS[f.key]).join(', '))}
            <//>
          </div>` : null}

        <div class="rw-card" style=${{ marginBottom: '16px' }}>
          <div class="rw-card__head"><span class="rw-panel-title">${T.documentInformation}</span></div>
          <div class="rw-card__body">
            <div class="rw-formgrid">
              <div class="rw-formgrid__wide">${text('title', WIDE)}</div>
              ${text('doc_no', SHORT)}
              ${text('version', SHORT)}
              ${text('secrecy', SHORT)}
              ${text('date', SHORT)}
              ${text('stage', SHORT)}
            </div>
          </div>
        </div>

        <div class="rw-card" style=${{ marginBottom: '16px' }}>
          <div class="rw-card__head"><span class="rw-panel-title">${T.signatures}</span></div>
          <div class="rw-card__body">
            <div class="rw-formgrid">
              ${text('author', SHORT)}
              ${text('approver', SHORT)}
              <div class="rw-formgrid__wide">
                <${Field} label=${T.reviewers}>
                  <div style=${{ display: 'flex', flexDirection: 'column', gap: '6px', width: '404px', maxWidth: '100%' }}>
                    ${reviewers.map((name, i) => html`
                      <div key=${i} style=${{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                        <input class="rw-input" type="text" value=${name || ''} aria-label=${T.reviewers}
                               onInput=${(event) => { reviewers[i] = event.currentTarget.value; commitEdit(); }}
                               onBlur=${changed} />
                        <${IconButton} glyph="✕" title=${T.remove} className="rw-iconbtn--sm"
                                       onClick=${() => { reviewers.splice(i, 1); changed(); }} />
                      </div>`)}
                    <button type="button" class="rw-dashrow"
                            onClick=${() => { reviewers.push(''); changed(); }}>+ ${T.add}</button>
                  </div>
                <//>
              </div>
            </div>
          </div>
        </div>

        <div class="rw-card">
          <div class="rw-card__head"><span class="rw-panel-title">${T.revisionHistory}</span></div>
          <div class="rw-card__body">
            <div style=${{ display: 'grid', gridTemplateColumns: '110px 130px 130px 1fr 28px', gap: '6px', alignItems: 'center' }}>
              <div class="rw-micro">${T.version}</div>
              <div class="rw-micro">${T.date}</div>
              <div class="rw-micro">${T.author}</div>
              <div class="rw-micro">${T.note}</div>
              <div></div>
              ${revisions.map((row, i) => html`
                <${Fragment} key=${i}>
                  ${['ver', 'date', 'author', 'note'].map((key) => html`
                    <input class="rw-input" type="text" key=${key} value=${row[key] || ''}
                           aria-label=${key === 'ver' ? T.version : key === 'date' ? T.date
                             : key === 'author' ? T.author : T.note}
                           onInput=${(event) => { row[key] = event.currentTarget.value; commitEdit(); }}
                           onBlur=${changed} />`)}
                  <${IconButton} glyph="✕" title=${T.deleteRow} className="rw-iconbtn--sm"
                                 onClick=${() => { revisions.splice(i, 1); changed(); }} />
                <//>`)}
            </div>
            <div style=${{ marginTop: '9px' }}>
              <button type="button" class="rw-dashrow"
                      onClick=${() => { revisions.push({ ver: '', date: '', author: '', note: '' }); changed(); }}
              >+ ${T.addRow}</button>
            </div>
          </div>
        </div>
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ *
 * one card, for a canvas somebody else draws
 *
 * views/editor.js owns the editor frame and draws the seams, the drag wrapper
 * and the selection itself; it then asks this file for the card that goes in
 * the slot. BlockCard is that entry point. It takes the editor's prop names and
 * hands the work to the card components below, which are the only
 * implementation of a prose card there is.
 * ------------------------------------------------------------------ */

// How many blocks the prose card starting at `start` covers, by the same rule
// util.groupBlocks uses: consecutive paragraphs up to the next cardStart.
export function proseRunLength(blocks, start) {
  const list = blocks || [];
  let n = 0;
  for (let i = start; i < list.length; i++) {
    if (!list[i] || list[i].type !== 'para') break;
    if (i > start && list[i].cardStart) break;
    n += 1;
  }
  return n || 1;
}

export function BlockCard(props) {
  const {
    block, card, index, node, dir, cfg, project, captions, selected,
    editingMarks, onChange, onSelect, onDelete, onDuplicate, onMoveUp, onMoveDown,
  } = props || {};
  const marksFromStore = useStore((state) => state.ui.marks);
  const marks = editingMarks === undefined ? marksFromStore : editingMarks;

  const numbers = useMemo(
    () => captions || computeCaptionNumbers((project && project.outline) || []),
    [captions, project]
  );

  const own = block || (card && card.blocks && card.blocks[0]);
  if (!own) return null;

  const siblings = (node && node.blocks) || [];
  const at = index == null ? siblings.indexOf(own) : index;
  const span = own.type === 'para' ? proseRunLength(siblings, at) : 1;

  const acts = {
    sectionId: node ? node.id : '',
    changed: () => { commitEdit(); if (onChange) onChange(); },
    toggleMarks: () => store.setUi({ marks: !store.get().ui.marks }),
    selectBlockId: () => { if (onSelect) onSelect(); },
    onDragState: () => {},
    move: (unused, delta) => {
      if (delta < 0) { if (onMoveUp) onMoveUp(); } else if (onMoveDown) onMoveDown();
    },
    duplicate: () => { if (onDuplicate) onDuplicate(); },
    remove: () => { if (onDelete) onDelete(); },
    // Per-keystroke commit of a prose card. The run is replaced IN PLACE --
    // `siblings` is node.blocks and the editor holds that exact array -- and the
    // edit is then announced with commitEdit(). Announcing it is not optional:
    // nothing about this splice changes the identity of node, of project, or of
    // anything above them, so a save in flight can only learn about it from the
    // store revision commitEdit bumps.
    replaceProse: (start, next) => {
      if (!siblings.length) return;
      const length = proseRunLength(siblings, start);
      Array.prototype.splice.apply(siblings, [start, length].concat(next));
      commitEdit();
    },
  };

  const first = at <= 0;
  const last = at + span >= siblings.length;
  const shared = {
    block: own, index: at, first: first, last: last, acts: acts, numbers: numbers,
    selected: !!selected, dir: dir, cfg: cfg, node: node,
  };

  if (own.type === 'para') {
    const run = (card && card.blocks && card.blocks.length)
      ? card.blocks
      : siblings.slice(at, at + span);
    return html`
      <${ProseCard} blocks=${run} numbers=${numbers} index=${at} first=${first} last=${last}
                    acts=${acts} marks=${marks} selected=${!!selected} />`;
  }
  if (own.type === 'image') return html`<${FigureCard} ...${shared} />`;
  if (own.type === 'imagegrid') return html`<${FigureGridCard} ...${shared} />`;
  if (own.type === 'table' || own.type === 'datatable') {
    return html`<${TableCard} ...${shared} />`;
  }
  return html`
    <div class="rw-card">
      <div class="rw-card__head"><span class="rw-card__type">${T.notAvailable}</span></div>
    </div>`;
}
