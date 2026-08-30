/*
 * views/editor.js -- the workbench frame.
 *
 * What this file owns, and nothing else:
 *   * the 52px header  (project / module selectors, the stage segmented control
 *     with its trailing '+', the over-spec pill, the exchange chip, History, the
 *     save indicator, Export and the overflow menu)
 *   * the 272px outline rail (search, legend, the pinned cover row, the tree,
 *     seam drag-reorder, the context menu)
 *   * the 44px section bar, the format toolbar and its 24px status line
 *   * the block canvas frame: the insert seams between cards, selection,
 *     keyboard, the delete-with-undo toast
 *   * the cover and metadata form
 *   * the three-pane layout, including collapsing the right panel to a strip
 *
 * What it deliberately does NOT own:
 *   * the block cards themselves        -> views/blocks.js
 *   * anything inside a table block     -> views/table.js
 *   * the right panel's content         -> views/preview.js
 *   * the exchange and history panels   -> views/sync.js
 *   * the asset tray                    -> views/assets.js
 * Each of those is imported at runtime and probed for the component it
 * publishes: a module that is not written yet leaves this screen booting and
 * usable, never blank.
 *
 * Data rules followed here:
 *   * this view never fetches or writes project.json. It mutates
 *     store.project in place and replaces the top-level reference so preact
 *     re-renders, then lets store.js autosave (debounced, 800ms).
 *   * every user-facing string comes from the frozen string list and is
 *     collected in S below, so there is one place to check them against it.
 */

import { store, useStore } from '../store.js';
import * as api from '../api.js';
import {
  computeCaptionNumbers, groupBlocks, formatClock, relativeTime, numericValue,
  flagsFrom, flagsForGroup,
} from '../util.js';
import {
  Button, IconButton, Pill, Menu, Dialog, Drawer, Toast, EmptyState,
  html, cx, Fragment,
  useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback,
} from '../components/index.js';

/* ------------------------------------------------------------------ *
 * Frozen strings
 * ------------------------------------------------------------------ */

const S = {
  // application chrome
  back: 'Back',
  more: 'More',
  saving: 'Saving…',
  notSaved: 'Not saved — retrying',
  saved: 'Saved',
  unsaved: 'Unsaved changes',
  loading: 'Loading…',
  notAvailable: 'This screen is not available yet',
  // header
  project: 'Project',
  module: 'Module',
  stage: 'Stage',
  newReport: 'New report',
  createReport: 'Create report',
  startFrom: 'Start from',
  inheritFrom: 'Inherit from an existing report',
  blankFromTemplate: 'Blank, from a template',
  cancel: 'Cancel',
  copied: 'Copied — paste it into the assistant conversation',
  overSpec: 'over spec',
  neverExchanged: 'Never exchanged',
  sectionsChangedSince: 'sections changed since',
  textExchange: 'Text exchange',
  history: 'History',
  exportLabel: 'Export',
  exportWordPdf: 'Export Word and PDF',
  // outline
  sections: 'Sections',
  searchSections: 'Search sections',
  coverAndMetadata: 'Cover and metadata',
  missing: 'missing',
  filled: 'Filled',
  inProgress: 'In progress',
  empty: 'Empty',
  overSpecDot: 'Over spec',
  rename: 'Rename',
  insertSectionAbove: 'Insert section above',
  insertSectionBelow: 'Insert section below',
  insertSubsection: 'Insert subsection',
  duplicate: 'Duplicate',
  deleteLabel: 'Delete',
  untitledSection: 'Untitled section',
  sectionDeleted: 'Section deleted',
  fixedTemplateText: 'Fixed template text',
  // section bar
  copyWholeSection: 'Copy whole section',
  previousSection: 'Previous section',
  nextSection: 'Next section',
  sectionNote: 'Section note',
  sectionNoteHint: 'Notes travel with the report and never appear in the exported file',
  // format toolbar
  styleLabel: 'Style',
  font: 'Font',
  size: 'Size',
  bigger: 'Bigger',
  smaller: 'Smaller',
  bold: 'Bold',
  italic: 'Italic',
  underline: 'Underline',
  textColour: 'Text colour',
  highlight: 'Highlight',
  bulletedList: 'Bulleted list',
  numberedList: 'Numbered list',
  decreaseIndent: 'Decrease indent',
  increaseIndent: 'Increase indent',
  alignLeft: 'Align left',
  alignCentre: 'Align centre',
  alignRight: 'Align right',
  lineSpacing: 'Line spacing',
  editingMarks: 'Editing marks',
  appliesTo: 'Applies to',
  matchesTemplate: 'Matches the template style',
  differsTemplate: 'Differs from the template style · Restore',
  prose: 'Prose',
  // canvas
  insertHere: 'Insert here',
  insertProse: 'Insert prose',
  insertFigure: 'Insert figure',
  insertFigureGrid: 'Insert figure grid',
  insertTable: 'Insert table',
  insertComplianceTable: 'Insert compliance table',
  moveUp: 'Move up',
  moveDown: 'Move down',
  deleteBlock: 'Delete block',
  blockDeleted: 'Block deleted',
  undo: 'Undo',
  nothingHereYet: 'Nothing here yet',
  // cover
  documentInformation: 'Document information',
  reportTitle: 'Report title',
  documentNumber: 'Document number',
  version: 'Version',
  secrecy: 'Secrecy',
  date: 'Date',
  signatures: 'Signatures',
  author: 'Author',
  reviewers: 'Reviewers',
  approver: 'Approver',
  add: 'Add',
  revisionHistory: 'Revision history',
  addARow: 'Add a row',
  note: 'Note',
  notFilled: 'Not filled — export will report an error',
  requiredEmpty: 'required fields are empty:',
  carryOver: 'Carry over from the previous report',
  // right panel
  preview: 'Preview',
  check: 'Check',
  collapse: 'Collapse',
  expand: 'Expand',
  assets: 'Assets',
};

/* The cover form is addressed like a section so it can live in the route. The
 * value matches the COVER_NODE that views/blocks.js publishes, so a jump from
 * anywhere else in the interface lands on the form rather than on a blank
 * canvas. Section ids are minted by uid() and always start 'n-', so a real
 * section can never collide with it. */
export const COVER_NODE = 'cover';

/* ------------------------------------------------------------------ *
 * Pure helpers
 * ------------------------------------------------------------------ */

// Block ids are stable cross-reference targets (the engine bookmarks them as
// bm_<id>_num), so they are minted once and never regenerated.
export function uid() {
  return 'n-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}

function text(value) {
  return value == null ? '' : String(value);
}

// The numeric part of an axis value. There is exactly ONE port of the engine's
// rule in the interface -- util.numericValue -- and every over-spec decision on
// screen goes through it, so the red this header counts is the red the exported
// file prints. Nothing in this file re-derives it.

// The over-spec rule itself -- violates, the per-group value lookup and the
// flags they produce -- lives in util.js, one implementation shared with the
// grid and the paper preview, mirroring core/tables.py. This file used to carry
// its own copy whose per-group lookup tested row.sims[key] for TRUTH rather
// than MEMBERSHIP, so a row whose sims map holds the key with a null value was
// counted against the flat sim_mtm and this header claimed an over-spec value
// the engine, the export and /api/tree all say is not there.

// The axis indices of one simulation group that are over spec, as an array in
// ascending order. Index 3 is the NTWC corner.
export function overSpecFlags(row, mtm, ntwc) {
  return Array.from(flagsFrom(row, mtm, ntwc));
}

// Every over-spec position in one block, as {rowIndex, group, axis}.
export function blockOverSpec(block) {
  const out = [];
  if (!block || block.type !== 'datatable') return out;
  const data = block.data || {};
  const keys = (data.sims || []).filter((g) => g && g.key).map((g) => g.key);
  const rows = data.rows || [];
  // A table that names no simulation still renders one group, keyed 'sim' --
  // core/tables.py::make_groups says so, and the lookup has to ask about the
  // same key the engine asks about.
  const groups = keys.length ? keys : ['sim'];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    if (!row || typeof row !== 'object') continue;
    for (let g = 0; g < groups.length; g++) {
      flagsForGroup(row, groups[g]).forEach((axis) => {
        out.push({ rowIndex: r, group: groups[g], axis: axis });
      });
    }
  }
  return out;
}

function nodeOverSpec(node) {
  let n = 0;
  const blocks = (node && node.blocks) || [];
  for (let i = 0; i < blocks.length; i++) n += blockOverSpec(blocks[i]).length;
  return n;
}

export function walkOutline(nodes, visit, depth, parent) {
  const list = nodes || [];
  for (let i = 0; i < list.length; i++) {
    const node = list[i];
    if (!node || typeof node !== 'object') continue;
    visit(node, depth || 0, parent || null, i);
    walkOutline(node.children || [], visit, (depth || 0) + 1, node);
  }
}

// The header's only status number, computed in the browser from the document so
// it can never lag behind an edit.
export function countOverSpec(project) {
  let total = 0;
  walkOutline((project && project.outline) || [], (node) => {
    total += nodeOverSpec(node);
  });
  return total;
}

// The first over-spec value in document order, for the header pill's jump.
function firstOverSpec(project) {
  let hit = null;
  walkOutline((project && project.outline) || [], (node) => {
    if (hit) return;
    const blocks = node.blocks || [];
    for (let i = 0; i < blocks.length; i++) {
      const positions = blockOverSpec(blocks[i]);
      if (positions.length) {
        hit = { node: node, block: blocks[i], position: positions[0] };
        return;
      }
    }
  });
  return hit;
}

// A block counts as filled when it carries something the export would print.
export function blockHasContent(block) {
  if (!block || typeof block !== 'object') return false;
  switch (block.type) {
    case 'para':
      return (block.runs || []).some((run) => text(run && run.t).trim() !== '');
    case 'image':
      return text(block.file).trim() !== '';
    case 'imagegrid':
      return (block.items || []).some((item) => text(item && (item.file || item)).trim() !== '');
    case 'table':
      return (block.rows || []).some((row) => (row || []).some((cell) => text(cell).trim() !== ''));
    case 'datatable': {
      const rows = ((block.data || {}).rows) || [];
      return rows.some((row) => {
        if (!row) return false;
        if ((row.sim_mtm || []).some((v) => numericValue(v) !== null)) return true;
        if (numericValue(row.sim_ntwc) !== null) return true;
        const sims = row.sims;
        if (!sims || typeof sims !== 'object') return false;
        return Object.keys(sims).some((k) => {
          const sv = sims[k] || {};
          return (sv.mtm || []).some((v) => numericValue(v) !== null)
            || numericValue(sv.ntwc) !== null;
        });
      });
    }
    default:
      return false;
  }
}

