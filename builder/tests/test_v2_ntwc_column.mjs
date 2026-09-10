#!/usr/bin/env node
// test_v2_ntwc_column.mjs -- the fourth corner is checked, so the grid draws it
// like one.
//
// Run:  node builder/tests/test_v2_ntwc_column.mjs
//       RW_PYTHON=... node builder/tests/test_v2_ntwc_column.mjs
//
// WHY THIS FILE EXISTS
// --------------------
// A simulation group's fourth axis (NTWC) really was outside the spec
// comparison once. The rule was rewritten to judge it -- against spec_ntwc when
// the row carries one, against the MIN/MAX bounds otherwise -- in BOTH places
// that judge anything:
//
//     core/tables.py::_flags_from   nt = _numv(ntwc) ... flags.add(3)
//     js/util.js::flagsFrom         const nt = numericValue(ntwc) ... flags.add(3)
//
// The grid never followed. It kept marking that column `excluded`, painting it
// a different yellow and hanging a `not checked` label under its header, so the
// screen said the numbers were unverified while the same screen reddened them.
// A reader of the compliance chapter read `not checked` as "this corner was
// never simulated" -- the opposite of what the column holds, and the reason it
// was reported as a defect.
//
// WHAT IT COVERS
//   1. the rule: the NTWC corner is judged, by util.js and by the engine, on
//      the same rows -- including the two ways it can be bounded and the one
//      case that is genuinely never flagged (an empty corner)
//   2. the grid says the same thing: planColumns marks no axis as excluded, no
//      v2 source carries a `not checked` label, and the stylesheet has no
//      token for a column that is not checked
//
// AGAINST THE PRE-FIX FILES: section 2 fails on all three pins (planColumns
// sets `excluded`, table.js labels the column, tokens.css defines
// --grid-head-3). Section 1 passes before and after -- that is the point: it is
// the evidence that the marking in section 2 was a lie.
//
// IT NEVER TOUCHES REAL REPORTS: every row here is written in this file.

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
 * the cases -- axis 3 is the NTWC corner
 * ------------------------------------------------------------------ */

function row(spec_mtm, sim_mtm, sim_ntwc, extra) {
  return Object.assign({
    cat: 'C', item: 'x', kind: 'result', unit: 'u',
    limit: 'le', spec_mtm, sim_mtm, sim_ntwc,
  }, extra || {});
}

// [what it is, the row, the axes that must be red]
const CASES = [
  ['a spec MAX judges the NTWC corner too',
   row([null, null, 300], [150, 200, 250], 420), [3]],
  ['the same row with the corner inside the bound stays black',
   row([null, null, 300], [150, 200, 250], 280), []],
  ['spec_ntwc, when the row carries one, is what the corner answers to',
   row([null, null, 300], [150, 200, 250], 420, { spec_ntwc: 500 }), []],
  ['and it can red the corner while the MTM columns pass',
   row([null, null, 300], [150, 200, 250], 260, { spec_ntwc: 200 }), [3]],
  ['an empty corner is never flagged, whatever the bound',
   row([null, null, 300], [150, 200, 250], null), []],
  ['ge reads the MIN slot on the corner as well',
   row([100, null, null], [150, 200, 250], 80, { limit: 'ge' }), [3]],
  ['range judges the corner at both ends',
   row([100, null, 300], [150, 200, 250], 320, { limit: 'range' }), [3]],
  ['a row with no limit is never red, corner included',
   row([null, null, 300], [150, 200, 250], 420, { limit: null }), []],
  ['a spec at TYP alone does not reach the corner',
   row([null, 200, null], [150, 200, 250], 420), []],
];

/* ------------------------------------------------------------------ *
 * the engine, consulted for real
 * ------------------------------------------------------------------ */

const PY = [
  'import json, sys',
  'sys.path.insert(0, sys.argv[1])',
  'import tables',
  'rows = json.load(sys.stdin)',
  'json.dump([sorted(tables.flag_positions(r)) for r in rows], sys.stdout)',
].join('\n');

function askEngine(rows) {
  const python = process.env.RW_PYTHON || 'python';
  const run = spawnSync(python, ['-c', PY, CORE], {
    cwd: REPO, input: JSON.stringify(rows), encoding: 'utf8',
  });
  if (run.error && run.error.code === 'ENOENT') return null;
  if (run.status !== 0) {
    throw new Error('the engine refused to answer:\n' + (run.stderr || run.stdout || ''));
  }
  return JSON.parse(run.stdout);
}

