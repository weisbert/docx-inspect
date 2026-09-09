#!/usr/bin/env node
// test_v2_free_align.mjs -- which way a plain table's cells read, and who says so.
//
// Run:  node builder/tests/test_v2_free_align.mjs
//       RW_PYTHON=... node builder/tests/test_v2_free_align.mjs
//
// WHY THIS FILE EXISTS
// --------------------
// A plain table was centred everywhere, with no way to say otherwise: a column
// holding a numbered list of conditions read as badly centred prose beside the
// short labels that wanted the centre. Alignment is a column's property here --
// `block.col_align` -- because a cell edit rewrites the cell and would take a
// per-cell setting with it; a cell may still overrule its column by carrying an
// `align` key, which is what a generated table uses for the odd cell.
//
// The trap this file guards is the one row_fills fell into twice: a name
// addressed BY POSITION that is not moved when the positions move. Inserting or
// deleting a column with the alignments left alone hands every column past the
// cut its neighbour's alignment.
//
// WHAT IT COVERS
//   1. reading: the list, map and single-name forms, and the precedence
//      cell > column > centred
//   2. the grid: the column plan carries the alignment the control aligns by
//   3. moving: insert and delete carry alignments (and widths) with the columns
//   4. writing: a table nobody has aligned keeps no col_align key at all, so
//      the upstream diff stays quiet about it
//   5. the renderer agrees: the same block put to core/tables.py in a Python
//      child process resolves every cell to the same side
//
// AGAINST THE PRE-FIX FILE: everything -- there was no alignment to read.
//
// IT NEVER TOUCHES REAL REPORTS: every table here is written in this file.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const V2 = process.env.RW_V2_DIR
  ? path.resolve(process.env.RW_V2_DIR)
  : path.join(REPO, 'builder', 'web', 'assets', 'v2');
const CORE = path.join(REPO, 'builder', 'core');

const failures = [];
let count = 0;

async function test(name, fn) {
  count += 1;
  try {
    await fn();
    console.log('  [ok  ] ' + name);
  } catch (err) {
    failures.push(name);
    console.log('  [FAIL] ' + name);
    const detail = (err && err.stack ? err.stack : String(err)).split('\n').slice(0, 6);
    for (const line of detail) console.log('         ' + line);
  }
}

function section(title) {
  console.log('\n' + title);
}

/* ------------------------------------------------------------------ *
 * the table the work was done for: short labels, one column of prose
 * ------------------------------------------------------------------ */

function reviewTable() {
  return {
    type: 'table',
    id: 'tbl',
    header_rows: 1,
    rows: [
      ['Item', 'Check', 'Finding'],
      ['EOS', 'static', { runs: [{ t: '1. no violation\n2. within the limit' }] }],
      ['EOS', 'dynamic', { runs: [{ t: 'see above' }], align: 'right' }],
      ['Aging', 'ten years', 'within the limit'],
    ],
    col_align: [null, 'center', 'left'],
  };
}

/* ------------------------------------------------------------------ *
 * the renderer, consulted for real
 * ------------------------------------------------------------------ */

const PY = [
  'import json, sys',
  'sys.path.insert(0, sys.argv[1])',
  'import tables',
  'block = json.load(sys.stdin)',
  'rows = block["rows"]',
  'ncols = max(len(tables._row_cells(r)) for r in rows)',
  'caligns = tables._col_align_list(block.get("col_align"), ncols)',
  'out = []',
  'for row in rows:',
  '    cells = tables._row_cells(row)',
  '    line = []',
  '    for c in range(ncols):',
  '        val = cells[c] if c < len(cells) else ""',
  '        line.append(tables._cell_align(val) or caligns[c])',
  '    out.append(line)',
  'json.dump(out, sys.stdout)',
].join('\n');

function askRenderer(block) {
  const python = process.env.RW_PYTHON || 'python';
  const run = spawnSync(python, ['-c', PY, CORE], {
    cwd: REPO, input: JSON.stringify(block), encoding: 'utf8',
  });
  if (run.error && run.error.code === 'ENOENT') return null;
  if (run.status !== 0) {
    throw new Error('the renderer refused to answer:\n' + (run.stderr || run.stdout || ''));
  }
  return JSON.parse(run.stdout);
}

/* ------------------------------------------------------------------ *
 * load the module under test
 * ------------------------------------------------------------------ */

