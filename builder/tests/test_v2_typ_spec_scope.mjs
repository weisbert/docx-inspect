#!/usr/bin/env node
// test_v2_typ_spec_scope.mjs -- a spec in the TYP slot judges the TYP column.
//
// Run:  node builder/tests/test_v2_typ_spec_scope.mjs
//       RW_PYTHON=... node builder/tests/test_v2_typ_spec_scope.mjs
//
// WHY THIS FILE EXISTS
// --------------------
// A number typed under Spec / TYP is a statement about the TYPICAL corner. It
// used to be the last resort of the `le` threshold chain for every axis:
//
//     thr = spec MAX, else the scalar spec, else spec TYP
//
// so a row specified only at TYP compared its MIN, its MAX and its NTWC corner
// against the typical number too. A part that is "typically 500" then reddened
// its worst corner at 688 -- a verdict nobody wrote and nobody wanted, on the
// one column where the reader most expects the number to be larger.
//
// The rule now scopes that slot to its own column, and prefers it there: the
// TYP column is judged by the spec TYP when the row carries one, MIN / MAX /
// NTWC never are. A spec MAX is untouched and still judges every axis, because
// "no corner above X" really is a claim about all of them. `ge` has never read
// the TYP slot and does not start to.
//
// WHAT IT COVERS
//   1. the rule itself, through util.js -- the seven cases measured off a real
//      report, including the two that must NOT change
//   2. the same rows put to the real engine in a Python child process, so the
//      grid and the exported document cannot drift apart
//   3. the rule is still defined ONCE: views/table.js reads the TYP axis from
//      util.js rather than carrying a second copy of the number
//
// AGAINST THE PRE-FIX FILES: section 1 fails on every "not red" case (the MAX
// column reds against the typical value) and on the two rows where the TYP
// column should newly red; section 2 fails the same way on the engine side.
//
// IT NEVER TOUCHES REAL REPORTS: every row here is written in this file.

import fs from 'node:fs';
import path from 'node:path';
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
 * the cases, measured off a real compliance chapter
 * ------------------------------------------------------------------ */

function row(spec_mtm, sim_mtm, extra) {
  return Object.assign({
    cat: 'C', item: 'x', kind: 'result', unit: 'u',
    limit: 'le', spec_mtm, sim_mtm, sim_ntwc: null,
  }, extra || {});
}

// [what it is, the row, the axes that must be red]
const CASES = [
  ['spec only at TYP: the MAX corner above it is not red',
   row([null, 500, null], [336.1, 482.1, 688.2]), []],
  ['spec only at TYP: a second one, same shape',
   row([null, 1, null], [0.064, 0.592, 6.928]), []],
  ['spec only at TYP: negative numbers read the same way',
   row([null, -40, null], [-51.98, -44.95, -39.4]), []],
  ['spec only at TYP: the TYP column that misses it IS red',
   row([null, 500, null], [336.1, 620.4, 688.2]), [1]],
  ['spec only at TYP: the NTWC corner is not judged by it either',
   row([null, 500, null], [336, 482, 688], { sim_ntwc: 900 }), []],
  ['spec at TYP and MAX: each column answers to its own bound',
   row([null, -105, -100], [-107.5, -103.2, -98.86]), [1, 2]],
  ['spec at TYP and MAX: the TYP breach alone',
   row([null, -145, -142], [-145.5, -143.8, -142.1]), [1]],
  ['spec at TYP and MAX: both breached',
   row([null, -145, -142], [-144.9, -143.3, -141.8]), [1, 2]],
  ['a TYP spec that IS met stays black; the MAX breach still reds',
   row([null, 24, 30], [15.53, 22.24, 30.46]), [2]],
  ['a spec MAX alone is unchanged: it judges every axis',
   row([null, null, 500], [336.1, 482.1, 688.2]), [2]],
  ['ge has never read the TYP slot and still does not',
   row([null, 3, null], [1, 2, 4], { limit: 'ge' }), []],
  ['ge still reads the MIN slot, on every axis',
   row([3, null, null], [1, 2, 4], { limit: 'ge' }), [0, 1]],
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
 * 1 - the rule, through the interface's own module
 * ------------------------------------------------------------------ */

const util = await import(pathToFileURL(path.join(V2, 'js', 'util.js')).href);

console.log('Report Workbench v2 -- a spec at TYP judges the TYP column');

section('the rule, as the grid reads it');

for (const [name, r, want] of CASES) {
  // eslint-disable-next-line no-await-in-loop
  await test(name, () => {
    const got = Array.from(util.flagsFrom(r, r.sim_mtm, r.sim_ntwc)).sort();
    assert.deepEqual(got, want);
  });
}

await test('the TYP axis is named once, and it is the second column', () => {
  assert.equal(util.TYP_AXIS, 1);
});

/* ------------------------------------------------------------------ *
 * 2 - and as the engine reads it
 * ------------------------------------------------------------------ */

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
 * 3 - still defined once
 * ------------------------------------------------------------------ */

section('one definition, not two');

await test('views/table.js takes the TYP axis from util.js', () => {
  const src = fs.readFileSync(path.join(V2, 'js', 'views', 'table.js'), 'utf8');
  assert.match(src, /import \{[^}]*\bTYP_AXIS\b[^}]*\} from '\.\.\/util\.js'/,
    'table.js must import TYP_AXIS rather than restate the number');
  assert.doesNotMatch(src, /(const|let|var)\s+TYP_AXIS\s*=/,
    'table.js must not declare a TYP_AXIS of its own');
});

await test('util.js is where the axis scoping lives', () => {
  const src = fs.readFileSync(path.join(V2, 'js', 'util.js'), 'utf8');
  assert.match(src, /export const TYP_AXIS/);
  assert.match(src, /axis === TYP_AXIS \? styp : null/,
    'the scoping must be in violates(), where the threshold is chosen');
});

console.log('\n' + (failures.length
  ? failures.length + ' of ' + count + ' failed: ' + failures.join(', ')
  : 'all ' + count + ' checks passed'));
process.exit(failures.length ? 1 : 0);
