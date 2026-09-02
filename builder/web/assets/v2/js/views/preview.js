/*
 * Report Workbench - the editor's right panel (Preview + Check) and the export
 * dialog.
 *
 * Owner of: the 432px right panel, both of its tabs, the export flow.
 *
 * WHAT THIS FILE PROVIDES TO js/views/editor.js
 * ---------------------------------------------
 *   <RightPanel dir=... />     the whole panel, including the collapsed strip.
 *                              Reads store.ui.rightOpen / store.ui.rightTab, so
 *                              the editor only has to mount it.
 *   <ExportDialog />           mount once anywhere; it renders itself only while
 *                              store.overlay.kind === 'export'.
 *   <ExportMenu dir=... />     the header's `Export` control, ready to drop in.
 *   <ExportChip />             the chip a background export leaves behind: progress
 *                              while it runs, then the finish, and it stays - and
 *                              reopens the result - until the user dismisses it.
 *   openExport(dir, fmt)       starts an export and opens the dialog.
 *   selectBlock(dir, node, id) the "go to this block" call the checklist and the
 *                              preview's Jump to editor use.
 *   checkReport(project, cfg)  the standing checklist, as pure data.
 *
 * THE CARET CONTRACT (how the preview follows the editor)
 * -------------------------------------------------------
 * The preview scrolls to whatever the editor says the caret is in. The editor
 * publishes that as two additive keys on store.ui:
 *
 *   store.setUi({ cursorNode: <outline node id>, cursorBlock: <block id> })
 *
 * Neither is required: with no cursorBlock the panel follows store.route.node,
 * which the outline already sets. Every change to either counts as "the caret
 * moved", which re-attaches the follow. Scrolling the preview by hand releases
 * it until the next caret move.
 *
 * When the user asks to jump the other way, this file writes:
 *
 *   store.setUi({ cursorNode, cursorBlock, focusBlock, focusAt: <epoch ms> })
 *
 * `focusBlock` + `focusAt` are the editor's cue to select and scroll to that
 * block; `focusAt` changes on every request so repeating the same jump still
 * fires. Ignoring them costs only the scroll, never correctness.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * -----------------------------
 * No separate continuous-read mode - the preview's scroll IS that. No verdict
 * state of any kind: the only thing this file colours is a value that violates
 * its spec. No "flag as doubtful". No appendix generation.
 */

import { store, useStore } from '../store.js';
import * as api from '../api.js';
// numericValue is imported alongside the rule it feeds: this file must never
// grow a second numeric parser, and the pinned test reads this line.
import { computeCaptionNumbers, formatBytes, classNames, numericValue, simAxisValues, axisValue, flagsFrom } from '../util.js';
import {
  html, Fragment, Button, IconButton, SegmentedControl, Dialog, Banner,
  EmptyState, Pill, Spinner, Menu, Toast,
  useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback,
} from '../components/index.js';

/* ------------------------------------------------------------------ *
 * Frozen strings.
 *
 * Every user-facing string this file can show is here, spelled exactly as the
 * glossary spells it. Nothing below builds a sentence out of fragments; a
 * placeholder is filled by fmt() and nothing else.
 *
 * The glossary uses an em dash between two clauses, an en dash inside a page
 * range and a single ellipsis character. This source file stays ASCII, so those
 * three characters are composed from their code points and spliced in rather
 * than typed.
 * ------------------------------------------------------------------ */

const EN = String.fromCharCode(0x2013);   // en dash, page ranges
const EM = String.fromCharCode(0x2014);   // em dash, clause separator
const DOTS = String.fromCharCode(0x2026); // ellipsis
const MID = ' ' + EM + ' ';               // the glossary's clause separator
const SEP = ' ' + String.fromCharCode(0x00b7) + ' '; // middle dot list separator

const S = {
  preview: 'Preview',
  check: 'Check',
  approximate: 'Approximate layout',
  proof: 'Proof this section',
  seconds: '{n}s',
  approxNote: 'Approximate layout' + MID + 'pagination and fonts differ from the exported file',
  proofTitle: 'This section, rendered by Word',
  proofRendering: 'Rendering this section' + DOTS,
  staleProof: 'These pages are the last saved version' + MID
    + 'the edits that are only in this page are not in them',
  pageOf: 'Page {n} of {m}',
  following: 'Following the cursor',
  wholeReport: 'Whole report',
  jumpToEditor: 'Jump to editor',
  approxOnly: 'Approximate layout only' + MID + 'the exported file is the authority on pagination',
  wordMissing: 'Word is not available on this machine' + MID + 'approximate layout only',
  pagesRange: 'Pages {a}' + EN + '{b}' + SEP + 'the whole report takes about {n}s' + MID + 'use Export',

  errors: 'Errors',
  warnings: 'Warnings',
  notes: 'Notes',
  nothingToFix: 'Nothing to fix',
  standing: 'Standing checklist' + MID + 'you do not need to export to see it',
  goTo: 'Go to',
  counts: '{e} errors' + SEP + '{w} warnings',

  exportLabel: 'Export',
  exportBoth: 'Export Word and PDF',
  exportWordOnly: 'Export Word only',
  exportingBoth: 'Exporting Word and PDF',
  exportingWord: 'Exporting Word',
  snapshotNote: 'The export is a snapshot of the moment you pressed the button'
    + MID + 'you can keep editing.',
  stepCollect: 'Collecting content and figures' + SEP + '{n} blocks',
  stepRender: 'Rendering Word' + SEP + 'block {i} of {n} ({section})',
  stepConvert: 'Converting to PDF' + SEP + 'this step has no progress',
  runBackground: 'Run in the background',
  cancelExport: 'Cancel export',
  finishedPages: 'Export finished' + SEP + '{n} pages',
  finished: 'Export finished',
  timings: 'Word {a}s' + SEP + 'PDF {b}s' + SEP + '{c}s total',
  timingsWord: 'Word {a}s' + SEP + '{c}s total',
  openFile: 'Open file',
  openFolder: 'Open folder',
  olderThanDoc: 'Older than the document' + MID + 'left by an earlier export',
  copyPath: 'Copy path',
  copied: 'Copied',
  exportChecks: "This export's checks: {e} errors" + SEP + '{w} warnings',
  backToEditing: 'Back to editing',
  notExported: 'Not exported' + MID + 'this report is not saved',
  notExportedBody: 'The last save did not reach the disk, so the exported file would be the '
    + 'last saved version, without the edits that exist only in this page. The save keeps '
    + 'retrying; export once it reports Saved.',
  exportAnyway: 'Export anyway' + MID + 'the file is the last saved version',
  staleExport: 'Exported from the last saved version' + MID
    + 'the edits that are only in this page are not in it',

  somethingWrong: 'Something went wrong',
  retry: 'Retry',
  close: 'Close',
  loading: 'Loading' + DOTS,
};

// fmt('Page {n} of {m}', {n: 2, m: 7}) -> 'Page 2 of 7'. Values are inserted
// verbatim: nothing rewrites them, so a section title keeps its own punctuation.
function fmt(template, values) {
  const v = values || {};
  return String(template).replace(/\{(\w+)\}/g, (all, key) => (
    v[key] === undefined || v[key] === null ? all : String(v[key])
  ));
}

const T = (key, values) => fmt(S[key], values);

/* ================================================================== *
 * 1 - the outline, flattened
 * ================================================================== */

// Document order, with the section number path each section carries in the
// exported file. Mirrors how content_lint numbers a location: top-level sections
// are 1..n, children append '.k'.
export function flattenOutline(outline) {
  const out = [];
  const walk = (node, path, depth) => {
    if (!node || typeof node !== 'object') return;
    out.push({
      id: node.id || path,
      node: node,
      loc: path,
      title: String(node.title == null ? '' : node.title),
      depth: depth,
      blocks: Array.isArray(node.blocks) ? node.blocks : [],
      fixedBody: !!node.fixed_body,
    });
    const kids = node.children || [];
    for (let i = 0; i < kids.length; i++) walk(kids[i], path + '.' + (i + 1), depth + 1);
  };
  const roots = outline || [];
  for (let i = 0; i < roots.length; i++) walk(roots[i], String(i + 1), 0);
  return out;
}

// Which flattened section holds a given block id.
function sectionOfBlock(sections, blockId) {
  if (!blockId) return null;
  for (let i = 0; i < sections.length; i++) {
    const blocks = sections[i].blocks;
    for (let j = 0; j < blocks.length; j++) {
      if (blocks[j] && blocks[j].id === blockId) return sections[i];
    }
  }
  return null;
}

/* ================================================================== *
 * 2 - the standing checklist
 *
 * A faithful port of core/content_lint.py: same rule ids, same levels, same
 * sentences. It runs in the browser so the Check tab stands on its own - the
 * server only produces these findings as part of an export, and the tab must not
 * make the user export to see them.
 *
 * The two rules that need a disk are left to the server: missing_image (is the
 * file really there) and missing_logo. They arrive with the render manifest
 * after an export and merge in below, de-duplicated against these.
 * ================================================================== */

const LINT_LEVELS = {
  // render-manifest types
  block_error: 'error',
  missing_image: 'warn',
  missing_logo: 'warn',
  no_caption: 'warn',
  row_clip_risk: 'warn',
  // A cross-reference whose target is gone does not merely look odd: the
  // renderer writes a red "[ref: <id>]" marker into the sentence, so the
  // exported document says something the author never wrote.
  dangling_ref: 'error',
  table_warning: 'warn',
  sim_span_unmergeable: 'error',
  // structural codes
  datatable_no_data: 'error',
  table_no_rows: 'error',
  row_missing_key: 'error',
  image_path: 'error',
  free_table_bounds: 'error',
  no_setting_rows: 'warn',
  limit_no_flag: 'warn',
  empty_sim_result: 'warn',
  empty_section: 'warn',
  unknown_sim_key: 'warn',
  duplicate_id: 'error',
  image_placeholder: 'info',
  unit_empty: 'info',
};

