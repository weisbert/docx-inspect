/*
 * views/table.js -- the table surface: a plain table and a compliance table
 * rendered through ONE grid wrapper, so selection, paste, undo and the keyboard
 * behave identically in both.
 *
 * Three rules this file exists to keep:
 *
 *   1. The column plan MUST match core/tables.py::_plan_columns, because the
 *      grid on screen is a drawing of the table the engine will write:
 *
 *          Category | Item | <group> ... | Unit
 *
 *      where each <group> is a separator column followed by that group's axes,
 *      groups come from make_groups (a spec group first, then one per
 *      data.sims entry), and UNIT IS THE LAST COLUMN. The legacy scalar Spec
 *      column between Item and the groups is dead and is never drawn.
 *
 *      Two columns are editor-only and never reach the document: '#' (the row
 *      number) and 'Limit'. Word has no way to encode a limit, so an imported
 *      table comes back without one -- which is why a blank limit is called
 *      out on screen instead of left to be discovered.
 *
 *   2. OVER SPEC IS THE ONLY VERDICT. A value that violates its row's limit is
 *      washed, coloured and bolded -- in whatever row and whatever simulation
 *      group it sits, exactly as core/tables.py reddens it (see
 *      overSpecCells). There is no pass state, no unknown state, no badge
 *      column, no verdict statistics and no filter chips. The white background
 *      of a normal cell means nothing at all.
 *
 *   3. PASTE BEHAVES EXACTLY LIKE PASTING INTO EXCEL. Tab-separated text lands
 *      at the active cell, rows are appended when it is taller, extra columns
 *      are dropped, row kinds are preserved, and the whole paste is one undo
 *      step. There is no column-mapping dialog.
 *
 * Undo is ours, not the grid control's: every mutation snapshots the block, so
 * a paste that also appended rows still undoes in a single keystroke. The
 * control's own history would have split that into two.
 *
 * Every user-facing string here comes from the frozen string list; every colour
 * comes from tokens.css.
 */

import { store } from '../store.js';
import * as api from '../api.js';
import {
  numericValue, simAxisValues, axisValue as sharedAxisValue,
  flagsFrom as sharedFlagsFrom, flagsForGroup,
} from '../util.js';
import {
  Button, IconButton, Select, SegmentedControl, Dialog, Menu, Pill, Spinner, Toast,
  html, cx, useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback,
} from '../components/index.js';

/* ================================================================== *
 * 1 - the data model, ported from core/tables.py
 *
 * The column plan and the group list are ported here; the over-spec rule is
 * NOT -- it lives once in util.js, shared with the preview and the header
 * count. When the engine's limit logic changes, util.js changes with it in the
 * same commit, or the editor stops agreeing with the exported document about
 * what is red.
 * ================================================================== */

const DEFAULT_AXES = ['MIN', 'TYP', 'MAX', 'NTWC'];
const MTM_AXES = 3;             // MIN / TYP / MAX
const MAX_AXES = MTM_AXES + 1;  // known limit: at most one non-MTM axis per group

// Numeric part of an axis value, supporting a [value, "CORNER"] pair.
//
// One implementation, in util.js, shared with the preview and the editor's
// count, because all three have to mark exactly what the exported document
// marks. This file used to carry its own parseFloat version, which read '5%'
// as 5 and reddened a cell the engine leaves alone. Do not reintroduce one:
// change util.numericValue and core/tables.py::_numv together or not at all.
export const numv = numericValue;

// Render an axis value: [value, "CORNER"] -> "value(CORNER)"; anything else as text.
export function fmtVal(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v) && v.length === 2) return String(v[0]) + '(' + String(v[1]) + ')';
  return String(v);
}

// Parse what was typed back into a stored value: a number stays a number,
// "value(CORNER)" comes back as the pair, anything else stays text.
function parseVal(text) {
  const s = String(text === null || text === undefined ? '' : text).trim();
  if (s === '') return null;
  const pair = s.match(/^(.+)\(([^()]+)\)$/);
  if (pair) {
    const head = pair[1].trim();
    const n = parseFloat(head);
    return [isFinite(n) && String(n) === head ? n : head, pair[2].trim()];
  }
  const n = parseFloat(s);
  return isFinite(n) && String(n) === s ? n : s;
}

// The over-spec rule -- violates / flagsFrom / the per-group value lookup --
// lives in util.js, one implementation shared with the paper preview and the
// header count, mirroring core/tables.py. This file used to carry its own copy,
// and that copy read row.sims[gkey] for TRUTH rather than MEMBERSHIP: a row
// whose sims map holds the group key with a null value fell back to the flat
// sim_mtm, so the grid reddened a value the engine never looks at. Do not
// reintroduce a copy -- change util.js and core/tables.py together or not at all.
export const flagsFrom = sharedFlagsFrom;
export const flagsFor = flagsForGroup;
export const axisValue = sharedAxisValue;

// One group's (mtm triple, ntwc) as a pair, the shape this file's callers read.
export function groupValues(row, gkey) {
  const v = simAxisValues(row, gkey);
  return [v.mtm, v.ntwc];
}

// Write one axis value back, in the shape the engine reads.
function setAxisValue(row, gkey, ai, value) {
  const put = (holder, mtmKey, ntwcKey) => {
    if (ai >= MTM_AXES) { holder[ntwcKey] = value; return; }
    const arr = (holder[mtmKey] || [null, null, null]).slice(0, MTM_AXES);
    while (arr.length < MTM_AXES) arr.push(null);
    arr[ai] = value;
    holder[mtmKey] = arr;
  };
  if (gkey === 'spec') { put(row, 'spec_mtm', 'spec_ntwc'); return; }
  // MEMBERSHIP, matching the read side: once the sims map names this group, the
  // group owns the value even when its entry is still empty. Writing to the flat
  // sim_mtm instead would store a number the engine never reads back.
  if (row.sims && Object.prototype.hasOwnProperty.call(row.sims, gkey)) {
    if (!row.sims[gkey]) row.sims[gkey] = { mtm: [null, null, null], ntwc: null };
    put(row.sims[gkey], 'mtm', 'ntwc');
    return;
  }
  put(row, 'sim_mtm', 'sim_ntwc');
}

// The ordered value groups: one spec group, then one per simulation.
// Mirrors core/tables.py::make_groups.
export function makeGroups(data, cfg) {
  const comp = (cfg && cfg.compliance) || {};
  const defaults = (comp.axis_labels || DEFAULT_AXES).slice();
  const groups = [];
  const d = data || {};
  if (d.show_spec !== false) {
    groups.push({
      key: 'spec', title: d.spec_name || 'Spec', stage: null, role: 'spec',
      axes: defaults.slice(), readOnly: false, source: null,
    });
  }
  const sims = (d.sims && d.sims.length) ? d.sims : [{ key: 'sim', title: 'Sim', stage: null }];
  for (let i = 0; i < sims.length; i++) {
    const sim = sims[i] || {};
    groups.push({
      key: String(sim.key === undefined ? 'sim' : sim.key),
      title: sim.title === undefined ? String(sim.key || '') : sim.title,
      stage: sim.stage || null,
      role: 'sim',
      axes: (sim.axes && sim.axes.length ? sim.axes : defaults).slice(),
      readOnly: sim.role === 'reference' || !!sim.readOnly,
      source: sim.source || null,
    });
  }
  return groups;
}

/* The column plan. Mirrors core/tables.py::_plan_columns, plus the two
 * editor-only columns on the left and minus the dead scalar Spec column. */
const W = { num: 26, cat: 92, item: 176, limit: 60, axis: 62, sep: 10, unit: 54 };

export function planColumns(groups) {
  const plan = [
    { kind: 'num', label: '', width: W.num },
    { kind: 'cat', label: 'Category', width: W.cat },
    { kind: 'item', label: 'Item', width: W.item },
    { kind: 'limit', label: 'Limit', width: W.limit },
  ];
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g];
    plan.push({ kind: 'sep', label: '', width: W.sep, group: group.key });
    for (let ai = 0; ai < group.axes.length; ai++) {
      plan.push({
        kind: 'axis', label: group.axes[ai], width: W.axis,
        group: group.key, role: group.role, axis: ai,
        readOnly: !!group.readOnly, excluded: ai >= MTM_AXES,
      });
    }
  }
  plan.push({ kind: 'sep', label: '', width: W.sep });
  plan.push({ kind: 'unit', label: 'Unit', width: W.unit });
  return plan;
}

/* Row kinds. A compliance row already carries `kind`; the template config
 * lists which kinds count as settings, which is what picks the row's fill
 * band. It does NOT decide what is judged -- see overSpecCells. */
export function settingKinds(cfg) {
  const comp = (cfg && cfg.compliance) || {};
  const list = comp.setting_kinds || ['common_setting', 'module_setting', 'tb'];
  return list.length ? list : ['common_setting'];
}

export function isSettingRow(row, cfg) {
  return settingKinds(cfg).indexOf(row && row.kind) >= 0;
}