// Status of one section, aggregated over the section and everything under it.
//
//   bad     -> holds an over-spec value; it wins over the other three
//   filled  -> every block has content (a fixed_body section is always filled)
//   partial -> some content
//   empty   -> no blocks at all, or every block empty
//
// Aggregating the children is deliberate: a chapter heading carries no blocks of
// its own, and showing it as empty while its subsections are full would be a lie
// about where the work stands.
export function sectionStatus(node) {
  let total = 0;
  let full = 0;
  let bad = false;
  const visit = (n) => {
    if (nodeOverSpec(n) > 0) bad = true;
    if (n.fixed_body) {
      total += 1;
      full += 1;
    } else {
      const blocks = n.blocks || [];
      for (let i = 0; i < blocks.length; i++) {
        total += 1;
        if (blockHasContent(blocks[i])) full += 1;
      }
    }
    const children = n.children || [];
    for (let i = 0; i < children.length; i++) visit(children[i]);
  };
  if (node) visit(node);
  if (bad) return 'bad';
  if (!total) return 'empty';
  if (full === total) return 'filled';
  if (full === 0) return 'empty';
  return 'partial';
}

const DOT_GLYPH = { filled: '●', partial: '◐', empty: '○', bad: '⚠' };
const DOT_CLASS = {
  filled: 'rw-dot--filled', partial: 'rw-dot--partial',
  empty: 'rw-dot--empty', bad: 'rw-dot--bad',
};
const DOT_TITLE = {
  filled: S.filled, partial: S.inProgress, empty: S.empty, bad: S.overSpecDot,
};

// Flatten the outline into rows carrying their section number, depth and the
// sibling list they live in -- everything the rail and the reorder need.
export function flattenOutline(outline) {
  const rows = [];
  const walk = (nodes, prefix, depth, parent) => {
    const list = nodes || [];
    for (let i = 0; i < list.length; i++) {
      const node = list[i];
      if (!node || typeof node !== 'object') continue;
      const number = prefix ? prefix + '.' + (i + 1) : String(i + 1);
      rows.push({
        node: node, number: number, depth: depth,
        parent: parent, index: i, siblings: list,
      });
      walk(node.children || [], number, depth + 1, node);
    }
  };
  walk(outline || [], '', 0, null);
  return rows;
}

function findRow(rows, id) {
  for (let i = 0; i < rows.length; i++) if (rows[i].node.id === id) return rows[i];
  return null;
}

/* ---- block factories (used unless views/blocks.js publishes its own) ---- */

export function newBlock(type, cfg) {
  switch (type) {
    case 'para':
      // cardStart marks the first block of a text card: a freshly inserted block
      // is its own card and never merges into the text above it.
      return { type: 'para', list: null, runs: [{ t: '' }], cardStart: true };
    case 'image':
      return { type: 'image', id: uid(), file: '', caption: '', width_cm: 14.0 };
    case 'imagegrid':
      return {
        type: 'imagegrid', id: uid(), cols: 2, caption: '', width_cm: 14.0,
        sub_captions: false, items: [],
      };
    case 'table':
      return {
        type: 'table', id: uid(), caption: '', header_rows: 1,
        rows: [['', '', ''], ['', '', '']], merges: [], col_w: null,
      };
    case 'datatable': {
      const comp = (cfg && cfg.compliance) || {};
      const axes = (comp.axis_labels || ['MIN', 'TYP', 'MAX', 'NTWC']).slice();
      return {
        type: 'datatable', id: uid(), kind: 'compliance', caption: '',
        data: {
          spec_name: 'Spec', show_spec: true,
          sims: [{ key: 'sim', title: '', stage: '', axes: axes }],
          rows: [],
        },
      };
    }
    default:
      return null;
  }
}

// A template's table preset, instantiated. Presets carry their setting rows, so
// a table started from one can never be missing its test conditions.
export function tableFromPreset(cfg, preset) {
  if (!preset) return null;
  const comp = (cfg && cfg.compliance) || {};
  const defAxes = comp.axis_labels || ['MIN', 'TYP', 'MAX', 'NTWC'];
  const base = preset.base || 'compliance';
  if (base === 'plain') {
    const rows = (preset.rows || [['', ''], ['', '']]).map((r) => r.slice());
    return {
      type: 'table', id: uid(), caption: preset.caption || '',
      header_rows: preset.header_rows == null ? 1 : preset.header_rows,
      rows: rows, merges: (preset.merges || []).slice(), col_w: preset.col_w || null,
    };
  }
  const taken = Object.create(null);
  const sims = (preset.sims || [{ title: '', stage: '', axes: defAxes.slice() }]).map((s) => {
    const stem = String(s.stage || 'g').toLowerCase() || 'g';
    let key = stem;
    let n = 2;
    while (taken[key]) { key = stem + n; n += 1; }
    taken[key] = true;
    return {
      key: key, title: s.title || '', stage: s.stage || '',
      axes: (s.axes || defAxes).slice(),
    };
  });
  const compare = base === 'compare' || sims.length > 1;
  const keys = compare ? sims.map((s) => s.key) : null;
  const build = (list, defaultKind) => (list || []).map((s) => {
    const row = {
      cat: s.cat || '', item: s.item || '', unit: s.unit || '',
      kind: s.kind || defaultKind, spec: s.spec == null ? null : s.spec,
      spec_mtm: Array.isArray(s.spec_mtm) ? s.spec_mtm.slice() : [null, null, null],
      spec_ntwc: s.spec_ntwc == null ? null : s.spec_ntwc,
      limit: s.limit || null, sim_span: !!s.sim_span,
    };
    if (keys) {
      row.sims = {};
      keys.forEach((k) => { row.sims[k] = { mtm: [null, null, null], ntwc: null }; });
    } else {
      row.sim_mtm = [null, null, null];
      row.sim_ntwc = null;
    }
    return row;
  });
  return {
    type: 'datatable', id: uid(), kind: 'compliance', caption: preset.caption || '',
    data: {
      spec_name: preset.spec_name == null ? (compare ? '' : 'Spec') : preset.spec_name,
      show_spec: preset.show_spec == null ? !compare : !!preset.show_spec,
      sims: sims,
      rows: build(preset.setting_rows, 'common_setting')
        .concat(build(preset.result_rows, 'result')),
    },
  };
}

function newSection() {
  return { id: uid(), title: '', blocks: [], children: [] };
}

function cloneSection(node) {
  const copy = JSON.parse(JSON.stringify(node));
  const fresh = (n) => {
    n.id = uid();
    (n.blocks || []).forEach((b) => { if (b && b.id) b.id = uid(); });
    (n.children || []).forEach(fresh);
  };
  fresh(copy);
  return copy;
}

/* ------------------------------------------------------------------ *
 * Editing the document
 * ------------------------------------------------------------------ */

// The one way this view changes the report. The outline is mutated in place --
// it is large and every other view holds the same reference -- and the top-level
// project reference is then replaced so preact re-renders and store.js saves.
function edit(mutator) {
  const project = store.get().project;
  if (!project) return;
  mutator(project);
  // The top-level reference is replaced so preact re-renders. The CHANGE itself
  // is announced through store.markDirty(), which bumps the store's revision
  // counter; setting `dirty` by hand here would leave that counter untouched,
  // and a save already in flight would clear the flag and swallow this edit.
  store.set({ project: Object.assign({}, project) });
  store.markDirty();
}

/* ------------------------------------------------------------------ *
 * Modules owned by other views
 * ------------------------------------------------------------------ */

// Each neighbouring view is imported at runtime and probed for the component it
// publishes. A module that is missing, or that exports under a name this file
// does not know, degrades to a placeholder; it never stops the frame rendering.
const OPTIONAL = new Map();   // path -> the module, once it has resolved
const PENDING = new Map();    // path -> the in-flight import

function pickExport(mod, names) {
  if (!mod) return null;
  for (let i = 0; i < names.length; i++) {
    const candidate = mod[names[i]];
    if (typeof candidate === 'function') return candidate;
  }
  return null;
}

function useOptionalModule(path) {
  const [, bump] = useState(0);
  useEffect(() => {
    if (OPTIONAL.has(path)) return undefined;
    let live = true;
    // The import is shared between every component asking for the same module,
    // and each of them attaches its own continuation -- so a component that
    // mounts while the import is still in flight is re-rendered when it lands
    // instead of being stuck on the placeholder.
    let pending = PENDING.get(path);
    if (!pending) {
      pending = import(path).then((mod) => mod || {}, () => ({}));
      PENDING.set(path, pending);
    }
    pending.then((mod) => {
      OPTIONAL.set(path, mod);
      PENDING.delete(path);
      if (live) bump((n) => n + 1);
    });
    return () => { live = false; };
  }, [path]);
  return OPTIONAL.get(path) || null;
}

function Unavailable(props) {
  return html`<${EmptyState} title=${S.notAvailable} body=${props.detail || null} />`;
}

/* ------------------------------------------------------------------ *
 * Small shared pieces
 * ------------------------------------------------------------------ */

function StatusDot(props) {
  const status = props.status || 'empty';
  return html`
    <span class=${cx('rw-dot', DOT_CLASS[status])} title=${DOT_TITLE[status]}
          aria-label=${DOT_TITLE[status]}>${DOT_GLYPH[status]}</span>`;
}

// One popup menu at a time, anchored where the user clicked.
function useMenu() {
  const [menu, setMenu] = useState(null);
  const openAt = useCallback((ev, items, label) => {
    if (ev && ev.preventDefault) ev.preventDefault();
    const x = ev && ev.clientX !== undefined ? ev.clientX : 0;
    const y = ev && ev.clientY !== undefined ? ev.clientY : 0;
    setMenu({ x: x, y: y, items: items, label: label || null });
  }, []);
  const openBelow = useCallback((ev, items, label) => {
    const el = ev && ev.currentTarget;
    const box = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    setMenu({
      x: box ? box.left : 0,
      y: box ? box.bottom + 4 : 0,
      items: items, label: label || null,
    });
  }, []);
  const close = useCallback(() => setMenu(null), []);
  const node = menu
    ? html`<${Menu} x=${menu.x} y=${menu.y} items=${menu.items}
                    ariaLabel=${menu.label} onClose=${close} />`
    : null;
  return { node: node, openAt: openAt, openBelow: openBelow, close: close, open: !!menu };
}

/* ------------------------------------------------------------------ *
 * Header
 * ------------------------------------------------------------------ */

const STAGES = ['XDR', 'PDR', 'CDR', 'FDR'];

// Locate the current report in the shelf tree: everything the header's three
// selectors need arrives from /api/tree, already shaped.
function locateReport(tree, dir) {
  const projects = (tree && tree.projects) || [];
  for (let p = 0; p < projects.length; p++) {
    const modules = projects[p].modules || [];
    for (let m = 0; m < modules.length; m++) {
      const reports = modules[m].reports || [];
      for (let r = 0; r < reports.length; r++) {
        if (reports[r].dir === dir) {
          return { project: projects[p], module: modules[m], report: reports[r] };
        }
      }
    }
  }
  return { project: projects[0] || null, module: null, report: null };
}

function firstReportOf(scope) {
  const modules = (scope && scope.modules) || [];
  for (let m = 0; m < modules.length; m++) {
    const reports = modules[m].reports || [];
    if (reports.length) return reports[0];
  }
  return ((scope && scope.reports) || [])[0] || null;
}