// Verbatim from the message table content_lint.py freezes. Placeholders keep the
// same spelling so the two tables can be diffed by eye.
const LINT_MESSAGES = {
  'image_path.absolute':
    'Image file is an absolute path: "%(file)s". Store the file under images/ '
    + 'and reference it as images/<name>',
  'image_path.escapes':
    'Image file points outside the report with "..": "%(file)s"',
  'image_path.outside':
    'Image file is not under images/: "%(file)s"',
  'image_placeholder.blank':
    'Image has no file yet - it is an empty frame waiting for a picture',
  'missing_image.not_found':
    'Image file "%(file)s" is missing from the report folder',
  'no_caption.image':
    'Image has no caption',
  'no_caption.imagegrid':
    'Image grid has no caption',
  'table_no_rows.missing':
    'Table has no rows',
  'table_no_rows.not_list':
    'Table rows are not a list of rows',
  'free_table_bounds.merge':
    'Merged cell at row %(r)s column %(c)s spanning %(rs)s x %(cs)s reaches '
    + 'outside this %(nrows)s x %(ncols)s table',
  'free_table_bounds.fill':
    'Row shading is set for row %(idx)s, but this table has only %(nrows)s rows',
  'datatable_no_data.block':
    'Compliance table has no data',
  'datatable_no_data.rows':
    'Compliance table data has no rows',
  'row_missing_key.not_object':
    'Row %(i)s is not a row object',
  'row_missing_key.missing':
    'Row %(i)s ("%(item)s") is missing: %(keys)s',
  'no_setting_rows.none':
    'Compliance table has no setting rows - add the test conditions at the '
    + 'top of the table',
  'limit_no_flag.blank':
    'Result row "%(item)s" has a spec but no limit set - this row is never '
    + 'marked over spec',
  'empty_sim_result.blank':
    'Result row "%(item)s" has no simulation values yet',
  'unit_empty.blank':
    'Result row "%(item)s" has an empty unit',
  'unknown_sim_key.undeclared':
    'Row %(i)s uses simulation column "%(key)s", which this table does not '
    + 'declare',
  'sim_span_unmergeable.thin':
    'A row spans the simulation columns, but simulation group(s) %(keys)s have '
    + 'fewer than two columns - there is nothing to merge',
  'empty_section.none':
    'Section is empty - no text, no figures, no tables',
  'dangling_ref.missing':
    'A cross-reference in this paragraph points at a figure or table that no '
    + 'longer exists - the export prints a red marker there',
  'duplicate_id.block':
    'Block id "%(id)s" is also used by another block at %(other)s - captions '
    + 'and cross-references cannot tell them apart',
  'duplicate_id.section':
    'Section id "%(id)s" is also used by another section at %(other)s',
};

const REQUIRED_ROW_KEYS = ['cat', 'item', 'kind', 'unit'];
const DEFAULT_AXES = ['MIN', 'TYP', 'MAX', 'NTWC'];
const DEFAULT_SETTING_KINDS = ['common_setting', 'module_setting', 'tb'];

function lintMessage(id, kw) {
  const tpl = LINT_MESSAGES[id];
  if (tpl === undefined) return id;
  const v = kw || {};
  return tpl.replace(/%\((\w+)\)[sdf]/g, (all, key) => (
    v[key] === undefined || v[key] === null ? '' : String(v[key])
  ));
}

function isEmptyValue(v) {
  return v === null || v === undefined || v === '';
}

function asList(v) {
  return Array.isArray(v) ? v.slice() : [];
}

function rowSimValues(row) {
  const vals = [];
  const sims = row.sims;
  if (sims && typeof sims === 'object' && Object.keys(sims).length) {
    const keys = Object.keys(sims);
    for (let i = 0; i < keys.length; i++) {
      const sv = sims[keys[i]];
      if (sv && typeof sv === 'object') {
        Array.prototype.push.apply(vals, asList(sv.mtm));
        vals.push(sv.ntwc);
      }
    }
  } else {
    Array.prototype.push.apply(vals, asList(row.sim_mtm));
    vals.push(row.sim_ntwc);
  }
  return vals;
}

function rowHasSpec(row) {
  if (!isEmptyValue(row.spec)) return true;
  const sm = asList(row.spec_mtm);
  for (let i = 0; i < sm.length; i++) if (!isEmptyValue(sm[i])) return true;
  return !isEmptyValue(row.spec_ntwc);
}

function axisCount(sim, defaultAxes) {
  const ax = sim && typeof sim === 'object' ? sim.axes : null;
  return Array.isArray(ax) ? ax.length : defaultAxes.length;
}

function lintImageFile(file, add) {
  if (!file) {
    add('image_placeholder', 'image_placeholder.blank');
    return;
  }
  const f = String(file).replace(/\\/g, '/');
  if (f.charAt(0) === '/' || (f.length >= 2 && f.charAt(1) === ':')) {
    add('image_path', 'image_path.absolute', { file: file });
  } else if (f.split('/').indexOf('..') >= 0) {
    add('image_path', 'image_path.escapes', { file: file });
  } else if (f.indexOf('images/') !== 0) {
    add('image_path', 'image_path.outside', { file: file });
  }
  // "is the file really on disk" needs the server; it arrives with the render
  // manifest as missing_image.
}

function lintFreeTable(block, rows, add) {
  if (!Array.isArray(rows)) {
    add('table_no_rows', 'table_no_rows.not_list');
    return;
  }
  const nrows = rows.length;
  let ncols = 0;
  for (let i = 0; i < rows.length; i++) {
    if (Array.isArray(rows[i]) && rows[i].length > ncols) ncols = rows[i].length;
  }
  const merges = block.merges || [];
  for (let i = 0; i < merges.length; i++) {
    const m = merges[i];
    if (!m || typeof m !== 'object') continue;
    const r = m.r || 0;
    const c = m.c || 0;
    const rs = m.rs === undefined ? 1 : m.rs;
    const cs = m.cs === undefined ? 1 : m.cs;
    if (r < 0 || c < 0 || r + rs > nrows || c + cs > ncols) {
      add('free_table_bounds', 'free_table_bounds.merge',
        { r: r, c: c, rs: rs, cs: cs, nrows: nrows, ncols: ncols });
    }
  }
  const rf = block.row_fills;
  if (rf && typeof rf === 'object' && !Array.isArray(rf)) {
    const keys = Object.keys(rf);
    for (let i = 0; i < keys.length; i++) {
      const ki = parseInt(keys[i], 10);
      if (isNaN(ki)) continue;
      if (ki < 0 || ki >= nrows) {
        add('free_table_bounds', 'free_table_bounds.fill', { idx: keys[i], nrows: nrows });
      }
    }
  }
}

function lintDatatable(data, add, defaultAxes, settingKinds) {
  const rows = data.rows;
  if (!Array.isArray(rows)) {
    add('datatable_no_data', 'datatable_no_data.rows');
    return;
  }
  const sims = (data.sims || []).filter((s) => s && typeof s === 'object');
  const simKeys = Object.create(null);
  for (let i = 0; i < sims.length; i++) if (sims[i].key) simKeys[sims[i].key] = 1;

  let hasSetting = false;
  let anySimSpan = false;
  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri];
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      add('row_missing_key', 'row_missing_key.not_object', { i: ri });
      continue;
    }
    const missing = REQUIRED_ROW_KEYS.filter((k) => !(k in row));
    if (missing.length) {
      add('row_missing_key', 'row_missing_key.missing',
        { i: ri, item: row.item === undefined ? '' : row.item, keys: missing.join(', ') });
    }
    if (settingKinds.indexOf(row.kind) >= 0) {
      hasSetting = true;
    } else {
      if (isEmptyValue(row.limit) && rowHasSpec(row)) {
        add('limit_no_flag', 'limit_no_flag.blank',
          { item: row.item === undefined ? '' : row.item });
      }
      if (rowSimValues(row).every(isEmptyValue)) {
        add('empty_sim_result', 'empty_sim_result.blank',
          { item: row.item === undefined ? '' : row.item });
      }
      if ('unit' in row && row.unit === '') {
        add('unit_empty', 'unit_empty.blank', { item: row.item === undefined ? '' : row.item });
      }
    }
    const rsims = row.sims;
    if (rsims && typeof rsims === 'object' && Object.keys(simKeys).length) {
      const keys = Object.keys(rsims);
      for (let k = 0; k < keys.length; k++) {
        if (!simKeys[keys[k]]) {
          add('unknown_sim_key', 'unknown_sim_key.undeclared', { i: ri, key: keys[k] });
        }
      }
    }
    if (row.sim_span) anySimSpan = true;
  }

  if (rows.length && !hasSetting) add('no_setting_rows', 'no_setting_rows.none');

  if (anySimSpan) {
    let thin;
    if (sims.length) {
      thin = sims.filter((s) => axisCount(s, defaultAxes) < 2).map((s) => s.key || '(unnamed)');
    } else {
      thin = defaultAxes.length < 2 ? ['(default)'] : [];
    }
    if (thin.length) {
      add('sim_span_unmergeable', 'sim_span_unmergeable.thin', { keys: thin.join(', ') });
    }
  }
}

// The block ids a cross-reference can resolve to. Mirrors content_lint's
// _ref_targets, which mirrors engine._collect_ref_targets: an image or image
// grid is a target whether or not it carries a caption (the render bookmarks it
// either way), a table only once it has one, a block with no id never is, and a
// section with a fixed_body contributes none of its own blocks.
function refTargets(outline) {
  const ids = {};
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (!node.fixed_body) {
      const blocks = node.blocks || [];
      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        if (!block || typeof block !== 'object' || !block.id) continue;
        if (block.type === 'image' || block.type === 'imagegrid') ids[block.id] = true;
        else if ((block.type === 'table' || block.type === 'datatable') && block.caption) {
          ids[block.id] = true;
        }
      }
    }
    const kids = node.children || [];
    for (let i = 0; i < kids.length; i++) walk(kids[i]);
  };
  const roots = outline || [];
  for (let i = 0; i < roots.length; i++) walk(roots[i]);
  return ids;
}

// A run carrying `ref` must point at a live target -- see refTargets.
function lintRefs(block, add, targets) {
  if (!targets) return;
  const runs = block.runs || [];
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (!run || typeof run !== 'object') continue;
    if (run.ref && !targets[run.ref]) add('dangling_ref', 'dangling_ref.missing');
  }
}

function lintBlock(block, add, defaultAxes, settingKinds, targets) {
  const bt = block.type;
  if (bt === 'para') {
    lintRefs(block, add, targets);
  } else if (bt === 'image') {
    lintImageFile(block.file, add);
    if (!String(block.caption || '').trim()) add('no_caption', 'no_caption.image');
  } else if (bt === 'imagegrid') {
    const items = block.items || [];
    for (let i = 0; i < items.length; i++) {
      if (items[i] && typeof items[i] === 'object') lintImageFile(items[i].file, add);
    }
    if (!String(block.caption || '').trim()) add('no_caption', 'no_caption.imagegrid');
  } else if (bt === 'table') {
    if (block.rows === undefined || block.rows === null) {
      add('table_no_rows', 'table_no_rows.missing');
    } else {
      lintFreeTable(block, block.rows, add);
    }
  } else if (bt === 'datatable') {
    const data = block.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      add('datatable_no_data', 'datatable_no_data.block');
    } else {
      lintDatatable(data, add, defaultAxes, settingKinds);
    }
  }
}

function makeFinding(code, text, location, loc, nodeId, blockId) {
  return {
    type: code,
    code: code,
    // A code missing from LINT_LEVELS is a bug in this mirror, not a reason to
    // hide the finding: default to 'error' so a rule ported on the python side
    // but forgotten here fails loud instead of silently downgrading to 'warn'.
    level: code in LINT_LEVELS ? LINT_LEVELS[code] : 'error',
    detail: text,
    message: text,
    location: location,
    loc: loc,
    nodeId: nodeId || null,
    blockId: blockId || null,
  };
}

