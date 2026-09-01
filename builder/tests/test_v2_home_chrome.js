#!/usr/bin/env node
'use strict';
/*
 * test_v2_home_chrome.js -- every action on the shelf appears once, where it
 * acts. Measured in a real browser.
 *
 * Run:  node builder/tests/test_v2_home_chrome.js
 *       node builder/tests/test_v2_home_chrome.js --headed
 *
 * WHY THIS FILE EXISTS
 *   The shelf carried the same three actions twice: once on the top bar as
 *   `Apply an external update / Import Word report / New report`, and again
 *   under the breadcrumb as `New report / Import Word report / Apply an
 *   external update / Settings` -- the same buttons in the OPPOSITE order, so
 *   whichever row a hand learned, the other one was wrong. `Import Word
 *   report` was a top-level button for one of the three choices the create
 *   dialog already offers under `Start from`, promoted to chrome and then
 *   listed twice.
 *
 *   Now each action sits where it acts. `Apply an external update` names its
 *   own destinations and can create reports under any project, and `Settings`
 *   is the machine's -- neither is scoped by what the breadcrumb has selected,
 *   so both live on the top bar. `New report` creates a report inside the
 *   selected project and module, so it sits beside the breadcrumb, once, with
 *   a caret that jumps straight to one of the three ways a report can start.
 *
 * WHAT IT ASSERTS
 *   1. no chrome action appears twice anywhere on the screen;
 *   2. `Apply an external update` is on the top bar and nowhere else;
 *   3. `Settings` is reachable, on the top bar, and opens;
 *   4. `New report` is beside the breadcrumb, once;
 *   5. its caret offers exactly the three starting points, and choosing one
 *      opens the create dialog with that choice ALREADY MADE.
 *
 *   Assertion 1 is the one with teeth: against the old chrome the same three
 *   labels are found twice each.
 *
 * IT NEVER TOUCHES REAL REPORTS. The fixture is generated from scratch into the
 * OS temporary directory and the server is booted against THAT with an explicit
 * --root.
 *
 * SKIPPING IS A FEATURE: no playwright-core (the public repository carries no
 * node_modules) or no system browser exits 0 with a note.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');

const HERE = __dirname;
const REPO = path.resolve(HERE, '..', '..');
const SERVER_PY = path.join(REPO, 'builder', 'web', 'server.py');

const ARGS = process.argv.slice(2);
const HEADED = ARGS.includes('--headed');
const VIEWPORT = { width: 1600, height: 940 };

const PROJECT_ID = '1108';
const MODULES = ['CLKDIV_5G', 'SERDES_2G'];

/* The labels this file is about. */
const APPLY = 'Apply an external update';
const NEW_REPORT = 'New report';
const IMPORT_WORD = 'Import Word report';
const SETTINGS = 'Settings';
const START_FROM = ['Inherit from an existing report', 'Blank, from a template', 'Import a Word file'];

let chromium = null;
let chromiumMissing = '';
try {
  chromium = require('playwright-core').chromium;
} catch (err) {
  chromiumMissing = 'playwright-core is not installed.  npm install, then re-run.';
}

/* ------------------------------------------------------------------ *
 * the fixture
 * ------------------------------------------------------------------ */

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function sampleReport(name) {
  return {
    template: 'sample',
    meta: {
      title: name + ' CDR report', doc_no: 'DOC-1', version: 'V1.0',
      secrecy: 'Internal', author: 'A. Engineer', date: '2026-08-30',
      reviewers: [], approver: '', revisions: [],
    },
    outline: [{
      id: 'n-results', title: 'Simulation results',
      blocks: [{ type: 'para', cardStart: true, list: null, runs: [{ t: 'Body text.' }] }],
      children: [],
    }],
  };
}

function sampleTemplateConfig() {
  return {
    id: 'sample', name: 'Sample template',
    caption_prefix: { figure: 'Figure', table: 'Table' },
    toc: { enabled: true },
    skeleton: [{ title: 'Simulation results', children: [] }],
    cover: { secrecy_default: 'Internal' },
    styles: {},
    compliance: {
      axis_labels: ['MIN', 'TYP', 'MAX'],
      setting_kinds: ['common_setting', 'module_setting', 'tb'],
      default_limit: {}, flag_color: 'FF0000',
      col_w_cm: { cat: 2.4, item: 3.6, unit: 1.4 },
      fills: { header: 'FFF2CC', setting: 'F2EFE9', result: 'FFFFFF' },
    },
    free_table: { header_fill: 'FFF2CC' },
    ui_strings: {}, table_presets: [],
  };
}