// The one piece of chrome that says whether the work is safe, so it reads BOTH
// halves of the truth: `saveState` is what the last write attempt did, `dirty`
// is whether the document in memory still differs from the file. They come
// apart routinely -- through the whole 800ms debounce after a keystroke, and
// permanently whenever a save was never issued -- and reading saveState alone
// printed "Saved HH:MM" over a document that was not on disk. An unsaved
// document never claims to be saved.
function SaveIndicator(props) {
  const state = props.state;
  const dirty = !!props.dirty;
  // The clock is the time of the last real save -- the file's own mtime when the
  // report was just opened. With nothing saved yet there is no time to show, and
  // inventing "now" would claim a save that never happened.
  const clock = formatClock(props.savedAt);
  const label = state === 'saving' ? S.saving
    : state === 'retrying' ? S.notSaved
      : dirty ? S.unsaved
        : clock ? S.saved + ' ' + clock : S.saved;
  return html`
    <div class=${cx('rw-save', state === 'saving' && 'rw-save--busy',
                    state === 'retrying' && 'rw-save--failed')}
         role="status" aria-live="polite">
      <span class="rw-save__dot" aria-hidden="true"></span>
      <span>${label}</span>
    </div>`;
}

// The stage strip: one segment per report this module holds, then a trailing '+'
// that starts another one. Switching stage is a route change; the outline
// position of each report is remembered by the store.
function StageStrip(props) {
  const reports = (props.module && props.module.reports) || [];
  const ordered = reports.slice().sort((a, b) => {
    const ia = STAGES.indexOf(String(a.stage || '').toUpperCase());
    const ib = STAGES.indexOf(String(b.stage || '').toUpperCase());
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  return html`
    <div class="rw-seg" role="radiogroup" aria-label=${S.stage}>
      ${ordered.map((report) => {
        const on = report.dir === props.dir;
        return html`
          <button type="button" key=${report.dir} role="radio" aria-checked=${String(on)}
                  class=${cx('rw-seg__item', on && 'rw-seg__item--on')}
                  onClick=${() => !on && store.navigate({ view: 'editor', dir: report.dir, node: store.lastNodeFor(report.dir) })}>
            ${report.stage || report.name || report.dir}
          </button>`;
      })}
      <button type="button" class="rw-seg__item" title=${S.newReport}
              aria-label=${S.newReport} onClick=${props.onNew}>+</button>
    </div>`;
}

function Header(props) {
  const { dir, project, cfg } = props;
  const tree = useStore((s) => s.tree);
  const saveState = useStore((s) => s.saveState);
  const savedAt = useStore((s) => s.savedAt);
  const dirty = useStore((s) => s.dirty);
  const ui = useStore((s) => s.ui);
  const menu = useMenu();

  const here = useMemo(() => locateReport(tree, dir), [tree, dir]);
  const overSpec = useMemo(() => countOverSpec(project), [project]);
  const exchange = (here.report && here.report.exchange) || null;
  const since = exchange && exchange.sectionsSince ? Number(exchange.sectionsSince) : 0;

  const previewMod = useOptionalModule('./preview.js');
  const ExportMenu = pickExport(previewMod, ['ExportMenu']);
  const openExport = pickExport(previewMod, ['openExport']);

  const goProject = (id) => {
    const target = ((tree && tree.projects) || []).find((p) => p.id === id);
    const report = firstReportOf(target);
    if (report) store.navigate({ view: 'editor', dir: report.dir, node: store.lastNodeFor(report.dir) });
  };
  const goModule = (id) => {
    const target = ((here.project && here.project.modules) || []).find((m) => m.id === id);
    const report = (target && (target.reports || [])[0]) || null;
    if (report) store.navigate({ view: 'editor', dir: report.dir, node: store.lastNodeFor(report.dir) });
  };

  const overflow = () => ([
    {
      label: S.editingMarks, glyph: '¶',
      onClick: () => store.setUi({ marks: !(ui && ui.marks) }),
    },
    {
      label: (ui && ui.assetsOpen) ? S.collapse : S.assets, glyph: '▭',
      onClick: () => store.setUi({ assetsOpen: !(ui && ui.assetsOpen) }),
    },
    { label: S.textExchange, glyph: '↻', separatorBefore: true, onClick: props.onExchange },
    { label: S.history, glyph: '⟲', onClick: props.onHistory },
    { label: S.back, glyph: '‹', separatorBefore: true, onClick: () => store.navigate({ view: 'home' }) },
  ]);

  return html`
    <${Fragment}>
      <header class="rw-topbar">
        <${IconButton} glyph="‹" title=${S.back}
                       onClick=${() => store.navigate({ view: 'home' })} />

        <select class="rw-select rw-select--bar" aria-label=${S.project}
                style=${{ width: '132px' }}
                value=${(here.project && here.project.id) || ''}
                onChange=${(ev) => goProject(ev.currentTarget.value)}>
          ${((tree && tree.projects) || []).map((p) => html`
            <option key=${p.id} value=${p.id}>${p.name || p.id}</option>`)}
        </select>
        <span class="rw-dim" aria-hidden="true">›</span>
        <select class="rw-select rw-select--bar" aria-label=${S.module}
                style=${{ width: '168px' }}
                value=${(here.module && here.module.id) || ''}
                onChange=${(ev) => goModule(ev.currentTarget.value)}>
          ${((here.project && here.project.modules) || []).map((m) => html`
            <option key=${m.id} value=${m.id}>${m.name || m.id}</option>`)}
        </select>
        <${StageStrip} module=${here.module} dir=${dir} onNew=${props.onNewReport} />

        <span class="rw-topbar__rule" aria-hidden="true"></span>

        ${overSpec > 0 ? html`
          <${Pill} tone="bad" glyph="✕" title=${S.overSpecDot} onClick=${props.onJumpOverSpec}>
            ${overSpec + ' ' + S.overSpec}
          <//>` : null}

        <${Pill} tone="neutral" glyph="↻" title=${S.textExchange} onClick=${props.onExchange}>
          ${exchange && exchange.last
            ? relativeTime(exchange.last)
            : S.neverExchanged}
          ${since > 0
            ? html`<span class="rw-warn">${' · ' + since + ' ' + S.sectionsChangedSince}</span>`
            : null}
        <//>
        <${Button} level="tertiary" onClick=${props.onHistory}>${S.history}<//>

        <span class="rw-spacer"></span>

        <${SaveIndicator} state=${saveState} dirty=${dirty} savedAt=${savedAt} />
        ${ExportMenu
          ? html`<${ExportMenu} dir=${dir} />`
          : html`
            <${Button} level="primary" onClick=${(ev) => menu.openBelow(ev, [{
              label: S.exportWordPdf,
              glyph: '↓',
              onClick: () => (openExport ? openExport(dir, 'pdf') : props.onExportUnavailable()),
            }], S.exportLabel)}>
              ${S.exportLabel}<span class="rw-btn__caret" aria-hidden="true"> ▾</span>
            <//>`}
        <${IconButton} glyph="⋯" title=${S.more}
                       onClick=${(ev) => menu.openBelow(ev, overflow(), S.more)} />
      </header>
      ${menu.node}
    <//>`;
}

/* ------------------------------------------------------------------ *
 * Outline rail
 * ------------------------------------------------------------------ */

// Which rows the rail shows. Two levels are always visible; anything deeper is
// reachable through its parent's twisty and stays closed until asked for. A
// search shows every match plus the ancestors that lead to it, so a hit is never
// orphaned from its chapter.
function visibleRows(rows, query, expanded) {
  const needle = String(query || '').trim().toLowerCase();
  if (needle) {
    const keep = new Set();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const hay = (row.number + ' ' + text(row.node.title)).toLowerCase();
      if (hay.indexOf(needle) === -1) continue;
      keep.add(row.node.id);
      let parent = row.parent;
      while (parent) {
        keep.add(parent.id);
        const parentRow = findRow(rows, parent.id);
        parent = parentRow ? parentRow.parent : null;
      }
    }
    return rows.filter((row) => keep.has(row.node.id));
  }
  return rows.filter((row) => {
    if (row.depth <= 1) return true;
    let parent = row.parent;
    while (parent) {
      if (!expanded[parent.id]) return false;
      const parentRow = findRow(rows, parent.id);
      parent = parentRow ? parentRow.parent : null;
    }
    return true;
  });
}

function OutlineRow(props) {
  const { row, selected, renaming } = props;
  const status = props.status;
  const hasChildren = (row.node.children || []).length > 0;
  const canTwisty = hasChildren && row.depth >= 1;

  if (renaming) {
    return html`
      <div class=${cx('rw-tree__row', row.depth === 1 && 'rw-tree__row--l2',
                      row.depth >= 2 && 'rw-tree__row--l3')}>
        <span class="rw-tree__count">${row.number}</span>
        <input class="rw-input" autoFocus value=${props.draft}
               aria-label=${S.rename}
               onInput=${(ev) => props.onDraft(ev.currentTarget.value)}
               onBlur=${props.onCommit}
               onKeyDown=${(ev) => {
                 if (ev.key === 'Enter') { ev.preventDefault(); props.onCommit(); }
                 if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); props.onCancel(); }
               }} />
      </div>`;
  }

  return html`
    <div class=${cx('rw-tree__row', selected && 'rw-tree__row--on',
                    row.depth === 1 && 'rw-tree__row--l2',
                    row.depth >= 2 && 'rw-tree__row--l3')}
         role="button" tabIndex="0"
         aria-current=${selected ? 'true' : null}
         aria-label=${row.number + ' ' + (text(row.node.title) || S.untitledSection)}
         draggable="true"
         onDragStart=${(ev) => props.onDragStart(ev, row)}
         onDragEnd=${props.onDragEnd}
         onClick=${() => props.onSelect(row)}
         onKeyDown=${(ev) => {
           if (ev.key !== 'Enter' && ev.key !== ' ') return;
           ev.preventDefault();
           props.onSelect(row);
         }}
         onDblClick=${() => props.onRename(row)}
         onContextMenu=${(ev) => props.onContext(ev, row)}>
      <span class="rw-tree__twisty" aria-hidden="true"
            onClick=${(ev) => { if (canTwisty) { ev.stopPropagation(); props.onToggle(row); } }}>
        ${canTwisty ? (props.expanded ? '⌄' : '›') : ''}
      </span>
      <${StatusDot} status=${status} />
      <span class="rw-tree__count">${row.number}</span>
      <span class="rw-tree__label">${text(row.node.title) || S.untitledSection}</span>
    </div>`;
}

function OutlineRail(props) {
  const { project, dir, selectedId } = props;
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState({});
  const [dragId, setDragId] = useState(null);
  const [overSeam, setOverSeam] = useState(-1);
  const [renaming, setRenaming] = useState(null);   // {id, draft}
  const bodyRef = useRef(null);
  const menu = useMenu();

  const rows = useMemo(() => flattenOutline(project && project.outline), [project]);
  const shown = useMemo(() => visibleRows(rows, query, expanded), [rows, query, expanded]);

  /* ---- outline scroll position, remembered per report ---- */
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !dir) return undefined;
    try {
      const saved = JSON.parse(window.localStorage.getItem('rw.outlineScroll') || '{}');
      if (saved && typeof saved[dir] === 'number') body.scrollTop = saved[dir];
    } catch (err) { /* storage is a convenience, never a requirement */ }
    const onScroll = () => {
      try {
        const saved = JSON.parse(window.localStorage.getItem('rw.outlineScroll') || '{}');
        saved[dir] = body.scrollTop;
        window.localStorage.setItem('rw.outlineScroll', JSON.stringify(saved));
      } catch (err) { /* ignore */ }
    };
    body.addEventListener('scroll', onScroll, { passive: true });
    return () => body.removeEventListener('scroll', onScroll);
  }, [dir]);

  /* ---- reorder ---- */

  // The drop target is the seam between two rows, and a section only ever moves
  // among its own siblings: a drag can reorder a chapter or a subsection, never
  // silently re-parent one. A seam that would do that simply does not accept the
  // drop, so nothing highlights and nothing moves.
  const seamTarget = (seamIndex) => {
    if (seamIndex >= shown.length) {
      const last = shown[shown.length - 1];
      if (!last) return { siblings: (project && project.outline) || [], index: 0 };
      const rootRows = rows.filter((r) => r.depth === 0);
      return { siblings: (project && project.outline) || [], index: rootRows.length };
    }
    const row = shown[seamIndex];
    return { siblings: row.siblings, index: row.index };
  };

  const seamAccepts = (seamIndex) => {
    if (!dragId) return false;
    const source = findRow(rows, dragId);
    if (!source) return false;
    const target = seamTarget(seamIndex);
    return target.siblings === source.siblings;
  };

  const dropAt = (seamIndex) => {
    const source = findRow(rows, dragId);
    if (!source) return;
    const target = seamTarget(seamIndex);
    if (target.siblings !== source.siblings) return;
    edit(() => {
      const list = source.siblings;
      const from = list.indexOf(source.node);
      if (from === -1) return;
      let to = target.index;
      list.splice(from, 1);
      if (from < to) to -= 1;
      list.splice(Math.max(0, Math.min(to, list.length)), 0, source.node);
    });
    setDragId(null);
    setOverSeam(-1);
  };

  /* ---- context menu ---- */

  const insertSibling = (row, offset) => {
    const created = newSection();
    edit(() => {
      row.siblings.splice(row.index + offset, 0, created);
    });
    props.onSelect(created.id);
    setRenaming({ id: created.id, draft: '' });
  };

  const contextItems = (row) => ([
    { label: S.rename, glyph: '✎', onClick: () => setRenaming({ id: row.node.id, draft: text(row.node.title) }) },
    { label: S.insertSectionAbove, glyph: '↑', separatorBefore: true, onClick: () => insertSibling(row, 0) },
    { label: S.insertSectionBelow, glyph: '↓', onClick: () => insertSibling(row, 1) },
    {
      label: S.insertSubsection,
      glyph: '→',
      onClick: () => {
        const created = newSection();
        edit(() => {
          if (!Array.isArray(row.node.children)) row.node.children = [];
          row.node.children.push(created);
        });
        setExpanded(Object.assign({}, expanded, { [row.node.id]: true }));
        props.onSelect(created.id);
        setRenaming({ id: created.id, draft: '' });
      },
    },
    {
      label: S.duplicate,
      glyph: '⧉',
      separatorBefore: true,
      onClick: () => {
        const copy = cloneSection(row.node);
        edit(() => { row.siblings.splice(row.index + 1, 0, copy); });
        props.onSelect(copy.id);
      },
    },
    {
      label: S.deleteLabel,
      glyph: '✕',
      danger: true,
      onClick: () => props.onDeleteSection(row),
    },
  ]);

  const seam = (index) => html`
    <div key=${'seam' + index}
         class=${cx('rw-outline__seam', overSeam === index && 'rw-outline__seam--over')}
         onDragOver=${(ev) => {
           if (!seamAccepts(index)) return;
           ev.preventDefault();
           ev.dataTransfer.dropEffect = 'move';
           if (overSeam !== index) setOverSeam(index);
         }}
         onDragLeave=${() => { if (overSeam === index) setOverSeam(-1); }}
         onDrop=${(ev) => { ev.preventDefault(); dropAt(index); }}></div>`;

  return html`
    <aside class="rw-editor__rail">
      <div class="rw-editor__railtop">
        <div class="rw-item-title">${S.sections}</div>
        <div class="rw-search">
          <span class="rw-search__glyph" aria-hidden="true">⌕</span>
          <input class="rw-input rw-input--bar" type="text" ref=${props.searchRef}
                 value=${query} placeholder=${S.searchSections} aria-label=${S.searchSections}
                 onInput=${(ev) => setQuery(ev.currentTarget.value)}
                 onKeyDown=${(ev) => { if (ev.key === 'Escape' && query) { ev.stopPropagation(); setQuery(''); } }} />
        </div>
        <div class="rw-editor__legend">
          <span><span class="rw-dot rw-dot--filled">●</span>${S.filled}</span>
          <span><span class="rw-dot rw-dot--partial">◐</span>${S.inProgress}</span>
          <span><span class="rw-dot rw-dot--empty">○</span>${S.empty}</span>
          <span><span class="rw-dot rw-dot--bad">⚠</span>${S.overSpecDot}</span>
        </div>
      </div>
      <div class="rw-editor__railbody" ref=${bodyRef}>
        <div class="rw-outline__pinned">
          <div class=${cx('rw-tree__row', selectedId === COVER_NODE && 'rw-tree__row--on')}
               role="button" tabIndex="0" aria-label=${S.coverAndMetadata}
               aria-current=${selectedId === COVER_NODE ? 'true' : null}
               onClick=${() => props.onSelect(COVER_NODE)}
               onKeyDown=${(ev) => {
                 if (ev.key !== 'Enter' && ev.key !== ' ') return;
                 ev.preventDefault();
                 props.onSelect(COVER_NODE);
               }}>
            <span class="rw-tree__twisty" aria-hidden="true"></span>
            <span class="rw-tree__label">${S.coverAndMetadata}</span>
            ${props.coverMissing > 0
              ? html`<${Pill} tone="warn">${props.coverMissing + ' ' + S.missing}<//>`
              : null}
          </div>
        </div>
        <div class="rw-tree">
          ${shown.map((row, i) => html`
            <${Fragment} key=${row.node.id}>
              ${seam(i)}
              <${OutlineRow}
                row=${row}
                status=${sectionStatus(row.node)}
                selected=${row.node.id === selectedId}
                expanded=${!!expanded[row.node.id]}
                renaming=${!!(renaming && renaming.id === row.node.id)}
                draft=${renaming ? renaming.draft : ''}
                onDraft=${(value) => setRenaming({ id: row.node.id, draft: value })}
                onCommit=${() => {
                  const draft = renaming ? renaming.draft : '';
                  edit(() => { row.node.title = draft; });
                  setRenaming(null);
                }}
                onCancel=${() => setRenaming(null)}
                onRename=${(target) => setRenaming({ id: target.node.id, draft: text(target.node.title) })}
                onToggle=${(target) => setExpanded(Object.assign({}, expanded,
                  { [target.node.id]: !expanded[target.node.id] }))}
                onSelect=${(target) => props.onSelect(target.node.id)}
                onContext=${(ev, target) => {
                  // Deliberately no selection here: selecting a section moves the
                  // preview's follow, and the scroll that follows closes any open
                  // popup. The menu acts on the row it was opened on regardless.
                  menu.openAt(ev, contextItems(target), S.sections);
                }}
                onDragStart=${(ev, target) => {
                  setDragId(target.node.id);
                  if (ev.dataTransfer) {
                    ev.dataTransfer.effectAllowed = 'move';
                    try { ev.dataTransfer.setData('text/plain', target.node.id); } catch (err) { /* ignore */ }
                  }
                }}
                onDragEnd=${() => { setDragId(null); setOverSeam(-1); }} />
            <//>`)}
          ${seam(shown.length)}
        </div>
      </div>
      ${menu.node}
    </aside>`;
}

/* ------------------------------------------------------------------ *
 * Section bar
 * ------------------------------------------------------------------ */

function ancestorTrail(rows, row) {
  const trail = [];
  let parent = row && row.parent;
  while (parent) {
    trail.unshift(text(parent.title) || S.untitledSection);
    const parentRow = findRow(rows, parent.id);
    parent = parentRow ? parentRow.parent : null;
  }
  return trail;
}

function SectionBar(props) {
  const { row, rows } = props;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);

  const node = row ? row.node : null;
  const trail = useMemo(() => ancestorTrail(rows, row), [rows, row]);
  const hasNote = !!(node && text(node.note).trim());

  useEffect(() => { setEditing(false); setNoteOpen(false); }, [node && node.id]);

  const commit = () => {
    edit(() => { node.title = draft; });
    setEditing(false);
  };

  return html`
    <${Fragment}>
      <div class="rw-sectionbar">
        ${trail.length
          ? html`<span class="rw-sectionbar__crumb">${trail.join(' › ') + ' ›'}</span>`
          : null}
        ${editing
          ? html`
            <input class="rw-input" autoFocus value=${draft} aria-label=${S.rename}
                   style=${{ width: '360px' }}
                   onInput=${(ev) => setDraft(ev.currentTarget.value)}
                   onBlur=${commit}
                   onKeyDown=${(ev) => {
                     if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
                     if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); setEditing(false); }
                   }} />`
          : html`
            <span class="rw-sectionbar__title"
                  onDblClick=${() => { setDraft(text(node.title)); setEditing(true); }}>
              ${row.number + '  ' + (text(node.title) || S.untitledSection)}
            </span>`}
        ${hasNote || noteOpen
          ? html`<${Pill} tone="note" onClick=${() => setNoteOpen(!noteOpen)}>${S.sectionNote}<//>`
          : null}
        <div class="rw-sectionbar__actions">
          ${!hasNote && !noteOpen
            ? html`<${Button} level="tertiary" onClick=${() => setNoteOpen(true)}>${S.sectionNote}<//>`
            : null}
          <${Button} level="tertiary" onClick=${props.onCopySection}>${S.copyWholeSection}<//>
          <${IconButton} glyph="↑" title=${S.previousSection} disabled=${!props.hasPrev}
                         onClick=${props.onPrev} />
          <${IconButton} glyph="↓" title=${S.nextSection} disabled=${!props.hasNext}
                         onClick=${props.onNext} />
        </div>
      </div>
      ${noteOpen ? html`
        <div class="rw-formatstatus" style=${{ height: 'auto', padding: '9px 12px' }}>
          <div style=${{ width: '100%' }}>
            <textarea class="rw-textarea" aria-label=${S.sectionNote}
                      value=${text(node.note)}
                      onInput=${(ev) => {
                        const value = ev.currentTarget.value;
                        edit(() => { node.note = value; });
                      }}></textarea>
            <div class="rw-meta">${S.sectionNoteHint}</div>
          </div>
        </div>` : null}
    <//>`;
}