// lintProject(project, cfg) -> flat findings in document order. Each finding
// carries the same keys the server-side lint emits, so the two lists merge.
export function lintProject(project, cfg) {
  const findings = [];
  const conf = cfg && typeof cfg === 'object' ? cfg : {};
  const comp = conf.compliance && typeof conf.compliance === 'object' ? conf.compliance : {};
  const defaultAxes = Array.isArray(comp.axis_labels) ? comp.axis_labels : DEFAULT_AXES;
  const settingKinds = Array.isArray(comp.setting_kinds) ? comp.setting_kinds : DEFAULT_SETTING_KINDS;
  // Whole-document, so a reference pointing FORWARD (or into another section)
  // is not reported as broken -- collected once, before the walk.
  const targets = refTargets((project && project.outline) || []);

  // Block ids and section (node) ids are each other's own namespace, shared
  // across the WHOLE project (not reset per section): the engine numbers
  // captions and resolves cross-references off a single project-wide
  // id -> target map, so two blocks (or two sections) that happen to share an
  // id collide there too -- the second one silently overwrites the first.
  // First-seen location wins; every later occurrence is flagged. Mirrors
  // content_lint.py's walk() exactly (seen_node_ids / seen_block_ids).
  const seenNodeIds = Object.create(null);
  const seenBlockIds = Object.create(null);

  const sections = flattenOutline((project && project.outline) || []);
  for (let si = 0; si < sections.length; si++) {
    const sec = sections[si];
    const loc0 = 'section "' + sec.title + '"';
    const rawNodeId = sec.node.id;
    if (rawNodeId) {
      if (seenNodeIds[rawNodeId]) {
        findings.push(makeFinding('duplicate_id',
          lintMessage('duplicate_id.section', { id: rawNodeId, other: seenNodeIds[rawNodeId] }),
          loc0, sec.loc, sec.id, null));
      } else {
        seenNodeIds[rawNodeId] = loc0;
      }
    }
    const hasKids = ((sec.node.children || []).length) > 0;
    if (!sec.blocks.length && !hasKids && !sec.fixedBody) {
      findings.push(makeFinding('empty_section', lintMessage('empty_section.none'),
        loc0, sec.loc, sec.id, null));
    }
    for (let bi = 0; bi < sec.blocks.length; bi++) {
      const block = sec.blocks[bi];
      if (!block || typeof block !== 'object') continue;
      const location = loc0 + ' / block ' + bi + ' (' + (block.type || '?') + ')';
      const blockId = block.id || null;
      if (blockId) {
        if (seenBlockIds[blockId]) {
          findings.push(makeFinding('duplicate_id',
            lintMessage('duplicate_id.block', { id: blockId, other: seenBlockIds[blockId] }),
            location, sec.loc, sec.id, blockId));
        } else {
          seenBlockIds[blockId] = location;
        }
      }
      const add = (code, mid, kw) => {
        findings.push(makeFinding(code, lintMessage(mid, kw), location, sec.loc, sec.id, blockId));
      };
      lintBlock(block, add, defaultAxes, settingKinds, targets);
    }
  }
  return findings;
}

// A render-manifest warning describes its place as: section "Title" / block 3
// (image). Turn that back into a section number and a block id so the item can
// be clicked, and leave it alone when it does not parse.
function locateManifestWarning(warning, sections) {
  const out = {
    loc: warning.loc || '',
    nodeId: warning.nodeId || null,
    blockId: warning.blockId || null,
  };
  if (out.loc && out.nodeId) return out;
  const location = String(warning.location || '');
  const titleMatch = /section "([^"]*)"/.exec(location);
  if (!titleMatch) return out;
  let section = null;
  for (let i = 0; i < sections.length; i++) {
    if (sections[i].title === titleMatch[1]) { section = sections[i]; break; }
  }
  if (!section) return out;
  out.loc = out.loc || section.loc;
  out.nodeId = out.nodeId || section.id;
  const blockMatch = /block (\d+)/.exec(location);
  if (blockMatch && !out.blockId) {
    const block = section.blocks[parseInt(blockMatch[1], 10)];
    if (block && block.id) out.blockId = block.id;
  }
  return out;
}

// checkReport(project, cfg, manifest) -> {errors, warnings, notes, counts}
//
// `manifest` is the warnings array from the last export. The browser lint and
// the manifest overlap on purpose (both report no_caption, both report structural
// problems), so identical findings are collapsed rather than listed twice.
export function checkReport(project, cfg, manifest) {
  const sections = flattenOutline((project && project.outline) || []);
  const findings = lintProject(project, cfg);
  const seen = Object.create(null);
  const key = (f) => [f.code || f.type, f.loc || '', f.blockId || '', f.message || f.detail || ''].join('|');
  for (let i = 0; i < findings.length; i++) seen[key(findings[i])] = 1;

  const extra = Array.isArray(manifest) ? manifest : [];
  for (let i = 0; i < extra.length; i++) {
    const w = extra[i];
    if (!w || typeof w !== 'object') continue;
    const code = w.code || w.type || 'table_warning';
    const text = w.message || w.detail || '';
    const where = locateManifestWarning(w, sections);
    const finding = {
      type: code,
      code: code,
      // Same rule as makeFinding: an unrecognized code fails loud (error)
      // rather than being silently downgraded to 'warn'.
      level: w.level || (code in LINT_LEVELS ? LINT_LEVELS[code] : 'error'),
      detail: text,
      message: text,
      location: w.location || '',
      loc: where.loc,
      nodeId: where.nodeId,
      blockId: where.blockId,
    };
    const k = key(finding);
    if (seen[k]) continue;
    seen[k] = 1;
    findings.push(finding);
  }

  const groups = { errors: [], warnings: [], notes: [] };
  for (let i = 0; i < findings.length; i++) {
    const f = findings[i];
    if (f.level === 'error') groups.errors.push(f);
    else if (f.level === 'info') groups.notes.push(f);
    else groups.warnings.push(f);
  }
  groups.counts = {
    errors: groups.errors.length,
    warnings: groups.warnings.length,
    notes: groups.notes.length,
  };
  return groups;
}

/* ================================================================== *
 * 3 - over spec
 *
 * The only verdict this tool has: a simulated value that violates its row's
 * limit is red and bold. Ported from core/tables.py so the paper preview marks
 * exactly what the exported document marks - no second opinion, no pass state,
 * no unknown state.
 * ================================================================== */

// numericValue comes from util.js: ONE parser, shared with the grid and the
// editor's count, mirroring core/tables.py::_numv. This file used to carry its
// own Number() version, which guarded only the empty string -- so a cell of
// spaces read as 0 and could be judged over spec while the engine, the grid
// and the shelf's count all left it alone.

// [value, "CORNER"] renders as value(CORNER); anything else renders as itself.
function formatValue(v) {
  if (Array.isArray(v) && v.length === 2) return String(v[0]) + '(' + String(v[1]) + ')';
  if (v === null || v === undefined) return '';
  return String(v);
}

// violates / flagsFrom / simAxisValues / axisValue come from util.js: ONE
// implementation of the over-spec rule, shared with the grid and the header
// count, mirroring core/tables.py. This file used to carry its own copies. Do
// not reintroduce them -- the paper has to mark exactly what the export marks.

// One spec group plus one group per simulation, exactly as the renderer builds
// them, so the preview's column layout matches the exported table's.
function makeGroups(data, comp) {
  const defaultAxes = (comp && Array.isArray(comp.axis_labels)) ? comp.axis_labels : DEFAULT_AXES;
  const groups = [];
  if (data.show_spec !== false) {
    groups.push({
      key: 'spec', title: data.spec_name || 'Spec', stage: null,
      role: 'spec', axes: defaultAxes.slice(),
    });
  }
  const sims = (Array.isArray(data.sims) && data.sims.length)
    ? data.sims
    : [{ key: 'sim', title: 'Sim', stage: null }];
  for (let i = 0; i < sims.length; i++) {
    const sim = sims[i] || {};
    groups.push({
      key: sim.key,
      title: sim.title || sim.key,
      stage: sim.stage || null,
      role: 'sim',
      axes: (Array.isArray(sim.axes) ? sim.axes : defaultAxes).slice(),
    });
  }
  return groups;
}

/* ================================================================== *
 * 4 - the paper
 *
 * An approximate rendering of the exported document: the template's colours
 * (FFFF00 header, EEECE1 setting rows, black rules, red bold over spec), the
 * serif paper face, real caption numbers. Pagination and fonts are not the
 * exported file's - the note above the view says so.
 * ================================================================== */

