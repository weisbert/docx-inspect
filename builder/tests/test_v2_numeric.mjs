#!/usr/bin/env node
// test_v2_numeric.mjs -- the interface and the engine must agree about which
// number is over spec.
//
// Run:  node builder/tests/test_v2_numeric.mjs
//
// WHY THIS FILE EXISTS
// --------------------
// "A value that violates its spec is red" is the only verdict this tool has, so
// the red on screen has to be the red the exported document prints. That means
// the browser needs the engine's numeric rule -- core/tables.py::_numv, which is
// Python's float() with a [value, "CORNER"] pair unwrapped first -- and NOT a JS
// approximation of it.
//
// There were three approximations, and all three disagreed with the engine and
// with each other. One screen showed four different answers about the same
// table:
//
//     table.js   parseFloat('5%')  -> 5   : red cell, footer "1 over spec"
//     preview.js Number('   ')     -> 0   : two different cells red
//     editor.js  Number('0x10')    -> 16  : header pill "1 over spec"
//     the engine float(...) raises -> None: GET /api/tree said overSpec 0
//
// So there is now one parser, util.numericValue, and this file pins it to the
// engine by GENERATING the expected values with the engine itself: every case
// below is fed to the real tables._numv in a Python child process, and the
// answer that comes back is what numericValue has to return. The mirror is
// proven on each run rather than asserted once by a human who read both.
//
// WHAT IT COVERS
//   1. numericValue against a Python-generated case table
//   2. the same for _flags_from: which axes of a row are over spec, generated
//      by the engine, checked against table.js's flagsFor -- including a null
//      NTWC never being flagged and spec_ntwc overriding the MTM thresholds
//   3. source pins: no view may carry a second parser
//
// AGAINST THE PRE-FIX FILES every one of these fails. The cases tagged PIN are
// the ones that fail for a reason a human should be able to name:
//   * '5%' is not 5            (pre-fix table.js reddened a cell the engine did not)
//   * '   ' is not 0           (pre-fix preview.js judged a blank cell as zero)
//   * '0x10' is not 16         (pre-fix preview.js and editor.js read hex)
//   * 'inf' IS infinity        (pre-fix table.js MISSED a real over-spec value)
//   * table.numv is util.numericValue, not a private copy

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));      // builder/tests
const REPO = path.resolve(HERE, '..', '..');
const V2 = path.join(REPO, 'builder', 'web', 'assets', 'v2');
const CORE = path.join(REPO, 'builder', 'core');

// The interface ships .js files the browser loads as modules, and package.json
// deliberately has no "type" field so the CommonJS harnesses next to this file
// keep working. Importing one from node prints a single advisory that says
// nothing about this code; swallow that one and leave every other warning.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning && warning.code === 'MODULE_TYPELESS_PACKAGE_JSON') return;
  console.warn(warning && warning.stack ? warning.stack : String(warning));
});

/* ------------------------------------------------------------------ *
 * tiny runner
 * ------------------------------------------------------------------ */

const failures = [];
let count = 0;

function test(name, fn, options) {
  count += 1;
  const tag = options && options.pin ? ' [PIN]' : '';
  try {
    fn();
    console.log('  [ok  ] ' + name + tag);
  } catch (err) {
    failures.push(name);
    console.log('  [FAIL] ' + name + tag);
    const detail = (err && err.stack ? err.stack : String(err)).split('\n').slice(0, 6);
    for (const line of detail) console.log('         ' + line);
  }
}

function section(title) {
  console.log('\n' + title);
}

/* ------------------------------------------------------------------ *
 * the engine, consulted for real
 * ------------------------------------------------------------------ */

// Runs tables._numv over a list of Python literals and tables._flags_from over
// a list of rows, and reports both back as JSON. Infinity and NaN have no JSON
// spelling, so numbers come back tagged.
const PY = [
  'import ast, json, sys',
  'sys.path.insert(0, sys.argv[1])',
  'import tables',
  '',
  'def enc(x):',
  '    if x is None:',
  '        return {"k": "none"}',
  '    if x != x:',
  '        return {"k": "nan"}',
  '    if x == float("inf"):',
  '        return {"k": "inf"}',
  '    if x == float("-inf"):',
  '        return {"k": "-inf"}',
  '    return {"k": "num", "v": x}',
  '',
  'payload = json.load(sys.stdin)',
  'values = [enc(tables._numv(ast.literal_eval(src))) for src in payload["values"]]',
  'flags = []',
  'for item in payload["flags"]:',
  '    mtm, ntwc = tables._sim_axis_vals(item["row"], item["key"])',
  '    flags.append(sorted(tables._flags_from(item["row"], mtm, ntwc)))',
  'json.dump({"values": values, "flags": flags}, sys.stdout)',
].join('\n');

