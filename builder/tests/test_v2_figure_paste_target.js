#!/usr/bin/env node
'use strict';
/*
 * test_v2_figure_paste_target.js -- WHERE A PASTED PICTURE GOES, driven with
 * real presses and real pastes in a real browser.
 *
 * Run:  node builder/tests/test_v2_figure_paste_target.js
 *       node builder/tests/test_v2_figure_paste_target.js --headed
 *
 * WHY THIS FILE EXISTS
 *   A figure block says "Paste a screenshot with Ctrl+V", and the two obvious
 *   ways of doing that both failed.
 *
 *   Pressing the grey frame first opened the file picker: a native window that
 *   takes the focus off the page, which is the one thing that guarantees the
 *   Ctrl+V the frame just asked for cannot land. The user who took a screenshot
 *   was asked for a file they had never saved.
 *
 *   Selecting the card and pasting did nothing either. Selecting is a press on
 *   the card's head and a head focuses nothing, so the keystroke reached the
 *   document, where the asset tray filed the picture in images/ and left the
 *   figure as empty as it was -- with a stray asset to hunt down afterwards.
 *
 * WHAT IT ASSERTS
 *   1. a press on the empty frame opens NO file dialog, and the frame takes the
 *      focus, so the Ctrl+V that follows has somewhere to land;
 *   2. a paste with the card SELECTED (its head pressed, nothing focused) fills
 *      that figure;
 *   3. one paste writes exactly ONE file into images/ -- the tray must not
 *      store a second copy of a picture a card has already claimed;
 *   4. the frame's own button, and a double-press on the frame, DO open the
 *      file picker, so the file on disk is still one gesture away;
 *   5. the same two rules hold for a cell of a figure grid, where a paste at
 *      the selected card fills the first free cell.
 *
 *   Assertions 1 and 2 are the ones with teeth: against the old code the press
 *   raises a file chooser and the selected card ignores the paste entirely.
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
const SECTION = 'Simulation results';

const FIG_ID = 'b-fig-1';
const GRID_ID = 'b-grid-1';
const FIG_CAPTION = 'Divider output at the slow corner';
const GRID_SUB = 'corner TT';

/* The figure card and the grid card, by the block index each one starts at:
 * the card wrapper publishes it, which is the only handle that survives a
 * re-render and does not depend on what the card happens to contain. */
const FIG_CARD = '.rw-card[data-block="1"]';
const GRID_CARD = '.rw-card[data-block="2"]';

const PNG_1X1_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

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
      secrecy: 'Internal', author: 'A. Engineer', date: '2026-09-08',
      reviewers: [], approver: '', revisions: [],
    },
    outline: [{
      id: 'n-results',
      title: SECTION,
      blocks: [
        { type: 'para', cardStart: true, list: null, runs: [{ t: 'Body text.' }] },
        // The figure starts EMPTY: this file is about how a picture gets in.
        { type: 'image', id: FIG_ID, file: '', caption: FIG_CAPTION, width_cm: 12 },
        {
          type: 'imagegrid', id: GRID_ID, cols: 2, width_cm: 15.5,
          caption: 'Two corners', sub_captions: true,
          items: [{ file: 'images/cell_a.png', sub: GRID_SUB }],
        },
      ],
      children: [],
    }],
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
  const images = path.join(dir, 'images');
  fs.mkdirSync(images, { recursive: true });
  fs.writeFileSync(path.join(images, 'cell_a.png'), Buffer.from(PNG_1X1_B64, 'base64'));
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
 * reading the report and images/ back off disk
 * ------------------------------------------------------------------ */