function runStyle(run) {
  const style = {};
  if (run.b) style.fontWeight = '700';
  if (run.i) style.fontStyle = 'italic';
  if (run.color) style.color = '#' + String(run.color).replace(/^#/, '');
  return style;
}

function Prose(props) {
  const { block, captions } = props;
  const runs = Array.isArray(block.runs) ? block.runs : [];
  const kind = block.list;
  const body = runs.map((run, i) => {
    if (!run || typeof run !== 'object') return null;
    if (run.ref) {
      const target = captions.get(run.ref);
      // A reference whose target is gone is not blank on paper: the renderer
      // writes a red "[ref: <id>]" into the sentence, and the reader has to be
      // able to see the thing they will have to fix. The run's own text is not
      // a fallback -- it is the number the reference used to print, which would
      // read as a live reference to a figure that no longer exists.
      if (!target) {
        return html`<span key=${i} class="rw-preview__ref rw-preview__ref--broken"
                          >${'[ref: ' + (run.ref || '?') + ']'}</span>`;
      }
      return html`<span key=${i} class="rw-preview__ref">${target.label}</span>`;
    }
    return html`<span key=${i} style=${runStyle(run)}>${run.t || ''}</span>`;
  });
  const cls = classNames('rw-preview__p', kind && 'rw-preview__p--list');
  const marker = kind === 'number' ? null : (kind ? String.fromCharCode(0x2022) : null);
  return html`
    <p class=${cls}>
      ${marker ? html`<span class="rw-preview__bullet" aria-hidden="true">${marker}</span>` : null}
      ${body}
    </p>`;
}

function Caption(props) {
  const { label, text } = props;
  if (!label && !text) return null;
  return html`
    <div class="rw-preview__caption">
      ${label ? html`<span class="rw-preview__capnum">${label}</span>` : null}
      ${text ? html`<span>${text}</span>` : null}
    </div>`;
}

function PaperImage(props) {
  const { dir, file, alt } = props;
  const [failed, setFailed] = useState(false);
  const src = file ? api.imgUrl(dir, file) : '';
  useEffect(() => { setFailed(false); }, [src]);
  // A figure whose file is not on disk draws the same empty frame as one that
  // was never filled: a report inherited for the next stage is full of those by
  // design, and a broken-image icon would read as damage.
  if (!file || failed) {
    return html`<div class="rw-preview__frame" aria-label=${alt || null}></div>`;
  }
  return html`
    <img class="rw-preview__img" src=${src} alt=${alt || ''} loading="lazy"
         onError=${() => setFailed(true)} />`;
}

function FreeTable(props) {
  const { block } = props;
  const rows = Array.isArray(block.rows) ? block.rows : [];
  const headerRows = Number(block.header_rows || 0);
  const fills = (block.row_fills && typeof block.row_fills === 'object') ? block.row_fills : {};
  return html`
    <div class="rw-preview__wide">
      <table>
        <tbody>
          ${rows.map((row, r) => {
            const cells = Array.isArray(row) ? row : [row];
            const shaded = fills[String(r)] !== undefined;
            return html`
              <tr key=${r} class=${shaded ? 'rw-paper__setting' : null}>
                ${cells.map((cell, c) => (r < headerRows
                  ? html`<th key=${c}>${cell === null || cell === undefined ? '' : String(cell)}</th>`
                  : html`<td key=${c}>${cell === null || cell === undefined ? '' : String(cell)}</td>`))}
              </tr>`;
          })}
        </tbody>
      </table>
    </div>`;
}

function ComplianceTable(props) {
  const { block, comp } = props;
  const data = block.data || {};
  const rows = Array.isArray(data.rows) ? data.rows : [];
  const settingKinds = (comp && Array.isArray(comp.setting_kinds))
    ? comp.setting_kinds : DEFAULT_SETTING_KINDS;
  const groups = makeGroups(data, comp);
  const simGroups = groups.filter((g) => g.role === 'sim');
  const anyStage = groups.some((g) => g.stage);

  // Category cells merge vertically over a run of rows sharing the same value,
  // exactly as the renderer merges them.
  const catSpan = [];
  for (let i = 0; i < rows.length;) {
    let j = i;
    while (j + 1 < rows.length && (rows[j + 1] || {}).cat === (rows[i] || {}).cat) j += 1;
    catSpan[i] = j - i + 1;
    for (let k = i + 1; k <= j; k++) catSpan[k] = 0;
    i = j + 1;
  }

  return html`
    <div class="rw-preview__wide">
      <table class="rw-preview__grid">
        <thead>
          <tr>
            <th rowSpan="3">Category</th>
            <th rowSpan="3">Item</th>
            ${groups.map((g) => html`
              <${Fragment} key=${g.key}>
                <th class="rw-preview__gap" rowSpan="3"></th>
                <th colSpan=${g.axes.length}>${g.title}</th>
              <//>`)}
            <th class="rw-preview__gap" rowSpan="3"></th>
            <th rowSpan="3">Unit</th>
          </tr>
          <tr>
            ${groups.map((g) => html`
              <th key=${g.key} colSpan=${g.axes.length}>${anyStage ? (g.stage || '') : ''}</th>`)}
          </tr>
          <tr>
            ${groups.map((g) => g.axes.map((ax, ai) => html`
              <th key=${g.key + ':' + ai}>${ax}</th>`))}
          </tr>
        </thead>
        <tbody>
          ${rows.map((row, ri) => {
            const r = row || {};
            const setting = settingKinds.indexOf(r.kind) >= 0;
            const flagsByGroup = Object.create(null);
            for (let i = 0; i < simGroups.length; i++) {
              const g = simGroups[i];
              const vals = simAxisValues(r, g.key);
              flagsByGroup[g.key] = flagsFrom(r, vals.mtm, vals.ntwc);
            }
            const span = !!r.sim_span;
            return html`
              <tr key=${ri} class=${setting ? 'rw-paper__setting' : null}>
                ${catSpan[ri] ? html`<td rowSpan=${catSpan[ri]}>${r.cat === undefined ? '' : r.cat}</td>` : null}
                <td class="rw-preview__item">${r.item === undefined ? '' : r.item}</td>
                ${groups.map((g) => {
                  const gap = html`<td class="rw-preview__gap"></td>`;
                  if (span && g.role === 'sim') {
                    let shown = null;
                    for (let ai = 0; ai < g.axes.length; ai++) {
                      const v = axisValue(r, g.key, ai);
                      if (!isEmptyValue(v)) { shown = v; break; }
                    }
                    return html`
                      <${Fragment} key=${g.key}>
                        ${gap}
                        <td class="rw-preview__num" colSpan=${g.axes.length}>${formatValue(shown)}</td>
                      <//>`;
                  }
                  return html`
                    <${Fragment} key=${g.key}>
                      ${gap}
                      ${g.axes.map((ax, ai) => {
                        const flagged = g.role === 'sim' && flagsByGroup[g.key] && flagsByGroup[g.key].has(ai);
                        return html`
                          <td key=${ai} class=${classNames('rw-preview__num', flagged && 'rw-paper__flag')}>
                            ${formatValue(axisValue(r, g.key, ai))}
                          </td>`;
                      })}
                    <//>`;
                })}
                <td class="rw-preview__gap"></td>
                <td>${r.unit === undefined ? '' : r.unit}</td>
              </tr>`;
          })}
        </tbody>
      </table>
    </div>`;
}

// The label an unlabelled panel of an image grid gets: (a)..(z),(aa),(ab)...
// The mirror of engine.py::_grid_sub_label, so a grid of more than 26 panels
// reads the same on the paper as it does in the exported document.
function gridSubLabel(index) {
  let n = Number(index) + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(97 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return '(' + s + ')';
}

// One block of the document, plus the hover affordance that takes the user to it
// in the centre canvas.
function PaperBlock(props) {
  const { block, dir, sectionId, captions, comp, cursor, onJump } = props;
  const number = block.id ? captions.get(block.id) : null;
  let body = null;

  if (block.type === 'para') {
    body = html`<${Prose} block=${block} captions=${captions} />`;
  } else if (block.type === 'image') {
    body = html`
      <figure class="rw-preview__figure">
        <${PaperImage} dir=${dir} file=${block.file} alt=${block.caption || ''} />
        <${Caption} label=${number ? number.label : null} text=${block.caption || ''} />
      </figure>`;
  } else if (block.type === 'imagegrid') {
    const items = Array.isArray(block.items) ? block.items : [];
    const cols = Math.max(1, Number(block.cols || 2));
    // `sub_captions` is the boolean "label every panel", not a list of labels:
    // the label of a panel is that panel's own `sub`, and a panel with none
    // falls back to (a)(b)(c). This is engine.py::_render_image_grid's contract,
    // and reading the flag as an array meant the preview showed no sub-caption
    // at all while the exported document showed every one of them.
    const showSubs = !!block.sub_captions;
    const subOf = (item, i) => (showSubs
      ? (String((item && item.sub) || '') || gridSubLabel(i))
      : '');
    body = html`
      <figure class="rw-preview__figure">
        <div class="rw-preview__figgrid" style=${{ gridTemplateColumns: 'repeat(' + cols + ', 1fr)' }}>
          ${items.map((item, i) => html`
            <div key=${i} class="rw-preview__figcell">
              <${PaperImage} dir=${dir} file=${item && item.file} alt=${subOf(item, i)} />
              ${showSubs ? html`<div class="rw-preview__subcap">${subOf(item, i)}</div>` : null}
            </div>`)}
        </div>
        <${Caption} label=${number ? number.label : null} text=${block.caption || ''} />
      </figure>`;
  } else if (block.type === 'table') {
    body = html`
      <div>
        <${Caption} label=${number ? number.label : null} text=${block.caption || ''} />
        <${FreeTable} block=${block} />
      </div>`;
  } else if (block.type === 'datatable') {
    body = html`
      <div>
        <${Caption} label=${number ? number.label : null} text=${block.caption || ''} />
        <${ComplianceTable} block=${block} comp=${comp} />
      </div>`;
  } else {
    return null;
  }

  const isCursor = !!(cursor && block.id && cursor === block.id);
  return html`
    <div class=${classNames('rw-paper__block', isCursor && 'rw-paper__block--cursor')}
         data-block=${block.id || null}>
      ${body}
      <div class="rw-paper__jump">
        <${IconButton} glyph=${String.fromCharCode(0x2197)} small=${true} title=${S.jumpToEditor}
                       onClick=${() => onJump(sectionId, block.id)} />
      </div>
    </div>`;
}

// One section of the document as one sheet of paper.
function PaperSection(props) {
  const { section, dir, captions, comp, cursor, onJump } = props;
  const level = Math.min(3, section.depth + 1);
  return html`
    <section class="rw-paper" data-node=${section.id}>
      <div class=${'rw-preview__h rw-preview__h' + level}>
        <span class="rw-preview__hnum">${section.loc}</span>${section.title}
      </div>
      ${section.fixedBody
        ? html`<div class="rw-preview__fixed">${String(section.fixedBody === true ? '' : section.fixedBody)}</div>`
        : section.blocks.map((block, i) => html`
            <${PaperBlock} key=${(block && block.id) || i} block=${block} dir=${dir}
                           sectionId=${section.id} captions=${captions} comp=${comp}
                           cursor=${cursor} onJump=${onJump} />`)}
    </section>`;
}

// A rough height for a section that has not been rendered yet, so the scroll bar
// is about the right length before anything is measured.
function estimateHeight(section) {
  if (section.fixedBody) return 200;
  let h = 84;
  const blocks = section.blocks;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i] || {};
    if (b.type === 'image') h += 220;
    else if (b.type === 'imagegrid') h += 130 * Math.ceil(((b.items || []).length || 1) / Math.max(1, b.cols || 2));
    else if (b.type === 'table') h += 40 + 22 * ((b.rows || []).length);
    else if (b.type === 'datatable') h += 80 + 20 * (((b.data || {}).rows || []).length);
    else h += 26 + 8 * Math.ceil(((b.runs || []).reduce((n, r) => n + String((r && r.t) || '').length, 0)) / 60);
  }
  return h;
}

/* ================================================================== *
 * 5 - proof renders
 *
 * POST /api/preview-section turns ONE section into real Word page images. The
 * result is cached per report+section so switching tabs, or scrolling away and
 * back, never re-pays the render.
 *
 * When the machine cannot do it at all - no Word, no pywin32, no PyMuPDF - the
 * control is disabled with the reason and the approximate layout keeps working.
 * That answer is remembered for the session: it is a property of the machine,
 * not of the section.
 * ================================================================== */

const proofCache = new Map();     // 'dir|node' -> {pages, ms, docxMs, wordMs, at, stale}
let lastExportSeconds = null;     // measured whole-report time, once one export has run
let proofBlocked = null;          // {reason} once the server says this machine cannot

// The server reports a missing capability as a plain 500 carrying the sentence
// live_preview composed. These are the shapes it can take; anything else is a
// transient failure of one render, not a verdict on the machine.
const CAPABILITY_HINTS = [
  'pywin32', 'PyMuPDF', 'Word page images need', 'Word is not available',
];

function isCapabilityFailure(err) {
  const text = String((err && err.message) || '');
  for (let i = 0; i < CAPABILITY_HINTS.length; i++) {
    if (text.indexOf(CAPABILITY_HINTS[i]) >= 0) return true;
  }
  return false;
}

function proofKey(dir, node) {
  return String(dir || '') + '|' + String(node || '');
}

/* ================================================================== *
 * 6 - jumping between the preview and the editor
 * ================================================================== */

// Select a block in the centre canvas. The editor watches ui.focusBlock /
// ui.focusAt; ignoring them costs only the scroll.
export function selectBlock(dir, nodeId, blockId) {
  if (nodeId && dir) store.navigate({ view: 'editor', dir: dir, node: nodeId });
  store.setUi({
    cursorNode: nodeId || null,
    cursorBlock: blockId || null,
    focusBlock: blockId || null,
    focusAt: Date.now(),
  });
}

/* ================================================================== *
 * 7 - the Preview tab
 *
 * One scrolling document. Sections near the viewport are built; the rest are a
 * measured spacer, so a 40-section report scrolls without holding 40 rendered
 * tables in the DOM.
 * ================================================================== */

const OVERSCAN = 700;   // px of document built above and below the viewport

// How long a press stays armed after the input that ended it, and how long a
// scroll this view performed itself stays attributable to this view. Both are
// short enough to be one gesture and long enough to cross a frame or two.
const HAND_GRACE_MS = 180;
const OWN_SCROLL_MS = 300;