/* ------------------------------------------------------------------ *
 * Format toolbar
 * ------------------------------------------------------------------ */

// What the caret is in, as far as this frame can tell. The prose card's DOM
// belongs to views/blocks.js, so the toolbar looks for the wrapper this file
// renders around every card and for an optional data-block-index the card may
// publish for each paragraph.
function readCaret(canvasEl) {
  if (!canvasEl || !window.getSelection) return null;
  const sel = window.getSelection();
  if (!sel || !sel.anchorNode) return null;
  let el = sel.anchorNode;
  if (el.nodeType === 3) el = el.parentNode;
  if (!el || !el.closest) return null;
  if (!canvasEl.contains(el)) return null;
  const editable = el.closest('[contenteditable="true"]');
  if (!editable) return null;
  const slot = el.closest('[data-card-start]');
  const paragraph = el.closest('[data-block-index]');
  return {
    cardStart: slot ? Number(slot.getAttribute('data-card-start')) : null,
    blockIndex: paragraph ? Number(paragraph.getAttribute('data-block-index')) : null,
  };
}

function cmd(name, value) {
  try {
    document.execCommand(name, false, value === undefined ? null : value);
  } catch (err) {
    /* a command the browser refuses is simply a no-op */
  }
}

function FormatToolbar(props) {
  const { caret, node } = props;
  const active = !!caret;
  const marks = !!props.marks;
  const [differs, setDiffers] = useState(false);

  useEffect(() => {
    if (!active) { setDiffers(false); return; }
    try {
      setDiffers(!!(document.queryCommandState('bold') || document.queryCommandState('italic')));
    } catch (err) {
      setDiffers(false);
    }
  }, [active, props.caretTick]);

  // The paragraphs the list and indent controls act on: the paragraph the caret
  // sits in when the card publishes one, else every paragraph of the card. A
  // one-paragraph card -- much the commonest -- is the same thing either way.
  const targets = () => {
    if (!caret || !node) return [];
    const blocks = node.blocks || [];
    if (caret.blockIndex !== null && blocks[caret.blockIndex]) return [blocks[caret.blockIndex]];
    if (caret.cardStart === null) return [];
    const out = [];
    for (let i = caret.cardStart; i < blocks.length; i++) {
      const block = blocks[i];
      if (!block || block.type !== 'para') break;
      if (i > caret.cardStart && block.cardStart) break;
      out.push(block);
    }
    return out;
  };

  const setList = (kind) => {
    const list = targets();
    if (!list.length) return;
    edit(() => {
      const turnOff = list.every((b) => b.list === kind);
      list.forEach((b) => { b.list = turnOff ? null : kind; });
    });
  };

  const step = (delta) => {
    const list = targets();
    if (!list.length) return;
    edit(() => {
      list.forEach((b) => {
        const level = Math.max(0, Math.min(8, (Number(b.level) || 0) + delta));
        b.level = level;
      });
    });
  };

  const rule = html`<span class="rw-formatbar__rule" aria-hidden="true"></span>`;

  // Controls that the document model has no field for are shown -- the order is
  // fixed -- but disabled, because a style that cannot be saved would silently
  // vanish on the next reload and look wrong in the exported file.
  return html`
    <${Fragment}>
      <div class=${cx('rw-formatbar', !active && 'rw-formatbar--off')}>
        <select class="rw-select rw-select--bar" disabled aria-label=${S.styleLabel}>
          <option>${S.styleLabel}</option>
        </select>
        <select class="rw-select rw-select--bar" disabled aria-label=${S.font}>
          <option>${S.font}</option>
        </select>
        <select class="rw-select rw-select--bar" disabled aria-label=${S.size}>
          <option>${S.size}</option>
        </select>
        <${IconButton} glyph="A⁺" title=${S.bigger} disabled />
        <${IconButton} glyph="A⁻" title=${S.smaller} disabled />
        ${rule}
        <${IconButton} glyph="B" title=${S.bold} onClick=${() => cmd('bold')} />
        <${IconButton} glyph="I" title=${S.italic} onClick=${() => cmd('italic')} />
        <${IconButton} glyph="U" title=${S.underline} disabled />
        <input type="color" class="rw-input rw-input--bar" title=${S.textColour}
               aria-label=${S.textColour} style=${{ width: '32px', padding: '2px' }}
               onInput=${(ev) => cmd('foreColor', ev.currentTarget.value)} />
        <${IconButton} glyph="▨" title=${S.highlight} disabled />
        ${rule}
        <${IconButton} glyph="•" title=${S.bulletedList} onClick=${() => setList('bullet')} />
        <${IconButton} glyph="1." title=${S.numberedList} onClick=${() => setList('number')} />
        <${IconButton} glyph="⇤" title=${S.decreaseIndent} onClick=${() => step(-1)} />
        <${IconButton} glyph="⇥" title=${S.increaseIndent} onClick=${() => step(1)} />
        ${rule}
        <${IconButton} glyph="≡" title=${S.alignLeft} disabled />
        <${IconButton} glyph="≣" title=${S.alignCentre} disabled />
        <${IconButton} glyph="⋯" title=${S.alignRight} disabled />
        <select class="rw-select rw-select--bar" disabled aria-label=${S.lineSpacing}>
          <option>${S.lineSpacing}</option>
        </select>
        <span class="rw-spacer"></span>
        <${IconButton} glyph="¶" title=${S.editingMarks} pressed=${marks}
                       onClick=${() => props.onMarks(!marks)} />
      </div>
      <div class="rw-formatstatus">
        <span>${active ? S.appliesTo + ' ' + S.prose : ''}</span>
        ${active && differs
          ? html`
            <span class="rw-formatstatus__right rw-formatstatus__right--differs">
              <button type="button" class="rw-btn rw-btn--tertiary"
                      onClick=${() => cmd('removeFormat')}>${S.differsTemplate}</button>
            </span>`
          : html`
            <span class="rw-formatstatus__right rw-formatstatus__right--match">
              ${active ? '✓ ' + S.matchesTemplate : ''}
            </span>`}
      </div>
    <//>`;
}

