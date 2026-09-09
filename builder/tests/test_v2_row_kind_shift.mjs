#!/usr/bin/env node
// test_v2_row_kind_shift.mjs -- a deleted row takes its colour with it.
//
// Run:  node builder/tests/test_v2_row_kind_shift.mjs
//       RW_PYTHON=... node builder/tests/test_v2_row_kind_shift.mjs
//
// WHY THIS FILE EXISTS
// --------------------
// Deleting one condition row from a plain table repainted the result rows
// below it as conditions. Two faults, one edit:
//
//   1. the row actions asked plainRowKinds() for the kinds AFTER splicing the
//      rows out. That function is bounded by rows.length and falls back to the
//      legacy index-keyed row_fills for any row that declares no kind, so it
//      was answering about a table that had already changed: the list came back
//      short by the rows just removed, was then spliced a SECOND time, and the
//      surviving fills lined up against whatever row had slid into their index;
//   2. row_fills itself was never renumbered, so its entries stayed on the old
//      positions and an entry past the end of the shortened table survived --
//      invisible, until a later insert brought it back into range.
//
// What landed in a real report: a seven-row table (one header, three
// conditions, three results) came out of one delete with every row marked as a
// condition and a row_fills key numbered past the last row.
//
// WHAT IT COVERS
//   1. delete: kinds travel with their rows, fills are renumbered, an entry on
//      a deleted row is dropped, and the last row cannot be deleted away
//   2. insert: kinds travel, fills below the insert move down with them
//   3. append: an entry stranded past the old end is not resurrected
//   4. the engine reads the result the way the grid draws it -- the same rows
//      put to core/tables.py::_row_kind_list in a Python child process
//
// AGAINST THE PRE-FIX FILE: section 1 fails (result rows come back marked
// 'setting' and row_fills keeps its stale keys) and section 3 fails.
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
 * the table the defect was found with
 * ------------------------------------------------------------------ */

const SETTING_FILL = 'EEECE1';

// One header, three condition rows, three result rows -- and the colours
// carried the OLD way, as an index-keyed map with no row_kinds at all. That is
// what content written by the previous editor looks like, and it is the shape
// the fault needed: with no declared kind, every row's colour is read out of
// this map by position.
function legacyTable() {
  return {
    type: 'table',
    id: 'tbl',
    header_rows: 1,
    rows: [
      ['Item', 'Value', 'Unit'],
      ['Supply', '1.1', 'V'],
      ['Supply', '0.9', 'V'],
      ['Temperature', '25', 'C'],
      ['Gain margin', '11.4', 'dB'],
      ['Phase margin', '62', 'deg'],
      ['Start-up time', '18', 'us'],
    ],
    row_fills: { 1: SETTING_FILL, 2: SETTING_FILL, 3: SETTING_FILL },
  };
}

/* ------------------------------------------------------------------ *
 * the engine, consulted for real
 * ------------------------------------------------------------------ */

const PY = [
  'import json, sys',
  'sys.path.insert(0, sys.argv[1])',
  'import tables',
  'block = json.load(sys.stdin)',
  'kinds = tables._row_kind_list(block["rows"], block.get("row_kinds"))',
  'json.dump(kinds, sys.stdout)',
].join('\n');