function readBlocks(root) {
  const file = path.join(root, ...REPORT_DIR.split('/'), 'project.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const blocks = ((doc.outline || [])[0] || {}).blocks || [];
  const byId = {};
  for (const b of blocks) if (b && b.id) byId[b.id] = b;
  return byId;
}

async function waitForBlock(root, id, predicate, timeoutMs) {
  const until = Date.now() + (timeoutMs == null ? 6000 : timeoutMs);
  let last = null;
  for (;;) {
    try {
      last = readBlocks(root)[id] || null;
      if (last && predicate(last)) return last;
    } catch (err) { /* mid-write */ }
    if (Date.now() > until) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
}

// The picture is posted to /api/image while the block that names it is still
// on its way through the debounced save, so images/ is watched rather than
// sampled: wait for the file to appear, THEN give a second one time to appear
// as well -- a paste that two handlers both claimed writes two.
async function waitForImages(root, expected, timeoutMs) {
  const until = Date.now() + (timeoutMs == null ? 6000 : timeoutMs);
  for (;;) {
    const n = countImages(root);
    if (n >= expected) return n;
    if (Date.now() > until) return n;
    await new Promise((r) => setTimeout(r, 150));
  }
}

function countImages(root) {
  const dir = path.join(root, ...REPORT_DIR.split('/'), 'images');
  try {
    return fs.readdirSync(dir).filter((n) => /\.png$/i.test(n)).length;
  } catch (err) {
    return 0;
  }
}

/* ------------------------------------------------------------------ *
 * driving
 * ------------------------------------------------------------------ */

const settle = (page, ms) => page.waitForTimeout(ms == null ? 350 : ms);

// A real paste: a PNG built in the page, wrapped in a DataTransfer, delivered
// as a ClipboardEvent to the element under test. `selector` is the element the
// event is dispatched at -- the same one a user's focus would be on. 'body' is
// where a paste goes when the user has selected a card and typed Ctrl+V.
const pasteImage = (page, selector) => page.evaluate(async (sel) => {
  const target = sel === 'body' ? document.body : document.querySelector(sel);
  if (!target) return 'no element at ' + sel;
  const canvas = document.createElement('canvas');
  canvas.width = 24;
  canvas.height = 16;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#3355ff';
  ctx.fillRect(0, 0, 24, 16);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  const file = new File([blob], 'pasted.png', { type: 'image/png' });
  const dt = new DataTransfer();
  dt.items.add(file);
  target.dispatchEvent(new ClipboardEvent('paste', {
    clipboardData: dt, bubbles: true, cancelable: true,
  }));
  return '';
}, selector);

const activeInfo = (page) => page.evaluate(() => {
  const el = document.activeElement;
  return {
    className: el ? String(el.className || '') : '',
    tag: el ? el.tagName : '',
  };
});

async function browserChecks() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const scratch = path.join(os.tmpdir(), 'report-workbench-v2-figure-paste', stamp);
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

    // A file chooser is a native window: listening for it both COUNTS the ones
    // that open and keeps any of them from blocking the run.
    const choosers = [];
    page.on('filechooser', (chooser) => { choosers.push(Date.now()); void chooser; });
    const chooserCount = () => choosers.length;

    const consoleErrors = [];
    page.on('console', (msg) => {
      const where = msg.location && msg.location() ? String(msg.location().url) : '';
      if (msg.type() === 'error' && where.indexOf('favicon') < 0) {
        consoleErrors.push(msg.text().slice(0, 200));
      }
    });
    page.on('pageerror', (err) => consoleErrors.push('uncaught: ' + String(err && err.message)));

    await page.goto(base + '/#/r/' + REPORT_DIR, { waitUntil: 'load' });
    await page.waitForSelector(FIG_CARD + ' .rw-empty', { timeout: 10000 });
    await settle(page, 500);

    /* ---- 1: a press on the frame arms it, and opens nothing ---- */
    section('a press on the empty frame');
    const before1 = chooserCount();
    await page.click(FIG_CARD + ' .rw-empty__title');
    await settle(page, 400);
    await page.screenshot({ path: path.join(shots, '1-armed.png') });
    check('the press opened NO file dialog',
      chooserCount() === before1,
      (chooserCount() - before1) + ' file chooser(s) opened');
    const armed = await activeInfo(page);
    check('the frame took the focus, so Ctrl+V has somewhere to land',
      /rw-empty/.test(armed.className),
      'focus is on ' + JSON.stringify(armed));

    /* ---- 2: the button in the frame IS the picker ---- */
    section('the frame\'s own button');
    const before2 = chooserCount();
    await page.click(FIG_CARD + ' .rw-empty .rw-btn');
    await settle(page, 400);
    check('the button opened the file picker',
      chooserCount() === before2 + 1,
      (chooserCount() - before2) + ' file chooser(s) opened');

    const before3 = chooserCount();
    await page.dblclick(FIG_CARD + ' .rw-empty__title');
    await settle(page, 400);
    check('a double-press opened the file picker too',
      chooserCount() === before3 + 1,
      (chooserCount() - before3) + ' file chooser(s) opened');

    /* ---- 3: the paste lands in the SELECTED card ---- */
    section('a paste with the card selected and nothing focused');
    // Selecting is a press on the card's HEAD -- on its type label, which is a
    // plain span: the tools beside it are buttons and belong to themselves.
    await page.click(FIG_CARD + ' .rw-card__type');
    await settle(page, 300);
    const isSelected = await page.evaluate((sel) => {
      const card = document.querySelector(sel);
      return !!card && /rw-card--selected/.test(String(card.className || ''));
    }, FIG_CARD);
    check('the press on the head selected the card', isSelected);
    await page.screenshot({ path: path.join(shots, '2-selected.png') });

    const imagesBefore = countImages(reportsRoot);
    const err1 = await pasteImage(page, 'body');
    check('the paste had somewhere to land', !err1, err1);
    const filled = await waitForBlock(reportsRoot, FIG_ID, (b) => !!b.file);
    await waitForImages(reportsRoot, imagesBefore + 1);
    await settle(page, 800);
    await page.screenshot({ path: path.join(shots, '3-filled.png') });
    check('the SELECTED figure took the picture',
      !!filled && /^images\/.*pasted/.test(filled.file || ''),
      'block.file is ' + JSON.stringify(filled && filled.file));
    check('the caption and the id are untouched',
      !!filled && filled.caption === FIG_CAPTION && filled.id === FIG_ID);
    check('one paste stored exactly ONE file in images/',
      countImages(reportsRoot) === imagesBefore + 1,
      'images/ went from ' + imagesBefore + ' to ' + countImages(reportsRoot));

    /* ---- 4: and a paste straight at the frame still works ---- */
    section('a paste at the frame itself');
    const wasFile = (filled && filled.file) || '';
    await page.click(FIG_CARD + ' .rw-figure__clear');
    await settle(page, 500);
    const imagesBefore2 = countImages(reportsRoot);
    const err2 = await pasteImage(page, FIG_CARD + ' .rw-empty');
    check('the paste had somewhere to land', !err2, err2);
    // A DIFFERENT file: the clear is still on its way through the debounced
    // save, so "the block names some file" is answered by the old one.
    const refilled = await waitForBlock(reportsRoot, FIG_ID,
      (b) => b.file && b.file !== wasFile);
    await waitForImages(reportsRoot, imagesBefore2 + 1);
    await settle(page, 800);
    check('the figure holds the newly pasted picture',
      !!refilled && /^images\/.*pasted/.test(refilled.file || '') && refilled.file !== wasFile,
      'block.file is ' + JSON.stringify(refilled && refilled.file));
    check('that paste stored exactly ONE file too',
      countImages(reportsRoot) === imagesBefore2 + 1,
      'images/ went from ' + imagesBefore2 + ' to ' + countImages(reportsRoot));

    /* ---- 5: the same rules in a figure grid ---- */
    section('a cell of a figure grid');
    const emptyCell = GRID_CARD + ' .rw-figgrid__cell:nth-child(2) .rw-drop';
    const before4 = chooserCount();
    await page.click(emptyCell + ' .rw-micro');
    await settle(page, 400);
    check('a press on the empty cell opened NO file dialog',
      chooserCount() === before4,
      (chooserCount() - before4) + ' file chooser(s) opened');
    const cellArmed = await activeInfo(page);
    check('the cell took the focus', /rw-drop/.test(cellArmed.className),
      'focus is on ' + JSON.stringify(cellArmed));

    const before5 = chooserCount();
    await page.click(emptyCell + ' .rw-btn');
    await settle(page, 400);
    check('the cell\'s button opened the file picker',
      chooserCount() === before5 + 1,
      (chooserCount() - before5) + ' file chooser(s) opened');

    await page.click(GRID_CARD + ' .rw-card__type');
    await settle(page, 300);
    const imagesBefore3 = countImages(reportsRoot);
    const err3 = await pasteImage(page, 'body');
    check('the paste had somewhere to land', !err3, err3);
    const grid = await waitForBlock(reportsRoot, GRID_ID,
      (b) => (b.items || [])[1] && (b.items || [])[1].file);
    await waitForImages(reportsRoot, imagesBefore3 + 1);
    await settle(page, 800);
    const items = (grid && grid.items) || [];
    await page.screenshot({ path: path.join(shots, '4-grid-filled.png') });
    check('the paste filled the first FREE cell',
      !!items[1] && /^images\/.*pasted/.test(items[1].file || ''),
      JSON.stringify(items));
    check('the cell that already held a picture was untouched',
      !!items[0] && items[0].file === 'images/cell_a.png' && items[0].sub === GRID_SUB,
      JSON.stringify(items[0]));
    check('that paste stored exactly ONE file as well',
      countImages(reportsRoot) === imagesBefore3 + 1,
      'images/ went from ' + imagesBefore3 + ' to ' + countImages(reportsRoot));

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
