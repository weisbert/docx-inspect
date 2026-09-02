#!/usr/bin/env node
'use strict';
/*
 * test_v2_paste_package.js -- a package .zip that arrives as TEXT, and the
 * entry it leaves behind in the history.
 *
 * 1. A ZIP PASTED AS BASE64 IS THE SAME PACKAGE AS A ZIP THAT WAS PICKED.
 *    The channel this report travels down cannot always carry a file. On the
 *    machines where it cannot, the package is base64 and it arrives in a chat
 *    window, which is what the old interface's "paste base64 zip text here" box
 *    was for. The paste box in the exchange drawer only understood JSON, so on
 *    exactly those machines an update could not be received at all. The test
 *    reads ONE package twice -- once through the file picker, once as base64
 *    text -- and asserts the two dialogs describe it identically.
 *
 * 2. RECEIVING A PACKAGE LEAVES SOMETHING TO ROLL BACK TO.
 *    A replace from a returned package is the one gesture that puts a whole
 *    report on top of another. It has to appear in the history as an EXCHANGE,
 *    with the state it replaced one press away.
 *
 * The package is built by the real packaging tool (apply_update.py --snapshot)
 * against a second, throwaway root, so the bytes under test are the bytes the
 * owner actually sends.
 *
 * Run:  node builder/tests/test_v2_paste_package.js
 *       node builder/tests/test_v2_paste_package.js --headed
 *
 * IT NEVER TOUCHES REAL REPORTS. Both roots are generated from scratch into the
 * OS temporary directory and the server is booted against one of them.
 *
 * SKIPPING IS A FEATURE: no playwright-core (the public repository carries no
 * node_modules) or no system browser exits 0 with a note.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const HERE = __dirname;
const REPO = path.resolve(HERE, '..', '..');
const SERVER_PY = path.join(REPO, 'builder', 'web', 'server.py');
const PACKER_PY = path.join(REPO, 'builder', 'sync', 'apply_update.py');

const ARGS = process.argv.slice(2);
const HEADED = ARGS.includes('--headed');
const KEEP_ROOT = ARGS.includes('--keep-root');
const VIEWPORT = { width: 1440, height: 940 };

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

const PROJECT_ID = '1108';
const MODULE_ID = 'CLKDIV_5G';
const REPORT_DIR = PROJECT_ID + '/' + MODULE_ID + '/CDR';
const SECTION = 'Overview';
const HOME_LINE = 'The divider was measured at room temperature.';
const SENT_BACK = 'The divider was measured over the full temperature range.';

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function sampleReport(line) {
  return {
    template: 'sample',
    meta: {
      title: MODULE_ID + ' CDR report', doc_no: 'DOC-1', version: 'V1.0',
      secrecy: 'Internal', author: 'A. Engineer', date: '2026-08-30',
      reviewers: [], approver: '', revisions: [],
    },
    outline: [
      {
        id: 'n-overview',
        title: SECTION,
        blocks: [{ type: 'para', id: 'b-para-1', cardStart: true, runs: [{ t: line }] }],
        children: [],
      },
    ],
  };
}

function sampleTemplateConfig() {
  return {
    id: 'sample', name: 'Sample template',
    caption_prefix: { figure: 'Figure', table: 'Table' },
    toc: { enabled: true },
    skeleton: [{ title: SECTION, children: [] }],
    cover: { secrecy_default: 'Internal' },
    styles: {},
    compliance: {
      axis_labels: ['MIN', 'TYP', 'MAX', 'NTWC'],
      setting_kinds: ['common_setting', 'module_setting', 'tb'],
      default_limit: {}, flag_color: 'FF0000',
      col_w_cm: { cat: 2.4, item: 3.6, unit: 1.4 },
      fills: { header: 'FFF2CC', setting: 'F2EFE9', result: 'FFFFFF' },
    },
    free_table: { header_fill: 'FFF2CC' },
    ui_strings: {}, table_presets: [],
  };
}

function buildRoot(root, line) {
  fs.mkdirSync(root, { recursive: true });
  writeJson(path.join(root, 'templates', 'sample', 'config.json'), sampleTemplateConfig());
  writeJson(path.join(root, PROJECT_ID, 'project_meta.json'), { name: 'Sample project' });
  writeJson(path.join(root, PROJECT_ID, MODULE_ID, 'project_meta.json'), { name: MODULE_ID });
  const reportDir = path.join(root, ...REPORT_DIR.split('/'));
  writeJson(path.join(reportDir, 'project.json'), sampleReport(line));
  fs.mkdirSync(path.join(reportDir, 'images'), { recursive: true });
  return root;
}

// The real packaging tool, against the throwaway root: one .zip holding
// update.json plus <report>/project.json, exactly as it reaches the owner.
function buildPackage(root) {
  const python = process.env.RW_PYTHON || 'python';
  const done = spawnSync(python, [PACKER_PY, '--snapshot', '--root', root],
    { cwd: REPO, encoding: 'utf8' });
  if (done.status !== 0) {
    return { error: String((done.stdout || '') + (done.stderr || '')).slice(0, 400) };
  }
  const outbox = path.join(root, '_outbox');
  const zips = fs.existsSync(outbox)
    ? fs.readdirSync(outbox).filter((n) => n.toLowerCase().endsWith('.zip'))
    : [];
  if (!zips.length) return { error: 'the packager wrote no .zip into ' + outbox };
  return { zip: path.join(outbox, zips.sort().pop()) };
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
      const status = await httpGet(base + '/api/health');
      if (status === 200) return;
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
 * driving the page
 * ------------------------------------------------------------------ */

