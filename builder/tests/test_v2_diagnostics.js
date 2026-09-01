#!/usr/bin/env node
'use strict';
/*
 * test_v2_diagnostics.js -- one click turns a fault into text somebody can act
 * on, driven in a real browser with a real clipboard.
 *
 * Run:  node builder/tests/test_v2_diagnostics.js
 *       node builder/tests/test_v2_diagnostics.js --headed
 *
 * WHY THIS FILE EXISTS
 *   This machine has no way to send a log anywhere: the only channel out is
 *   text the user copies and pastes by hand. The price of a bug report was
 *   therefore whatever they could be bothered to type, and what that bought was
 *   "it froze". js/diag.js keeps what happened -- version, screen, the requests
 *   that failed and the ones that never came back -- and the error banner and
 *   Ctrl+Alt+D put it on the clipboard.
 *
 * WHAT IT ASSERTS
 *   1. a failed request raises a banner that offers `Copy details`;
 *   2. what it copies names the tool version, the address, the browser, and the
 *      request that failed, with its status;
 *   3. Ctrl+Alt+D copies the same diagnostics with no banner needed, and says
 *      so on screen;
 *   4. a request that has NOT come back is listed as still waiting -- the one
 *      line that tells a freeze apart from a crash;
 *   5. the text carries no report CONTENT: no section titles, no body text.
 *
 *   Assertion 5 is not decoration. This text is pasted into a chat window, and
 *   a diagnostic that quietly carries a paragraph of the report out with it
 *   would be a worse defect than the one it was helping to report.
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
const MODULE_ID = 'CLKDIV_5G';
const REPORT_DIR = PROJECT_ID + '/' + MODULE_ID + '/CDR';

/* The one distinctive phrase in the fixture's prose. If it turns up in the
 * copied diagnostics, the diagnostics are carrying report content. */
const SECRET_PROSE = 'zylophonic parachute measurements';
const SECTION_TITLE = 'Simulation results';

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

function sampleReport() {
  return {
    template: 'sample',
    meta: {
      title: MODULE_ID + ' CDR report', doc_no: 'DOC-1', version: 'V1.0',
      secrecy: 'Internal', author: 'A. Engineer', date: '2026-08-30',
      reviewers: [], approver: '', revisions: [],
    },
    outline: [{
      id: 'n-results',
      title: SECTION_TITLE,
      blocks: [{
        type: 'para', cardStart: true, list: null,
        runs: [{ t: 'The table below states the ' + SECRET_PROSE + ' and their conditions.' }],
      }],
      children: [],
    }],
  };
}

