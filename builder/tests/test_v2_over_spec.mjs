#!/usr/bin/env node
// test_v2_over_spec.mjs -- one over-spec rule, and chrome that tells the truth.
//
// Run:  node builder/tests/test_v2_over_spec.mjs
//       node builder/tests/test_v2_over_spec.mjs --headed     (watch the browser)
//
// WHY THIS FILE EXISTS
// --------------------
// test_v2_numeric.mjs pinned the PARSER ("is this text a number?"). The rule
// built on top of it -- which values a simulation group even contributes, and
// which of them break the row's limit -- was still copied into three views, and
// the copies read the per-group map with a TRUTHINESS test where the engine
// uses MEMBERSHIP:
//
//     core/tables.py::_sim_axis_vals   if isinstance(sims, dict) and gkey in sims
//     the three view copies            if (row.sims && row.sims[gkey])
//
// A row whose sims map holds the group key with a null value -- which is what a
// table carries between "this group exists" and "someone typed a number into
// it" -- therefore fell back to the FLAT sim_mtm in the views and to nothing at
// all in the engine. One screen said two things at once:
//
//     row {limit:'le', spec_mtm:[null,null,3], sim_mtm:[9,null,null], sims:{typ:null}}
//     the grid          reddened MIN and its footer said "1 over spec"
//     the header pill   said "1 over spec"
//     the engine, the exported Word file, /api/tree and the paper preview: 0
//
// WHAT IT COVERS
//   1. that exact row, checked against the real engine in a Python child
//      process, then against util.js, views/table.js (grid text, cell flags,
//      block and outline counts) and views/editor.js (the header count)
//   2. source pins: the rule is DEFINED once, in util.js, and no view carries
//      its own violates / flagsFrom / per-group lookup
//   3. no v2 source file contains a NUL byte -- one in views/table.js made every
//      text tool call the largest view binary, so a tree-wide grep listed no
//      lines from it at all
//   4. in a real browser, against a generated scratch report: the grid, its
//      footer, the header and the paper preview all say zero, and the save
//      indicator never reads "Saved" while the document is dirty
//
// AGAINST THE PRE-FIX FILES: section 1 fails (the grid flags MIN, the counts say
// 1, the grid prints 9 where the engine prints nothing), section 2 fails (three
// views define the rule), section 3 fails (table.js carries a NUL), and the
// browser section fails on the indicator (it reads "Saved HH:MM" over an unsaved
// document for the whole debounce).
//
// IT NEVER TOUCHES REAL REPORTS: the fixture is generated into a fresh
// directory under the OS temporary directory and the server is booted against
// THAT with an explicit --root.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
// The interface under test. RW_V2_DIR points the module loading and the
// source pins at a COPY of the tree instead -- that is how the pre-fix files
// were kept around long enough to prove these assertions fail against them.
// The browser section always drives the real server and is skipped in that mode.
const V2 = process.env.RW_V2_DIR
  ? path.resolve(process.env.RW_V2_DIR)
  : path.join(REPO, 'builder', 'web', 'assets', 'v2');
const CORE = path.join(REPO, 'builder', 'core');
const SERVER_PY = path.join(REPO, 'builder', 'web', 'server.py');
const HEADED = process.argv.slice(2).includes('--headed');

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
 * the row the defect was found with
 * ------------------------------------------------------------------ */

// 'typ' is a declared simulation group; the row names it and leaves it empty.
// The flat sim_mtm still carries a 9 from before the group existed, and 9 is
// over the row's max of 3 -- so a truthiness lookup finds a violation and a
// membership lookup finds an empty group.
function trapRow() {
  return {
    cat: 'Performance', item: 'Current', kind: 'result', unit: 'mA',
    limit: 'le', spec: null, spec_mtm: [null, null, 3], spec_ntwc: null,
    sim_mtm: [9, null, null], sim_ntwc: null, sim_span: false,
    sims: { typ: null },
  };
}

function trapBlock() {
  return {
    type: 'datatable', id: 'b-compliance-1', caption: 'Performance against spec',
    data: {
      spec_name: 'Spec',
      sims: [{ key: 'typ', title: 'Run', stage: 'CDR', axes: ['MIN', 'TYP', 'MAX'] }],
      rows: [trapRow()],
    },
  };
}

const CFG = {
  compliance: {
    axis_labels: ['MIN', 'TYP', 'MAX', 'NTWC'],
    setting_kinds: ['common_setting', 'module_setting', 'tb'],
  },
};