/* ------------------------------------------------------------------ *
 * Block canvas
 * ------------------------------------------------------------------ */

const BLOCK_TYPE_LABEL = {
  para: S.prose, image: 'Figure', imagegrid: 'Figure grid',
  table: 'Table', datatable: 'Compliance table',
};

// The stand-in card, used only while views/blocks.js is not present. It shows
// what the block holds so the frame can be worked on, and nothing more: editing
// a block belongs to that file.
function FallbackCard(props) {
  const { block, blocks, dir } = props;
  const kind = block ? block.type : 'para';
  const label = BLOCK_TYPE_LABEL[kind] || kind;
  const paragraphs = blocks || [block];
  return html`
    <div class=${cx('rw-card', props.selected && 'rw-card--selected')}>
      <div class="rw-card__head">
        <span class=${cx('rw-card__marker',
          kind === 'para' ? 'rw-card__marker--prose'
            : (kind === 'image' || kind === 'imagegrid') ? 'rw-card__marker--figure'
              : 'rw-card__marker--table')} aria-hidden="true"></span>
        <span class="rw-card__type">${label}</span>
        ${props.number ? html`<span class="rw-numchip">${props.number}</span>` : null}
        <span class="rw-card__meta">${props.meta || ''}</span>
        <div class="rw-card__tools">
          <${IconButton} glyph="↑" small title=${S.moveUp} onClick=${props.onUp} />
          <${IconButton} glyph="↓" small title=${S.moveDown} onClick=${props.onDown} />
          <${IconButton} glyph="✕" small danger title=${S.deleteBlock} onClick=${props.onDelete} />
        </div>
      </div>
      <div class="rw-card__body">
        ${kind === 'para'
          ? paragraphs.map((b, i) => html`
              <div class="rw-prose" key=${i}>
                ${(b.runs || []).map((run) => text(run.t)).join('') || ''}
              </div>`)
          : null}
        ${kind === 'image' && text(block.file)
          ? html`<div class="rw-figure"><img class="rw-figure__img"
                   src=${api.imgUrl(dir, block.file)} alt=${text(block.caption)} /></div>`
          : null}
        ${kind === 'image' && !text(block.file)
          ? html`<${EmptyState} compact title=${'Paste a screenshot with Ctrl+V, or drop a file'} />`
          : null}
        ${kind === 'table' || kind === 'datatable'
          ? html`<div class="rw-meta">${props.meta || ''}</div>`
          : null}
        ${(kind === 'image' || kind === 'imagegrid' || kind === 'table' || kind === 'datatable')
          && text(block.caption)
          ? html`<div class="rw-meta">${text(block.caption)}</div>` : null}
      </div>
    </div>`;
}

function blockMeta(card, block) {
  if (!block) return '';
  if (card && card.kind === 'prose') return card.blocks.length + ' paragraphs';
  if (block.type === 'image') return block.width_cm ? 'Width ' + block.width_cm + ' cm' : '';
  if (block.type === 'imagegrid') {
    return (block.items || []).length + ' figures · ' + (block.cols || 1) + ' columns';
  }
  if (block.type === 'table') {
    const rows = block.rows || [];
    const cols = rows.length ? (rows[0] || []).length : 0;
    return cols + ' columns × ' + rows.length + ' rows';
  }
  if (block.type === 'datatable') {
    const data = block.data || {};
    const rows = (data.rows || []).length;
    const groups = (data.sims || []).length + (data.show_spec === false ? 0 : 1);
    return groups + ' columns × ' + rows + ' rows';
  }
  return '';
}