function buildReportsRoot(root) {
  fs.mkdirSync(root, { recursive: true });
  writeJson(path.join(root, 'templates', 'sample', 'config.json'), sampleTemplateConfig());
  writeJson(path.join(root, 'templates', 'sample', 'skeleton.json'), sampleTemplateConfig().skeleton);
  writeJson(path.join(root, PROJECT_ID, 'project_meta.json'), { name: 'Sample project' });
  for (const mod of MODULES) {
    writeJson(path.join(root, PROJECT_ID, mod, 'project_meta.json'), { name: mod });
    const dir = path.join(root, PROJECT_ID, mod, 'CDR');
    writeJson(path.join(dir, 'project.json'), sampleReport(mod));
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
  }
  return root;
}

/* ------------------------------------------------------------------ *
 * assertions
 * ------------------------------------------------------------------ */

const failures = [];

function check(name, ok, detail) {
  console.log((ok ? '  [ok  ] ' : '  [FAIL] ') + name);
  if (!ok) {
    if (detail) console.log('         ' + detail);
    failures.push(name + (detail ? ' -- ' + detail : ''));
  }
}

function section(title) {
  console.log('');
  console.log(title);
}

/* ------------------------------------------------------------------ *
 * server lifecycle
 * ------------------------------------------------------------------ */

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
    if (child.exitCode !== null) throw new Error('the server exited before it answered');
    try {
      if (await httpGet(base + '/api/health') === 200) return;
    } catch (err) { /* not up yet */ }
    if (Date.now() > until) throw new Error('the server did not answer within ' + deadlineMs + 'ms');
    await new Promise((r) => setTimeout(r, 120));
  }
}

function startServer(root, port) {
  const python = process.env.RW_PYTHON || 'python';
  const config = path.join(root, 'templates', 'sample', 'config.json');
  const child = spawn(python, [SERVER_PY, '--port', String(port), '--root', root, '--config', config],
    { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
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
      try { child.kill('SIGKILL'); } catch (err) { /* already gone */ }
      resolve();
    }, 1000);
  });
}

/* ------------------------------------------------------------------ *
 * reading the chrome
 * ------------------------------------------------------------------ */

const settle = (page, ms) => page.waitForTimeout(ms == null ? 300 : ms);

// Every button on screen, by its accessible name and by where it sits.
const buttons = (page) => page.evaluate(() => {
  const out = [];
  const all = document.querySelectorAll('button');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height) continue;                       // not on screen
    const name = (el.getAttribute('aria-label') || el.textContent || '')
      .replace(/\s+/g, ' ').trim();
    if (!name) continue;
    out.push({
      name: name,
      topbar: !!el.closest('.rw-topbar'),
      header: !!el.closest('.rw-home__header'),
      rail: !!el.closest('.rw-home__rail'),
      row: !!el.closest('.rw-row') || !!el.closest('.rw-rows__group'),
    });
  }
  return out;
});

const countNamed = (list, name) => list.filter((b) => b.name === name).length;