// Every over-spec cell of one block, as {row, group, axis}. The only verdict.
//
// The SET judged here is the set core/tables.py::render_datatable judges, cell
// for cell, because this number is printed next to three others -- the header
// pill, the paper preview and GET /api/tree -- and all four have to be the
// number of red runs in the exported document. So:
//
//   * EVERY ROW, whatever its kind. The engine computes a row's flags before it
//     picks the fill band, so a setting row that carries a limit and breaks it
//     comes out red in Word. Setting rows are normally authored without a limit
//     and a row with no limit is never over spec -- that, not a skip here, is
//     what leaves them unmarked.
//   * EVERY SIMULATION GROUP, a reference column included. make_groups gives
//     role 'sim' to every data.sims entry, so a column pulled from another
//     report is judged against this report's spec exactly like this report's
//     own run, and the export reddens it. Read-only is about typing, not about
//     judging.
//   * ONLY THE AXES THE GROUP DECLARES. The engine can redden only a cell it
//     draws, and it draws one per entry of the group's own `axes`; a flag past
//     the end of them (a fourth-axis value in a MIN/TYP/MAX group) has no cell
//     in the document, and none in the grid either.
//
// This used to skip setting rows and read-only columns, so the footer and the
// header pill contradicted each other on one screen and both contradicted the
// file the user sends out. Do not narrow this again without narrowing
// core/tables.py in the same commit.
export function overSpecCells(block, cfg) {
  const out = [];
  if (!block || block.type !== 'datatable') return out;
  const data = block.data || {};
  const rows = data.rows || [];
  const groups = makeGroups(data, cfg).filter((g) => g.role === 'sim');
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || typeof row !== 'object') continue;
    for (let g = 0; g < groups.length; g++) {
      const drawn = groups[g].axes.length;
      flagsFor(row, groups[g].key).forEach((ai) => {
        if (ai < drawn) out.push({ row: i, group: groups[g].key, axis: ai });
      });
    }
  }
  return out;
}

export function blockOverSpec(block, cfg) {
  return overSpecCells(block, cfg).length;
}

// The whole document's count, for the one status chip the header carries.
export function outlineOverSpec(outline, cfg) {
  let n = 0;
  const walk = (nodes) => {
    for (let i = 0; i < (nodes || []).length; i++) {
      const node = nodes[i] || {};
      const blocks = node.blocks || [];
      for (let b = 0; b < blocks.length; b++) n += blockOverSpec(blocks[b], cfg);
      walk(node.children);
    }
  };
  walk(outline);
  return n;
}

/* ================================================================== *
 * 2 - plain-table rows and kinds
 *
 * A plain table row is either a bare array of cells or {cells, kind}. The kind
 * travels WITH the row, so inserting a row no longer shifts every colour below
 * it -- that is what core/tables.py::_row_kind_list reads. The legacy
 * index-keyed row_fills map is still honoured for reading, so a table written
 * by the older editor still draws its bands.
 * ================================================================== */

const FREE_ROW_KINDS = ['header', 'setting', 'result'];
const LEGACY_SETTING_FILL = 'EEECE1';

export function rowCells(row) {
  if (row && !Array.isArray(row) && typeof row === 'object') {
    return Array.isArray(row.cells) ? row.cells : [];
  }
  return Array.isArray(row) ? row : [];
}

function cellText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object' && Array.isArray(value.runs)) {
    return value.runs.map((r) => (r && r.t) || '').join('');
  }
  return String(value);
}

// Per-row kind, by the same precedence core/tables.py uses, with the legacy
// fill map as a last resort so old content still reads correctly.
export function plainRowKinds(block) {
  const rows = (block && block.rows) || [];
  const out = new Array(rows.length).fill(null);
  const declared = block && block.row_kinds;
  if (declared && !Array.isArray(declared) && typeof declared === 'object') {
    Object.keys(declared).forEach((k) => {
      const i = parseInt(k, 10);
      if (i >= 0 && i < rows.length && declared[k]) out[i] = String(declared[k]);
    });
  } else if (Array.isArray(declared)) {
    for (let i = 0; i < Math.min(declared.length, rows.length); i++) {
      if (declared[i]) out[i] = String(declared[i]);
    }
  }
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row && !Array.isArray(row) && typeof row === 'object' && row.kind) out[i] = String(row.kind);
  }
  const headerRows = block && block.header_rows ? Number(block.header_rows) : 0;
  const fills = (block && block.row_fills) || {};
  for (let i = 0; i < rows.length; i++) {
    if (out[i]) continue;
    if (i < headerRows) { out[i] = 'header'; continue; }
    const fill = fills[String(i)] || fills[i];
    if (fill && String(fill).toUpperCase() === LEGACY_SETTING_FILL) out[i] = 'setting';
  }
  return out;
}

function setPlainRowKind(block, index, kind) {
  const rows = block.rows || [];
  const list = plainRowKinds(block);
  if (index < 0 || index >= rows.length) return;
  if (FREE_ROW_KINDS.indexOf(kind) < 0) return;
  list[index] = kind;
  block.row_kinds = list.map((k) => k || null);
}

/* ================================================================== *
 * 3 - new blocks and presets
 *
 * A preset ALWAYS brings its setting rows. That is the structural fix for the
 * recurring "the table has no test conditions" problem and it must not be
 * weakened: this module never produces a compliance table with zero setting
 * rows, from the toolbar or from the insert menu.
 * ================================================================== */

function uid() {
  return 'n-' + Math.random().toString(16).slice(2, 10) + Math.random().toString(16).slice(2, 4);
}

export function tablePresets(cfg) {
  return (cfg && Array.isArray(cfg.table_presets)) ? cfg.table_presets : [];
}

function rowsFromSpec(list, defaultKind, simKeys) {
  const out = [];
  for (let i = 0; i < (list || []).length; i++) {
    const s = list[i] || {};
    const row = {
      cat: s.cat || '', item: s.item || '', unit: s.unit || '',
      kind: s.kind || defaultKind,
      spec: s.spec === undefined ? null : s.spec,
      spec_mtm: Array.isArray(s.spec_mtm) ? s.spec_mtm.slice() : [null, null, null],
      spec_ntwc: s.spec_ntwc === undefined ? null : s.spec_ntwc,
      limit: s.limit === undefined ? null : s.limit,
      sim_span: !!s.sim_span,
    };
    if (simKeys && simKeys.length) {
      row.sims = {};
      simKeys.forEach((k) => { row.sims[k] = { mtm: [null, null, null], ntwc: null }; });
    } else {
      row.sim_mtm = [null, null, null];
      row.sim_ntwc = null;
    }
    out.push(row);
  }
  return out;
}

// Instantiate one entry of the template config's table_presets.
export function tableFromPreset(cfg, key) {
  const preset = tablePresets(cfg).filter((p) => p && p.key === key)[0];
  if (!preset) return null;
  const comp = (cfg && cfg.compliance) || {};
  const defAxes = comp.axis_labels || DEFAULT_AXES;
  if (preset.base === 'plain') {
    return {
      type: 'table', id: uid(), caption: preset.caption || '',
      header_rows: preset.header_rows === undefined ? 1 : preset.header_rows,
      rows: (preset.rows || [['', ''], ['', '']]).map((r) => rowCells(r).slice()),
      merges: (preset.merges || []).slice(),
      col_w: preset.col_w ? preset.col_w.slice() : undefined,
    };
  }
  const specSims = preset.sims && preset.sims.length
    ? preset.sims : [{ title: '', stage: '', axes: defAxes.slice() }];
  const sims = [];
  const taken = {};
  for (let i = 0; i < specSims.length; i++) {
    const s = specSims[i] || {};
    const base = String(s.stage || 'g').toLowerCase() || 'g';
    let k = base;
    let n = 2;
    while (taken[k]) { k = base + n; n += 1; }
    taken[k] = true;
    sims.push({
      key: k, title: s.title || '', stage: s.stage || '',
      axes: (s.axes && s.axes.length ? s.axes : defAxes).slice(0, MAX_AXES),
    });
  }
  const compare = preset.base === 'compare' || sims.length > 1;
  const simKeys = compare ? sims.map((s) => s.key) : null;
  const rows = rowsFromSpec(preset.setting_rows, 'common_setting', simKeys)
    .concat(rowsFromSpec(preset.result_rows, 'result', simKeys));
  return {
    type: 'datatable', id: uid(), kind: 'compliance',
    caption: preset.caption || 'Compliance table',
    data: {
      spec_name: preset.spec_name === undefined ? (compare ? '' : 'Spec') : preset.spec_name,
      show_spec: preset.show_spec === undefined ? !compare : preset.show_spec,
      sims: sims, rows: rows,
    },
  };
}

export function newTableBlock() {
  return {
    type: 'table', id: uid(), caption: '', header_rows: 1,
    rows: [['', '', ''], ['', '', ''], ['', '', '']],
    row_kinds: ['header', null, null],
  };
}

