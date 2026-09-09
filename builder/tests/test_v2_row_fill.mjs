#!/usr/bin/env node
// test_v2_row_fill.mjs -- a row's own colour, set by hand and kept.
//
// Run:  node builder/tests/test_v2_row_fill.mjs
//       RW_PYTHON=... node builder/tests/test_v2_row_fill.mjs
//
// WHY THIS FILE EXISTS
// --------------------
// The editor could colour a row only by its KIND -- header, condition, result.
// A comparison table shaped as before / after / difference triplets has no kind
// for "difference", so colouring those rows meant hand-editing row_fills (the
// index map that is handed to the wrong rows by the next insert, twice fixed) or
// inventing a kind in the template config: a config edit for what should be a
// click. A row can carry `fill` instead -- a bare RRGGBB on the row itself.
//
// The whole point is that it travels WITH the row, so most of this file is
// about the row moving underneath it.
//
// WHAT IT COVERS
//   1. reading: what counts as a colour and what does not
//   2. writing: a row becomes a dict to carry one and drops back to a bare list
//      when it no longer does -- an empty wrapper would sit in every upstream
//      diff for the rest of the report's life
//   3. moving: insert and delete carry the colour, and a row inserted inside a
//      coloured band belongs to the band
//   4. the document agrees: the same rows rendered by core/tables.py in a
//      Python child process come back shaded the same way
//
// AGAINST THE PRE-FIX FILE: everything -- there was no such field.
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

const DIFF = 'DCE6F1';
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
 * the table that asked for this
 * ------------------------------------------------------------------ */

function tripletTable() {
  return {
    type: 'table',
    id: 'tbl',
    header_rows: 1,
    rows: [
      ['Item', 'Value'],
      ['Before', '1.10'],
      ['After', '1.14'],
      { cells: ['Difference', '+0.04'], fill: DIFF },
    ],
    row_kinds: ['header', null, null, null],
  };
}

/* ------------------------------------------------------------------ *
 * the renderer, consulted for real: what colour does each row come out?
 * ------------------------------------------------------------------ */

const PY = [
  'import json, sys',
  'sys.path.insert(0, sys.argv[1])',
  'import tables',
  'from docx import Document',
  'from docx.oxml.ns import qn',
  'block = json.load(sys.stdin)',
  'cfg = {"header_fill": "D9D9D9", "border": {"val": "single", "sz": 4, "color": "000000"},',
  '       "font_pt": 8}',
  't = tables.render_free_table(Document(), block["rows"], cfg,',
  '                             header_rows=block.get("header_rows", 1),',
  '                             row_kinds=block.get("row_kinds"),',
  '                             row_fills=block.get("row_fills"))["table"]',
  'out = []',
  'for row in t.rows:',
  '    tcPr = row.cells[0]._tc.find(qn("w:tcPr"))',
  '    shd = None if tcPr is None else tcPr.find(qn("w:shd"))',
  '    val = None if shd is None else shd.get(qn("w:fill"))',
  '    out.append(None if val in (None, "auto") else val.upper())',
  'json.dump(out, sys.stdout)',
].join('\n');