/* ------------------------------------------------------------------ *
 * the engine, consulted for real
 * ------------------------------------------------------------------ */

const PY = [
  'import json, sys',
  'sys.path.insert(0, sys.argv[1])',
  'import tables',
  'row = json.load(sys.stdin)',
  'mtm, ntwc = tables._sim_axis_vals(row, "typ")',
  'flags = sorted(tables._flags_from(row, mtm, ntwc))',
  'cells = [tables._axis_value(row, "typ", i) for i in range(3)]',
  'json.dump({"flags": flags, "cells": cells, "positions": sorted(tables.flag_positions(row))},',
  '          sys.stdout)',
].join('\n');

function askEngine(row) {
  const python = process.env.RW_PYTHON || 'python';
  const run = spawnSync(python, ['-c', PY, CORE], {
    cwd: REPO, input: JSON.stringify(row), encoding: 'utf8',
  });
  if (run.error && run.error.code === 'ENOENT') return null;
  if (run.status !== 0) {
    throw new Error('the engine refused to answer:\n' + (run.stderr || run.stdout || ''));
  }
  return JSON.parse(run.stdout);
}

/* ------------------------------------------------------------------ *
 * load the interface modules
 * ------------------------------------------------------------------ */

for (const name of ['preact.umd.js', 'hooks.umd.js', 'htm.umd.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(V2, 'vendor', name), 'utf8'), { filename: name });
}

const util = await import(pathToFileURL(path.join(V2, 'js', 'util.js')).href);
const table = await import(pathToFileURL(path.join(V2, 'js', 'views', 'table.js')).href);
const editor = await import(pathToFileURL(path.join(V2, 'js', 'views', 'editor.js')).href);

console.log('Report Workbench v2 -- one over-spec rule');

/* ------------------------------------------------------------------ *
 * 1 - the group key with a null value
 * ------------------------------------------------------------------ */

section('a sims map that holds the group key with a null value');

const engine = askEngine(trapRow());
if (!engine) {
  console.log('  SKIP: no Python interpreter on PATH, so the engine cannot be consulted.');
} else {
  await test('the engine flags nothing and reads the group as empty', () => {
    assert.deepEqual(engine.flags, [], 'the engine itself must flag nothing here');
    assert.deepEqual(engine.cells, [null, null, null],
      'the engine must read the empty group, not the flat sim_mtm');
    assert.deepEqual(engine.positions, [0],
      'the flat schema alone IS over spec -- that is what makes the fallback visible');
  });

  await test('util.flagsForGroup agrees with the engine', () => {
    const got = Array.from(util.flagsForGroup(trapRow(), 'typ'));
    assert.deepEqual(got, engine.flags,
      'the engine flags [' + engine.flags + '], util flags [' + got + ']');
  });

  await test('util.simAxisValues / util.axisValue read the empty group', () => {
    const vals = util.simAxisValues(trapRow(), 'typ');
    assert.deepEqual(vals.mtm, [null, null, null]);
    assert.equal(vals.ntwc, null);
    assert.deepEqual([0, 1, 2].map((i) => util.axisValue(trapRow(), 'typ', i)), engine.cells);
  });

  await test('the grid flags nothing', () => {
    const got = Array.from(table.flagsFor(trapRow(), 'typ'));
    assert.deepEqual(got, engine.flags,
      'the engine flags [' + engine.flags + '], the grid flags [' + got + ']');
  });

  await test('the grid prints what the engine prints', () => {
    const shown = [0, 1, 2].map((i) => table.axisValue(trapRow(), 'typ', i));
    assert.deepEqual(shown, engine.cells,
      'the grid must not print the flat sim_mtm for a group the engine reads as empty');
  });

  await test('the footer count and the outline count are 0', () => {
    const block = trapBlock();
    assert.equal(table.blockOverSpec(block, CFG), 0, 'the grid footer would say 1 over spec');
    assert.equal(
      table.outlineOverSpec([{ id: 'n', title: 'S', blocks: [block], children: [] }], CFG), 0);
  });

  await test('the header pill count is 0', () => {
    const block = trapBlock();
    assert.deepEqual(editor.blockOverSpec(block), []);
    assert.equal(
      editor.countOverSpec({ outline: [{ id: 'n', title: 'S', blocks: [block], children: [] }] }),
      0, 'the editor header would claim an over-spec value the export does not print');
  });

  await test('a group that IS filled is still judged, by its own values', () => {
    const row = trapRow();
    row.sims = { typ: { mtm: [null, null, 7], ntwc: null } };
    assert.deepEqual(Array.from(util.flagsForGroup(row, 'typ')), [2],
      '7 is over a max of 3 in the group that carries it');
    assert.deepEqual(Array.from(table.flagsFor(row, 'typ')), [2]);
    assert.equal(editor.blockOverSpec({ type: 'datatable', id: 'b', data: {
      sims: [{ key: 'typ', title: 'Run', axes: ['MIN', 'TYP', 'MAX'] }], rows: [row],
    } }).length, 1);
  });

  await test('a row with no sims map at all still uses the flat schema', () => {
    const row = trapRow();
    delete row.sims;
    assert.deepEqual(Array.from(util.flagsForGroup(row, 'typ')), [0],
      'membership must not break the ordinary single-simulation table');
    assert.deepEqual(Array.from(table.flagsFor(row, 'typ')), [0]);
  });
}

/* ------------------------------------------------------------------ *
 * 2 - the rule is defined once
 * ------------------------------------------------------------------ */

section('one definition, in util.js');

const V2_SOURCES = [];
(function collect(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'vendor') continue;      // third-party, never edited
      collect(full);
    } else if (entry.name.endsWith('.js')) {
      V2_SOURCES.push(full);
    }
  }
})(path.join(V2, 'js'));