/* ------------------------------------------------------------------ *
 * 1 - the rule
 * ------------------------------------------------------------------ */

// views/table.js is a Preact view: its component imports need the vendored
// globals in place before the module body runs.
for (const name of ['preact.umd.js', 'hooks.umd.js', 'htm.umd.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(V2, 'vendor', name), 'utf8'), { filename: name });
}

const util = await import(pathToFileURL(path.join(V2, 'js', 'util.js')).href);
const table = await import(pathToFileURL(path.join(V2, 'js', 'views', 'table.js')).href);

console.log('Report Workbench v2 -- the NTWC corner is checked like the others');

section('the rule, as the grid reads it');

for (const [name, r, want] of CASES) {
  // eslint-disable-next-line no-await-in-loop
  await test(name, () => {
    const got = Array.from(util.flagsFrom(r, r.sim_mtm, r.sim_ntwc)).sort();
    assert.deepEqual(got, want);
  });
}

section('the same rows, put to the engine that writes the document');

const engine = askEngine(CASES.map(([, r]) => r));
if (!engine) {
  console.log('  SKIP: no Python interpreter on PATH, so the engine cannot be consulted.');
} else {
  for (let i = 0; i < CASES.length; i++) {
    const [name, r, want] = CASES[i];
    // eslint-disable-next-line no-await-in-loop
    await test('engine agrees: ' + name, () => {
      assert.deepEqual(engine[i], want);
      assert.deepEqual(Array.from(util.flagsFrom(r, r.sim_mtm, r.sim_ntwc)).sort(),
        engine[i], 'the grid and the document must give one answer');
    });
  }
}

/* ------------------------------------------------------------------ *
 * 2 - and the grid says the same thing
 * ------------------------------------------------------------------ */

section('nothing on screen contradicts it');

const tableSrc = fs.readFileSync(path.join(V2, 'js', 'views', 'table.js'), 'utf8');

await test('planColumns marks no axis as excluded from checking', () => {
  const plan = table.planColumns([
    { key: 'fdr', axes: ['MIN', 'TYP', 'MAX', 'NTWC'], role: 'sim' },
  ]);
  const axes = plan.filter((c) => c.kind === 'axis');
  assert.equal(axes.length, 4, 'the four axes must all be planned');
  for (const col of axes) {
    assert.equal(col.excluded, undefined,
      'axis ' + col.axis + ' carries an `excluded` marker the rule does not honour');
  }
});

await test('no v2 source labels a column `not checked`', () => {
  const roots = [path.join(V2, 'js'), path.join(V2, 'css')];
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'vendor') continue;
        walk(full);
        continue;
      }
      if (!/\.(js|mjs|css)$/.test(entry.name)) continue;
      const src = fs.readFileSync(full, 'utf8');
      // The label, not the words. A quoted string or a text node is something
      // a reader sees; prose reasoning about what is checked -- including the
      // comment in table.js that records why this marking was wrong -- is not,
      // so backtick quoting is left out of the class on purpose.
      if (/(['"])not checked\1|>\s*not checked\s*</i.test(src)) {
        offenders.push(path.relative(V2, full));
      }
    }
  };
  roots.forEach(walk);
  assert.deepEqual(offenders, [], 'these files still label a column `not checked`');
});

await test('the grid draws no chrome for an excluded axis', () => {
  assert.doesNotMatch(tableSrc, /\.excluded\b/,
    'table.js still reads an `excluded` flag off a planned column');
  assert.doesNotMatch(tableSrc, /axisnote/,
    'table.js still builds the note that hung under the column header');
});

await test('the stylesheet has no colour for a column that is not checked', () => {
  const tokens = fs.readFileSync(path.join(V2, 'css', 'tokens.css'), 'utf8');
  assert.doesNotMatch(tokens, /--grid-head-3\b/,
    'tokens.css still defines the fill the excluded column was painted with');
  const app = fs.readFileSync(path.join(V2, 'css', 'app.css'), 'utf8');
  assert.doesNotMatch(app, /--excluded\b|__axisnote\b/,
    'app.css still styles the excluded column or its note');
});

console.log('\n' + (failures.length
  ? failures.length + ' of ' + count + ' failed: ' + failures.join(', ')
  : 'all ' + count + ' checks passed'));
process.exit(failures.length ? 1 : 0);