const settle = (page, ms) => page.waitForTimeout(ms == null ? 400 : ms);

async function clickText(page, label) {
  const clicked = await page.evaluate((wanted) => {
    const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    const nodes = Array.from(document.querySelectorAll(
      'button, a, summary, label, li, [role="button"], [role="tab"], [tabindex]'));
    let hit = null;
    for (const el of nodes) {
      const own = norm(el.innerText || el.textContent);
      const alt = norm(el.getAttribute('aria-label') || el.getAttribute('title'));
      const text = own || alt;
      if (!(text === wanted || alt === wanted || text.indexOf(wanted) >= 0)) continue;
      const box = el.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      if (!hit || hit.contains(el)) hit = el;
    }
    if (!hit) return false;
    hit.scrollIntoView({ block: 'center', inline: 'nearest' });
    hit.click();
    return true;
  }, label);
  if (clicked) await settle(page);
  return clicked;
}

// The manifest table, as rows of plain strings, so two readings can be compared.
const manifestRows = (page) => page.evaluate(() => {
  const table = document.querySelector('.rw-dialog .rw-sync__table');
  if (!table) return null;
  return Array.from(table.querySelectorAll('tbody tr')).map(
    (tr) => Array.from(tr.children).map(
      (td) => String(td.textContent || '').replace(/\s+/g, ' ').trim()));
});

const timelineRows = (page) => page.evaluate(() => Array.from(
  document.querySelectorAll('.rw-timeline__item')).map((item) => ({
  title: String((item.querySelector('.rw-timeline__title') || {}).textContent || '')
    .replace(/\s+/g, ' ').trim(),
  tag: String((item.querySelector('.rw-pill') || {}).textContent || '')
    .replace(/\s+/g, ' ').trim(),
  actions: Array.from(item.querySelectorAll('button')).map(
    (b) => String(b.textContent || '').replace(/\s+/g, ' ').trim()),
})));

function readReport(root) {
  const file = path.join(root, ...REPORT_DIR.split('/'), 'project.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return null;
  }
}

async function waitForReport(root, predicate, timeoutMs) {
  const until = Date.now() + (timeoutMs == null ? 8000 : timeoutMs);
  for (;;) {
    const doc = readReport(root);
    if (doc && predicate(doc)) return doc;
    if (Date.now() > until) return doc;
    await new Promise((r) => setTimeout(r, 200));
  }
}

const firstLine = (doc) => {
  const blocks = (((doc || {}).outline || [])[0] || {}).blocks || [];
  return ((blocks[0] || {}).runs || []).map((r) => String(r.t || '')).join('');
};

/* ------------------------------------------------------------------ *
 * the run
 * ------------------------------------------------------------------ */