const UTIL_REL = path.join('js', 'util.js');

// The shapes a private copy of the rule takes. `simAxisVals` is the name the
// editor's copy went by, so it is named here too.
const RULE_DEFINITIONS = [
  /\bfunction\s+violates\s*\(/,
  /\bfunction\s+flagsFrom\s*\(/,
  /\bfunction\s+flagsFor\s*\(/,
  /\bfunction\s+simAxisVals(?:ues)?\s*\(/,
  /\bfunction\s+groupValues\s*\(/,
];

await test('no view defines its own violates / flagsFrom / per-group lookup', () => {
  for (const file of V2_SOURCES) {
    const rel = path.relative(V2, file);
    if (rel === UTIL_REL) continue;
    const src = fs.readFileSync(file, 'utf8');
    for (const pattern of RULE_DEFINITIONS) {
      // groupValues in views/table.js is a two-line adapter over the shared
      // lookup; every other shape is a second answer to "is this over spec".
      if (pattern.source.includes('groupValues')) continue;
      assert.ok(!pattern.test(src),
        rel + ' defines ' + pattern.source + ' -- the rule lives in util.js');
    }
  }
});

await test('util.js publishes the whole rule', () => {
  for (const name of ['violates', 'flagsFrom', 'flagsForGroup', 'simAxisValues', 'axisValue']) {
    assert.equal(typeof util[name], 'function', 'util.js must export ' + name);
  }
});

await test('the views share util.js\'s functions by identity', () => {
  assert.equal(table.flagsFrom, util.flagsFrom, 'views/table.js must re-export util.flagsFrom');
  assert.equal(table.flagsFor, util.flagsForGroup);
  assert.equal(table.axisValue, util.axisValue);
  assert.equal(table.numv, util.numericValue);
});

/* ------------------------------------------------------------------ *
 * 3 - the file stays greppable
 * ------------------------------------------------------------------ */

section('every v2 source is text');

await test('no v2 source file contains a NUL byte', () => {
  for (const file of V2_SOURCES) {
    const bytes = fs.readFileSync(file);
    const at = bytes.indexOf(0);
    assert.equal(at, -1, path.relative(V2, file) + ' carries a NUL byte at offset ' + at
      + ' -- grep then reports "Binary file ... matches" and lists no lines');
  }
});

/* ------------------------------------------------------------------ *
 * 4 - the browser
 * ------------------------------------------------------------------ */

let chromium = null;
try {
  chromium = require('playwright-core').chromium;
} catch (err) {
  chromium = null;
}

const PROJECT_ID = '1108';
const MODULE_ID = 'CLKDIV_5G';
const REPORT_DIR = PROJECT_ID + '/' + MODULE_ID + '/CDR';
const SECTION_PROSE = 'Design description';
const SECTION_TABLE = 'Simulation results';

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function para(t, cardStart) {
  const block = { type: 'para', runs: [{ t: t }] };
  if (cardStart) block.cardStart = true;
  return block;
}

function fixtureReport() {
  return {
    schema_version: 1,
    template: 'sample',
    meta: {
      title: MODULE_ID + ' CDR report', doc_no: 'DOC-1108-CDR', version: 'V1.0',
      secrecy: 'Internal', author: 'A. Engineer', date: '2026-08-30',
      reviewers: ['B. Engineer'], approver: 'C. Engineer', revisions: [],
    },
    outline: [
      {
        id: 'n-design', title: SECTION_PROSE,
        blocks: [para('The divider takes a differential input.', true)],
        children: [],
      },
      {
        id: 'n-results', title: SECTION_TABLE,
        blocks: [trapBlock()],
        children: [],
      },
    ],
  };
}

function fixtureConfig() {
  return {
    id: 'sample',
    name: 'Sample template',
    caption_prefix: { image: 'Figure', table: 'Table' },
    skeleton: [{ title: SECTION_PROSE, children: [] }, { title: SECTION_TABLE, children: [] }],
    cover: { fields: [{ key: 'title', label: 'Title', table: 'info', required: true }] },
    compliance: {
      axis_labels: ['MIN', 'TYP', 'MAX', 'NTWC'],
      setting_kinds: ['common_setting', 'module_setting', 'tb'],
      default_limit: { le: '<= upper', ge: '>= target', range: 'within' },
      flag_color: 'FF0000',
      col_w_cm: { cat: 2.0, item: 3.0, spec: 1.5, axis: 1.4, spacer: 0.2, unit: 1.2 },
      font_pt: 7,
      fills: { header: 'FFF2CC', setting: 'F2EFE9', result: 'FFFFFF', separator: 'BFBFBF' },
    },
    free_table: { header_fill: 'FFF2CC' },
    ui_strings: {},
    table_presets: [],
  };
}

const SECOND_DIR = PROJECT_ID + '/' + MODULE_ID + '/PDR';

function buildRoot(root) {
  writeJson(path.join(root, 'templates', 'sample', 'config.json'), fixtureConfig());
  writeJson(path.join(root, PROJECT_ID, 'project_meta.json'),
    { name: 'Sample project', description: 'Generated fixture' });
  writeJson(path.join(root, PROJECT_ID, MODULE_ID, 'project_meta.json'),
    { name: MODULE_ID, description: 'Divider block' });
  const dir = path.join(root, ...REPORT_DIR.split('/'));
  writeJson(path.join(dir, 'project.json'), fixtureReport());
  fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
  // An earlier stage of the same module: what a reference column is pulled from.
  const second = path.join(root, ...SECOND_DIR.split('/'));
  writeJson(path.join(second, 'project.json'), fixtureReport());
  fs.mkdirSync(path.join(second, 'images'), { recursive: true });
  return root;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

function httpGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => { res.resume(); resolve(res.statusCode); });
    req.setTimeout(timeoutMs || 1500, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function waitForServer(base, child, deadlineMs) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error('the server exited before it answered:\n' + child.log.join(''));
    }
    try {
      if (await httpGet(base + '/api/health') === 200) return;
    } catch (err) { /* not up yet */ }
    if (Date.now() > until) {
      throw new Error('the server did not answer within ' + deadlineMs + 'ms:\n' + child.log.join(''));
    }
    await new Promise((r) => setTimeout(r, 120));
  }
}

function startServer(root, port) {
  const python = process.env.RW_PYTHON || 'python';
  const config = path.join(root, 'templates', 'sample', 'config.json');
  const child = spawn(python, [SERVER_PY, '--port', String(port), '--root', root,
    '--config', config], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => log.push(c));
  child.stderr.on('data', (c) => log.push(c));
  child.on('error', (err) => log.push('spawn failed: ' + err.message + '\n'));
  child.log = log;
  return child;
}

function stopServer(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    try { child.kill(); } catch (err) { return resolve(); }
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (err) { /* gone */ }
      resolve();
    }, 1000);
  });
}