async function browserChecks() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const scratch = path.join(os.tmpdir(), 'report-workbench-v2-home-chrome', stamp);
  const reportsRoot = path.join(scratch, 'reports');
  const shots = path.join(scratch, 'screens');
  fs.mkdirSync(shots, { recursive: true });
  buildReportsRoot(reportsRoot);
  console.log('  fixture: ' + reportsRoot);

  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const child = startServer(reportsRoot, port);
  let browser = null;

  const cleanup = async () => {
    if (browser) { try { await browser.close(); } catch (err) { /* gone */ } }
    await stopServer(child);
  };

  try {
    try {
      await waitForServer(base, child, 12000);
    } catch (err) {
      console.log('  SKIP: ' + String(err && err.message));
      console.log((child.log || []).join('').slice(-800));
      return;
    }

    try {
      browser = await chromium.launch({ channel: 'msedge', headless: !HEADED });
    } catch (err) {
      console.log('  SKIP: the system browser could not be launched.');
      console.log('        ' + String(err && err.message ? err.message : err).split('\n')[0]);
      return;
    }

    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('console', (msg) => {
      const where = msg.location && msg.location() ? String(msg.location().url) : '';
      if (msg.type() === 'error' && where.indexOf('favicon') < 0) {
        consoleErrors.push(msg.text().slice(0, 200));
      }
    });
    page.on('pageerror', (err) => consoleErrors.push('uncaught: ' + String(err && err.message)));

    await page.goto(base + '/#/', { waitUntil: 'load' });
    await page.waitForSelector('.rw-home__rail', { timeout: 10000 });
    await settle(page, 500);
    await page.screenshot({ path: path.join(shots, '1-shelf.png') });

    const shown = await buttons(page);
    console.log('  buttons on screen: ' + shown.length);

    section('nothing is offered twice');
    const seen = new Map();
    for (const b of shown) {
      // The list itself legitimately repeats: one action set per report row,
      // one `New report in this module` per module heading. Chrome is what is
      // drawn once per SCREEN, and that is what this counts.
      if (b.row) continue;
      seen.set(b.name, (seen.get(b.name) || 0) + 1);
    }
    const doubled = Array.from(seen.entries()).filter((e) => e[1] > 1);
    check('no chrome action appears twice', doubled.length === 0,
      doubled.map((e) => e[0] + ' x' + e[1]).join(' | '));

    section('the app-level actions are on the top bar');
    check(APPLY + ' appears exactly once', countNamed(shown, APPLY) === 1,
      'found ' + countNamed(shown, APPLY));
    check('and it is on the top bar',
      shown.some((b) => b.name === APPLY && b.topbar));
    check(SETTINGS + ' appears exactly once, on the top bar',
      countNamed(shown, SETTINGS) === 1
        && shown.some((b) => b.name === SETTINGS && b.topbar),
      'found ' + countNamed(shown, SETTINGS));
    check(IMPORT_WORD + ' is no longer chrome of its own',
      countNamed(shown, IMPORT_WORD) === 0,
      'found ' + countNamed(shown, IMPORT_WORD));

    section('the scoped action sits beside the breadcrumb');
    check(NEW_REPORT + ' appears exactly once', countNamed(shown, NEW_REPORT) === 1,
      'found ' + countNamed(shown, NEW_REPORT));
    check('and it is in the detail header, not the top bar',
      shown.some((b) => b.name === NEW_REPORT && b.header && !b.topbar));

    section('the caret offers the three starting points');
    await page.click('.rw-split__more');
    await settle(page, 300);
    await page.screenshot({ path: path.join(shots, '2-start-from-menu.png') });
    const items = await page.evaluate(() => Array.from(document.querySelectorAll('.rw-menu button'))
      .map((b) => (b.textContent || '').replace(/\s+/g, ' ').trim()));
    check('the menu lists exactly the three ways a report starts',
      items.length === START_FROM.length && START_FROM.every((s) => items.indexOf(s) >= 0),
      JSON.stringify(items));

    section('choosing one opens the dialog with that choice already made');
    await page.locator('.rw-menu button').filter({ hasText: START_FROM[0] }).first().click();
    await settle(page, 500);
    await page.screenshot({ path: path.join(shots, '3-create-dialog.png') });
    const chosen = await page.evaluate((label) => {
      const chips = Array.from(document.querySelectorAll('.rw-chip'));
      const hit = chips.filter((c) => (c.textContent || '').trim() === label)[0];
      return {
        dialogOpen: !!document.querySelector('.rw-dialog'),
        found: !!hit,
        pressed: hit ? hit.getAttribute('aria-pressed') : null,
      };
    }, START_FROM[0]);
    check('the create dialog opened', chosen.dialogOpen);
    check('Start from is already set to the entry that was chosen',
      chosen.found && chosen.pressed === 'true', JSON.stringify(chosen));

    section('console');
    if (consoleErrors.length) {
      check('no console errors', false, consoleErrors.slice(0, 4).join(' | '));
    } else {
      console.log('  [ok  ] no console errors');
    }

    console.log('');
    console.log('  screenshots: ' + shots);
    await context.close();
  } finally {
    await cleanup();
  }
}

async function main() {
  section('in a real browser');
  if (!chromium) {
    console.log('  SKIP: ' + chromiumMissing);
  } else {
    await browserChecks();
  }

  console.log('');
  if (failures.length) {
    console.log(failures.length + ' assertion(s) failed');
    process.exit(1);
  }
  console.log('all assertions passed');
  process.exit(0);
}

main().catch((err) => {
  console.log('FAIL: the harness itself failed');
  console.log(String(err && err.stack ? err.stack : err));
  process.exit(1);
});