function askEngine(payload) {
  const python = process.env.RW_PYTHON || 'python';
  const run = spawnSync(python, ['-c', PY, CORE], {
    cwd: REPO,
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
  if (run.error && run.error.code === 'ENOENT') return null;   // no interpreter
  if (run.status !== 0) {
    throw new Error('the engine refused to answer:\n' + (run.stderr || run.stdout || ''));
  }
  return JSON.parse(run.stdout);
}

// A tagged answer -> the JS value it stands for.
function decode(tagged) {
  if (tagged.k === 'none') return null;
  if (tagged.k === 'nan') return NaN;
  if (tagged.k === 'inf') return Infinity;
  if (tagged.k === '-inf') return -Infinity;
  return tagged.v;
}

function show(v) {
  if (v === null) return 'null';
  if (typeof v === 'number' && Number.isNaN(v)) return 'NaN';
  return String(v);
}

// null === null, NaN matches NaN, and -0 stays distinct from 0.
function sameNumber(a, b) {
  if (a === null || b === null) return a === b;
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  return Object.is(a, b);
}

/* ------------------------------------------------------------------ *
 * the case table
 *
 * `js` is the value handed to numericValue; `py` is the same value written as
 * a Python literal, handed to tables._numv. `undefined` is the one case with no
 * Python spelling: both languages mean "there is no value here", so it is
 * checked against None.
 * ------------------------------------------------------------------ */

const CASES = [
  // the cases the defect was found with
  { label: "''", js: '', py: "''", pin: true },
  { label: "'   '", js: '   ', py: "'   '", pin: true },
  { label: "'5%'", js: '5%', py: "'5%'", pin: true },
  { label: "'12 dB'", js: '12 dB', py: "'12 dB'", pin: true },
  { label: "'<3'", js: '<3', py: "'<3'" },
  { label: "'0x10'", js: '0x10', py: "'0x10'", pin: true },
  { label: "'1e3'", js: '1e3', py: "'1e3'" },
  { label: "' 42 '", js: ' 42 ', py: "' 42 '" },
  { label: "'inf'", js: 'inf', py: "'inf'", pin: true },
  { label: "'-Infinity'", js: '-Infinity', py: "'-Infinity'", pin: true },
  { label: "'NaN'", js: 'NaN', py: "'NaN'" },
  { label: 'null', js: null, py: 'None' },
  { label: 'undefined', js: undefined, py: 'None' },
  { label: 'true', js: true, py: 'True' },
  { label: "[3, 'CORNER']", js: [3, 'CORNER'], py: "[3, 'CORNER']" },
  { label: '3', js: 3, py: '3' },
  { label: "'3.0'", js: '3.0', py: "'3.0'" },

  // the rest of what float() does and does not take
  { label: 'false', js: false, py: 'False' },
  { label: '0', js: 0, py: '0' },
  { label: '-2.5', js: -2.5, py: '-2.5' },
  { label: "'+3'", js: '+3', py: "'+3'" },
  { label: "'.5'", js: '.5', py: "'.5'" },
  { label: "'1.'", js: '1.', py: "'1.'" },
  { label: "'0.'", js: '0.', py: "'0.'" },
  { label: "'00012'", js: '00012', py: "'00012'" },
  { label: "'1E+3'", js: '1E+3', py: "'1E+3'" },
  { label: "'1e-3'", js: '1e-3', py: "'1e-3'" },
  { label: "'1e400'", js: '1e400', py: "'1e400'" },
  { label: "'1e'", js: '1e', py: "'1e'" },
  { label: "'-0'", js: '-0', py: "'-0'" },
  { label: "'  +inf  '", js: '  +inf  ', py: "'  +inf  '" },
  { label: "'INFINITY'", js: 'INFINITY', py: "'INFINITY'" },
  { label: "'-nan'", js: '-nan', py: "'-nan'" },
  { label: "'\\t 7 \\n'", js: '\t 7 \n', py: "'\\t 7 \\n'" },
  { label: "'1_000'", js: '1_000', py: "'1_000'" },
  { label: "'1_0.0_1'", js: '1_0.0_1', py: "'1_0.0_1'" },
  { label: "'_1'", js: '_1', py: "'_1'" },
  { label: "'1_'", js: '1_', py: "'1_'" },
  { label: "'1__0'", js: '1__0', py: "'1__0'" },
  { label: "'1e_3'", js: '1e_3', py: "'1e_3'" },
  { label: "'3,5'", js: '3,5', py: "'3,5'" },
  { label: "'true'", js: 'true', py: "'true'" },
  { label: "'0b101'", js: '0b101', py: "'0b101'" },
  { label: "'in f'", js: 'in f', py: "'in f'" },
  { label: "'--3'", js: '--3', py: "'--3'" },
  { label: "' - 3'", js: ' - 3', py: "' - 3'" },
  { label: '[3]', js: [3], py: '[3]' },
  { label: '[1, 2, 3]', js: [1, 2, 3], py: '[1, 2, 3]' },
  { label: "[[1, 2], 'CORNER']", js: [[1, 2], 'CORNER'], py: "[[1, 2], 'CORNER']" },
  { label: '{}', js: {}, py: '{}' },
  { label: "['4', 'CORNER']", js: ['4', 'CORNER'], py: "['4', 'CORNER']" },
];

/* ------------------------------------------------------------------ *
 * the flag table: which axes of a row the engine marks
 *
 * Every row is a result row of one sim group keyed 'typ'. The interesting ones
 * are the ones whose values are not plain numbers, plus the two NTWC rules:
 * a null NTWC is never flagged, and spec_ntwc replaces the MTM thresholds for
 * the NTWC axis when the row carries one.
 * ------------------------------------------------------------------ */

function row(over) {
  return Object.assign({
    cat: 'Performance', item: 'Item', kind: 'result', unit: 'mA',
    limit: 'le', spec: null, spec_mtm: [null, null, null], spec_ntwc: null,
    sim_mtm: [null, null, null], sim_ntwc: null, sim_span: false,
  }, over);
}

const FLAG_CASES = [
  {
    label: "'5%' is not 5, so nothing is over a max of 3",
    pin: true,
    row: row({ limit: 'le', spec_mtm: [null, null, 3], sim_mtm: [1, 2, '5%'] }),
  },
  {
    label: "a cell of spaces is not 0, so nothing is under a min of 1",
    pin: true,
    row: row({ limit: 'ge', spec_mtm: [1, null, null], sim_mtm: [2, 3, '   '] }),
  },
  {
    label: "'0x10' is not 16, so nothing is over a max of 5",
    pin: true,
    row: row({ limit: 'le', spec_mtm: [null, null, 5], sim_mtm: [1, 2, '0x10'] }),
  },
  {
    label: "'inf' IS over a max of 3, and 'nan' and '' are not",
    pin: true,
    row: row({ limit: 'le', spec_mtm: [null, null, 3], sim_mtm: ['inf', 'nan', ''] }),
  },
  {
    label: 'a plain number over its max is still flagged',
    row: row({ limit: 'le', spec_mtm: [null, null, 3], sim_mtm: [1, 2, 4] }),
  },
  {
    label: 'a null NTWC is never flagged',
    row: row({ limit: 'le', spec_mtm: [null, null, 3], sim_mtm: [1, 2, 3], sim_ntwc: null }),
  },
  {
    label: 'spec_ntwc replaces the MTM threshold for the NTWC axis',
    row: row({ limit: 'le', spec_mtm: [null, null, 3], spec_ntwc: 10,
               sim_mtm: [1, 2, 2], sim_ntwc: 8 }),
  },
  {
    label: 'an NTWC value over spec_ntwc is flagged',
    row: row({ limit: 'le', spec_mtm: [null, null, 3], spec_ntwc: 5,
               sim_mtm: [1, 2, 2], sim_ntwc: 7 }),
  },
  {
    label: "'ge' with an exponent and a [value, corner] pair",
    row: row({ limit: 'ge', spec_mtm: [2, null, null], sim_mtm: ['1e3', '1', [0.5, 'CORNER']] }),
  },
  {
    label: "'range' with a unit suffix in the last cell",
    row: row({ limit: 'range', spec_mtm: [1, null, 5], sim_mtm: [0.5, 3, '12 dB'] }),
  },
  {
    label: 'no limit means nothing is ever flagged',
    row: row({ limit: null, spec_mtm: [null, null, 3], sim_mtm: [9, 9, 9] }),
  },
  {
    label: 'a scalar spec stands in for a missing MTM threshold',
    row: row({ limit: 'le', spec: 3, spec_mtm: [null, null, null], sim_mtm: [1, '5%', 4] }),
  },
  {
    label: 'per-group values are judged by their own group',
    row: row({ limit: 'le', spec_mtm: [null, null, 3], sim_mtm: [9, 9, 9],
               sims: { typ: { mtm: [1, 2, '5%'], ntwc: null } } }),
  },
];

/* ------------------------------------------------------------------ *
 * load the modules
 * ------------------------------------------------------------------ */

// views/table.js reaches the component set, which reads the vendor libraries
// off the global object because index.html loads them as plain UMD scripts.
// Running those three files here is what lets node import the view at all.
for (const name of ['preact.umd.js', 'hooks.umd.js', 'htm.umd.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(V2, 'vendor', name), 'utf8'), { filename: name });
}

const UTIL_PATH = path.join(V2, 'js', 'util.js');
const TABLE_PATH = path.join(V2, 'js', 'views', 'table.js');
const PREVIEW_PATH = path.join(V2, 'js', 'views', 'preview.js');

const util = await import(pathToFileURL(UTIL_PATH).href);
const table = await import(pathToFileURL(TABLE_PATH).href);
const { numericValue } = util;

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

const answer = askEngine({
  values: CASES.map((c) => c.py),
  flags: FLAG_CASES.map((c) => ({ row: c.row, key: 'typ' })),
});

if (!answer) {
  console.log('SKIP: no Python interpreter on PATH, so the engine cannot be consulted.');
  console.log('      Set RW_PYTHON to the interpreter that runs the server, then re-run.');
  process.exit(0);
}

console.log('Report Workbench v2 -- the numeric rule\n');

section('numericValue mirrors core/tables.py::_numv');
CASES.forEach((c, i) => {
  const expected = decode(answer.values[i]);
  test('numericValue(' + c.label + ') -> ' + show(expected), () => {
    const got = numericValue(c.js);
    assert.ok(
      sameNumber(got, expected),
      'the engine says ' + show(expected) + ', the interface says ' + show(got)
    );
  }, { pin: c.pin });
});

section('one parser, not four');
test('table.js exports the util.js parser itself, not a private copy', () => {
  assert.equal(typeof table.numv, 'function');
  assert.equal(table.numv, numericValue,
    'views/table.js must use util.numericValue, not its own port of it');
}, { pin: true });

test('preview.js takes numericValue from util.js', () => {
  const src = fs.readFileSync(PREVIEW_PATH, 'utf8');
  const line = src.split('\n').find((l) => /^import .*from '\.\.\/util\.js';$/.test(l.trim()));
  assert.ok(line, "views/preview.js must import from '../util.js'");
  assert.ok(/\bnumericValue\b/.test(line),
    'views/preview.js must import numericValue from util.js, not define one');
}, { pin: true });

test('no view defines a second numeric parser', () => {
  for (const file of [TABLE_PATH, PREVIEW_PATH]) {
    const src = fs.readFileSync(file, 'utf8');
    assert.ok(!/\bfunction\s+numericValue\s*\(/.test(src),
      path.basename(file) + ' defines its own numericValue');
    assert.ok(!/\bfunction\s+numv\s*\(/.test(src),
      path.basename(file) + ' defines its own numv');
    assert.ok(!/parseFloat\s*\(\s*value\s*\)/.test(src),
      path.basename(file) + ' still parses an axis value with parseFloat');
  }
}, { pin: true });

section('flagsFor mirrors core/tables.py::_flags_from');
FLAG_CASES.forEach((c, i) => {
  const expected = answer.flags[i];
  test(c.label + ' -> axes [' + expected.join(', ') + ']', () => {
    const got = Array.from(table.flagsFor(c.row, 'typ')).sort((a, b) => a - b);
    assert.deepEqual(got, expected,
      'the engine flags [' + expected.join(', ') + '], the grid flags [' + got.join(', ') + ']');
  }, { pin: c.pin });
});

section('the whole block agrees with the shelf count');
test('a block of values the engine leaves alone reports 0 over spec', () => {
  const block = {
    type: 'datatable', id: 'b-1', caption: 'Performance against spec',
    data: {
      spec_name: 'Spec',
      sims: [{ key: 'typ', title: 'Run', stage: 'CDR', axes: ['MIN', 'TYP', 'MAX'] }],
      rows: [
        row({ limit: 'le', spec_mtm: [null, null, 3], sim_mtm: [1, 2, '5%'] }),
        row({ limit: 'ge', spec_mtm: [1, null, null], sim_mtm: [2, 3, '   '] }),
        row({ limit: 'le', spec_mtm: [null, null, 5], sim_mtm: [1, 2, '0x10'] }),
      ],
    },
  };
  const cfg = { compliance: { axis_labels: ['MIN', 'TYP', 'MAX', 'NTWC'],
                              setting_kinds: ['common_setting', 'module_setting', 'tb'] } };
  assert.equal(table.blockOverSpec(block, cfg), 0);
  assert.equal(table.outlineOverSpec([{ id: 'n', title: 'S', blocks: [block], children: [] }], cfg), 0);
}, { pin: true });

console.log('\n' + (failures.length
  ? failures.length + ' of ' + count + ' failed: ' + failures.join(', ')
  : 'all ' + count + ' passed'));
process.exit(failures.length ? 1 : 0);