export function PreviewTab(props) {
  const dir = props.dir;
  const project = useStore((s) => s.project);
  const cfg = useStore((s) => s.cfg);
  const ui = useStore((s) => s.ui);
  const route = useStore((s) => s.route);
  const dirty = useStore((s) => s.dirty);
  const saveState = useStore((s) => s.saveState);

  // The project document is edited in place, so its reference does not change on
  // every keystroke. The save cycle is the cheap "something changed" signal: the
  // preview refreshes about once per edit burst rather than once per character.
  const stamp = String(dirty) + '|' + saveState;
  const sections = useMemo(
    () => flattenOutline((project && project.outline) || []),
    [project, stamp]
  );
  const captions = useMemo(
    () => computeCaptionNumbers((project && project.outline) || []),
    [project, stamp]
  );
  const comp = (cfg && cfg.compliance) || null;

  const scrollRef = useRef(null);
  const heights = useRef(new Map());
  const rafPending = useRef(false);
  const [view, setView] = useState({ top: 0, h: 700 });
  const [, bump] = useState(0);
  const [proofBusy, setProofBusy] = useState(false);
  const [proofError, setProofError] = useState(null);
  const [blocked, setBlocked] = useState(proofBlocked);
  const [page, setPage] = useState(1);

  const fidelity = ui.previewFidelity === 'proof' ? 'proof' : 'approximate';
  const cursorBlock = ui.cursorBlock || null;

  // The caret can sit somewhere the document does not have a section for - the
  // cover form is the everyday case - so the proof always targets a real outline
  // node, and the control is disabled when there is none to render.
  const byId = (id) => (id ? sections.find((s) => s.id === id) || null : null);
  const caretSection = byId(ui.cursorNode)
    || (cursorBlock ? sectionOfBlock(sections, cursorBlock) : null)
    || byId(route.node)
    || sections[0]
    || null;
  const cursorNode = caretSection ? caretSection.id : null;
  const proof = proofCache.get(proofKey(dir, cursorNode)) || null;
  const proofNode = fidelity === 'proof' && proof ? cursorNode : null;

  /* ---- geometry ---- */

  const heightKey = (section) => section.id + (section.id === proofNode ? '|proof' : '|approx');
  const offsets = [];
  let total = 0;
  for (let i = 0; i < sections.length; i++) {
    offsets.push(total);
    const stored = heights.current.get(heightKey(sections[i]));
    total += stored === undefined ? estimateHeight(sections[i]) : stored;
  }

  let first = 0;
  let last = -1;
  for (let i = 0; i < sections.length; i++) {
    const top = offsets[i];
    const bottom = i + 1 < sections.length ? offsets[i + 1] : total;
    if (bottom < view.top - OVERSCAN) continue;
    if (top > view.top + view.h + OVERSCAN) break;
    if (last < 0) first = i;
    last = i;
  }
  if (last < 0) { first = 0; last = Math.min(sections.length - 1, 2); }
  const leadPad = offsets[first] || 0;
  const tailPad = Math.max(0, total - (last + 1 < sections.length ? offsets[last + 1] : total));

  // Measure what was actually built and keep the spacers honest.
  useLayoutEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    const nodes = box.querySelectorAll('[data-node]');
    let changed = false;
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      const id = el.getAttribute('data-node');
      const section = sections.find((s) => s.id === id);
      if (!section) continue;
      const style = window.getComputedStyle(el);
      const h = el.offsetHeight + (parseFloat(style.marginBottom) || 0);
      const key = heightKey(section);
      const known = heights.current.get(key);
      if (known === undefined || Math.abs(known - h) > 0.5) {
        heights.current.set(key, h);
        changed = true;
      }
    }
    if (changed) bump((n) => n + 1);
  });

  /* ---- scrolling ---- */

  const readViewport = useCallback(() => {
    const box = scrollRef.current;
    if (!box) return;
    setView({ top: box.scrollTop, h: box.clientHeight });
    const pages = box.querySelectorAll('[data-page]');
    if (pages.length) {
      const middle = box.scrollTop + box.clientHeight / 2;
      let best = 1;
      for (let i = 0; i < pages.length; i++) {
        if (pages[i].offsetTop <= middle) best = i + 1;
      }
      setPage(best);
    }
  }, []);

  // Scrolling by hand releases the follow. What counts as "by hand" is the
  // INPUT, not the scroll event: building a section, loading a figure or the
  // spacers settling all move the scroll position, and none of those is the user
  // asking to look somewhere else.
  const release = useCallback(() => {
    if (store.get().ui.follow) store.setUi({ follow: false });
  }, []);

  // A PRESS IS NOT A SCROLL.
  //
  // The document carries controls of its own - every block has Jump to editor -
  // and a press on one used to release the follow before the button's own click
  // ever ran, so the single control whose whole job is "take me to this block"
  // quietly cost the follow that had put the block on screen. The same held for
  // the keyboard: Space on a focused Jump button is that button being pressed,
  // not the paper being scrolled.
  //
  // Asking what was pressed would mean listing what a control looks like, and
  // the next control this view gains would fall straight through the list. So
  // nothing is listed. A press only ARMS a release; what fires it is the paper
  // ACTUALLY MOVING while the press is held - a drag that scrolls, the scroll
  // bar, a scroll key. A button that scrolls nothing releases nothing.
  //
  // Two details make that hold in practice:
  //
  //  * The press outlives its own end event by HAND_GRACE_MS. The browser
  //    dispatches a scroll a frame or two after the input that caused it, and a
  //    quick tap of a scroll key is over before that scroll arrives.
  //  * A scroll THIS VIEW performed is not the user scrolling. Following the
  //    caret is itself a scroll, and it lands right after the click that asked
  //    for it, so every programmatic move is stamped and ignored for
  //    OWN_SCROLL_MS. Without that, Jump to editor would release the follow by
  //    way of the very scroll it asked for.
  //
  // The wheel needs no arming: there is no such thing as a wheel that means
  // something other than "move this document".
  const hand = useRef(null);
  const selfScrolledAt = useRef(0);

  const dropHand = useCallback(() => {
    const held = hand.current;
    if (!held) return;
    hand.current = null;
    window.removeEventListener(held.end, held.off, true);
    if (held.timer) window.clearTimeout(held.timer);
  }, []);

  const endHand = useCallback(() => {
    const held = hand.current;
    if (!held || held.timer) return;
    held.timer = window.setTimeout(dropHand, HAND_GRACE_MS);
  }, [dropHand]);

  // `end` is the event that ends this press: mouseup, touchend, keyup. It is
  // listened for on the window, so a press that ends outside the panel - or
  // outside the document - still ends.
  const takeHand = useCallback((end) => {
    dropHand();
    const held = { end: end, off: null, timer: 0 };
    held.off = () => endHand();
    hand.current = held;
    window.addEventListener(end, held.off, true);
  }, [dropHand, endHand]);

  useEffect(() => dropHand, [dropHand]);

  const onScroll = useCallback(() => {
    const ours = Date.now() - selfScrolledAt.current < OWN_SCROLL_MS;
    if (hand.current && !ours) release();
    if (rafPending.current) return;
    rafPending.current = true;
    window.requestAnimationFrame(() => {
      rafPending.current = false;
      readViewport();
    });
  }, [readViewport, release]);

  const onScrollKey = useCallback((ev) => {
    const keys = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '];
    if (keys.indexOf(ev.key) >= 0) takeHand('keyup');
  }, [takeHand]);

  const scrollTo = useCallback((top) => {
    const box = scrollRef.current;
    if (!box) return;
    const next = Math.max(0, top);
    if (Math.abs(box.scrollTop - next) < 1) return;
    selfScrolledAt.current = Date.now();
    box.scrollTop = next;
    setView({ top: next, h: box.clientHeight });
  }, []);

  // Two passes: the first uses the estimated offsets so the target section gets
  // built, the second corrects against where it really landed.
  const scrollToCaret = useCallback(() => {
    const box = scrollRef.current;
    if (!box || !sections.length) return;
    let index = -1;
    if (cursorBlock) {
      const owner = sectionOfBlock(sections, cursorBlock);
      if (owner) index = sections.indexOf(owner);
    }
    if (index < 0 && cursorNode) index = sections.findIndex((s) => s.id === cursorNode);
    if (index < 0) return;
    scrollTo((offsets[index] || 0) - 10);
    window.requestAnimationFrame(() => {
      const inner = scrollRef.current;
      if (!inner) return;
      let target = cursorBlock
        ? inner.querySelector('[data-block="' + cssEscape(cursorBlock) + '"]')
        : null;
      if (!target) target = inner.querySelector('[data-node="' + cssEscape(sections[index].id) + '"]');
      if (!target) return;
      selfScrolledAt.current = Date.now();
      inner.scrollTop = Math.max(0, target.offsetTop - 10);
      setView({ top: inner.scrollTop, h: inner.clientHeight });
    });
  }, [sections, cursorBlock, cursorNode, scrollTo]);

  // A caret move re-attaches the follow; a hand scroll released it.
  const caretStamp = (cursorBlock || '') + '>' + (cursorNode || '');
  useEffect(() => {
    if (!cursorBlock && !cursorNode) return;
    if (!store.get().ui.follow) store.setUi({ follow: true });
    scrollToCaret();
  }, [caretStamp]);

  useEffect(() => {
    readViewport();
  }, [readViewport]);

  /* ---- proof ---- */

  // The proof renders the project.json ON DISK - the same file the export
  // reads - so the disk is made current first, exactly as the export does.
  //
  // A refusal is answered differently here, though. The export DELIVERS a file
  // somebody will send on, so it stops and asks. A proof only shows pages, and
  // the pages of the last saved version are still worth looking at, so the
  // render goes ahead - the panel never blanks - and the result CARRIES the
  // fact that it is older than the screen, which is the part that was missing:
  // the images used to be presented as if they were the document on screen.
  const runProof = useCallback(async () => {
    if (!dir || !cursorNode || proofBlocked) return;
    setProofBusy(true);
    setProofError(null);
    try {
      const landed = await flushEdits();
      const answer = await api.previewSection(dir, cursorNode);
      if (answer && answer.stub) {
        proofBlocked = { reason: String(answer.detail || '') };
        setBlocked(proofBlocked);
        return;
      }
      proofCache.set(proofKey(dir, cursorNode), {
        pages: (answer && answer.pages) || [],
        ms: (answer && answer.ms) || 0,
        docxMs: (answer && answer.docx_ms) || 0,
        wordMs: (answer && answer.word_ms) || 0,
        at: Date.now(),
        stale: !landed,
      });
      setPage(1);
      bump((n) => n + 1);
    } catch (err) {
      if (isCapabilityFailure(err)) {
        proofBlocked = { reason: String((err && err.message) || '') };
        setBlocked(proofBlocked);
      } else {
        setProofError(String((err && err.message) || err));
      }
    } finally {
      setProofBusy(false);
    }
  }, [dir, cursorNode]);

  const onFidelity = useCallback((value) => {
    if (value === 'proof') {
      if (proofBlocked) return;
      store.setUi({ previewFidelity: 'proof' });
      if (!proofCache.get(proofKey(dir, cursorNode))) runProof();
    } else {
      store.setUi({ previewFidelity: 'approximate' });
    }
  }, [dir, cursorNode, runProof]);

  const onJump = useCallback((nodeId, blockId) => {
    selectBlock(dir, nodeId, blockId);
  }, [dir]);

  /* ---- what to draw ---- */

  if (!project) {
    return html`<div class="rw-preview"><div class="rw-preview__doc"><${Spinner} label=${S.loading} /></div></div>`;
  }

  const secondsHint = (text) => html`<span class="rw-preview__hint">${text}</span>`;
  const options = [
    {
      value: 'approximate',
      label: html`${S.approximate} ${secondsHint(T('seconds', { n: '0.1' }))}`,
    },
    {
      value: 'proof',
      label: html`${S.proof} ${secondsHint(T('seconds', { n: '0.6' }))}`,
      disabled: !!blocked || !cursorNode,
      title: blocked ? blocked.reason : null,
    },
  ];

  const built = [];
  for (let i = first; i <= last && i < sections.length; i++) {
    const section = sections[i];
    if (section.id === proofNode) {
      built.push(html`
        <div key=${section.id} data-node=${section.id} class="rw-preview__proof">
          <div class="rw-preview__prooftitle">${S.proofTitle}</div>
          ${proof.pages.map((p, pi) => html`
            <img key=${pi} data-page=${pi + 1} class="rw-preview__page"
                 src=${'data:image/png;base64,' + p.png_b64}
                 alt=${T('pageOf', { n: pi + 1, m: proof.pages.length })} />`)}
        </div>`);
    } else {
      built.push(html`
        <${PaperSection} key=${section.id} section=${section} dir=${dir} captions=${captions}
                         comp=${comp} cursor=${cursorBlock} onJump=${onJump} />`);
    }
  }

  // What the whole report costs. A finished export is the real measurement, so
  // it wins. Without one, the section render is the only number there is: it
  // already walks the whole outline to get the numbering right, and the whole
  // report is converted by Word once however many sections it has, so building
  // plus converting is a fair floor. It reads as "about", and the first export
  // replaces it with the measured figure.
  const wholeReportSeconds = lastExportSeconds !== null
    ? Math.max(1, Math.round(lastExportSeconds))
    : (proof
      ? Math.max(2, Math.round(((proof.docxMs || proof.ms || 0) + (proof.wordMs || 0)) / 1000))
      : null);

  return html`
    <div class="rw-preview">
      <div class="rw-preview__bar">
        <${SegmentedControl} value=${fidelity} options=${options} onChange=${onFidelity}
                             ariaLabel=${S.preview} />
        <span class="rw-spacer"></span>
        <${Pill} tone=${ui.follow ? 'accent' : 'neutral'}
                 onClick=${() => {
                   if (!store.get().ui.follow) store.setUi({ follow: true });
                   scrollToCaret();
                 }}>
          ${ui.follow ? S.following : S.wholeReport}
        <//>
      </div>
      <div class="rw-preview__note">${S.approxNote}</div>
      ${blocked ? html`
        <div class="rw-preview__blocked">
          <div>${S.wordMissing}</div>
          ${blocked.reason ? html`<div class="rw-preview__reason">${blocked.reason}</div>` : null}
        </div>` : null}
      ${proofBusy ? html`
        <div class="rw-preview__strip">
          <${Banner} level="warn">${S.proofRendering}<//>
        </div>` : null}
      ${!proofBusy && proofNode && proof && proof.stale ? html`
        <div class="rw-preview__strip">
          <${Banner} level="warn"
                     action=${html`<${Button} level="tertiary" onClick=${runProof}>${S.retry}<//>`}>
            ${S.staleProof}
          <//>
        </div>` : null}
      ${proofError ? html`
        <div class="rw-preview__strip">
          <${Banner} level="error" title=${S.somethingWrong}
                     action=${html`<${Button} level="tertiary" onClick=${runProof}>${S.retry}<//>`}>
            ${proofError}
          <//>
        </div>` : null}
      <div class="rw-preview__doc" ref=${scrollRef} onScroll=${onScroll}
           onWheel=${release}
           onMouseDown=${() => takeHand('mouseup')}
           onTouchStart=${() => takeHand('touchend')}
           onKeyDown=${onScrollKey}>
        <div style=${{ height: leadPad + 'px' }} aria-hidden="true"></div>
        ${built}
        <div style=${{ height: tailPad + 'px' }} aria-hidden="true"></div>
      </div>
      ${proofNode && proof && proof.pages.length ? html`
        <div class="rw-preview__thumbs">
          <div class="rw-preview__thumbrow">
            ${proof.pages.map((p, pi) => html`
              <button key=${pi} type="button"
                      class=${classNames('rw-preview__thumb', page === pi + 1 && 'rw-preview__thumb--on')}
                      title=${T('pageOf', { n: pi + 1, m: proof.pages.length })}
                      onClick=${() => {
                        const box = scrollRef.current;
                        if (!box) return;
                        const el = box.querySelectorAll('[data-page]')[pi];
                        if (el) scrollTo(el.offsetTop - 10);
                      }}>
                <img src=${'data:image/png;base64,' + p.png_b64} alt="" />
              </button>`)}
          </div>
          <div class="rw-preview__thumbmeta">
            <span class="rw-strong">${T('pageOf', { n: page, m: proof.pages.length })}</span>
            <span>${T('pagesRange', { a: 1, b: proof.pages.length, n: wholeReportSeconds || 1 })}</span>
          </div>
        </div>` : html`
        <div class="rw-preview__foot">${S.approxOnly}</div>`}
    </div>`;
}