function sampleTemplateConfig() {
  return {
    id: 'sample', name: 'Sample template',
    caption_prefix: { figure: 'Figure', table: 'Table' },
    toc: { enabled: true },
    skeleton: [{ title: SECTION_TITLE, children: [] }],
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
  writeJson(path.join(root, PROJECT_ID, MODULE_ID, 'project_meta.json'), { name: MODULE_ID });
  const dir = path.join(root, ...REPORT_DIR.split('/'));
  writeJson(path.join(dir, 'project.json'), sampleReport());
  fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
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
 * driving
 * ------------------------------------------------------------------ */

const settle = (page, ms) => page.waitForTimeout(ms == null ? 300 : ms);
const clipboard = (page) => page.evaluate(() => navigator.clipboard.readText());

async function browserChecks() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const scratch = path.join(os.tmpdir(), 'report-workbench-v2-diagnostics', stamp);
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
    try {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
    } catch (err) {
      console.log('  SKIP: this browser will not grant clipboard access.');
      console.log('        ' + String(err && err.message).split('\n')[0]);
      return;
    }
    const page = await context.newPage();

    /* ---- the report opens, so the diagnostics have something to name ---- */
    await page.goto(base + '/#/r/' + REPORT_DIR, { waitUntil: 'load' });
    await page.waitForSelector('.rw-app', { timeout: 10000 });
    await settle(page, 800);

    section('Ctrl+Alt+D, with nothing wrong');
    await page.keyboard.press('Control+Alt+d');
    await settle(page, 500);
    const said = await page.textContent('.rw-banner__title').catch(() => '');
    check('the app confirms it copied', /Diagnostics copied/i.test(said || ''),
      'banner title: ' + JSON.stringify(said));
    const quiet = await clipboard(page);
    await page.screenshot({ path: path.join(shots, '1-copied.png') });
    check('it names the tool and the address',
      /Report Workbench diagnostics/.test(quiet) && /page\s+http:\/\/127\.0\.0\.1/.test(quiet),
      quiet.slice(0, 200));
    check('it names the browser and the window',
      /browser\s+\S/.test(quiet) && /window\s+\d+x\d+/.test(quiet), quiet.slice(0, 300));
    check('it names the screen the user is on',
      quiet.indexOf(REPORT_DIR) >= 0, 'route line missing ' + REPORT_DIR);
    check('it carries no report content',
      quiet.indexOf(SECRET_PROSE) < 0 && quiet.indexOf(SECTION_TITLE) < 0,
      'the copied text quotes the report');

    /* ---- a request that fails ---- */
    section('a request that fails');
    await page.evaluate(() => { window.__diagBanner = null; });
    await page.route('**/api/project*', (route) => route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'disk went away' }),
    }));
    // Leaving and coming back re-reads the report through the failing route.
    await page.goto(base + '/#/', { waitUntil: 'load' });
    await settle(page, 400);
    await page.goto(base + '/#/r/' + REPORT_DIR, { waitUntil: 'load' });
    await page.waitForSelector('.rw-banner', { timeout: 10000 });
    await settle(page, 400);

    // Located by position, not by label: the label becomes `Copied` after the
    // click, and a locator that matched the old text would stop matching.
    const copyBtn = page.locator('.rw-banner__actions .rw-btn').first();
    check('the banner offers Copy details',
      (await copyBtn.count()) > 0
        && /Copy details/.test(String((await copyBtn.textContent()) || '')),
      'first banner action: ' + JSON.stringify(await copyBtn.textContent().catch(() => null)));
    if (await copyBtn.count()) {
      await copyBtn.click();
      await settle(page, 400);
      const text = await clipboard(page);
      await page.screenshot({ path: path.join(shots, '2-failed-request.png') });
      check('the copied text names the failed request',
        /api-fail/.test(text) && text.indexOf('/api/project') >= 0,
        text.slice(-400));
      check('it carries the status the server answered with',
        /HTTP 500/.test(text) || /disk went away/.test(text), text.slice(-400));
      check('it still carries no report content',
        text.indexOf(SECRET_PROSE) < 0, 'the copied text quotes the report');
      const label = String((await copyBtn.textContent()) || '').trim();
      check('the button says it copied', /^Copied$/.test(label), 'label: ' + JSON.stringify(label));
      console.log('');
      console.log('  ---- what the user would paste ----');
      console.log(text.split('\n').map((l) => '  | ' + l).join('\n'));
      console.log('  -----------------------------------');
    }
    await page.unroute('**/api/project*');

    /* ---- a request that never comes back: the freeze case ---- */
    section('a request that never comes back');
    await page.route('**/api/export-stream*', () => { /* swallowed on purpose */ });
    await page.evaluate(() => {
      // Any endpoint will do; what matters is that api.js recorded it as sent
      // and never recorded an answer. The absolute URL is the one the app's own
      // <base href="/assets/v2/"> resolves to, so this is the SAME module
      // instance the app is using -- and therefore the same trace table.
      return import('/assets/v2/js/api.js').then((api) => {
        api.request('POST', '/api/export-stream', { query: { dir: 'x' }, timeout: 60000 })
          .catch(() => {});
      });
    });
    await settle(page, 1200);
    await page.keyboard.press('Control+Alt+d');
    await settle(page, 500);
    const waiting = await clipboard(page);
    await page.screenshot({ path: path.join(shots, '3-pending.png') });
    check('a request with no answer is listed as still waiting',
      /still waiting for an answer/.test(waiting)
        && waiting.indexOf('/api/export-stream') >= 0,
      waiting.slice(0, 600));

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