async function browserChecks() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const scratch = path.join(os.tmpdir(), 'report-workbench-v2-paste-package', stamp);
  const reportsRoot = path.join(scratch, 'reports');
  const upstream = path.join(scratch, 'sent-back');
  const shots = path.join(scratch, 'screens');
  fs.mkdirSync(shots, { recursive: true });
  buildRoot(reportsRoot, HOME_LINE);
  buildRoot(upstream, SENT_BACK);
  console.log('  fixture: ' + reportsRoot);

  const packed = buildPackage(upstream);
  if (packed.error) {
    check('the packaging tool produced a .zip', false, packed.error);
    if (!KEEP_ROOT) fs.rmSync(scratch, { recursive: true, force: true });
    return;
  }
  const zipBytes = fs.readFileSync(packed.zip);
  const zipB64 = zipBytes.toString('base64');
  console.log('  package: ' + packed.zip + '  (' + zipBytes.length + ' bytes, '
    + zipB64.length + ' as text)');

  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const child = startServer(reportsRoot, port);
  let browser = null;

  const cleanup = async () => {
    if (browser) await browser.close().catch(() => {});
    await stopServer(child);
    if (!KEEP_ROOT) fs.rmSync(scratch, { recursive: true, force: true });
  };

  try {
    try {
      await waitForServer(base, child, 20000);
    } catch (err) {
      check('the server starts', false, err.message
        + '\n' + child.log.join('').split('\n').slice(-12).join('\n'));
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
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(String(err && err.message)));
    page.on('dialog', (d) => d.dismiss().catch(() => {}));

    const editorUrl = base + '/#/r/' + REPORT_DIR.split('/').map(encodeURIComponent).join('/');
    await page.goto(editorUrl, { waitUntil: 'load' });
    await settle(page, 1400);

    const openExchange = async () => {
      const ok = await clickText(page, 'Text exchange');
      await settle(page, 600);
      return ok;
    };
    const closeDialog = async () => {
      await page.keyboard.press('Escape');
      await settle(page, 300);
      await page.evaluate(() => {
        const close = document.querySelector('.rw-dialog button[aria-label="Close"]');
        if (close) close.click();
      });
      await settle(page, 300);
    };

    /* ---- 1. the same package, picked and pasted ---- */

    section('a package read from a file');
    if (!(await openExchange())) {
      check('the exchange drawer opens', false, 'no Text exchange control');
      await context.close();
      return;
    }
    await page.setInputFiles('.rw-sync input[type="file"]', packed.zip);
    await settle(page, 900);
    const picked = await manifestRows(page);
    check('the picker describes the package', !!picked && picked.length > 0,
      'no manifest rows on screen: ' + JSON.stringify(picked));
    check('and the manifest names this report\'s file',
      !!picked && picked.some((r) => r[0] === REPORT_DIR + '/project.json'),
      JSON.stringify(picked));
    await page.screenshot({ path: path.join(shots, 'picked.png') });
    await closeDialog();

    section('the same package pasted as base64 text');
    if (!(await openExchange())) {
      check('the exchange drawer opens again', false, 'no Text exchange control');
      await context.close();
      return;
    }
    const opened = await clickText(page, 'Or paste text');
    check('the paste box opens', opened, 'no "Or paste text" control');
    await page.fill('.rw-sync__paste', zipB64);
    await settle(page, 300);
    await clickText(page, 'Use this text');
    await settle(page, 1200);

    const errorShown = await page.evaluate(() => {
      const banner = document.querySelector('.rw-sync .rw-banner--error');
      return banner ? String(banner.textContent || '').replace(/\s+/g, ' ').trim() : '';
    });
    check('the pasted text is accepted', !errorShown, errorShown);

    const pasted = await manifestRows(page);
    check('a pasted package is described the same as a picked one',
      !!pasted && !!picked && JSON.stringify(pasted) === JSON.stringify(picked),
      'picked: ' + JSON.stringify(picked) + '\n         pasted: ' + JSON.stringify(pasted));
    await page.screenshot({ path: path.join(shots, 'pasted.png') });

    /* ---- 2. receiving it leaves something to roll back to ---- */

    section('receiving it leaves an entry to roll back to');
    const took = await clickText(page, 'Replace the report');
    check('the dialog offers to take the package', took,
      'no "Replace the report" control on screen');
    if (took) {
      const landed = await waitForReport(reportsRoot, (doc) => firstLine(doc) === SENT_BACK);
      check('the returned report replaced the local one',
        firstLine(landed) === SENT_BACK, 'the first line on disk is '
          + JSON.stringify(firstLine(landed)));
      await settle(page, 800);
      await closeDialog();

      const sawHistory = await clickText(page, 'History');
      await settle(page, 1000);
      check('the history drawer opens', sawHistory, 'no History control');
      const rows = await timelineRows(page);
      const exchange = (rows || []).filter((r) => r.tag === 'Exchange')[0];
      check('the exchange is an entry in the timeline', !!exchange,
        'the timeline reads ' + JSON.stringify(rows));
      check('it says which state it holds, not just that it is a snapshot',
        !!exchange && exchange.title === 'Before replacing from pasted text',
        'the entry reads ' + JSON.stringify(exchange && exchange.title));
      check('and it offers to roll back to it',
        !!exchange && exchange.actions.indexOf('Roll back') >= 0,
        'its actions are ' + JSON.stringify(exchange && exchange.actions));
      await page.screenshot({ path: path.join(shots, 'history.png') });
    }

    check('no uncaught error was raised in the page', pageErrors.length === 0,
      pageErrors.slice(0, 3).join(' | '));
    await context.close();
  } finally {
    await cleanup();
  }
}

async function main() {
  console.log('a package pasted as text, and the entry it leaves');
  if (!chromium) {
    console.log('  SKIP: ' + chromiumMissing);
    return 0;
  }
  await browserChecks();
  console.log('');
  if (failures.length) {
    console.log(failures.length + ' check(s) failed:');
    for (const line of failures) console.log('  - ' + line);
    return 1;
  }
  console.log('paste package: all checks passed');
  return 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