// CSS.escape is not in every engine this ships to; block ids are plain tokens,
// so quoting the few characters that could appear is enough.
function cssEscape(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}

/* ================================================================== *
 * 8 - the Check tab
 * ================================================================== */

const GROUP_META = [
  { key: 'errors', title: S.errors, level: 'error', glyph: String.fromCharCode(0x2715) },
  { key: 'warnings', title: S.warnings, level: 'warn', glyph: '!' },
  { key: 'notes', title: S.notes, level: 'note', glyph: String.fromCharCode(0x00b7) },
];

export function CheckTab(props) {
  const dir = props.dir;
  const project = useStore((s) => s.project);
  const cfg = useStore((s) => s.cfg);
  const manifest = useStore((s) => s.warnings);
  const dirty = useStore((s) => s.dirty);
  const saveState = useStore((s) => s.saveState);
  const stamp = String(dirty) + '|' + saveState;

  const report = useMemo(
    () => checkReport(project, cfg, manifest),
    [project, cfg, manifest, stamp]
  );
  const totalItems = report.counts.errors + report.counts.warnings + report.counts.notes;

  if (!project) {
    return html`<div class="rw-right__body"><${Spinner} label=${S.loading} /></div>`;
  }

  return html`
    <div class="rw-right__body">
      <div class="rw-check__head">
        <div class="rw-meta">${S.standing}</div>
        <div class="rw-check__counts">
          ${T('counts', { e: report.counts.errors, w: report.counts.warnings })}
        </div>
      </div>
      ${totalItems === 0 ? html`
        <div class="rw-check__empty">
          <${EmptyState} title=${S.nothingToFix} />
        </div>` : html`
        <div class="rw-checklist">
          ${GROUP_META.map((group) => {
            const items = report[group.key];
            if (!items.length) return null;
            return html`
              <${Fragment} key=${group.key}>
                <div class="rw-checklist__group">${group.title} ${items.length}</div>
                ${items.map((item, i) => html`
                  <div key=${group.key + i}
                       class=${'rw-checklist__item rw-checklist__item--' + group.level
                            + ' rw-check__item--' + group.level}
                       role="button" tabIndex="0"
                       onClick=${() => selectBlock(dir, item.nodeId, item.blockId)}
                       onKeyDown=${(ev) => {
                         if (ev.key === 'Enter' || ev.key === ' ') {
                           ev.preventDefault();
                           selectBlock(dir, item.nodeId, item.blockId);
                         }
                       }}>
                    <span class="rw-checklist__glyph" aria-hidden="true">${group.glyph}</span>
                    <span class="rw-check__loc">${item.loc}</span>
                    <span class="rw-check__text">${item.message}</span>
                    <span class="rw-checklist__go">${S.goTo}</span>
                  </div>`)}
              <//>`;
          })}
        </div>`}
    </div>`;
}

/* ================================================================== *
 * 9 - the panel
 * ================================================================== */

// The whole panel, ready to mount.
//
// It carries its own .rw-editor__right frame so an editor that simply drops it
// into the three-pane row gets the right geometry. If the editor already
// provides that frame, the effect below notices the parent is the frame and
// steps out of the way rather than nesting two of them.
export function RightPanel(props) {
  const ui = useStore((s) => s.ui);
  const route = useStore((s) => s.route);
  const project = useStore((s) => s.project);
  const cfg = useStore((s) => s.cfg);
  const manifest = useStore((s) => s.warnings);
  const dirty = useStore((s) => s.dirty);
  const saveState = useStore((s) => s.saveState);
  const dir = props.dir || route.dir;
  const stamp = String(dirty) + '|' + saveState;
  const rootRef = useRef(null);
  const [nested, setNested] = useState(false);

  useLayoutEffect(() => {
    const el = rootRef.current;
    const parent = el && el.parentElement;
    const inFrame = !!(parent && parent.classList && parent.classList.contains('rw-editor__right'));
    if (inFrame !== nested) setNested(inFrame);
  });

  const errorCount = useMemo(
    () => checkReport(project, cfg, manifest).counts.errors,
    [project, cfg, manifest, stamp]
  );

  if (!ui.rightOpen) {
    return html`
      <div ref=${rootRef}
           class=${classNames(!nested && 'rw-editor__right', !nested && 'rw-editor__right--collapsed',
                              nested && 'rw-preview__fill')}>
        <div class="rw-rightstrip" role="button" tabIndex="0"
             title=${S.preview}
             onClick=${() => store.setUi({ rightOpen: true })}
             onKeyDown=${(ev) => {
               if (ev.key === 'Enter' || ev.key === ' ') {
                 ev.preventDefault();
                 store.setUi({ rightOpen: true });
               }
             }}>
          <span class="rw-rightstrip__label">${S.preview}</span>
          ${errorCount ? html`<span class="rw-rightstrip__count">${errorCount}</span>` : null}
        </div>
      </div>`;
  }

  const tab = ui.rightTab === 'check' ? 'check' : 'preview';
  return html`
    <div ref=${rootRef} class=${classNames(!nested && 'rw-editor__right', nested && 'rw-preview__fill')}>
      <div class="rw-right__head">
        <div class="rw-tabs" role="tablist">
          <button type="button" role="tab" aria-selected=${String(tab === 'preview')}
                  class=${classNames('rw-tabs__item', tab === 'preview' && 'rw-tabs__item--on')}
                  onClick=${() => store.setUi({ rightTab: 'preview' })}>${S.preview}</button>
          <button type="button" role="tab" aria-selected=${String(tab === 'check')}
                  class=${classNames('rw-tabs__item', tab === 'check' && 'rw-tabs__item--on')}
                  onClick=${() => store.setUi({ rightTab: 'check' })}>
            ${S.check}
            ${errorCount ? html`<span class="rw-check__badge">${errorCount}</span>` : null}
          </button>
        </div>
        <span class="rw-spacer"></span>
        <${ExportChip} />
        <${IconButton} glyph=${String.fromCharCode(0x00bb)} small=${true} title=${S.close}
                       onClick=${() => store.setUi({ rightOpen: false })} />
      </div>
      <${ExportDialog} />
      ${tab === 'preview'
        ? html`<${PreviewTab} dir=${dir} />`
        : html`<${CheckTab} dir=${dir} />`}
    </div>`;
}