// Never zero setting rows: a blank compliance table still opens with the two
// rows that say under what conditions the numbers below were taken.
export function newComplianceBlock(cfg) {
  const comp = (cfg && cfg.compliance) || {};
  const axes = (comp.axis_labels || DEFAULT_AXES).slice(0, MAX_AXES);
  return {
    type: 'datatable', id: uid(), kind: 'compliance', caption: '',
    data: {
      spec_name: 'Spec', show_spec: true,
      sims: [{ key: 'sim', title: '', stage: '', axes: axes }],
      rows: rowsFromSpec([
        { cat: 'Setting', item: 'Temperature', unit: '' },
        { cat: 'Setting', item: 'Supply', unit: '' },
      ], 'common_setting', null).concat(
        rowsFromSpec([{ cat: '', item: '', unit: '' }], 'result', null)
      ),
    },
  };
}

/* ================================================================== *
 * 4 - single-table xlsx export
 *
 * The server pairs the in-memory block with the project's template config and
 * runs the engine's own exporter, so the sheet is a visual replica of the Word
 * table rather than a clean data grid. Nothing is written to disk here: the
 * base64 the server returns is handed straight to the browser.
 * ================================================================== */

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function downloadB64(filename, b64, mime) {
  const raw = atob(String(b64 || ''));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: mime || XLSX_MIME }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'table.xlsx';
  document.body.appendChild(a);
  a.click();
  a.parentNode.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export async function exportBlockXlsx(dir, block) {
  const result = await api.exportXlsx(dir, block);
  downloadB64(result && result.filename, result && result.xlsx_b64);
  return result;
}

/* ================================================================== *
 * 5 - grid model: block -> what the control draws
 * ================================================================== */

const LIMIT_TO_SIGN = { le: '≤', ge: '≥', range: '=' };
const SIGN_TO_LIMIT = {
  '≤': 'le', '<=': 'le', '<': 'le', le: 'le',
  '≥': 'ge', '>=': 'ge', '>': 'ge', ge: 'ge',
  '=': 'range', range: 'range',
};

function limitSign(limit) {
  return LIMIT_TO_SIGN[limit] || '';
}

function parseLimit(text) {
  const s = String(text === null || text === undefined ? '' : text).trim();
  if (!s) return null;
  return SIGN_TO_LIMIT[s] || SIGN_TO_LIMIT[s.toLowerCase()] || null;
}

function cmToPx(cm) {
  const n = parseFloat(cm);
  if (!isFinite(n) || n <= 0) return null;
  return Math.max(40, Math.min(320, Math.round(n * 37.8)));
}

// Compliance: one grid row per data row, one grid column per plan entry.
function complianceModel(block, cfg) {
  const data = block.data || {};
  const rows = data.rows || [];
  const groups = makeGroups(data, cfg);
  const plan = planColumns(groups);
  const grid = [];
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y] || {};
    const line = [];
    for (let x = 0; x < plan.length; x++) {
      const col = plan[x];
      if (col.kind === 'num') line.push(String(y + 1));
      else if (col.kind === 'cat') line.push(String(row.cat || ''));
      else if (col.kind === 'item') line.push(String(row.item || ''));
      else if (col.kind === 'limit') line.push(limitSign(row.limit));
      else if (col.kind === 'unit') line.push(String(row.unit || ''));
      else if (col.kind === 'axis') line.push(fmtVal(axisValue(row, col.group, col.axis)));
      else line.push('');
    }
    grid.push(line);
  }
  return { mode: 'compliance', groups: groups, plan: plan, grid: grid, rows: rows };
}

// Plain: '#' then one grid column per table column.
function plainModel(block) {
  const rows = block.rows || [];
  let ncols = 1;
  for (let i = 0; i < rows.length; i++) ncols = Math.max(ncols, rowCells(rows[i]).length);
  const widths = block.col_w || [];
  const plan = [{ kind: 'num', label: '', width: W.num }];
  for (let c = 0; c < ncols; c++) {
    plan.push({ kind: 'cell', index: c, label: columnLetter(c), width: cmToPx(widths[c]) || 128 });
  }
  const grid = [];
  for (let y = 0; y < rows.length; y++) {
    const cells = rowCells(rows[y]);
    const line = [String(y + 1)];
    for (let c = 0; c < ncols; c++) line.push(cellText(cells[c]));
    grid.push(line);
  }
  return { mode: 'plain', groups: [], plan: plan, grid: grid, kinds: plainRowKinds(block) };
}

export function gridModel(block, cfg) {
  if (!block) return null;
  return block.type === 'datatable' ? complianceModel(block, cfg) : plainModel(block);
}