function Canvas(props) {
  const { node, dir, cfg, project, selectedStart } = props;
  const menu = useMenu();
  const [dragIndex, setDragIndex] = useState(-1);
  const [dragCount, setDragCount] = useState(1);
  const [overSeam, setOverSeam] = useState(-1);

  const blocksMod = useOptionalModule('./blocks.js');
  const BlockCard = pickExport(blocksMod, ['BlockCard', 'Card', 'Block']);
  const makeBlock = pickExport(blocksMod, ['newBlock', 'createBlock', 'makeBlock']);
  const makePreset = pickExport(blocksMod, ['makeTableFromPreset']);
  // One step up or down is a CARD step, not a block step: the neighbour a card
  // hops over is itself a range of blocks, and landing in the middle of one
  // splits it permanently. views/blocks.js owns that rule and this frame calls
  // it -- there is no second copy of the arithmetic here. If that module has not
  // loaded, the arrows do nothing; a guess is exactly what breaks a document.
  const moveBySpan = pickExport(blocksMod, ['moveCardBySpan']);

  const captions = useMemo(
    () => computeCaptionNumbers((project && project.outline) || []),
    [project]
  );

  if (!node) return html`<div class="rw-canvas"></div>`;

  if (node.fixed_body) {
    return html`
      <div class="rw-canvas">
        <div class="rw-canvas__inner">
          <div class="rw-card">
            <div class="rw-card__head">
              <span class="rw-card__marker" aria-hidden="true"></span>
              <span class="rw-card__type">${S.fixedTemplateText}</span>
            </div>
          </div>
        </div>
      </div>`;
  }

  const blocks = node.blocks || [];
  const cards = groupBlocks(blocks);

  const insert = (at, type, preset) => {
    const created = preset
      ? (makePreset ? makePreset(preset, cfg) : tableFromPreset(cfg, preset))
      : (makeBlock ? makeBlock(type, cfg) : newBlock(type, cfg));
    if (!created) return;
    edit(() => { blocks.splice(at, 0, created); });
    props.onSelectBlock(created.id || null);
  };

  const insertItems = (at) => {
    const items = [
      { label: S.insertProse, glyph: '¶', onClick: () => insert(at, 'para') },
      { label: S.insertFigure, glyph: '▣', onClick: () => insert(at, 'image') },
      { label: S.insertFigureGrid, glyph: '▦', onClick: () => insert(at, 'imagegrid') },
      { label: S.insertTable, glyph: '▤', onClick: () => insert(at, 'table') },
      { label: S.insertComplianceTable, glyph: '▥', onClick: () => insert(at, 'datatable') },
    ];
    const presets = (cfg && cfg.table_presets) || [];
    presets.forEach((preset, i) => {
      items.push({
        label: preset.label || preset.key,
        glyph: '▥',
        separatorBefore: i === 0,
        onClick: () => insert(at, null, preset),
      });
    });
    return items;
  };

  // Dropping a dragged card on a seam. A seam sits BETWEEN two cards, so the
  // destination is already a card boundary and no span arithmetic is involved --
  // this is a different operation from the one-step move below, not a second
  // copy of it.
  const dropCardAt = (from, count, to) => {
    edit(() => {
      const cut = blocks.splice(from, count);
      let at = to;
      if (from < to) at -= count;
      blocks.splice(Math.max(0, Math.min(at, blocks.length)), 0, ...cut);
    });
  };

  // One card up (-1) or down (+1), by the shared rule.
  const moveCard = (from, count, direction) => {
    if (!moveBySpan) return;
    const next = moveBySpan(blocks, from, count, direction);
    if (!next || next === blocks) return;   // a no-op at either end
    edit(() => { node.blocks = next; });
  };

  const seam = (at, index) => html`
    <div class=${cx('rw-seam', overSeam === index && 'rw-seam--over',
                    menu.open && 'rw-seam--open')}
         key=${'seam' + index}
         title=${S.insertHere}
         onClick=${(ev) => menu.openAt(ev, insertItems(at), S.insertHere)}
         onDragOver=${(ev) => {
           if (dragIndex < 0) return;
           ev.preventDefault();
           ev.dataTransfer.dropEffect = 'move';
           if (overSeam !== index) setOverSeam(index);
         }}
         onDragLeave=${() => { if (overSeam === index) setOverSeam(-1); }}
         onDrop=${(ev) => {
           ev.preventDefault();
           if (dragIndex >= 0) dropCardAt(dragIndex, dragCount, at);
           setDragIndex(-1);
           setOverSeam(-1);
         }}>
      <span class="rw-seam__plus" aria-hidden="true">+</span>
    </div>`;

  return html`
    <div class="rw-canvas" ref=${props.canvasRef}>
      <div class="rw-canvas__inner">
        ${cards.length === 0
          ? html`
            <${EmptyState} title=${S.nothingHereYet} body=${S.insertHere}>
              <${Button} level="secondary"
                         onClick=${(ev) => menu.openAt(ev, insertItems(0), S.insertHere)}>
                ${S.insertHere}
              <//>
            <//>`
          : null}
        ${cards.map((card, i) => {
          const start = card.kind === 'prose' ? card.start : card.idx;
          const count = card.kind === 'prose' ? card.blocks.length : 1;
          const block = card.kind === 'prose' ? card.blocks[0] : card.block;
          const numbered = block && block.id ? captions.get(block.id) : null;
          // Selection is keyed on the card's first block INDEX, not on a block
          // id: prose blocks carry no id (only cross-reference targets do), and
          // a prose card must still be selectable and deletable.
          const selected = selectedStart === start;
          const slot = html`
            <div key=${'card' + start}
                 data-card-start=${String(start)}
                 data-block-id=${block && block.id ? block.id : null}
                 draggable=${props.editingHere ? null : 'true'}
                 onDragStart=${(ev) => {
                   const target = ev.target;
                   if (target && target.closest
                       && target.closest('[contenteditable="true"],input,textarea,select')) {
                     ev.preventDefault();
                     return;
                   }
                   setDragIndex(start);
                   setDragCount(count);
                   if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
                 }}
                 onDragEnd=${() => { setDragIndex(-1); setOverSeam(-1); }}
                 onMouseDown=${() => props.onSelectBlock(block && block.id ? block.id : null, start)}>
              ${BlockCard
                ? html`<${BlockCard}
                    block=${block} blocks=${card.blocks || [block]} card=${card}
                    index=${start} node=${node} dir=${dir} cfg=${cfg} project=${project}
                    captions=${captions} number=${numbered ? numbered.label : null}
                    selected=${selected} editingMarks=${props.editingMarks}
                    onChange=${() => edit(() => {})}
                    onSelect=${() => props.onSelectBlock(block && block.id ? block.id : null, start)}
                    onDelete=${() => props.onDeleteCard(start, count)}
                    onDuplicate=${() => props.onDuplicateCard(start, count)}
                    onMoveUp=${() => moveCard(start, count, -1)}
                    onMoveDown=${() => moveCard(start, count, 1)} />`
                : html`<${FallbackCard}
                    block=${block} blocks=${card.blocks} dir=${dir} selected=${selected}
                    number=${numbered ? numbered.label : null}
                    meta=${blockMeta(card, block)}
                    onUp=${() => moveCard(start, count, -1)}
                    onDown=${() => moveCard(start, count, 1)}
                    onDelete=${() => props.onDeleteCard(start, count)} />`}
            </div>`;
          return html`<${Fragment} key=${'slot' + start}>${seam(start, i)}${slot}<//>`;
        })}
        ${cards.length ? seam(blocks.length, cards.length) : null}
      </div>
      ${menu.node}
    </div>`;
}

/* ------------------------------------------------------------------ *
 * Cover and metadata
 * ------------------------------------------------------------------ */

const COVER_FIELDS = [
  { key: 'title', label: S.reportTitle, wide: true },
  { key: 'doc_no', label: S.documentNumber },
  { key: 'version', label: S.version },
  { key: 'secrecy', label: S.secrecy },
  { key: 'date', label: S.date },
  { key: 'stage', label: S.stage },
];

function requiredCoverKeys(cfg) {
  const fields = ((cfg && cfg.cover) || {}).fields || [];
  const keys = fields.filter((f) => f && f.required).map((f) => f.key);
  return keys.length ? keys : ['title'];
}

function coverValue(meta, key) {
  const value = meta ? meta[key] : '';
  if (Array.isArray(value)) return value.join(', ');
  return text(value);
}

export function coverMissing(project, cfg) {
  const meta = (project && project.meta) || {};
  return requiredCoverKeys(cfg).filter((key) => coverValue(meta, key).trim() === '');
}

function labelFor(key) {
  const found = COVER_FIELDS.find((f) => f.key === key);
  if (found) return found.label;
  if (key === 'author') return S.author;
  if (key === 'reviewers') return S.reviewers;
  if (key === 'approver') return S.approver;
  return key;
}

function CoverField(props) {
  const invalid = props.required && text(props.value).trim() === '';
  return html`
    <div class="rw-field" style=${{ width: props.wide ? '404px' : '196px' }}>
      <label class="rw-field__label">
        ${props.label}${props.required ? html`<span class="rw-field__req">*</span>` : null}
      </label>
      <input class=${cx('rw-input', invalid && 'rw-input--invalid')} type="text"
             value=${props.value} aria-label=${props.label}
             onInput=${(ev) => props.onInput(ev.currentTarget.value)} />
      ${invalid ? html`<div class="rw-field__hint rw-field__hint--bad">${S.notFilled}</div>` : null}
    </div>`;
}

function CoverForm(props) {
  const { project, cfg, dir } = props;
  const meta = (project && project.meta) || {};
  const required = requiredCoverKeys(cfg);
  const missing = coverMissing(project, cfg);
  const [reviewerDraft, setReviewerDraft] = useState('');
  const [carrying, setCarrying] = useState(false);

  const setMeta = (key, value) => {
    edit((p) => {
      if (!p.meta) p.meta = {};
      p.meta[key] = value;
    });
  };

  // Copy the empty required fields from the module's most recent other report.
  // Only the empty ones: a field the user already filled is never overwritten.
  const carryOver = async () => {
    const tree = store.get().tree;
    const here = locateReport(tree, dir);
    const siblings = ((here.module && here.module.reports) || [])
      .filter((r) => r.dir !== dir)
      .sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
    if (!siblings.length) return;
    setCarrying(true);
    try {
      const payload = await api.getProject(siblings[0].dir);
      const source = ((payload && payload.project) || payload || {}).meta || {};
      edit((p) => {
        if (!p.meta) p.meta = {};
        missing.forEach((key) => {
          if (source[key] !== undefined && source[key] !== null && source[key] !== '') {
            p.meta[key] = source[key];
          }
        });
      });
    } catch (err) {
      store.pushBanner({ level: 'error', code: 'carry-over', message: String(err && err.message ? err.message : err) });
    } finally {
      setCarrying(false);
    }
  };

  const reviewers = Array.isArray(meta.reviewers) ? meta.reviewers : [];
  const revisions = Array.isArray(meta.revisions) ? meta.revisions : [];

  const setRevision = (index, key, value) => {
    edit((p) => {
      if (!Array.isArray(p.meta.revisions)) p.meta.revisions = [];
      p.meta.revisions[index] = Object.assign({}, p.meta.revisions[index], { [key]: value });
    });
  };

  return html`
    <div class="rw-canvas">
      <div class="rw-canvas__inner">
        ${missing.length ? html`
          <div class="rw-banner rw-banner--attention" role="status">
            <span class="rw-banner__glyph" aria-hidden="true">!</span>
            <div class="rw-banner__body">
              ${missing.length + ' ' + S.requiredEmpty + ' '
                + missing.map(labelFor).join(', ')}
            </div>
            <div class="rw-banner__actions">
              <${Button} level="secondary" disabled=${carrying} onClick=${carryOver}>
                ${S.carryOver}
              <//>
            </div>
          </div>` : null}

        <div class="rw-card" style=${{ marginTop: '12px' }}>
          <div class="rw-card__head"><span class="rw-card__type">${S.documentInformation}</span></div>
          <div class="rw-card__body">
            <div class="rw-btnrow" style=${{ flexWrap: 'wrap', alignItems: 'flex-start', gap: '12px 16px' }}>
              ${COVER_FIELDS.map((field) => html`
                <${CoverField} key=${field.key} label=${field.label} wide=${field.wide}
                               required=${required.indexOf(field.key) !== -1}
                               value=${coverValue(meta, field.key)}
                               onInput=${(value) => setMeta(field.key, value)} />`)}
            </div>
          </div>
        </div>

        <div class="rw-card" style=${{ marginTop: '12px' }}>
          <div class="rw-card__head"><span class="rw-card__type">${S.signatures}</span></div>
          <div class="rw-card__body">
            <div class="rw-btnrow" style=${{ flexWrap: 'wrap', alignItems: 'flex-start', gap: '12px 16px' }}>
              <${CoverField} label=${S.author} required=${required.indexOf('author') !== -1}
                             value=${coverValue(meta, 'author')}
                             onInput=${(value) => setMeta('author', value)} />
              <${CoverField} label=${S.approver} required=${required.indexOf('approver') !== -1}
                             value=${coverValue(meta, 'approver')}
                             onInput=${(value) => setMeta('approver', value)} />
              <div class="rw-field" style=${{ width: '404px' }}>
                <label class="rw-field__label">${S.reviewers}</label>
                <div class="rw-chips">
                  ${reviewers.map((name, i) => html`
                    <span class="rw-chip" key=${i}>
                      ${name}
                      <span class="rw-chip__x" role="button" aria-label=${S.deleteLabel}
                            onClick=${() => edit((p) => { p.meta.reviewers.splice(i, 1); })}>✕</span>
                    </span>`)}
                </div>
                <div class="rw-btnrow">
                  <input class="rw-input" type="text" value=${reviewerDraft}
                         aria-label=${S.reviewers}
                         onInput=${(ev) => setReviewerDraft(ev.currentTarget.value)}
                         onKeyDown=${(ev) => {
                           if (ev.key !== 'Enter' || !reviewerDraft.trim()) return;
                           ev.preventDefault();
                           edit((p) => {
                             if (!Array.isArray(p.meta.reviewers)) p.meta.reviewers = [];
                             p.meta.reviewers.push(reviewerDraft.trim());
                           });
                           setReviewerDraft('');
                         }} />
                  <${Button} level="secondary" disabled=${!reviewerDraft.trim()}
                             onClick=${() => {
                               edit((p) => {
                                 if (!Array.isArray(p.meta.reviewers)) p.meta.reviewers = [];
                                 p.meta.reviewers.push(reviewerDraft.trim());
                               });
                               setReviewerDraft('');
                             }}>${S.add}<//>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="rw-card" style=${{ marginTop: '12px' }}>
          <div class="rw-card__head"><span class="rw-card__type">${S.revisionHistory}</span></div>
          <div class="rw-card__body">
            <div style=${{ display: 'grid', gridTemplateColumns: '120px 140px 160px 1fr', gap: '4px' }}>
              <div class="rw-micro">${S.version}</div>
              <div class="rw-micro">${S.date}</div>
              <div class="rw-micro">${S.author}</div>
              <div class="rw-micro">${S.note}</div>
              ${revisions.map((rev, i) => html`
                <${Fragment} key=${i}>
                  <input class="rw-input" aria-label=${S.version} value=${text(rev.ver)}
                         onInput=${(ev) => setRevision(i, 'ver', ev.currentTarget.value)} />
                  <input class="rw-input" aria-label=${S.date} value=${text(rev.date)}
                         onInput=${(ev) => setRevision(i, 'date', ev.currentTarget.value)} />
                  <input class="rw-input" aria-label=${S.author} value=${text(rev.author)}
                         onInput=${(ev) => setRevision(i, 'author', ev.currentTarget.value)} />
                  <input class="rw-input" aria-label=${S.note} value=${text(rev.note)}
                         onInput=${(ev) => setRevision(i, 'note', ev.currentTarget.value)} />
                <//>`)}
            </div>
            <div class="rw-dashrow" role="button" tabIndex="0"
                 onClick=${() => edit((p) => {
                   if (!Array.isArray(p.meta.revisions)) p.meta.revisions = [];
                   p.meta.revisions.push({ ver: '', date: '', author: '', note: '' });
                 })}>${S.addARow}</div>
          </div>
        </div>
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ *
 * Right panel
 * ------------------------------------------------------------------ */