function askRenderer(block) {
  const python = process.env.RW_PYTHON || 'python';
  const run = spawnSync(python, ['-c', PY, CORE], {
    cwd: REPO, input: JSON.stringify(block), encoding: 'utf8',
  });
  if (run.error && run.error.code === 'ENOENT') return null;
  if (run.status !== 0) {
    if (/ModuleNotFoundError/.test(run.stderr || '')) return null;   // no python-docx
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

console.log('Report Workbench v2 -- a row keeps the colour it was given');

/* ------------------------------------------------------------------ *
 * 1 - reading
 * ------------------------------------------------------------------ */

section('what counts as a colour');

await test('a colour is read however it is written', () => {
  assert.equal(table.fillHex('#dce6f1'), DIFF);
  assert.equal(table.fillHex('  DCE6F1 '), DIFF);
});

await test('and anything else is not one', () => {
  assert.equal(table.fillHex('cornflower'), null);
  assert.equal(table.fillHex('DCE6F'), null, 'five digits is not a colour');
  assert.equal(table.fillHex(''), null);
  assert.equal(table.fillHex(null), null);
  assert.equal(table.fillHex(0xdce6f1), null, 'a number is not a colour either');
});

await test('only the row that carries one has one', () => {
  const block = tripletTable();
  assert.deepEqual(block.rows.map(table.plainRowFill), [null, null, null, DIFF]);
});

/* ------------------------------------------------------------------ *
 * 2 - writing
 * ------------------------------------------------------------------ */

section('giving and taking away');

await test('a plain row becomes a dict to carry a colour, keeping its cells', () => {
  const block = tripletTable();
  assert.equal(table.setPlainRowFill(block, 1, DIFF), true);
  assert.deepEqual(block.rows[1], { cells: ['Before', '1.10'], fill: DIFF });
  assert.deepEqual(table.rowCells(block.rows[1]), ['Before', '1.10'],
    'and it still reads as the same row');
});

await test('taking the colour away leaves a bare list behind, not an empty wrapper', () => {
  const block = tripletTable();
  assert.equal(table.setPlainRowFill(block, 3, null), true);
  assert.deepEqual(block.rows[3], ['Difference', '+0.04'],
    'no {cells: [...]} shell to sit in every diff from here on');
});

await test('a row that carries something else keeps its wrapper', () => {
  const block = tripletTable();
  block.rows[3].kind = 'result';
  table.setPlainRowFill(block, 3, null);
  assert.deepEqual(block.rows[3], { cells: ['Difference', '+0.04'], kind: 'result' });
});

await test('a colour that is not one changes nothing', () => {
  const block = tripletTable();
  assert.equal(table.setPlainRowFill(block, 1, 'cornflower'), false);
  assert.deepEqual(block.rows[1], ['Before', '1.10']);
});

await test('setting the same colour twice is not an edit', () => {
  const block = tripletTable();
  assert.equal(table.setPlainRowFill(block, 3, DIFF), false,
    'so the toolbar does not push an undo step for a no-op');
});

/* ------------------------------------------------------------------ *
 * 3 - the row moves
 * ------------------------------------------------------------------ */

section('the colour travels with the row');

await test('deleting a row above it does not repaint the one below', () => {
  const block = tripletTable();
  assert.equal(table.deletePlainRows(block, 1, 1), true);
  assert.deepEqual(block.rows.map(table.plainRowFill), [null, null, DIFF],
    'the difference row is still the only coloured one');
  assert.deepEqual(table.rowCells(block.rows[2]), ['Difference', '+0.04']);
});

await test('inserting a row above it does not either', () => {
  const block = tripletTable();
  table.insertPlainRows(block, 1, 1, 1);
  assert.deepEqual(block.rows.map(table.plainRowFill), [null, null, null, null, DIFF]);
});

await test('a row inserted inside a coloured band belongs to the band', () => {
  const block = tripletTable();
  block.rows[2] = { cells: ['After', '1.14'], fill: DIFF };
  table.insertPlainRows(block, 3, 1, 2);            // shaped like the row above it
  assert.deepEqual(block.rows.map(table.plainRowFill), [null, null, DIFF, DIFF, DIFF]);
  assert.deepEqual(table.rowCells(block.rows[3]), ['', ''], 'and it is empty, like any new row');
});

await test('a row inserted under the header does not inherit the header', () => {
  const block = tripletTable();
  block.rows[0] = { cells: ['Item', 'Value'], kind: 'header', fill: 'FFFF00' };
  table.insertPlainRows(block, 1, 1, 0);
  assert.equal(table.plainRowFill(block.rows[1]), null);
});

/* ------------------------------------------------------------------ *
 * 4 - the document agrees
 * ------------------------------------------------------------------ */

section('the document paints what the editor shows');

await test('every row comes out of the renderer the colour the editor drew', () => {
  const block = tripletTable();
  const theirs = askRenderer(block);
  if (theirs === null) {
    console.log('         (no python / no python-docx -- set RW_PYTHON; skipped)');
    return;
  }
  assert.deepEqual(theirs, ['D9D9D9', null, null, DIFF]);
  block.rows.forEach((row, i) => {
    const own = table.plainRowFill(row);
    if (own) assert.equal(theirs[i], own, 'row ' + i + ' is painted by hand');
  });
});

await test('and a colour taken away in the editor is gone from the document', () => {
  const block = tripletTable();
  table.setPlainRowFill(block, 3, null);
  const theirs = askRenderer(block);
  if (theirs === null) return;
  assert.deepEqual(theirs, ['D9D9D9', null, null, null]);
});

/* ------------------------------------------------------------------ */

console.log('');
if (failures.length) {
  console.log('FAILED ' + failures.length + ' of ' + count + ': ' + failures.join(', '));
  process.exit(1);
}
console.log('all ' + count + ' assertions passed');