function columnLetter(x) {
  let n = Number(x);
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

function cellName(x, y) {
  return columnLetter(x) + (y + 1);
}

/* Category runs merge vertically; a sim_span row merges across each group's
 * axes. Both are what the exported table does, so the editor draws them too. */
function buildMerges(model) {
  const merges = {};
  if (model.mode !== 'compliance') return merges;
  const catCol = model.plan.map((c) => c.kind).indexOf('cat');
  const rows = model.rows;
  let i = 0;
  while (i < rows.length) {
    let j = i;
    while (j + 1 < rows.length && (rows[j + 1] || {}).cat === (rows[i] || {}).cat) j += 1;
    if (j > i && catCol >= 0) merges[cellName(catCol, i)] = [1, j - i + 1];
    i = j + 1;
  }
  for (let y = 0; y < rows.length; y++) {
    if (!rows[y] || !rows[y].sim_span) continue;
    const byGroup = {};
    for (let x = 0; x < model.plan.length; x++) {
      const col = model.plan[x];
      if (col.kind !== 'axis' || col.role !== 'sim') continue;
      if (!byGroup[col.group]) byGroup[col.group] = [];
      byGroup[col.group].push(x);
    }
    Object.keys(byGroup).forEach((gkey) => {
      const cols = byGroup[gkey];
      if (cols.length > 1) merges[cellName(cols[0], y)] = [cols.length, 1];
    });
  }
  return merges;
}

/* ================================================================== *
 * 6 - the grid wrapper
 * ================================================================== */

const DENSITY = { tight: 21, normal: 25, loose: 32 };

// Classes this module owns on the control's own cells. They are added and
// removed by name so the control's classes (selection, freeze, read-only) are
// never disturbed.
const CELL_CLASSES = [
  'rw-grid__sep', 'rw-grid__cell--overspec', 'rw-grid__cell--excluded',
  'rw-grid__cell--num', 'rw-grid__cell--ref', 'rw-grid__cell--index',
  'rw-grid__cell--head',
];

function clearOwnClasses(el) {
  for (let i = 0; i < CELL_CLASSES.length; i++) el.classList.remove(CELL_CLASSES[i]);
}

export function TableBlock(props) {
  const block = props.block;
  const cfg = props.cfg || store.get().cfg;
  const dir = props.dir || (store.get().route && store.get().route.dir) || '';

  const hostRef = useRef(null);
  const sheetRef = useRef(null);
  const modelRef = useRef(null);
  const undoRef = useRef({ past: [], future: [] });
  const catWarnRef = useRef(false);
  // The control fires onchange while it builds -- laying out a merge blanks the
  // cells the merge covers -- so edits are ignored until the build has settled.
  const buildingRef = useRef(true);

  const [revision, setRevision] = useState(0);
  const [tick, setTick] = useState(0);
  const [density, setDensity] = useState('normal');
  const [selection, setSelection] = useState(null);
  const [menu, setMenu] = useState(null);
  const [toast, setToast] = useState(null);
  const [refOpen, setRefOpen] = useState(false);
  const [catAsk, setCatAsk] = useState(null);
  const [staleSources, setStaleSources] = useState({});

  // The keyboard and paste handlers are registered once on the document, so
  // everything they need is read through refs rather than captured.
  const selectionRef = useRef(null);
  selectionRef.current = selection;
  const handlersRef = useRef({});

  const model = useMemo(() => gridModel(block, cfg), [block, cfg, revision]);
  // The verdict count follows every edit; the drawn grid is only rebuilt when
  // the shape changes, so that typing in a cell does not reset the cursor.
  const overSpec = useMemo(() => overSpecCells(block, cfg), [block, cfg, revision, tick]);

  /* ---- change plumbing ------------------------------------------ */

  // Every mutation goes through here: snapshot for undo, mutate, save, redraw.
  const mutate = useCallback((fn, options) => {
    const opt = options || {};
    const snapshot = JSON.stringify(block);
    const changed = fn();
    if (changed === false) return false;
    undoRef.current.past.push(snapshot);
    if (undoRef.current.past.length > 100) undoRef.current.past.shift();
    undoRef.current.future = [];
    store.markDirty();
    setTick((n) => n + 1);
    if (opt.rebuild !== false) setRevision((n) => n + 1);
    else repaintRef.current();
    if (typeof props.onChange === 'function') props.onChange(block);
    return true;
  }, [block, props.onChange]);

  const restore = useCallback((text) => {
    const next = JSON.parse(text);
    Object.keys(block).forEach((k) => { delete block[k]; });
    Object.keys(next).forEach((k) => { block[k] = next[k]; });
    store.markDirty();
    setTick((n) => n + 1);
    setRevision((n) => n + 1);
    if (typeof props.onChange === 'function') props.onChange(block);
  }, [block, props.onChange]);

  const undo = useCallback(() => {
    const stack = undoRef.current;
    if (!stack.past.length) return;
    stack.future.push(JSON.stringify(block));
    restore(stack.past.pop());
  }, [block, restore]);

  const redo = useCallback(() => {
    const stack = undoRef.current;
    if (!stack.future.length) return;
    stack.past.push(JSON.stringify(block));
    restore(stack.future.pop());
  }, [block, restore]);

  const say = useCallback((text, action) => {
    setToast({ id: Date.now(), text: text, action: action || null });
  }, []);

  /* ---- painting -------------------------------------------------- */

  // The control draws the cells; this decides what each one means. It runs
  // after every build and after every edit, and only ever touches the classes
  // listed in CELL_CLASSES.
  const repaint = useCallback(() => {
    const ws = sheetRef.current;
    const m = modelRef.current;
    if (!ws || !m || !ws.records) return;
    const flagged = {};
    if (m.mode === 'compliance') {
      overSpecCells(block, cfg).forEach((c) => { flagged[c.row + ':' + c.group + ':' + c.axis] = true; });
    }
    const kinds = m.mode === 'plain' ? plainRowKinds(block) : null;
    for (let y = 0; y < ws.records.length; y++) {
      const tr = ws.rows && ws.rows[y] && ws.rows[y].element;
      if (tr) {
        const row = m.mode === 'compliance' ? (m.rows[y] || {}) : null;
        const setting = m.mode === 'compliance'
          ? isSettingRow(row, cfg)
          : kinds[y] === 'setting';
        const header = m.mode === 'plain' && kinds[y] === 'header';
        tr.classList.toggle('rw-grid__row--setting', !!setting);
        tr.classList.toggle('rw-grid__row--head', !!header);
      }
      for (let x = 0; x < m.plan.length; x++) {
        const rec = ws.records[y] && ws.records[y][x];
        const el = rec && rec.element;
        if (!el) continue;
        clearOwnClasses(el);
        const col = m.plan[x];
        if (col.kind === 'sep') { el.classList.add('rw-grid__sep'); continue; }
        if (col.kind === 'num') { el.classList.add('rw-grid__cell--index'); continue; }
        if (col.kind === 'axis') {
          el.classList.add('rw-grid__cell--num');
          if (col.excluded) el.classList.add('rw-grid__cell--excluded');
          if (col.readOnly) el.classList.add('rw-grid__cell--ref');
          if (flagged[y + ':' + col.group + ':' + col.axis]) {
            el.classList.add('rw-grid__cell--overspec');
          }
          continue;
        }
        if (col.kind === 'limit') { el.classList.add('rw-grid__cell--num'); continue; }
        if (col.kind === 'cell' && kinds && kinds[y] === 'header') {
          el.classList.add('rw-grid__cell--head');
        }
      }
    }
  }, [block, cfg]);

  const repaintRef = useRef(repaint);
  repaintRef.current = repaint;

  /* ---- build / rebuild the control ------------------------------- */

  useLayoutEffect(() => {
    const host = hostRef.current;
    const jss = window.jspreadsheet;
    if (!host || !jss || !model) return undefined;
    host.innerHTML = '';
    modelRef.current = model;
    buildingRef.current = true;

    const columns = model.plan.map((col) => ({
      title: col.kind === 'sep' ? ' ' : (col.label || ' '),
      width: col.width,
      align: col.kind === 'item' || col.kind === 'cat' ? 'left' : 'center',
      readOnly: col.kind === 'num' || col.kind === 'sep' || !!col.readOnly,
      type: 'text',
      wordWrap: false,
    }));

    const options = {
      data: model.grid.length ? model.grid : [model.plan.map(() => '')],
      columns: columns,
      mergeCells: buildMerges(model),
      minDimensions: [model.plan.length, Math.max(1, model.grid.length)],
      tableOverflow: true,
      tableWidth: '100%',
      tableHeight: (props.height || 420) + 'px',
      freezeColumns: 3,
      defaultColAlign: 'center',
      allowInsertRow: true,
      allowManualInsertRow: false,
      allowInsertColumn: false,
      allowManualInsertColumn: false,
      allowDeleteRow: true,
      allowDeleteColumn: false,
      allowRenameColumn: false,
      columnDrag: false,
      columnSorting: false,
      rowDrag: false,
      rowResize: false,
    };
    if (model.mode === 'compliance') options.nestedHeaders = buildNestedHeaders(model);

    let ws = null;
    try {
      // The context menu is a SPREADSHEET-level setting, not a worksheet one:
      // returning false from it suppresses the control's own menu so this view
      // can draw one whose entries are the table's vocabulary.
      const made = jss(host, Object.assign(
        { worksheets: [options], contextMenu: () => false }, gridEvents
      ));
      ws = Array.isArray(made) ? made[0] : made;
    } catch (err) {
      try {
        const made = jss(host, Object.assign({ contextMenu: () => false }, options));
        ws = Array.isArray(made) ? made[0] : made;
      } catch (err2) {
        store.pushBanner({ level: 'error', code: 'grid', message: String(err2 && err2.message) });
        return undefined;
      }
    }
    sheetRef.current = ws;
    if (ws && typeof ws.hideIndex === 'function') ws.hideIndex();
    if (ws && typeof ws.resetSelection === 'function') ws.resetSelection();
    decorateHeaders(host, model);
    repaint();
    const settle = setTimeout(() => { buildingRef.current = false; }, 0);

    // The control pins the frozen columns by offsetting each cell from the
    // scroll position, but its offset assumes its own row-number gutter, which
    // this grid replaces with a '#' column of its own. Correcting it is one
    // line: a frozen cell is pinned exactly when it is shifted right by the
    // distance the body has been scrolled.
    const content = host.querySelector('.jss_content');
    const pinFrozen = () => {
      if (!content) return;
      const left = content.scrollLeft + 'px';
      const cells = host.querySelectorAll('.jss_worksheet > tbody > tr > td.jss_freezed');
      for (let i = 0; i < cells.length; i++) cells[i].style.left = left;
    };
    if (content) content.addEventListener('scroll', pinFrozen);
    pinFrozen();

    return () => {
      clearTimeout(settle);
      if (content) content.removeEventListener('scroll', pinFrozen);
      buildingRef.current = true;
      sheetRef.current = null;
      try { host.innerHTML = ''; } catch (err) { /* the node may be gone */ }
    };
  }, [model, props.height]);

  /* ---- the control's events -------------------------------------- */

  // Declared once and read through refs, so rebuilding the sheet never leaves a
  // stale closure holding an old block.
  const stateRef = useRef({});
  stateRef.current = {
    block, cfg, mutate, undo, say, setSelection, catWarnRef, setCatAsk, buildingRef,
  };

  const gridEvents = useMemo(() => ({
    onselection: (instance, x1, y1, x2, y2) => {
      if (stateRef.current.buildingRef.current) return;
      stateRef.current.setSelection({
        x1: Math.min(x1, x2), y1: Math.min(y1, y2),
        x2: Math.max(x1, x2), y2: Math.max(y1, y2),
      });
    },
    onchange: (instance, cell, x, y, value, oldValue) => {
      if (stateRef.current.buildingRef.current) return;
      if (String(value) === String(oldValue)) return;
      applyCellEdit(stateRef.current, Number(x), Number(y), value);
    },
  }), []);

  /* ---- who owns a gesture over the grid ---------------------------- *
   *
   * ONE predicate, asked of the control itself: is one of its cells being
   * edited right now? Every gesture the grid host claims -- the keyboard, the
   * clipboard, the context menu -- steps aside while the answer is yes,
   * because a cell editor is a component with its own claim on all three.
   *
   * It asks the OWNER whether it is busy rather than testing what kind of
   * element the event landed on. An enumeration of element types is how the
   * card wrapper's drag guard was written, and it missed a bare <td>; the
   * editor the control opens is a <td> as well, so the same enumeration would
   * miss it here for the same reason. `ws.edition` is the control's own record
   * of the open editor, so it cannot drift from what is on screen.  */
  const editing = useCallback(() => {
    const ws = sheetRef.current;
    return !!(ws && ws.edition && ws.edition.length);
  }, []);

  /* ---- keyboard and paste ---------------------------------------- */

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    const inside = (target) => !!(target && host.contains(target));

    const onKeyDown = (ev) => {
      if (!inside(ev.target) || editing()) return;
      const ctrl = ev.ctrlKey || ev.metaKey;
      if (!ctrl) return;
      const key = String(ev.key || '').toLowerCase();
      const on = handlersRef.current;
      if (key === 'z' && !ev.shiftKey) { ev.preventDefault(); ev.stopPropagation(); on.undo(); return; }
      if ((key === 'z' && ev.shiftKey) || key === 'y') {
        ev.preventDefault(); ev.stopPropagation(); on.redo(); return;
      }
      if (key === 'd') { ev.preventDefault(); ev.stopPropagation(); on.fillDown(); }
    };

    const onPaste = (ev) => {
      if (!inside(ev.target) || editing()) return;
      const text = ev.clipboardData ? ev.clipboardData.getData('text/plain') : '';
      if (!text) return;
      ev.preventDefault();
      ev.stopPropagation();
      handlersRef.current.applyPaste(text);
    };

    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('paste', onPaste, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('paste', onPaste, true);
    };
  }, []);

  /* ---- actions ---------------------------------------------------- */

  const activeCell = () => {
    const sel = selectionRef.current;
    if (sel) return { x: sel.x1, y: sel.y1 };
    return { x: 1, y: 0 };
  };

  const blankComplianceRow = (like) => {
    const row = {
      cat: like ? like.cat || '' : '', item: '', unit: like ? like.unit || '' : '',
      kind: like ? like.kind || 'result' : 'result',
      spec: null, spec_mtm: [null, null, null], spec_ntwc: null,
      limit: like ? (like.limit === undefined ? null : like.limit) : null,
      sim_span: false,
    };
    if (like && like.sims) {
      row.sims = {};
      Object.keys(like.sims).forEach((k) => { row.sims[k] = { mtm: [null, null, null], ntwc: null }; });
    } else {
      row.sim_mtm = [null, null, null];
      row.sim_ntwc = null;
    }
    return row;
  };

  const selectedRows = () => {
    const sel = selectionRef.current;
    return sel ? sel.y2 - sel.y1 + 1 : 1;
  };

  const insertRow = (where) => {
    const sel = selectionRef.current;
    const at = where === 'above' ? activeCell().y : (sel ? sel.y2 : activeCell().y);
    const count = selectedRows();
    mutate(() => {
      const index = where === 'above' ? at : at + 1;
      if (block.type === 'datatable') {
        const rows = block.data.rows || (block.data.rows = []);
        const like = rows[activeCell().y];
        for (let i = 0; i < count; i++) rows.splice(index, 0, blankComplianceRow(like));
      } else {
        const rows = block.rows || (block.rows = []);
        const width = Math.max(1, rowCells(rows[activeCell().y]).length);
        const kinds = plainRowKinds(block);
        const inherit = kinds[activeCell().y] === 'header' ? null : kinds[activeCell().y] || null;
        for (let i = 0; i < count; i++) {
          rows.splice(index, 0, new Array(width).fill(''));
          kinds.splice(index, 0, inherit);
        }
        block.row_kinds = kinds.map((k) => k || null);
      }
    });
  };

  const deleteRow = () => {
    // selectionRef, not the selection state, and for the same reason every
    // other action here reads it: a right-click moves the cursor to the cell
    // under the pointer through the ref, and the state that follows it has not
    // landed by the time the menu that was built in the same handler is
    // clicked. Reading the state would act on wherever the cursor was BEFORE
    // the right-click.
    const sel = selectionRef.current || { y1: activeCell().y, y2: activeCell().y };
    const from = sel.y1;
    const count = sel.y2 - sel.y1 + 1;
    mutate(() => {
      if (block.type === 'datatable') {
        const rows = block.data.rows || [];
        if (rows.length <= count) return false;
        rows.splice(from, count);
      } else {
        const rows = block.rows || [];
        if (rows.length <= count) return false;
        rows.splice(from, count);
        const kinds = plainRowKinds(block);
        kinds.splice(from, count);
        block.row_kinds = kinds.map((k) => k || null);
      }
      return true;
    });
  };

  // On a compliance table a column is an axis of the group under the cursor.
  // The known limit stands: at most one non-MTM axis per group.
  const insertColumn = () => {
    const col = model.plan[activeCell().x];
    if (block.type !== 'datatable') {
      mutate(() => {
        const at = Math.max(0, activeCell().x - 1) + 1;
        (block.rows || []).forEach((row, i) => {
          const cells = rowCells(row);
          cells.splice(at, 0, '');
          if (Array.isArray(block.rows[i])) block.rows[i] = cells;
          else block.rows[i].cells = cells;
        });
        if (Array.isArray(block.col_w)) block.col_w.splice(at, 0, 2);
      });
      return;
    }
    if (!col || col.kind !== 'axis' || col.group === 'spec') return;
    const sims = block.data.sims || [];
    const sim = sims.filter((s) => String(s.key) === String(col.group))[0];
    if (!sim) return;
    const axes = (sim.axes || DEFAULT_AXES).slice();
    if (axes.length >= MAX_AXES) {
      say('A simulation group can carry at most one column beyond MIN / TYP / MAX');
      return;
    }
    mutate(() => { sim.axes = axes.concat([DEFAULT_AXES[axes.length] || 'NTWC']); });
  };

  const deleteColumn = () => {
    const col = model.plan[activeCell().x];
    if (block.type !== 'datatable') {
      mutate(() => {
        const at = Math.max(0, activeCell().x - 1);
        (block.rows || []).forEach((row, i) => {
          const cells = rowCells(row);
          if (cells.length <= 1) return;
          cells.splice(at, 1);
          if (Array.isArray(block.rows[i])) block.rows[i] = cells;
          else block.rows[i].cells = cells;
        });
        if (Array.isArray(block.col_w)) block.col_w.splice(at, 1);
      });
      return;
    }
    if (!col || col.kind !== 'axis' || col.group === 'spec') return;
    const sims = block.data.sims || [];
    const sim = sims.filter((s) => String(s.key) === String(col.group))[0];
    if (!sim) return;
    const axes = (sim.axes || DEFAULT_AXES).slice();
    if (axes.length <= MTM_AXES) return;
    mutate(() => { sim.axes = axes.slice(0, axes.length - 1); });
  };

  const setRowKind = (kind) => {
    const sel = selectionRef.current || { y1: activeCell().y, y2: activeCell().y };
    mutate(() => {
      for (let y = sel.y1; y <= sel.y2; y++) {
        if (block.type === 'datatable') {
          const row = (block.data.rows || [])[y];
          if (!row) continue;
          if (kind === 'setting') {
            if (!isSettingRow(row, cfg)) row.kind = settingKinds(cfg)[0];
          } else {
            row.kind = 'result';
          }
        } else {
          setPlainRowKind(block, y, kind);
        }
      }
    });
  };

  const fillDown = () => {
    const sel = selectionRef.current;
    if (!sel || sel.y2 <= sel.y1) return;
    mutate(() => {
      const fresh = gridModel(block, cfg);
      for (let x = sel.x1; x <= sel.x2; x++) {
        const source = readCell(fresh, x, sel.y1);
        for (let y = sel.y1 + 1; y <= sel.y2; y++) {
          writeCell({ block, cfg, model: fresh }, x, y, source);
        }
      }
    });
  };

  const applyPreset = (key) => {
    const built = tableFromPreset(cfg, key);
    if (!built) return;
    mutate(() => {
      if (built.type === 'datatable') {
        block.type = 'datatable';
        block.kind = 'compliance';
        block.data = built.data;
        delete block.rows;
        delete block.row_kinds;
        delete block.header_rows;
      } else {
        block.type = 'table';
        block.rows = built.rows;
        block.header_rows = built.header_rows;
        block.col_w = built.col_w;
        delete block.data;
      }
      if (!block.caption) block.caption = built.caption;
    });
  };

  const spanAcrossGroup = () => {
    const y = activeCell().y;
    mutate(() => {
      const row = (block.data.rows || [])[y];
      if (!row) return false;
      row.sim_span = !row.sim_span;
      return true;
    });
  };

  const doExportXlsx = () => {
    exportBlockXlsx(dir, block).catch((err) => {
      store.pushBanner({ level: 'error', code: 'export-xlsx', message: String(err && err.message) });
    });
  };

  /* ---- paste, exactly like Excel ---------------------------------- */

  const applyPaste = (text) => {
    const table = parseTsv(text);
    if (!table.length) return;
    const fresh = gridModel(block, cfg);
    const start = activeCell();
    const startX = Math.max(1, start.x);   // the row-number column is never a target
    const startY = start.y;
    const room = fresh.plan.length - startX;
    const wide = table[0].length > room;
    const width = Math.min(table[0].length, room);
    const needed = startY + table.length;
    const grew = needed - fresh.grid.length;

    mutate(() => {
      if (grew > 0) appendRows(block, cfg, grew);
      const after = gridModel(block, cfg);
      for (let r = 0; r < table.length; r++) {
        for (let c = 0; c < width; c++) {
          writeCell({ block, cfg, model: after }, startX + c, startY + r, table[r][c]);
        }
      }
    });

    let message = 'Pasted ' + table.length + ' rows × ' + width + ' columns';
    if (grew > 0) message = 'Rows were added to fit the paste';
    else if (wide) message = 'Extra columns were dropped';
    say(message, true);
  };

  handlersRef.current = { undo, redo, fillDown, applyPaste };

  /* ---- reference columns ------------------------------------------ */

  const refGroups = useMemo(
    () => (model && model.mode === 'compliance'
      ? model.groups.filter((g) => g.readOnly && g.source) : []),
    [model]
  );

  // A reference column is a snapshot. Nothing refreshes on its own; this only
  // asks whether the source has moved, so the header can say so.
  useEffect(() => {
    let live = true;
    if (!refGroups.length || !dir || !block.id) return undefined;
    refGroups.forEach((group) => {
      const src = group.source || {};
      if (!src.report || !src.group) return;
      api.refcol({
        dir: dir, srcReport: src.report, targetBlock: block.id,
        group: src.group, axis: group.axis, title: group.title,
      }).then((result) => {
        if (!live || !result || !result.column) return;
        const fresh = (result.column.source || {}).hash;
        if (fresh && src.hash && fresh !== src.hash) {
          setStaleSources((prev) => Object.assign({}, prev, { [group.key]: result }));
        }
      }).catch(() => { /* a source that cannot be read is simply not stale */ });
    });
    return () => { live = false; };
  }, [refGroups.length, dir, block.id]);

  const insertReferenceColumn = (result, title) => {
    const column = result && result.column;
    if (!column) return;
    mutate(() => {
      const data = block.data;
      data.sims = data.sims || [];
      const key = column.key;
      const leaf = String((column.source || {}).report || '').split('/').filter((p) => p).pop() || '';
      let name = title || column.title || '';
      if (leaf && name.indexOf('(' + leaf + ')') < 0) name = (name + ' (' + leaf + ')').trim();
      data.sims.push({
        key: key, title: name, stage: column.stage || '',
        axes: (column.axes || DEFAULT_AXES).slice(0, MAX_AXES),
        role: 'reference', readOnly: true, source: column.source,
      });
      const rows = data.rows || [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!row) continue;
        row.sims = row.sims || {};
        const value = (column.rows || [])[i];
        row.sims[key] = value
          ? { mtm: (value.mtm || [null, null, null]).slice(), ntwc: value.ntwc === undefined ? null : value.ntwc }
          : { mtm: [null, null, null], ntwc: null };
      }
    });
  };

  const refreshReference = (groupKey) => {
    const result = staleSources[groupKey];
    if (!result || !result.column) return;
    mutate(() => {
      const rows = block.data.rows || [];
      for (let i = 0; i < rows.length; i++) {
        const value = (result.column.rows || [])[i];
        rows[i].sims = rows[i].sims || {};
        rows[i].sims[groupKey] = value
          ? { mtm: (value.mtm || [null, null, null]).slice(), ntwc: value.ntwc === undefined ? null : value.ntwc }
          : { mtm: [null, null, null], ntwc: null };
      }
      const sim = (block.data.sims || []).filter((s) => String(s.key) === String(groupKey))[0];
      if (sim) sim.source = result.column.source;
    });
    setStaleSources((prev) => {
      const next = Object.assign({}, prev);
      delete next[groupKey];
      return next;
    });
  };

  /* ---- the context menu ------------------------------------------- */

  const onContextMenu = (ev) => {
    // While a cell editor is open the right-click belongs to the EDITOR: the
    // user wants Paste, Select all, Undo on the text under the caret, and every
    // entry this menu carries acts on the row instead. So the grid does not
    // claim the gesture, and it does not preventDefault -- the browser's own
    // edit menu is the right answer here.
    //
    // stopPropagation as well, and for a reason worth keeping: the control
    // listens for contextmenu on the DOCUMENT. Its handler preventDefaults
    // whenever it is editing, which would swallow the edit menu this branch
    // exists to let through, and if the editor has been closed underneath it,
    // it walks the (now detached) target up through parentElement looking for
    // its own root and reads .classList of null. That TypeError reached the
    // global error trap and told the user something was broken, when the whole
    // truth was that this menu does not apply here.
    if (editing()) { ev.stopPropagation(); return; }
    ev.preventDefault();
    // A right-click acts on the cell under the pointer, so move the active cell
    // there first -- otherwise the menu would act on wherever the last click was.
    const td = ev.target && ev.target.closest ? ev.target.closest('td[data-x]') : null;
    if (td) {
      const x = parseInt(td.getAttribute('data-x'), 10);
      const y = parseInt(td.getAttribute('data-y'), 10);
      if (isFinite(x) && isFinite(y)) {
        const next = { x1: x, y1: y, x2: x, y2: y };
        selectionRef.current = next;
        setSelection(next);
        const ws = sheetRef.current;
        if (ws && typeof ws.updateSelectionFromCoords === 'function') {
          try { ws.updateSelectionFromCoords(x, y, x, y); } catch (err) { /* not selectable */ }
        }
      }
    }
    const compliance = block.type === 'datatable';
    const col = model.plan[activeCell().x] || {};
    const items = [
      { label: 'Setting row', glyph: '▤', onClick: () => setRowKind('setting') },
      { label: 'Result row', glyph: '□', onClick: () => setRowKind('result') },
      {
        label: selectedRows() > 1 ? 'Insert ' + selectedRows() + ' rows' : 'Insert row above',
        glyph: '⤒', separatorBefore: true, onClick: () => insertRow('above'),
      },
      { label: 'Insert row below', glyph: '⤓', onClick: () => insertRow('below') },
      { label: 'Delete row', glyph: '✕', danger: true, onClick: deleteRow },
      {
        label: 'Insert column', glyph: '⇥', separatorBefore: true,
        disabled: compliance && (col.kind !== 'axis' || col.group === 'spec'),
        onClick: insertColumn,
      },
      {
        label: 'Delete column', glyph: '✕',
        disabled: compliance && (col.kind !== 'axis' || col.group === 'spec'),
        onClick: deleteColumn,
      },
      { label: 'Fill down', glyph: '↓', key: 'Ctrl+D', separatorBefore: true, onClick: fillDown },
      { label: 'Undo', glyph: '↶', key: 'Ctrl+Z', disabled: !undoRef.current.past.length, onClick: undo },
      { label: 'Redo', glyph: '↷', key: 'Ctrl+Shift+Z', disabled: !undoRef.current.future.length, onClick: redo },
    ];
    if (compliance) {
      items.push({
        label: 'Merge across this group', glyph: '↔', separatorBefore: true,
        onClick: spanAcrossGroup,
      });
    }
    setMenu({ x: ev.clientX, y: ev.clientY, items: items });
  };

  /* ---- render ------------------------------------------------------ */

  if (!block) return null;

  const compliance = block.type === 'datatable';
  const resultRows = compliance
    ? (block.data.rows || []).filter((r) => !isSettingRow(r, cfg)).length : 0;
  const selectionSize = selection
    ? (selection.y2 - selection.y1 + 1) + ' × ' + (selection.x2 - selection.x1 + 1) + ' selected'
    : null;
  const limitNote = compliance && selection
    ? noLimitNote((block.data.rows || [])[selection.y1], cfg) : null;
  const presets = tablePresets(cfg);
  const staleKeys = Object.keys(staleSources);

  return html`
    <div class="rw-tbl">
      <div class="rw-tblbar" role="toolbar">
        <span class="rw-micro rw-tblbar__label">Row kind</span>
        <${SegmentedControl}
          value=${currentRowKind(block, cfg, selection)}
          options=${[
            { value: 'setting', label: 'Setting row' },
            { value: 'result', label: 'Result row' },
          ]}
          onChange=${setRowKind}
          ariaLabel="Row kind" />

        <span class="rw-tblbar__rule"></span>
        <${IconButton} glyph="⤒" title="Insert row above" onClick=${() => insertRow('above')} />
        <${IconButton} glyph="⤓" title="Insert row below" onClick=${() => insertRow('below')} />
        <${IconButton} glyph="✕" title="Delete row" danger onClick=${deleteRow} />
        <${IconButton} glyph="⇥" title="Insert column" onClick=${insertColumn} />
        <${IconButton} glyph="⇤" title="Delete column" onClick=${deleteColumn} />

        <span class="rw-tblbar__rule"></span>
        <${IconButton} glyph="↶" title="Undo" disabled=${!undoRef.current.past.length} onClick=${undo} />
        <${IconButton} glyph="↷" title="Redo" disabled=${!undoRef.current.future.length} onClick=${redo} />
        <${IconButton} glyph="↓" title="Fill down" onClick=${fillDown} />

        <span class="rw-tblbar__right">
          ${presets.length ? html`
            <${Button} glyph="▦" onClick=${(ev) => setMenu({
              x: ev.clientX, y: ev.clientY,
              items: presets.map((p) => ({
                label: p.label || p.key, glyph: p.icon || '▦',
                onClick: () => applyPreset(p.key),
              })),
            })}>Apply a preset<//>` : null}
          ${compliance ? html`
            <${Button} glyph="⊕" onClick=${() => setRefOpen(true)}>Add a reference column<//>` : null}
          <span class="rw-micro rw-tblbar__label">Density</span>
          <${SegmentedControl}
            value=${density}
            options=${[
              { value: 'tight', label: '≡', title: 'Density' },
              { value: 'normal', label: '≣', title: 'Density' },
              { value: 'loose', label: '☰', title: 'Density' },
            ]}
            onChange=${setDensity}
            ariaLabel="Density" />
          <${IconButton} glyph="⬇" title="Export .xlsx" onClick=${doExportXlsx} />
        </span>
      </div>

      ${staleKeys.length ? html`
        <div class="rw-tblnote rw-tblnote--warn">
          <span>Source has been updated</span>
          ${staleKeys.map((key) => html`
            <${Button} key=${key} level="tertiary" onClick=${() => refreshReference(key)}>
              Refresh from source
            <//>`)}
        </div>` : null}

      <div
        class=${cx('rw-grid', 'rw-grid__scroll', density === 'tight' && 'rw-grid--tight',
                   density === 'loose' && 'rw-grid--loose')}
        ref=${hostRef}
        onContextMenu=${onContextMenu}></div>

      <div class="rw-grid__foot">
        ${compliance ? html`
          <span>${resultRows} result rows</span>
          <span class=${overSpec.length ? 'rw-grid__foot--bad' : ''}>${overSpec.length} over spec</span>
        ` : html`
          <span>This table has no spec columns, so nothing is checked against a spec</span>
        `}
        ${selectionSize ? html`<span>${selectionSize}</span>` : null}
        <span class="rw-spacer"></span>
        <span>Arrow keys move · Shift extends · double-click edits · Ctrl+D fills down · Ctrl+Z undoes</span>
      </div>

      ${limitNote ? html`<div class="rw-tblnote">${limitNote}</div>` : null}

      ${menu ? html`
        <${Menu} x=${menu.x} y=${menu.y} items=${menu.items}
                 ariaLabel="More" onClose=${() => setMenu(null)} />` : null}

      ${refOpen ? html`
        <${ReferenceColumnDialog}
          dir=${dir} block=${block} cfg=${cfg}
          onClose=${() => setRefOpen(false)}
          onInsert=${(result, title) => { insertReferenceColumn(result, title); setRefOpen(false); }} />` : null}

      ${catAsk ? html`
        <${Dialog}
          title="Editing a merged category edits every row it covers"
          width=${440}
          onClose=${() => { catAsk.revert(); setCatAsk(null); }}
          footer=${html`
            <${Button} onClick=${() => { catAsk.revert(); setCatAsk(null); }}>Cancel<//>
            <${Button} level="primary" onClick=${() => { catWarnRef.current = true; setCatAsk(null); }}>Continue<//>`}>
          <div class="rw-meta">
            This changes the category on ${catAsk.count} rows. Merged cells hold one value
            for the whole run.
          </div>
        <//>` : null}

      ${toast ? html`
        <${Toast} key=${toast.id} text=${toast.text}
                  action=${toast.action ? 'Undo' : null}
                  onAction=${() => { undo(); setToast(null); }}
                  onDismiss=${() => setToast(null)} />` : null}
    </div>`;
}

/* ================================================================== *
 * 7 - cell read / write, shared by editing, fill-down and paste
 * ================================================================== */

function readCell(model, x, y) {
  const line = model.grid[y];
  return line ? (line[x] === undefined ? '' : line[x]) : '';
}

// One cell of the grid -> the block. Returns false when nothing was written
// (a read-only column, a reference column, a row that no longer exists).
function writeCell(ctx, x, y, text) {
  const { block, cfg, model } = ctx;
  const col = model.plan[x];
  if (!col || col.kind === 'num' || col.kind === 'sep') return false;
  if (model.mode === 'plain') {
    const rows = block.rows || [];
    const row = rows[y];
    if (row === undefined) return false;
    const cells = rowCells(row);
    while (cells.length <= col.index) cells.push('');
    cells[col.index] = String(text === null || text === undefined ? '' : text);
    if (Array.isArray(row)) rows[y] = cells;
    else row.cells = cells;
    return true;
  }
  const rows = block.data.rows || [];
  const row = rows[y];
  if (!row) return false;
  if (col.readOnly) return false;
  const value = String(text === null || text === undefined ? '' : text);
  if (col.kind === 'cat') { row.cat = value; return true; }
  if (col.kind === 'item') { row.item = value; return true; }
  if (col.kind === 'unit') { row.unit = value; return true; }
  if (col.kind === 'limit') { row.limit = parseLimit(value); return true; }
  if (col.kind === 'axis') { setAxisValue(row, col.group, col.axis, parseVal(value)); return true; }
  return false;
}

// The control edited one cell. Category runs are merged, so editing the run's
// head writes the whole run -- and says so the first time.
function applyCellEdit(ctx, x, y, value) {
  const { block, cfg, mutate, undo, catWarnRef, setCatAsk } = ctx;
  const model = gridModel(block, cfg);
  const col = model.plan[x];
  if (!col) return;
  let run = 1;
  mutate(() => {
    if (model.mode === 'compliance' && col.kind === 'cat') {
      const rows = block.data.rows || [];
      const was = (rows[y] || {}).cat;
      let end = y;
      while (end + 1 < rows.length && rows[end + 1].cat === was) end += 1;
      run = end - y + 1;
      for (let i = y; i <= end; i++) rows[i].cat = String(value === null ? '' : value);
      return true;
    }
    return writeCell({ block, cfg, model }, x, y, value);
  }, { rebuild: col.kind === 'cat' || col.kind === 'limit' || col.kind === 'item' });
  if (run > 1 && !catWarnRef.current) setCatAsk({ count: run, revert: undo });
}

function currentRowKind(block, cfg, selection) {
  const y = selection ? selection.y1 : 0;
  if (block.type === 'datatable') {
    const row = (block.data.rows || [])[y];
    return isSettingRow(row, cfg) ? 'setting' : 'result';
  }
  const kinds = plainRowKinds(block);
  return kinds[y] === 'setting' ? 'setting' : 'result';
}

// Word cannot encode a limit, so an imported table comes back without one. Say
// so where the user would otherwise expect the round trip to have kept it.
function noLimitNote(row, cfg) {
  if (!row || isSettingRow(row, cfg)) return null;
  if (row.limit) return null;
  return 'No limit set — this row is never marked over spec';
}

function parseTsv(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
  const table = lines.map((line) => line.split('\t'));
  let width = 0;
  table.forEach((row) => { width = Math.max(width, row.length); });
  // Ragged rows are padded to the widest row, the same fix the older editor carries.
  table.forEach((row) => { while (row.length < width) row.push(''); });
  return table;
}

// Appended rows inherit the kind of the row above them.
function appendRows(block, cfg, count) {
  if (block.type === 'datatable') {
    const rows = block.data.rows || (block.data.rows = []);
    const last = rows[rows.length - 1];
    for (let i = 0; i < count; i++) {
      const row = {
        cat: '', item: '', unit: '', kind: last ? last.kind || 'result' : 'result',
        spec: null, spec_mtm: [null, null, null], spec_ntwc: null, limit: null, sim_span: false,
      };
      if (last && last.sims) {
        row.sims = {};
        Object.keys(last.sims).forEach((k) => { row.sims[k] = { mtm: [null, null, null], ntwc: null }; });
      } else {
        row.sim_mtm = [null, null, null];
        row.sim_ntwc = null;
      }
      rows.push(row);
    }
    return;
  }
  const rows = block.rows || (block.rows = []);
  const width = Math.max(1, rowCells(rows[rows.length - 1]).length);
  const kinds = plainRowKinds(block);
  const inherit = kinds.length ? kinds[kinds.length - 1] : null;
  for (let i = 0; i < count; i++) {
    rows.push(new Array(width).fill(''));
    kinds.push(inherit === 'header' ? null : inherit);
  }
  block.row_kinds = kinds.map((k) => k || null);
}

/* ================================================================== *
 * 8 - header decoration
 *
 * The control draws two nested header rows plus its own column-title row. That
 * is the same three-row band the engine writes: group title, stage, axis.
 * ================================================================== */

function buildNestedHeaders(model) {
  const band = [];
  const stages = [];
  const push = (list, title, colspan, className) => {
    list.push({ title: title, colspan: colspan, className: className });
  };
  let lead = 0;
  for (let x = 0; x < model.plan.length; x++) {
    if (model.plan[x].kind === 'sep' || model.plan[x].kind === 'axis') break;
    lead += 1;
  }
  push(band, '', lead);
  push(stages, '', lead);
  for (let g = 0; g < model.groups.length; g++) {
    const group = model.groups[g];
    const width = group.axes.length + 1; // the separator column belongs to the group
    push(band, group.title || '', width);
    push(stages, group.stage || '', width);
  }
  push(band, '', 2);   // the trailing separator plus Unit
  push(stages, '', 2);
  return [band, stages];
}

// Header cells the control has already built: mark the axis row, the separator
// columns and the excluded axis, and hang the `not checked` note under it.
function decorateHeaders(host, model) {
  const table = host.querySelector('table.jss_worksheet');
  if (!table) return;
  const head = table.querySelector('thead');
  if (!head) return;
  const rows = head.querySelectorAll('tr');
  for (let r = 0; r < rows.length; r++) {
    const cells = rows[r].querySelectorAll('td');
    const last = r === rows.length - 1;
    for (let c = 0; c < cells.length; c++) {
      cells[c].classList.add(last ? 'rw-grid__axis' : 'rw-grid__band');
    }
  }
  const axisRow = rows[rows.length - 1];
  if (!axisRow) return;
  const cells = axisRow.querySelectorAll('td');
  // The control keeps its own hidden index cell as the first td.
  const offset = cells.length > model.plan.length ? cells.length - model.plan.length : 0;
  for (let x = 0; x < model.plan.length; x++) {
    const col = model.plan[x];
    const cell = cells[x + offset];
    if (!cell) continue;
    if (col.kind === 'sep') {
      cell.classList.remove('rw-grid__axis');
      cell.classList.add('rw-grid__sep');
      cell.textContent = '';
    } else if (col.kind === 'axis' && col.excluded) {
      cell.classList.add('rw-grid__axis--excluded');
      const note = document.createElement('span');
      note.className = 'rw-grid__axisnote';
      note.textContent = 'not checked';
      cell.appendChild(note);
    }
  }
}

/* ================================================================== *
 * 9 - the reference column dialog
 *
 * The values are a snapshot, never a live link. Matching is by item name; a row
 * that does not match is left EMPTY and listed, never guessed at.
 * ================================================================== */

const REF_EXPLAIN = 'The values are fixed at the moment you insert them, and the column '
  + 'records where they came from. If the source report changes later, this column does '
  + 'not change — a marker appears in the column header and you decide whether to refresh.';

const REF_READONLY = 'Reference columns are read-only, are not checked against a spec, '
  + 'and carry the source name into the exported header';

function siblingReports(tree, dir) {
  const out = [];
  const projects = (tree && tree.projects) || [];
  for (let p = 0; p < projects.length; p++) {
    const modules = projects[p].modules || [];
    for (let m = 0; m < modules.length; m++) {
      const reports = modules[m].reports || [];
      if (!reports.some((r) => r && r.dir === dir)) continue;
      reports.forEach((r) => { if (r && r.dir !== dir) out.push(r); });
    }
  }
  out.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  return out;
}

function ReferenceColumnDialog(props) {
  const { dir, block, cfg, onClose, onInsert } = props;
  const tree = store.get().tree;
  const options = useMemo(() => siblingReports(tree, dir), [tree, dir]);

  const [source, setSource] = useState(options.length ? options[0].dir : '');
  const [columns, setColumns] = useState([]);
  const [pick, setPick] = useState('');
  const [title, setTitle] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');

  // Which columns the source offers: its own groups, read from its document.
  useEffect(() => {
    let live = true;
    setColumns([]);
    setPick('');
    setResult(null);
    if (!source) return undefined;
    api.getProject(source).then((payload) => {
      if (!live) return;
      const project = (payload && payload.project) || payload;
      const found = [];
      const walk = (nodes) => {
        (nodes || []).forEach((node) => {
          (node.blocks || []).forEach((b) => {
            if (b && b.type === 'datatable') {
              makeGroups(b.data, cfg).forEach((g) => {
                if (g.role !== 'sim') return;
                g.axes.slice(0, MTM_AXES).forEach((axis) => {
                  // The option value is the entry's own index, not the group key
                  // joined to the axis: no delimiter can collide with a key the
                  // document chose, two blocks may well offer the same group and
                  // axis, and an index keeps this file plain text. (It used to be
                  // joined with a NUL, which made every text tool call the file
                  // binary -- grep then listed no lines from the largest view.)
                  found.push({
                    value: String(found.length),
                    label: (g.title || g.key) + ' · ' + axis,
                    group: g.key, axis: axis, stage: g.stage || '',
                  });
                });
              });
            }
          });
          walk(node.children);
        });
      };
      walk(project && project.outline);
      setColumns(found);
      if (found.length) {
        const preferred = found.filter((c) => c.axis === 'MAX')[0];
        setPick((preferred || found[0]).value);
      }
    }).catch((err) => { if (live) setFailed(String(err && err.message)); });
    return () => { live = false; };
  }, [source, cfg]);

  // Ask the server to match the rows and value the column.
  useEffect(() => {
    let live = true;
    if (!source || !pick) return undefined;
    const chosen = columns.filter((c) => c.value === pick)[0];
    if (!chosen) return undefined;
    setBusy(true);
    setFailed('');
    api.refcol({
      dir: dir, srcReport: source, targetBlock: block.id,
      group: chosen.group, axis: chosen.axis,
    }).then((payload) => {
      if (!live) return;
      setResult(payload);
      setTitle((payload && payload.column && payload.column.title) || '');
      setBusy(false);
    }).catch((err) => {
      if (!live) return;
      setFailed(String(err && err.message));
      setBusy(false);
    });
    return () => { live = false; };
  }, [source, pick, columns, dir, block.id]);

  const matches = (result && result.matches) || [];
  const summary = (result && result.summary) || { matched: 0, renamed: 0, nomatch: 0, total: 0 };
  const matchedCount = summary.matched + summary.renamed;
  const sourceName = String(source || '').split('/').filter((s) => s).pop() || String(source || '');
  const provenance = result && result.column && result.column.source
    ? [result.column.source.stage, result.column.source.date, result.column.source.version]
      .filter((s) => s).join(' · ')
    : '';

  const statusLabel = (status) => {
    if (status === 'matched') return 'Matched';
    if (status === 'renamed') return 'Renamed — matched by similarity';
    return 'No match';
  };

  return html`
    <${Dialog}
      title="Add a reference column"
      subtitle="Pull one column from another report of this module and compare side by side"
      width=${880}
      scrimCloses=${false}
      onClose=${onClose}
      footerLeft=${html`<span class="rw-meta">${REF_READONLY}</span>`}
      footer=${html`
        <${Button} onClick=${onClose}>Cancel<//>
        <${Button} level="primary" disabled=${!result || busy}
                   onClick=${() => onInsert(result, title)}>Insert this column<//>`}>
      <div class="rw-refcol">
        ${!options.length ? html`
          <div class="rw-empty"><div class="rw-empty__title">Nothing here yet</div></div>` : html`
          <div class="rw-refcol__top">
            <label class="rw-field">
              <span class="rw-field__label">Source report</span>
              <${Select} small value=${source} onChange=${setSource}
                options=${options.map((r) => ({
                  value: r.dir,
                  label: (r.stage ? r.stage + ' · ' : '') + (r.title || r.name || r.dir),
                }))} />
            </label>
            <label class="rw-field">
              <span class="rw-field__label">Which column</span>
              <${Select} small value=${pick} onChange=${setPick} options=${columns} />
            </label>
            <label class="rw-field rw-refcol__title">
              <span class="rw-field__label">New column title</span>
              <input class="rw-input rw-input--bar" value=${title}
                     onInput=${(ev) => setTitle(ev.target.value)} />
            </label>
          </div>`}

        <div class="rw-banner rw-banner--note rw-refcol__panel">
          <span class="rw-banner__glyph">i</span>
          <div class="rw-banner__body">
            <div class="rw-banner__title">This is a snapshot, not a live link</div>
            <div>${REF_EXPLAIN}</div>
            ${provenance ? html`<${Pill} tone="note">${provenance}<//>` : null}
          </div>
        </div>

        ${failed ? html`
          <div class="rw-banner rw-banner--blocking">
            <span class="rw-banner__glyph">✕</span>
            <div class="rw-banner__body">
              <div class="rw-banner__title">Something went wrong</div>
              <div>${failed}</div>
            </div>
          </div>` : null}

        ${busy ? html`<div class="rw-refcol__busy"><${Spinner} /><span>Loading…</span></div>` : null}

        ${result ? html`
          <div class="rw-section-title rw-refcol__head">How the rows were matched</div>
          <div class="rw-refcol__match">
            <div class="rw-refcol__mrow rw-refcol__mhead">
              <span>This report's rows</span>
              <span>Matching row in ${sourceName}</span>
              <span>Value</span>
              <span>Result</span>
            </div>
            ${matches.map((entry) => html`
              <div class="rw-refcol__mrow" key=${entry.row}>
                <span class="rw-truncate">${entry.item}</span>
                <span class="rw-truncate rw-dim">${entry.srcItem || ''}</span>
                <span class="rw-num">${fmtVal(entry.value)}</span>
                <span class=${'rw-refcol__status rw-refcol__status--' + entry.status}>
                  ${statusLabel(entry.status)}
                </span>
              </div>`)}
          </div>
          <div class="rw-meta rw-refcol__foot">
            Matched ${matchedCount} of ${summary.total} rows by item name · unmatched rows
            are left empty, never guessed
          </div>

          <div class="rw-section-title rw-refcol__head">Preview</div>
          <div class="rw-refcol__match">
            <div class="rw-refcol__mrow rw-refcol__mhead">
              <span>Item</span>
              <span>Value</span>
              <span>Δ</span>
              <span>Unit</span>
            </div>
            ${matches.map((entry) => html`
              <div class="rw-refcol__mrow" key=${'p' + entry.row}>
                <span class="rw-truncate">${entry.item}</span>
                <span class="rw-num">${fmtVal(entry.value)}</span>
                <span class=${cx('rw-num', 'rw-refcol__delta',
                                 entry.direction === 'toward' && 'rw-refcol__delta--toward',
                                 entry.direction === 'away' && 'rw-refcol__delta--away')}>
                  ${entry.delta === null || entry.delta === undefined
                    ? '' : (entry.delta > 0 ? '+' : '') + roundDelta(entry.delta)}
                </span>
                <span class="rw-dim">${entry.unit || ''}</span>
              </div>`)}
          </div>` : null}
      </div>
    <//>`;
}

function roundDelta(n) {
  const v = Number(n);
  if (!isFinite(v)) return '';
  if (Math.abs(v) >= 100) return String(Math.round(v));
  return String(Math.round(v * 1000) / 1000);
}

export default TableBlock;