// Names a neighbouring view might probe for. All three are the same panel.
export const PreviewPanel = RightPanel;
export const Preview = RightPanel;

/* ================================================================== *
 * 10 - the export
 *
 * One export at a time, held in module state rather than in a component, so
 * `Run in the background` can close the dialog without losing the job and the
 * header chip can reopen it.
 *
 * The transport is api.exportStream, which reads the NDJSON feed from
 * POST /api/export-stream and falls back to the plain POST /api/export on its
 * own. A fallback arrives as one indeterminate progress event followed by the
 * real done event, so the three lines below behave the same either way.
 * ================================================================== */

const jobListeners = new Set();
let job = null;
let jobSeq = 0;                 // identity that survives patchJob's copies
let announcedJob = 0;           // the job whose finish has already been said out loud
let openPathAvailable = true;   // set false the first time the endpoint 404s

/* -- flushing before a write ----------------------------------------
 * The export renders the project.json ON DISK, not the document in memory, so
 * an edit the autosave loop still owes is simply not in the file it reads. The
 * dialog's own copy promises "a snapshot of the moment you pressed the button",
 * and that promise is false the instant a save is outstanding.
 *
 * store.saveNow() is the contract for that: it flushes any pending save and
 * resolves once the disk holds what the screen is showing, whether the edit
 * replaced the project reference or mutated the outline in place.
 *
 * -> true when the disk now holds what the screen shows, false when it does
 * not. Every way saveNow can report a failure is treated as one: a rejection,
 * an explicit failure it resolves with, and the document still being dirty
 * afterwards, which is the ground truth whichever of the two it chose. A store
 * too old to have the method saves nothing and owes nothing, so it answers true
 * rather than blocking the button.
 *
 * This is the same helper, word for word, that the exchange screen flushes
 * with. The two screens make the same promise, so they keep the same contract. */
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

function setJob(next) {
  job = next;
  jobListeners.forEach((fn) => {
    try { fn(job); } catch (err) { /* a listener must never break the job */ }
  });
}

function patchJob(patch) {
  if (!job) return;
  setJob(Object.assign({}, job, patch));
}

export function useExportJob() {
  const [, bump] = useState(0);
  useEffect(() => {
    const fn = () => bump((n) => n + 1);
    jobListeners.add(fn);
    return () => { jobListeners.delete(fn); };
  }, []);
  return job;
}

function startExport(dir, fmt, options) {
  const opts = options || {};
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  jobSeq += 1;
  setJob({
    // patchJob replaces the object on every event, so identity is this number,
    // not the reference: it is what tells the chip whether a finish has already
    // been announced.
    id: jobSeq,
    dir: dir,
    fmt: fmt,
    // 'held' is an export that has not started: the document could not be
    // written, so the file this render would read is not the one on screen.
    status: 'running',
    phase: 'preparing',
    done: 0,
    total: 0,
    label: '',
    indeterminate: false,
    startedAt: Date.now(),
    renderStart: null,
    convertStart: null,
    endedAt: null,
    result: null,
    error: null,
    controller: controller,
    background: false,
    checks: null,
    // true once the user has asked for the file knowing it comes from an older
    // version of the report. Never set on its own.
    stale: false,
  });

  const onEvent = (event) => {
    if (!job || job.status !== 'running') return;
    if (event.type === 'phase') {
      const patch = { phase: event.label || '' };
      if (event.label === 'rendering' && !job.renderStart) patch.renderStart = Date.now();
      if (event.label === 'converting' && !job.convertStart) patch.convertStart = Date.now();
      patchJob(patch);
    } else if (event.type === 'progress') {
      patchJob({
        done: Number(event.done) || 0,
        total: Number(event.total) || job.total,
        label: event.label || job.label,
        indeterminate: !!event.indeterminate,
        renderStart: job.renderStart || Date.now(),
      });
    }
  };

  // The export renders what is ON DISK, so the disk is made current first and
  // the verdict is HONOURED. `force` is the user having been told what would be
  // missing and having asked for the file anyway; `stale` then travels with the
  // job so every screen it reaches says which version it came from.
  const run = async () => {
    const landed = await flushEdits();
    if (!job || job.status !== 'running') return;
    if (!landed && !opts.force) {
      patchJob({ status: 'held', endedAt: Date.now() });
      return;
    }
    if (!landed) patchJob({ stale: true });
    const result = await api.exportStream(dir, onEvent, {
      fmt: fmt,
      saveFirst: true,
      signal: controller ? controller.signal : undefined,
    });
    if (!job || job.status !== 'running') return;
    const state = store.get();
    const warnings = (result && result.warnings) || [];
    store.set({ warnings: warnings });
    const report = checkReport(state.project, state.cfg, warnings);
    const finishedAt = Date.now();
    lastExportSeconds = (finishedAt - job.startedAt) / 1000;
    patchJob({
      status: 'done',
      endedAt: finishedAt,
      result: result || null,
      checks: report.counts,
    });
  };

  run().catch((err) => {
    if (!job || job.status !== 'running') return;
    if (controller && controller.signal.aborted) return;   // cancelled on purpose
    patchJob({ status: 'error', endedAt: Date.now(), error: String((err && err.message) || err) });
  });
}

// Start an export and show the dialog. This is what the header's Export control
// calls, and it is exported so any other view can start one the same way.
export function openExport(dir, fmt) {
  const format = fmt === 'docx' ? 'docx' : 'pdf';
  if (!dir) return;
  startExport(dir, format);
  store.set({ overlay: { kind: 'export', dir: dir, fmt: format } });
}

function cancelExport() {
  if (job && job.controller) {
    try { job.controller.abort(); } catch (err) { /* already gone */ }
  }
  setJob(null);
  store.set({ overlay: null });
}

/* ---- artefacts ---- */

// The result names one file. A PDF export also leaves the .docx it was made
// from, so both are listed - the user asked for Word and PDF and both are real.
//
// After those come the artefacts this export did NOT rewrite, which the server
// names in `stale_siblings`: a Word-only export overwrites the .docx and leaves
// the .pdf of an earlier export beside it, same name, same folder, one render
// out of date. Nothing in a directory listing tells them apart, so this list
// does - the file is still offered, because it is still the user's file, but it
// is never presented as part of what just came out.
function artefactsOf(result) {
  if (!result || !result.out) return [];
  const rows = [];
  // The server measures the files it wrote; a row it has no size for simply
  // does not show one.
  const sizes = (result.sizes && typeof result.sizes === 'object') ? result.sizes : {};
  const add = (rel, abs, stale) => {
    const parts = String(rel).split('/');
    const name = parts[parts.length - 1];
    const absolute = String(abs || '');
    const cut = absolute.lastIndexOf('/');
    rows.push({
      rel: rel,
      abs: absolute,
      name: name,
      folder: cut > 0 ? absolute.slice(0, cut) : '',
      size: Number(sizes[rel]) || 0,
      stale: !!stale,
    });
  };
  if (result.fmt === 'pdf') {
    add(String(result.out).replace(/\.pdf$/i, '.docx'),
      String(result.abs || '').replace(/\.pdf$/i, '.docx'));
  }
  add(result.out, result.abs);
  const older = Array.isArray(result.stale_siblings) ? result.stale_siblings : [];
  for (let i = 0; i < older.length; i++) {
    if (older[i] && older[i].out) add(older[i].out, older[i].abs, true);
  }
  return rows;
}

async function openPath(dir, file, folder) {
  try {
    await api.request('POST', '/api/open-path', {
      body: { dir: dir, file: file, folder: !!folder },
      timeout: 20000,
    });
    return true;
  } catch (err) {
    if (err && (err.status === 404 || err.status === 501)) openPathAvailable = false;
    return false;
  }
}

function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
  } catch (err) { /* fall through to the textarea */ }
  try {
    const box = document.createElement('textarea');
    box.value = text;
    box.setAttribute('readonly', 'readonly');
    box.style.position = 'fixed';
    box.style.left = '-1000px';
    document.body.appendChild(box);
    box.select();
    document.execCommand('copy');
    document.body.removeChild(box);
  } catch (err) { /* nothing else to try */ }
  return Promise.resolve();
}

function seconds(ms) {
  if (!ms || ms < 0) return '0.0';
  return (ms / 1000).toFixed(1);
}

/* ---- the dialog ---- */

function ExportSteps(props) {
  const state = props.job;
  const collecting = state.phase !== 'preparing' || state.total > 0;
  const rendering = state.phase === 'rendering' || state.phase === 'converting';
  const converting = state.phase === 'converting';
  const total = state.total || 0;
  const pct = total ? Math.min(100, Math.round((state.done / total) * 100)) : 0;

  return html`
    <div class="rw-export__steps">
      <div class=${classNames('rw-export__step', collecting && 'rw-export__step--done')}>
        <span class="rw-export__mark" aria-hidden="true">${collecting ? String.fromCharCode(0x2713) : ''}</span>
        <span>${T('stepCollect', { n: total || 0 })}</span>
      </div>

      <div class=${classNames('rw-export__step', converting && 'rw-export__step--done')}>
        <span class="rw-export__mark" aria-hidden="true">${converting ? String.fromCharCode(0x2713) : ''}</span>
        <div class="rw-export__line">
          <div class="rw-export__label">
            ${T('stepRender', { i: state.done || 0, n: total || 0, section: state.label || '' })}
          </div>
          <div class=${classNames('rw-progress', (!total || state.indeterminate) && 'rw-progress--indeterminate')}>
            <div class="rw-progress__bar"
                 style=${total && !state.indeterminate ? { width: pct + '%' } : null}></div>
          </div>
        </div>
        ${total && !state.indeterminate ? html`<span class="rw-export__timing">${pct}%</span>` : null}
      </div>

      ${state.fmt === 'pdf' ? html`
        <div class=${classNames('rw-export__step', rendering && !converting && 'rw-export__step--wait')}>
          <span class="rw-export__mark" aria-hidden="true"></span>
          <div class="rw-export__line">
            <div class="rw-export__label">${S.stepConvert}</div>
            ${converting ? html`
              <div class="rw-progress rw-progress--indeterminate"><div class="rw-progress__bar"></div></div>`
              : null}
          </div>
        </div>` : null}
    </div>`;
}