function askEngine(block) {
  const python = process.env.RW_PYTHON || 'python';
  const run = spawnSync(python, ['-c', PY, CORE], {
    cwd: REPO, input: JSON.stringify(block), encoding: 'utf8',
  });
  if (run.error && run.error.code === 'ENOENT') return null;
  if (run.status !== 0) {
    throw new Error('the engine refused to answer:\n' + (run.stderr || run.stdout || ''));
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

console.log('Report Workbench v2 -- row kinds travel with their rows');

/* ------------------------------------------------------------------ *
 * 1 - delete
 * ------------------------------------------------------------------ */

section('deleting a condition row');

await test('the fixture really reads its colours by position', () => {
  const block = legacyTable();
  assert.deepEqual(table.plainRowKinds(block),
    ['header', 'setting', 'setting', 'setting', null, null, null]);
});

await test('the result rows are still results afterwards', () => {
  const block = legacyTable();
  assert.equal(table.deletePlainRows(block, 2, 1), true, 'the delete must happen');
  assert.deepEqual(block.row_kinds,
    ['header', 'setting', 'setting', null, null, null],
    'six rows: header, two conditions, three results');
  assert.deepEqual(table.plainRowKinds(block),
    ['header', 'setting', 'setting', null, null, null]);
});

await test('the rows themselves lost exactly the one that was deleted', () => {
  const block = legacyTable();
  table.deletePlainRows(block, 2, 1);
  assert.deepEqual(block.rows.map((r) => r[0]),
    ['Item', 'Supply', 'Temperature', 'Gain margin', 'Phase margin', 'Start-up time']);
});

await test('row_fills is renumbered onto the rows it still colours', () => {
  const block = legacyTable();
  table.deletePlainRows(block, 2, 1);
  assert.deepEqual(block.row_fills, { 1: SETTING_FILL, 2: SETTING_FILL },
    'the entry on the deleted row goes; the one below it moves up');
});

await test('no key survives past the end of the shortened table', () => {
  const block = legacyTable();
  block.row_fills[6] = SETTING_FILL;          // colours the last row
  table.deletePlainRows(block, 2, 2);         // two rows out, six left
  const keys = Object.keys(block.row_fills).map(Number);
  assert.ok(keys.every((i) => i >= 0 && i < block.rows.length),
    'every remaining key must address a row that exists: ' + JSON.stringify(block.row_fills));
});

await test('deleting a whole selection keeps the rest lined up', () => {
  const block = legacyTable();
  table.deletePlainRows(block, 1, 3);          // all three conditions at once
  assert.deepEqual(block.row_kinds, ['header', null, null, null]);
  assert.deepEqual(block.row_fills, {});
});

await test('a table is never emptied of its last row', () => {
  const block = { type: 'table', rows: [['only']], header_rows: 0 };
  assert.equal(table.deletePlainRows(block, 0, 1), false);
  assert.equal(block.rows.length, 1);
});

/* ------------------------------------------------------------------ *
 * 2 - insert
 * ------------------------------------------------------------------ */

section('inserting a row');

await test('a row inserted among the conditions is a condition', () => {
  const block = legacyTable();
  table.insertPlainRows(block, 2, 1, 1);       // below the first condition
  assert.deepEqual(block.row_kinds,
    ['header', 'setting', 'setting', 'setting', 'setting', null, null, null]);
});

await test('the colours below an insert move down with their rows', () => {
  const block = legacyTable();
  table.insertPlainRows(block, 2, 1, 1);
  assert.deepEqual(block.row_fills,
    { 1: SETTING_FILL, 3: SETTING_FILL, 4: SETTING_FILL },
    'the entries that were 2 and 3 are now 3 and 4');
});

await test('a row inserted below the header does not inherit header', () => {
  const block = legacyTable();
  table.insertPlainRows(block, 1, 1, 0);
  assert.equal(block.row_kinds[1], null);
  assert.equal(block.row_kinds[0], 'header');
});

await test('the inserted row is as wide as the one it was modelled on', () => {
  const block = legacyTable();
  table.insertPlainRows(block, 2, 2, 1);
  assert.equal(block.rows[2].length, 3);
  assert.equal(block.rows[3].length, 3);
});

/* ------------------------------------------------------------------ *
 * 3 - append
 * ------------------------------------------------------------------ */

section('appending rows');

await test('an entry stranded past the end is not brought back', () => {
  const block = legacyTable();
  block.row_fills[9] = SETTING_FILL;          // left over from a longer table
  table.appendRows(block, null, 3);
  const keys = Object.keys(block.row_fills).map(Number);
  assert.ok(!keys.includes(9),
    'a key beyond the old last row must not colour a row that has just arrived');
  assert.deepEqual(table.plainRowKinds(block).slice(7), [null, null, null],
    'the appended rows carry the kind of the row above, which is a result row');
});

/* ------------------------------------------------------------------ *
 * 4 - and the engine reads it the same way
 * ------------------------------------------------------------------ */

section('the engine that writes the document agrees');

const block = legacyTable();
table.deletePlainRows(block, 2, 1);
const engine = askEngine(block);
if (!engine) {
  console.log('  SKIP: no Python interpreter on PATH, so the engine cannot be consulted.');
} else {
  await test('core/tables.py reads the same kinds the grid draws', () => {
    assert.deepEqual(engine, table.plainRowKinds(block));
    assert.deepEqual(engine, ['header', 'setting', 'setting', null, null, null],
      'the three result rows must reach the document unshaded');
  });
}

console.log('\n' + (failures.length
  ? failures.length + ' of ' + count + ' failed: ' + failures.join(', ')
  : 'all ' + count + ' checks passed'));
process.exit(failures.length ? 1 : 0);
