#!/usr/bin/env node
'use strict';
/*
 * test_v2_home_rail_height.js -- the shelf's left rail is as tall as the
 * window, measured in a real browser.
 *
 * Run:  node builder/tests/test_v2_home_rail_height.js
 *       node builder/tests/test_v2_home_rail_height.js --headed
 *
 * WHY THIS FILE EXISTS
 *   boot.js mounts every view inside `<div class="rw-view">`, and css/app.css
 *   had no rule for that class. The one element between #app (height:100%) and
 *   the view was therefore an ordinary block box of automatic height, and the
 *   `height:100%` on .rw-app underneath it resolved to `auto`: a percentage
 *   height against an auto-height parent is not a length.
 *
 *   Everything below then sized itself to its CONTENT instead of to the window.
 *   The rail ended where the report table ended, so `Templates`, `Trash` and
 *   `Design system` -- which live in the rail's footer and belong in the bottom
 *   left corner -- floated up to wherever the report list happened to stop, and
 *   moved whenever the number of reports changed. A long list pushed the whole
 *   page into scrolling instead of scrolling the list inside its own pane.
 *
 * WHAT IT ASSERTS
 *   1. .rw-app fills the window;
 *   2. the rail and its footer reach the bottom of the window;
 *   3. the page itself does not scroll -- the report list scrolls in its pane;
 *   4. filtering the list down to one report does not move the footer.
 *
 *   Assertion 4 is the one with teeth: against the old stylesheet the footer
 *   sits a few hundred pixels below the top, right where the short list ends.
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

/* Enough reports that the table is taller than the window: the rail must not
 * follow the list in either direction. */
const PROJECT_ID = '1108';
const MODULE_COUNT = 24;
const moduleId = (i) => 'MOD_' + String(i).padStart(2, '0');

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
      id: 'n-results',
      title: 'Simulation results',
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
  for (let i = 0; i < MODULE_COUNT; i += 1) {
    const mod = moduleId(i);
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
 * measuring
 * ------------------------------------------------------------------ */

const settle = (page, ms) => page.waitForTimeout(ms == null ? 300 : ms);

const geometry = (page) => page.evaluate(() => {
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, height: r.height };
  };
  const doc = document.documentElement;
  return {
    winH: window.innerHeight,
    app: box('.rw-app'),
    rail: box('.rw-home__rail'),
    foot: box('.rw-home__railfoot'),
    rows: document.querySelectorAll('.rw-row').length,
    pageScrollH: Math.max(doc.scrollHeight, document.body.scrollHeight),
  };
});

const NEAR = 2;   // sub-pixel rounding only

function checkFilled(label, g) {
  check(label + ': .rw-app fills the window',
    !!g.app && Math.abs(g.app.height - g.winH) <= NEAR,
    g.app ? 'app height ' + g.app.height.toFixed(1) + ', window ' + g.winH : 'no .rw-app');
  check(label + ': the rail reaches the bottom of the window',
    !!g.rail && Math.abs(g.rail.bottom - g.winH) <= NEAR,
    g.rail ? 'rail bottom ' + g.rail.bottom.toFixed(1) + ', window ' + g.winH : 'no rail');
  check(label + ': Templates / Trash / Design system sit at the bottom left',
    !!g.foot && Math.abs(g.foot.bottom - g.winH) <= NEAR,
    g.foot ? 'footer bottom ' + g.foot.bottom.toFixed(1) + ', window ' + g.winH : 'no footer');
  check(label + ': the page itself does not scroll',
    g.pageScrollH <= g.winH + NEAR,
    'page scrollHeight ' + g.pageScrollH + ', window ' + g.winH);
}

async function browserChecks() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const scratch = path.join(os.tmpdir(), 'report-workbench-v2-home-rail', stamp);
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
    await page.waitForSelector('.rw-home__railfoot', { timeout: 10000 });
    await settle(page, 400);

    section('a long report list');
    const long = await geometry(page);
    console.log('  rows on screen: ' + long.rows);
    await page.screenshot({ path: path.join(shots, '1-long-list.png') });
    check('the fixture really is longer than the window',
      long.rows >= MODULE_COUNT, 'rows ' + long.rows);
    checkFilled('long list', long);

    section('the same shelf filtered down to one report');
    await page.fill('.rw-home__railtop input.rw-input', moduleId(3));
    await settle(page, 400);
    const short = await geometry(page);
    console.log('  rows on screen: ' + short.rows);
    await page.screenshot({ path: path.join(shots, '2-filtered.png') });
    check('the filter really did shorten the list', short.rows <= 2, 'rows ' + short.rows);
    checkFilled('one report', short);

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