// An outline row carries its section number as well as its title, so the click
// is by containment on the innermost row that holds the title.
async function openSection(page, title) {
  const opened = await page.evaluate((wanted) => {
    const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    const nodes = Array.from(document.querySelectorAll(
      'button, li, [role="treeitem"], [role="button"], [tabindex]'));
    let hit = null;
    for (const el of nodes) {
      if (norm(el.innerText).indexOf(wanted) < 0) continue;
      const box = el.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      if (!hit || hit.contains(el)) hit = el;
    }
    if (!hit) return false;
    hit.scrollIntoView({ block: 'center' });
    hit.click();
    return true;
  }, title);
  if (opened) await page.waitForTimeout(500);
  return opened;
}

// Click the innermost visible control whose text or label is `label`.
async function clickLabel(page, label) {
  const done = await page.evaluate((wanted) => {
    const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    const nodes = Array.from(document.querySelectorAll(
      'button, a, [role="button"], [role="menuitem"], [tabindex]'));
    let hit = null;
    for (const el of nodes) {
      const own = norm(el.innerText || el.textContent);
      const alt = norm(el.getAttribute('aria-label') || el.getAttribute('title'));
      // A button renders its glyph inside its own text, so the match is by
      // containment; the innermost containing control wins.
      if (own.indexOf(wanted) < 0 && alt !== wanted) continue;
      const box = el.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      if (!hit || hit.contains(el)) hit = el;
    }
    if (!hit) return false;
    hit.scrollIntoView({ block: 'center' });
    hit.click();
    return true;
  }, label);
  if (done) await page.waitForTimeout(300);
  return done;
}