for (const name of ['preact.umd.js', 'hooks.umd.js', 'htm.umd.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(V2, 'vendor', name), 'utf8'), { filename: name });
}

const table = await import(pathToFileURL(path.join(V2, 'js', 'views', 'table.js')).href);

console.log('Report Workbench v2 -- a column reads the way it says it does');

/* ------------------------------------------------------------------ *
 * 1 - reading
 * ------------------------------------------------------------------ */

section('reading the alignment');

await test('a list names its columns in order', () => {
  const block = reviewTable();
  assert.deepEqual(table.plainColAligns(block, 3), [null, 'center', 'left']);
});

await test('a map names them by index', () => {
  const block = reviewTable();
  block.col_align = { 2: 'right' };
  assert.deepEqual(table.plainColAligns(block, 3), [null, null, 'right']);
});

await test('one name covers the whole table', () => {
  const block = reviewTable();
  block.col_align = 'left';
  assert.deepEqual(table.plainColAligns(block, 3), ['left', 'left', 'left']);
});

await test('a name nobody knows is not an alignment', () => {
  const block = reviewTable();
  block.col_align = ['middle', 'CENTRE', 'Left'];
  assert.deepEqual(table.plainColAligns(block, 3), [null, 'center', 'left'],
    'a typo centres; case and the British spelling still read');
});

await test('a table that says nothing aligns nothing', () => {
  const block = reviewTable();
  delete block.col_align;
  assert.deepEqual(table.plainColAligns(block, 3), [null, null, null]);
});

await test('a cell overrules its column, and nothing else does', () => {
  const block = reviewTable();
  const aligns = table.plainColAligns(block, 3);
  const cells = table.rowCells(block.rows[2]);
  assert.equal(table.cellAlign(cells[2], aligns[2]), 'right', "the cell's own align wins");
  assert.equal(table.cellAlign(table.rowCells(block.rows[1])[2], aligns[2]), 'left',
    'a cell with no align of its own takes its column');
  assert.equal(table.cellAlign('plain text', aligns[0]), null,
    'and a column with no alignment leaves the cell centred by default');
});

await test('a cell is read for its text, not printed as an object', () => {
  const block = reviewTable();
  assert.equal(table.cellText(table.rowCells(block.rows[2])[2]), 'see above');
  assert.equal(table.cellText({ align: 'left' }), '', 'a cell described only by keys is empty');
  assert.equal(table.cellText(null), '');
});

/* ------------------------------------------------------------------ *
 * 2 - the grid
 * ------------------------------------------------------------------ */

section('what the grid is built with');

await test('the column plan carries the alignment', () => {
  const model = table.gridModel(reviewTable(), {});
  const cells = model.plan.filter((c) => c.kind === 'cell');
  assert.deepEqual(cells.map((c) => c.align), ['center', 'center', 'left'],
    'a column with no alignment of its own is centred, like the document');
});

/* ------------------------------------------------------------------ *
 * 3 - moving columns
 * ------------------------------------------------------------------ */

section('inserting and deleting a column');

await test('an inserted column does not shift the alignments below it', () => {
  const block = reviewTable();
  block.col_w = [2, 3, 6];
  assert.equal(table.insertPlainColumn(block, 1), true);
  assert.deepEqual(block.col_align, [null, null, 'center', 'left'],
    'the new column is unaligned; the prose column is still the prose column');
  assert.deepEqual(block.col_w, [2, 2, 3, 6], 'and the widths moved with them');
  assert.deepEqual(table.rowCells(block.rows[0]), ['Item', '', 'Check', 'Finding']);
});

await test('a deleted column takes its alignment with it', () => {
  const block = reviewTable();
  block.col_w = [2, 3, 6];
  assert.equal(table.deletePlainColumn(block, 1), true);
  assert.deepEqual(block.col_align, [null, 'left']);
  assert.deepEqual(block.col_w, [2, 6]);
  assert.deepEqual(table.rowCells(block.rows[0]), ['Item', 'Finding']);
});

await test('the last column stays, and nothing else moves with it', () => {
  const block = { type: 'table', id: 't', header_rows: 1, rows: [['only'], ['one']],
                  col_w: [4], col_align: ['left'] };
  assert.equal(table.deletePlainColumn(block, 0), false);
  assert.deepEqual(block.col_align, ['left'], 'the alignment is not cut either');
  assert.deepEqual(block.col_w, [4]);
});

/* ------------------------------------------------------------------ *
 * 4 - writing it back
 * ------------------------------------------------------------------ */

section('writing the alignment back');

await test('a table nobody aligned keeps no key at all', () => {
  const block = reviewTable();
  table.setColAligns(block, [null, null, null]);
  assert.equal('col_align' in block, false,
    'an all-centred table must not gain a field, or every diff carries one');
});

await test('and a table with one aligned column keeps a full list', () => {
  const block = reviewTable();
  table.setColAligns(block, [null, 'right', null]);
  assert.deepEqual(block.col_align, [null, 'right', null]);
});

/* ------------------------------------------------------------------ *
 * 5 - the renderer agrees
 * ------------------------------------------------------------------ */

section('the document puts the same text on the same side');

await test('every cell resolves the way core/tables.py resolves it', () => {
  const block = reviewTable();
  const theirs = askRenderer(block);
  if (theirs === null) {
    console.log('         (no python on PATH -- set RW_PYTHON; skipped)');
    return;
  }
  const aligns = table.plainColAligns(block, 3);
  const ours = block.rows.map((row) => {
    const cells = table.rowCells(row);
    return [0, 1, 2].map((c) => table.cellAlign(cells[c], aligns[c]));
  });
  assert.deepEqual(ours, theirs);
});

/* ------------------------------------------------------------------ */

console.log('');
if (failures.length) {
  console.log('FAILED ' + failures.length + ' of ' + count + ': ' + failures.join(', '));
  process.exit(1);
}
console.log('all ' + count + ' assertions passed');