// The panel's content belongs to views/preview.js, which publishes RightPanel
// and renders the collapsed strip itself. This frame owns only the column's
// width, so a missing module still leaves a usable three-pane layout.
function RightPane(props) {
  const ui = useStore((s) => s.ui);
  const open = !ui || ui.rightOpen !== false;
  const mod = useOptionalModule('./preview.js');
  const RightPanel = pickExport(mod, ['RightPanel']);

  const body = RightPanel
    ? html`<${RightPanel} dir=${props.dir} />`
    : open
      ? html`
        <${Fragment}>
          <div class="rw-right__head">
            <div class="rw-tabs">
              <button type="button" class="rw-tabs__item rw-tabs__item--on">${S.preview}</button>
              <button type="button" class="rw-tabs__item">${S.check}</button>
            </div>
            <span class="rw-spacer"></span>
            <${IconButton} glyph="›" title=${S.collapse}
                           onClick=${() => store.setUi({ rightOpen: false })} />
          </div>
          <div class="rw-right__body"><${Unavailable} /></div>
        <//>`
      : html`
        <div class="rw-rightstrip" role="button" tabIndex="0" title=${S.expand}
             onClick=${() => store.setUi({ rightOpen: true })}>
          <span class="rw-rightstrip__label">${S.preview}</span>
          ${props.overSpec > 0
            ? html`<span class="rw-rightstrip__count">${props.overSpec}</span>`
            : null}
        </div>`;

  return html`
    <aside class=${cx('rw-editor__right', !open && 'rw-editor__right--collapsed')}>
      ${body}
    </aside>`;
}

/* ------------------------------------------------------------------ *
 * New report, started from the stage strip's '+'
 * ------------------------------------------------------------------ */

function NewReportDialog(props) {
  const { here, dir } = props;
  const used = ((here.module && here.module.reports) || [])
    .map((r) => String(r.stage || '').toUpperCase());
  const free = STAGES.filter((s) => used.indexOf(s) === -1);
  const [stage, setStage] = useState(free[0] || STAGES[0]);
  const [mode, setMode] = useState(dir ? 'inherit' : 'template');
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (!here.project || !here.module) return;
    setBusy(true);
    try {
      const result = await api.reportNew({
        project: here.project.id,
        module: here.module.id,
        stage: stage,
        mode: mode,
        from: mode === 'inherit' ? dir : undefined,
        clearValues: true,
      });
      try {
        store.set({ tree: await api.getTree() });
      } catch (err) { /* the shelf refreshes on its own next time */ }
      if (result && result.dir) store.navigate({ view: 'editor', dir: result.dir, node: null });
      props.onClose();
    } catch (err) {
      store.pushBanner({
        level: 'error', code: 'report-new',
        message: String(err && err.message ? err.message : err),
      });
      setBusy(false);
    }
  };

  return html`
    <${Dialog} title=${S.newReport} width=${460} onClose=${props.onClose} scrimCloses=${false}
      footer=${html`
        <${Button} level="tertiary" onClick=${props.onClose}>${S.cancel}<//>
        <${Button} level="primary" disabled=${busy} onClick=${create}>${S.createReport}<//>`}>
      <div class="rw-formgrid rw-formgrid--full">
        <div class="rw-field">
          <label class="rw-field__label">${S.stage}</label>
          <select class="rw-select" value=${stage} aria-label=${S.stage}
                  onChange=${(ev) => setStage(ev.currentTarget.value)}>
            ${(free.length ? free : STAGES).map((s) => html`
              <option key=${s} value=${s}>${s}</option>`)}
          </select>
        </div>
        <div class="rw-field">
          <label class="rw-field__label">${S.startFrom}</label>
          <select class="rw-select" value=${mode} aria-label=${S.startFrom}
                  onChange=${(ev) => setMode(ev.currentTarget.value)}>
            <option value="inherit">${S.inheritFrom}</option>
            <option value="template">${S.blankFromTemplate}</option>
          </select>
        </div>
      </div>
    <//>`;
}

/* ------------------------------------------------------------------ *
 * Drawers owned by views/sync.js
 * ------------------------------------------------------------------ */

function SideDrawer(props) {
  const mod = useOptionalModule('./sync.js');
  const whole = pickExport(mod, props.kind === 'history'
    ? ['HistoryDrawer'] : ['SyncDrawer', 'ExchangeDrawer']);
  const panel = pickExport(mod, props.kind === 'history'
    ? ['HistoryPanel', 'History'] : ['ExchangePanel', 'SyncPanel', 'TextExchange']);

  if (whole) return html`<${whole} dir=${props.dir} onClose=${props.onClose} />`;
  return html`
    <${Drawer} title=${props.kind === 'history' ? S.history : S.textExchange}
               onClose=${props.onClose}>
      ${panel ? html`<${panel} dir=${props.dir} />` : html`<${Unavailable} />`}
    <//>`;
}

/* ------------------------------------------------------------------ *
 * Copying a section out as plain text
 * ------------------------------------------------------------------ */

// The channel to the work machine carries text only, so a section leaves as
// text: headings, prose, and a line naming each figure and table so the other
// side knows what sits where. Values inside a compliance table stay in the
// report; this is a reading copy, not an exchange package.
function sectionAsText(node, number) {
  const lines = [];
  const walk = (n, prefix) => {
    lines.push(prefix + ' ' + (text(n.title) || S.untitledSection));
    const blocks = n.blocks || [];
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (!block) continue;
      if (block.type === 'para') {
        const line = (block.runs || []).map((run) => text(run.t)).join('');
        if (line.trim()) lines.push(line);
      } else if (block.type === 'image' || block.type === 'imagegrid') {
        lines.push('[' + BLOCK_TYPE_LABEL[block.type] + '] ' + text(block.caption));
      } else if (block.type === 'table' || block.type === 'datatable') {
        lines.push('[' + BLOCK_TYPE_LABEL[block.type] + '] ' + text(block.caption));
      }
    }
    const children = n.children || [];
    for (let i = 0; i < children.length; i++) walk(children[i], prefix + '.' + (i + 1));
  };
  walk(node, number);
  return lines.join('\n');
}