section('in a real browser');

if (process.env.RW_V2_DIR) {
  console.log('  SKIP: RW_V2_DIR points at a copy; the browser drives the real tree.');
} else if (!chromium) {
  console.log('  SKIP: playwright-core is not installed (npm install, then re-run).');
} else if (!engine) {
  console.log('  SKIP: the server needs the same interpreter the engine check wanted.');
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-overspec-'));
  buildRoot(root);
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const server = startServer(root, port);
  let browser = null;
  try {
    await waitForServer(base, server, 20000);
    browser = await chromium.launch({ channel: 'msedge', headless: !HEADED });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const consoleErrors = [];
    const notFound = [];
    // The browser asks for a favicon on its own and reports the miss as a
    // console error; that is the browser's noise, not the interface's.
    const ignored = (url) => /\/favicon\.ico(\?|$)/.test(String(url || ''));
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const where = msg.location && msg.location() ? msg.location().url : '';
      if (where && ignored(where)) return;
      consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(String(err && err.message)));
    page.on('response', (res) => {
      if (res.status() >= 400 && !ignored(res.url())) notFound.push(res.status() + ' ' + res.url());
    });

    await page.goto(base + '/v2#/r/' + REPORT_DIR, { waitUntil: 'load' });
    try {
      await page.waitForSelector('.rw-save', { timeout: 15000 });
    } catch (err) {
      // A shell that did not mount is a harness fault far more often than a
      // product one, so say what the page actually shows before giving up.
      const dump = await page.evaluate(() => ({
        title: document.title,
        text: (document.body.innerText || '').slice(0, 600),
      }));
      console.log('  the page showed: ' + JSON.stringify(dump));
      for (const line of consoleErrors) console.log('  console: ' + line);
      throw err;
    }
    await page.waitForTimeout(900);

    await test('the header claims no over-spec value', async () => {
      const text = await page.evaluate(() => document.body.innerText);
      assert.ok(!/\d+\s+over spec/.test(text.split('over spec')[0] + 'over spec')
        || !/[1-9]\d*\s+over spec/.test(text),
      'the chrome says "' + (text.match(/[1-9]\d*\s+over spec/) || [''])[0] + '"');
    });

    // Open the section that holds the compliance table and let the grid build.
    await test('the grid reddens nothing and its footer says 0 over spec', async () => {
      const opened = await openSection(page, SECTION_TABLE);
      assert.ok(opened, 'could not open the section named ' + SECTION_TABLE);
      await page.waitForSelector('.rw-grid__foot', { timeout: 15000 });
      await page.waitForTimeout(600);
      const state = await page.evaluate(() => ({
        foot: document.querySelector('.rw-grid__foot').innerText.replace(/\s+/g, ' ').trim(),
        red: document.querySelectorAll('.rw-grid__cell--overspec').length,
        cells: Array.from(document.querySelectorAll('.rw-grid__cell--num'))
          .map((el) => el.innerText.trim()),
      }));
      assert.ok(/0 over spec/.test(state.foot), 'the footer reads "' + state.foot + '"');
      assert.equal(state.red, 0, 'the grid reddened ' + state.red + ' cell(s)');
      assert.ok(!state.cells.includes('9'),
        'the grid printed the flat sim_mtm (9) for a group the engine reads as empty');
    });

    await test('the paper preview marks nothing either', async () => {
      const flagged = await page.evaluate(() => document.querySelectorAll('.rw-paper__flag').length);
      assert.equal(flagged, 0, 'the preview reddened ' + flagged + ' value(s)');
    });

    await test('the save indicator never reads "Saved" while the document is dirty', async () => {
      const settled = await page.evaluate(() => document.querySelector('.rw-save').innerText.trim());
      assert.ok(/^Saved/.test(settled),
        'the fixture should open on a clean document; the chip reads "' + settled + '"');

      // Type into the prose card. store.js debounces the save by 800ms, so for
      // that whole window `dirty` is true and `saveState` is still 'saved'.
      const typed = await openSection(page, SECTION_PROSE);
      assert.ok(typed, 'could not open the section named ' + SECTION_PROSE);
      await page.waitForTimeout(400);
      const target = await page.$('[contenteditable="true"]');
      assert.ok(target, 'the prose card did not offer an editable surface');
      await target.click();
      await page.keyboard.type(' One more clause.');

      const seen = [];
      for (let i = 0; i < 6; i++) {
        seen.push(await page.evaluate(() => ({
          chip: document.querySelector('.rw-save').innerText.trim(),
          dirty: !!(window.__rwStore && window.__rwStore.get().dirty),
        })));
        await page.waitForTimeout(120);
      }
      const liar = seen.filter((s) => /^Saved/.test(s.chip)).slice(0, 1)[0];
      const early = seen[0];
      assert.ok(!/^Saved/.test(early.chip),
        'right after a keystroke the chip already reads "' + early.chip + '"');
      assert.ok(!liar, 'the chip read "' + (liar && liar.chip) + '" during the debounce');

      // ... and once the write lands it goes back to claiming a save, because
      // by then there really is one.
      await page.waitForFunction(
        () => /^Saved/.test(document.querySelector('.rw-save').innerText.trim()),
        null, { timeout: 8000 }
      );
      const after = await page.evaluate(() => document.querySelector('.rw-save').innerText.trim());
      assert.ok(/^Saved/.test(after), 'the chip never went back to "Saved": "' + after + '"');
    });

    // The reference-column dialog identifies each offered column by an option
    // value. That value used to be the group key joined to the axis with a NUL
    // byte; it is now the entry's index. Either way the browser has to end up
    // with one distinct, selectable value per column.
    await test('the reference-column dialog offers distinct, selectable columns', async () => {
      assert.ok(await openSection(page, SECTION_TABLE), 'could not reopen the table section');
      assert.ok(await clickLabel(page, 'Add a reference column'),
        'the grid toolbar offered no way to add a reference column');
      await page.waitForTimeout(1200);
      const state = await page.evaluate(() => {
        const labels = Array.from(document.querySelectorAll('.rw-field'));
        const field = labels.filter((el) => (el.innerText || '').indexOf('Which column') >= 0)[0];
        const select = field ? field.querySelector('select') : null;
        if (!select) return null;
        const values = Array.from(select.options).map((o) => o.value);
        return { values: values, chosen: select.value, texts: Array.from(select.options).map((o) => o.text) };
      });
      assert.ok(state, 'the dialog showed no "Which column" selector');
      assert.ok(state.values.length >= 3, 'expected one option per axis, got ' + state.values.length);
      assert.equal(new Set(state.values).size, state.values.length,
        'two columns share an option value: ' + state.values.join(', '));
      assert.ok(state.values.every((v) => v.indexOf(String.fromCharCode(0)) < 0),
        'an option value still carries a NUL byte');
      assert.ok(state.chosen && state.values.indexOf(state.chosen) >= 0,
        'the dialog preselected a value it does not offer: ' + state.chosen);
      assert.ok(await clickLabel(page, 'Cancel'), 'the dialog would not close');
      await page.waitForTimeout(300);
    });

    await test('the screen raised no console error and no failed request', () => {
      assert.deepEqual(notFound, [], 'requests that failed: ' + notFound.join(', '));
      assert.deepEqual(consoleErrors, [], 'console said: ' + consoleErrors.join(' | '));
    });

    await context.close();
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

console.log('\n' + (failures.length
  ? failures.length + ' of ' + count + ' failed: ' + failures.join(', ')
  : 'all ' + count + ' passed'));
process.exit(failures.length ? 1 : 0);