function ArtefactRow(props) {
  const { row, dir } = props;
  const [copied, setCopied] = useState(false);
  const [, bump] = useState(0);
  return html`
    <div class="rw-export__file">
      <div class="rw-export__filename">
        ${row.name}${row.size ? SEP + formatBytes(row.size) : ''}
      </div>
      ${row.stale ? html`<${Pill} tone="warn">${S.olderThanDoc}<//>` : null}
      <div class="rw-export__filemeta">${row.folder}</div>
      <div class="rw-btnrow">
        ${openPathAvailable ? html`
          <${Fragment}>
            <${Button} level="secondary"
                       onClick=${async () => { await openPath(dir, row.rel, false); bump((n) => n + 1); }}>
              ${S.openFile}
            <//>
            <${Button} level="secondary"
                       onClick=${async () => { await openPath(dir, row.rel, true); bump((n) => n + 1); }}>
              ${S.openFolder}
            <//>
          <//>` : null}
        <${Button} level="tertiary" onClick=${() => {
          copyText(row.abs || row.rel);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        }}>${copied ? S.copied : S.copyPath}<//>
      </div>
    </div>`;
}

// The dialog and the chip are each mounted in two places - beside the header's
// Export control and inside the right panel - so they exist however the editor
// chooses to wire the export up. Only one instance of each draws; the rest stand
// down, so two mounts never become two dialogs or two chips.
//
// The seat is claimed after EVERY render, not only on mount, and giving it up
// WAKES the instances that were standing by. Collapsing the right panel unmounts
// one of the two, and the survivor has to be able to pick the seat up even when
// nothing else would have re-rendered it - otherwise a finished export's chip
// leaves the header the moment the panel is collapsed and never comes back.
function makeSeat() {
  let host = null;
  const standingBy = new Set();
  return function useSeat() {
    const token = useRef(null);
    if (!token.current) token.current = {};
    const [, bump] = useState(0);
    useEffect(() => {
      if (host === null) {
        host = token.current;
        bump((n) => n + 1);
      }
    });
    useEffect(() => {
      const me = token.current;
      const wake = () => bump((n) => n + 1);
      standingBy.add(wake);
      return () => {
        standingBy.delete(wake);
        if (host === me) {
          host = null;
          standingBy.forEach((fn) => {
            try { fn(); } catch (err) { /* a stale instance must not block the seat */ }
          });
        }
      };
    }, []);
    return host !== null && host === token.current;
  };
}

const useDialogSeat = makeSeat();
const useChipSeat = makeSeat();

export function ExportDialog() {
  const overlay = useStore((s) => s.overlay);
  const state = useExportJob();
  const seated = useDialogSeat();
  const open = !!(overlay && overlay.kind === 'export');
  if (!open || !seated) return null;

  const dir = (overlay && overlay.dir) || (state && state.dir) || null;
  const fmt = (state && state.fmt) || (overlay && overlay.fmt) || 'pdf';
  const title = fmt === 'pdf' ? S.exportingBoth : S.exportingWord;
  const close = () => store.set({ overlay: null });

  if (!state) {
    return html`
      <${Dialog} title=${title} width=${560} onClose=${close}
                 footer=${html`<${Button} level="primary" onClick=${close}>${S.backToEditing}<//>`}>
        <${Spinner} label=${S.loading} />
      <//>`;
  }

  // Nothing has been rendered. The report could not be written, so the file this
  // export would read is not the one on screen -- and refusing outright is the
  // wrong answer, because the user may genuinely want a document now. So the
  // choice is named and handed back, exactly as the exchange screen hands back
  // a restart it will not take on the user's behalf.
  if (state.status === 'held') {
    return html`
      <${Dialog} title=${title} width=${560} onClose=${close}
                 footer=${html`<${Button} level="primary" onClick=${close}>${S.backToEditing}<//>`}>
        <${Banner} level="error" title=${S.notExported}
                   action=${html`
                     <div class="rw-btnrow">
                       <${Button} onClick=${() => startExport(state.dir, state.fmt)}>${S.retry}<//>
                       <${Button} level="danger"
                                  onClick=${() => startExport(state.dir, state.fmt, { force: true })}>
                         ${S.exportAnyway}
                       <//>
                     </div>`}>
          ${S.notExportedBody}
        <//>
      <//>`;
  }

  if (state.status === 'running') {
    return html`
      <${Dialog} title=${title} width=${560} onClose=${close}
                 footerLeft=${html`
                   <${Button} level="tertiary" onClick=${() => {
                     patchJob({ background: true });
                     store.set({ overlay: null });
                   }}>${S.runBackground}<//>`}
                 footer=${html`<${Button} level="danger" onClick=${cancelExport}>${S.cancelExport}<//>`}>
        <${ExportSteps} job=${state} />
        <div class="rw-dialog__note rw-export__snapshot">
          ${state.stale ? S.staleExport : S.snapshotNote}
        </div>
      <//>`;
  }

  if (state.status === 'error') {
    return html`
      <${Dialog} title=${title} width=${560} onClose=${close}
                 footer=${html`
                   <${Button} level="secondary" onClick=${() => startExport(state.dir, state.fmt)}>${S.retry}<//>
                   <${Button} level="primary" onClick=${close}>${S.backToEditing}<//>`}>
        <${Banner} level="error" title=${S.somethingWrong}>${state.error}<//>
      <//>`;
  }

  const result = state.result || {};
  const pages = result.pages || (result.stats && result.stats.pages) || null;
  const wordMs = (state.convertStart || state.endedAt) - (state.renderStart || state.startedAt);
  const pdfMs = state.convertStart ? state.endedAt - state.convertStart : 0;
  const totalMs = state.endedAt - state.startedAt;
  const checks = state.checks || { errors: 0, warnings: 0 };

  return html`
    <${Dialog} title=${title} width=${560} onClose=${close}
               footer=${html`<${Button} level="primary" onClick=${close}>${S.backToEditing}<//>`}>
      <div class="rw-export__done">
        <span class="rw-export__tick" aria-hidden="true">${String.fromCharCode(0x2713)}</span>
        <span class="rw-section-title">
          ${pages ? T('finishedPages', { n: pages }) : S.finished}
        </span>
      </div>
      ${state.stale ? html`<${Banner} level="warn">${S.staleExport}<//>` : null}
      <div class="rw-export__timing rw-export__times">
        ${state.convertStart
          ? T('timings', { a: seconds(wordMs), b: seconds(pdfMs), c: seconds(totalMs) })
          : T('timingsWord', { a: seconds(wordMs), c: seconds(totalMs) })}
      </div>
      <div class="rw-export__files">
        ${artefactsOf(result).map((row) => html`
          <${ArtefactRow} key=${row.rel} row=${row} dir=${state.dir} />`)}
      </div>
      <button type="button" class="rw-export__checks" onClick=${() => {
        store.setUi({ rightTab: 'check', rightOpen: true });
        close();
      }}>
        ${T('exportChecks', { e: checks.errors, w: checks.warnings })}
      </button>
    <//>`;
}

/* ---- the header controls ---- */

// The header's Export control: the default is Word and PDF, the menu also offers
// Word on its own.
// It also carries the background export's chip: the chip belongs in the header,
// beside this control, so a backgrounded export stays reachable with the right
// panel collapsed. Both mounts share one seat, so this never doubles the chip in
// the panel head.
export function ExportMenu(props) {
  const dir = props.dir;
  const [menu, setMenu] = useState(null);
  const items = [
    { label: S.exportBoth, glyph: String.fromCharCode(0x2193), onClick: () => openExport(dir, 'pdf') },
    { label: S.exportWordOnly, onClick: () => openExport(dir, 'docx') },
  ];
  return html`
    <${Fragment}>
      <${Button} level="primary" disabled=${!dir}
                 onClick=${(ev) => {
                   const box = ev.currentTarget.getBoundingClientRect();
                   setMenu({ x: box.left, y: box.bottom + 4 });
                 }}>
        ${S.exportLabel}<span class="rw-btn__caret" aria-hidden="true"> ${String.fromCharCode(0x25be)}</span>
      <//>
      ${menu ? html`
        <${Menu} x=${menu.x} y=${menu.y} items=${items} ariaLabel=${S.exportLabel}
                 onClose=${() => setMenu(null)} />` : null}
      <${ExportDialog} />
      <${ExportChip} />
    <//>`;
}

/* ---- the chip a background export leaves behind ----
 *
 * `Run in the background` closes the dialog, and this chip is the ONLY way back
 * to the job. It used to render nothing unless the export was still running, so
 * the instant the export FINISHED the chip disappeared - taking the file list,
 * the Open file / Open folder controls, the timings and the check summary with
 * it, and saying nothing at all about having finished. The one button pressed so
 * the user could keep working was the one that made the result unreachable; the
 * only recovery was to export again and wait in front of it.
 *
 * So the chip now outlives the job: it shows progress while the export runs, it
 * ANNOUNCES the finish once, and it stays until the user dismisses it, reopening
 * the finished dialog - file, folder, path, timings, checks - on click.
 */

// What the chip says, and how loudly, for each state a backgrounded job reaches.
function chipState(state) {
  if (!state) return null;
  if (state.status === 'running') {
    const pct = state.total ? Math.min(100, Math.round((state.done / state.total) * 100)) : null;
    return {
      tone: 'accent',
      done: false,
      text: (state.fmt === 'pdf' ? S.exportingBoth : S.exportingWord)
        + (pct === null ? '' : ' ' + pct + '%'),
    };
  }
  if (state.status === 'error') return { tone: 'bad', done: true, text: S.somethingWrong };
  if (state.status === 'held') return { tone: 'warn', done: true, text: S.notExported };
  const result = state.result || {};
  const pages = result.pages || (result.stats && result.stats.pages) || null;
  return {
    tone: 'good',
    done: true,
    text: pages ? T('finishedPages', { n: pages }) : S.finished,
  };
}

export function ExportChip() {
  const state = useExportJob();
  const seated = useChipSeat();
  const [notice, setNotice] = useState(null);
  const live = !!state && !!state.background;
  const settled = live && state.status !== 'running';

  // The announcement. It fires once per job, on the transition out of running,
  // and only for the instance holding the seat, so two mounts never speak twice.
  useEffect(() => {
    if (!seated || !settled) return;
    if (announcedJob === state.id) return;
    announcedJob = state.id;
    setNotice(chipState(state));
  }, [seated, settled, live && state.id, live && state.status]);

  if (!seated || !live) return null;
  const shown = chipState(state);
  const open = () => store.set({ overlay: { kind: 'export', dir: state.dir, fmt: state.fmt } });

  // Dismissing is offered only once the job has settled: while it runs, the way
  // to stop it is Cancel export, inside the dialog. Letting go of a finished job
  // while its dialog stands open would leave that dialog with nothing to show,
  // so the overlay goes with it.
  const dismiss = () => {
    const overlay = store.get().overlay;
    if (overlay && overlay.kind === 'export') store.set({ overlay: null });
    setNotice(null);
    setJob(null);
  };

  const first = artefactsOf(state.result)[0] || null;
  return html`
    <${Fragment}>
      <${Pill} tone=${shown.tone} onClick=${open}>${shown.text}<//>
      ${shown.done ? html`
        <${IconButton} glyph=${String.fromCharCode(0x2715)} small=${true} title=${S.close}
                       onClick=${dismiss} />` : null}
      ${notice ? html`
        <${Toast} text=${notice.text}
                  action=${notice.tone === 'good' && openPathAvailable && first ? S.openFile : null}
                  onAction=${() => openPath(state.dir, first ? first.rel : '', false)}
                  dismissLabel=${S.close}
                  onDismiss=${() => setNotice(null)} />` : null}
    <//>`;
}

export default RightPanel;