async function copyText(value) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch (err) { /* fall through to the textarea path */ }
  try {
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', 'readonly');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch (err) {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * The screen
 * ------------------------------------------------------------------ */

export function Editor(props) {
  const route = useStore((s) => s.route);
  const project = useStore((s) => s.project);
  const cfg = useStore((s) => s.cfg);
  const ui = useStore((s) => s.ui);
  const tree = useStore((s) => s.tree);

  const dir = (props.route && props.route.dir) || (route && route.dir) || null;
  const [selectedBlock, setSelectedBlock] = useState(null);
  const [selectedStart, setSelectedStart] = useState(-1);
  const [caret, setCaret] = useState(null);
  const [caretTick, setCaretTick] = useState(0);
  const [toast, setToast] = useState(null);
  const [drawer, setDrawer] = useState(null);
  const [newReport, setNewReport] = useState(false);
  // Editing marks live on store.ui.marks -- the key views/blocks.js reads when it
  // draws the pilcrows -- so the toolbar's toggle, the overflow menu's entry and
  // a card's own toggle are all one switch.
  const editingMarks = !!(ui && ui.marks);

  const searchRef = useRef(null);
  const canvasRef = useRef(null);

  const rows = useMemo(() => flattenOutline(project && project.outline), [project]);
  const here = useMemo(() => locateReport(tree, dir), [tree, dir]);
  const missing = useMemo(() => coverMissing(project, cfg), [project, cfg]);
  const overSpec = useMemo(() => countOverSpec(project), [project]);

  const nodeId = (route && route.node) || null;
  const currentRow = nodeId && nodeId !== COVER_NODE ? findRow(rows, nodeId) : null;
  const rowIndex = currentRow ? rows.indexOf(currentRow) : -1;

  const previewMod = useOptionalModule('./preview.js');
  // views/preview.js's ExportMenu already mounts the export dialog, so mounting
  // it here as well would stack two of them; it is only needed when the header
  // is falling back to this file's own Export control.
  const ExportDialog = pickExport(previewMod, ['ExportMenu'])
    ? null : pickExport(previewMod, ['ExportDialog']);
  const assetsMod = useOptionalModule('./assets.js');
  const AssetTray = pickExport(assetsMod, ['AssetTray']);
  const blocksMod = useOptionalModule('./blocks.js');
  // views/blocks.js publishes the cover form's fields alongside the block cards,
  // so the form matches the cards it sits next to; the one in this file is the
  // fallback for when that module is not there.
  const TheirCoverForm = pickExport(blocksMod, ['CoverForm']);

  const select = useCallback((id) => {
    if (!dir) return;
    store.navigate({ view: 'editor', dir: dir, node: id });
    store.setUi({ cursorNode: id, cursorBlock: null });
    setSelectedBlock(null);
    setSelectedStart(-1);
  }, [dir]);

  /* ---- land on a section when the address names none ---- */
  useEffect(() => {
    if (!dir || !project) return;
    if (nodeId) return;
    const remembered = store.lastNodeFor(dir);
    const fallback = rows.length ? rows[0].node.id : COVER_NODE;
    const target = remembered && (remembered === COVER_NODE || findRow(rows, remembered))
      ? remembered : fallback;
    store.navigate({ view: 'editor', dir: dir, node: target });
  }, [dir, project, nodeId, rows.length]);

  /* ---- the caret, for the format toolbar and the preview's follow ---- */
  useEffect(() => {
    const onSelectionChange = () => {
      const next = readCaret(canvasRef.current);
      setCaret(next);
      setCaretTick((n) => n + 1);
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, []);

  /* ---- a jump requested by the preview or the checklist ---- */
  useEffect(() => {
    const target = ui && ui.focusBlock;
    if (!target) return;
    setSelectedBlock(target);
    const el = document.querySelector('[data-block-id="' + target + '"]');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' });
  }, [ui && ui.focusBlock, ui && ui.focusAt]);

  /* ---- deleting, with an undo ---- */

  const deleteCard = (start, count) => {
    const node = currentRow && currentRow.node;
    if (!node) return;
    const removed = (node.blocks || []).slice(start, start + count);
    edit(() => { node.blocks.splice(start, count); });
    setSelectedBlock(null);
    setSelectedStart(-1);
    setToast({
      text: S.blockDeleted,
      action: S.undo,
      onAction: () => {
        edit(() => { node.blocks.splice(start, 0, ...removed); });
        setToast(null);
      },
    });
  };

  const duplicateCard = (start, count) => {
    const node = currentRow && currentRow.node;
    if (!node) return;
    const copies = (node.blocks || []).slice(start, start + count)
      .map((block) => {
        const copy = JSON.parse(JSON.stringify(block));
        if (copy.id) copy.id = uid();
        return copy;
      });
    edit(() => { node.blocks.splice(start + count, 0, ...copies); });
  };

  const deleteSection = (row) => {
    const list = row.siblings;
    const at = list.indexOf(row.node);
    if (at === -1) return;
    const neighbour = list[at + 1] || list[at - 1] || (row.parent || null);
    edit(() => { list.splice(at, 1); });
    select(neighbour && neighbour.id ? neighbour.id : COVER_NODE);
    setToast({
      text: S.sectionDeleted,
      action: S.undo,
      onAction: () => {
        edit(() => { list.splice(at, 0, row.node); });
        select(row.node.id);
        setToast(null);
      },
    });
  };

  /* ---- keyboard ---- */
  useEffect(() => {
    const onKeyDown = (ev) => {
      const target = ev.target;
      const inField = !!(target && target.closest
        && target.closest('input,textarea,select,[contenteditable="true"]'));

      if ((ev.ctrlKey || ev.metaKey) && (ev.key === 's' || ev.key === 'S')) {
        ev.preventDefault();
        store.saveNow();
        return;
      }
      if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'f' || ev.key === 'F')) {
        ev.preventDefault();
        if (searchRef.current) searchRef.current.focus();
        return;
      }
      if (ev.altKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) {
        if (!rows.length) return;
        ev.preventDefault();
        const step = ev.key === 'ArrowUp' ? -1 : 1;
        const next = rowIndex === -1
          ? (step > 0 ? 0 : rows.length - 1)
          : Math.max(0, Math.min(rows.length - 1, rowIndex + step));
        select(rows[next].node.id);
        return;
      }
      if (ev.key === 'Escape') {
        if (inField && target.blur) {
          target.blur();
          return;
        }
        if (newReport) { setNewReport(false); return; }
        if (drawer) { setDrawer(null); return; }
        if (ui && ui.rightOpen === false) return;
        return;
      }
      if (ev.key === 'Delete' && !inField && selectedStart >= 0) {
        ev.preventDefault();
        const node = currentRow && currentRow.node;
        const blocks = (node && node.blocks) || [];
        const block = blocks[selectedStart];
        let count = 1;
        if (block && block.type === 'para') {
          count = 0;
          for (let i = selectedStart; i < blocks.length; i++) {
            if (blocks[i].type !== 'para') break;
            if (i > selectedStart && blocks[i].cardStart) break;
            count += 1;
          }
        }
        deleteCard(selectedStart, Math.max(1, count));
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [rows, rowIndex, selectedBlock, selectedStart, currentRow, drawer, newReport, ui]);

  /* ---- header actions ---- */

  const jumpOverSpec = () => {
    const hit = firstOverSpec(project);
    if (!hit) return;
    select(hit.node.id);
    setSelectedBlock(hit.block.id || null);
    store.setUi({
      cursorNode: hit.node.id,
      cursorBlock: hit.block.id || null,
      focusBlock: hit.block.id || null,
      focusAt: Date.now(),
      focusCell: hit.position,
    });
  };

  const copySection = async () => {
    if (!currentRow) return;
    const ok = await copyText(sectionAsText(currentRow.node, currentRow.number));
    if (ok) setToast({ text: S.copied });
  };

  if (!dir) return html`<div class="rw-app"></div>`;
  if (!project) {
    return html`
      <div class="rw-app" style=${{ height: '100vh' }}>
        <div class="rw-canvas"><div class="rw-canvas__inner">${S.loading}</div></div>
      </div>`;
  }

  const showCover = nodeId === COVER_NODE || (!currentRow && nodeId === null);

  return html`
    <div class="rw-app" style=${{ height: '100vh' }}>
      <${Header}
        dir=${dir} project=${project} cfg=${cfg}
        onJumpOverSpec=${jumpOverSpec}
        onExchange=${() => setDrawer('exchange')}
        onHistory=${() => setDrawer('history')}
        onNewReport=${() => setNewReport(true)}
        onExportUnavailable=${() => setDrawer('export')} />

      <div class="rw-shell" style=${{ minWidth: 0 }}>
        <div class="rw-editor" style=${{ minWidth: 0 }}>
          <${OutlineRail}
            project=${project} dir=${dir} selectedId=${nodeId}
            coverMissing=${missing.length}
            searchRef=${searchRef}
            onSelect=${select}
            onDeleteSection=${deleteSection} />

          <div class="rw-editor__centre">
            ${showCover
              ? html`
                <${Fragment}>
                  <div class="rw-sectionbar">
                    <span class="rw-sectionbar__title">${S.coverAndMetadata}</span>
                    ${missing.length
                      ? html`<${Pill} tone="warn">${missing.length + ' ' + S.missing}<//>`
                      : null}
                  </div>
                  ${TheirCoverForm
                    ? html`<${TheirCoverForm} project=${project} cfg=${cfg} dir=${dir} />`
                    : html`<${CoverForm} project=${project} cfg=${cfg} dir=${dir} />`}
                <//>`
              : currentRow
                ? html`
                  <${Fragment}>
                    <${SectionBar}
                      row=${currentRow} rows=${rows}
                      hasPrev=${rowIndex > 0} hasNext=${rowIndex < rows.length - 1}
                      onPrev=${() => rowIndex > 0 && select(rows[rowIndex - 1].node.id)}
                      onNext=${() => rowIndex < rows.length - 1 && select(rows[rowIndex + 1].node.id)}
                      onCopySection=${copySection} />
                    <${FormatToolbar}
                      caret=${caret} caretTick=${caretTick} node=${currentRow.node}
                      marks=${editingMarks}
                      onMarks=${(on) => store.setUi({ marks: on })} />
                    <${Canvas}
                      node=${currentRow.node} dir=${dir} cfg=${cfg} project=${project}
                      canvasRef=${canvasRef}
                      editingHere=${!!caret}
                      editingMarks=${editingMarks}
                      selectedBlock=${selectedBlock}
                      selectedStart=${selectedStart}
                      onSelectBlock=${(id, start) => {
                        setSelectedBlock(id || null);
                        setSelectedStart(start === undefined ? -1 : start);
                        if (id) store.setUi({ cursorNode: nodeId, cursorBlock: id });
                      }}
                      onDeleteCard=${deleteCard}
                      onDuplicateCard=${duplicateCard} />
                  <//>`
                : html`<div class="rw-canvas"></div>`}
            ${AssetTray ? html`<${AssetTray} dir=${dir} />` : null}
          </div>

          <${RightPane} dir=${dir} overSpec=${overSpec} />
        </div>
      </div>

      ${drawer === 'exchange' || drawer === 'history'
        ? html`<${SideDrawer} kind=${drawer} dir=${dir} onClose=${() => setDrawer(null)} />`
        : null}
      ${drawer === 'export'
        ? html`
          <${Dialog} title=${S.exportWordPdf} onClose=${() => setDrawer(null)}>
            <${Unavailable} />
          <//>`
        : null}
      ${newReport
        ? html`<${NewReportDialog} here=${here} dir=${dir} onClose=${() => setNewReport(false)} />`
        : null}
      ${ExportDialog ? html`<${ExportDialog} />` : null}
      ${toast
        ? html`<${Toast} text=${toast.text} action=${toast.action || null}
                         onAction=${toast.onAction || null}
                         onDismiss=${() => setToast(null)} />`
        : null}
    </div>`;
}

export default Editor;
