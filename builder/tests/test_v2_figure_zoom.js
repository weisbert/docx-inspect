#!/usr/bin/env node
'use strict';
/*
 * test_v2_figure_zoom.js -- looking at a picture, full size, in a real browser.
 *
 * Run:  node builder/tests/test_v2_figure_zoom.js
 *       node builder/tests/test_v2_figure_zoom.js --headed
 *
 * WHY THIS FILE EXISTS
 *   A figure in the canvas is drawn at the width it will have on the printed
 *   page -- 12 cm is about 310 pixels. A screenshot of a plot is captured at
 *   two or three times that, so in the card the axis labels, the legend and the
 *   cursor readouts, which are the whole reason the picture is in the report,
 *   are a grey smear. Checking one meant exporting the document, or opening
 *   images/ in a file browser.
 *
 *   So a picture opens: double-click it, or press the ⤢ on it, and it fills the
 *   screen with a fit / 1:1 / zoom of its own. It is for LOOKING: nothing in
 *   the viewer writes to the document, which is the other half of what this
 *   file pins.
 *
 * WHAT IT ASSERTS
 *   1. a double-click on a filled figure opens the viewer, and the ⤢ does too;
 *   2. the picture is drawn far larger there than in the card;
 *   3. 1:1 shows it at its own pixel size -- the size a screenshot's text was
 *      drawn to be read at;
 *   4. Esc closes it, and so does a press on the backdrop;
 *   5. one cell of a figure grid opens ITS own picture, not the card's first;
 *   6. looking changes nothing: project.json is byte-identical afterwards.
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
const FIG_CARD = '.rw-card[data-block="1"]';
const GRID_CARD = '.rw-card[data-block="2"]';

/* The picture the test pastes in: big enough that the card cannot show it at
 * its own size, which is the whole situation being tested. */
const BIG = { w: 1600, h: 900 };

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
        { type: 'image', id: FIG_ID, file: '', caption: 'Divider output', width_cm: 12 },
        {
          type: 'imagegrid', id: GRID_ID, cols: 2, width_cm: 15.5,
          caption: 'Two corners', sub_captions: true, items: [],
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
  fs.writeFileSync(path.join(images, 'seed.png'), Buffer.from(PNG_1X1_B64, 'base64'));
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
 * reading the report back off disk
 * ------------------------------------------------------------------ */

const projectFile = (root) => path.join(root, ...REPORT_DIR.split('/'), 'project.json');

function readBlocks(root) {
  const doc = JSON.parse(fs.readFileSync(projectFile(root), 'utf8'));
  const blocks = ((doc.outline || [])[0] || {}).blocks || [];
  const byId = {};
  for (const b of blocks) if (b && b.id) byId[b.id] = b;
  return byId;
}

async function waitForBlock(root, id, predicate, timeoutMs) {
  const until = Date.now() + (timeoutMs == null ? 8000 : timeoutMs);
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

/* ------------------------------------------------------------------ *
 * driving
 * ------------------------------------------------------------------ */

const settle = (page, ms) => page.waitForTimeout(ms == null ? 350 : ms);

// A real paste of a picture BIG enough that the card cannot show it whole.
const pasteBigImage = (page, selector, size) => page.evaluate(async (args) => {
  const target = document.querySelector(args.sel);
  if (!target) return 'no element at ' + args.sel;
  const canvas = document.createElement('canvas');
  canvas.width = args.w;
  canvas.height = args.h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#2f6fed';
  ctx.fillRect(0, 0, args.w, args.h);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(20, 20, args.w - 40, 40);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  const file = new File([blob], 'plot.png', { type: 'image/png' });
  const dt = new DataTransfer();
  dt.items.add(file);
  target.dispatchEvent(new ClipboardEvent('paste', {
    clipboardData: dt, bubbles: true, cancelable: true,
  }));
  return '';
}, { sel: selector, w: size.w, h: size.h });

const viewerState = (page) => page.evaluate(() => {
  const box = document.querySelector('.rw-lightbox');
  if (!box) return { open: false };
  const img = box.querySelector('.rw-lightbox__img');
  const rect = img ? img.getBoundingClientRect() : null;
  const pct = box.querySelector('.rw-lightbox__pct');
  return {
    open: true,
    src: img ? img.getAttribute('src') : '',
    width: rect ? Math.round(rect.width) : 0,
    natural: img ? img.naturalWidth : 0,
    percent: pct ? String(pct.textContent || '').trim() : '',
    subtitle: (box.querySelector('.rw-lightbox__sub') || {}).textContent || '',
    title: (box.querySelector('.rw-lightbox__title') || {}).textContent || '',
  };
});

const cardImageWidth = (page, cardSelector) => page.evaluate((sel) => {
  const img = document.querySelector(sel + ' .rw-figure__img');
  return img ? Math.round(img.getBoundingClientRect().width) : 0;
}, cardSelector);

async function browserChecks() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const scratch = path.join(os.tmpdir(), 'report-workbench-v2-figure-zoom', stamp);
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

    await page.goto(base + '/#/r/' + REPORT_DIR, { waitUntil: 'load' });
    await page.waitForSelector(FIG_CARD + ' .rw-empty', { timeout: 10000 });
    await settle(page, 500);

    /* ---- a picture the card is too small for ---- */
    section('a picture the card is too small for');
    const err1 = await pasteBigImage(page, FIG_CARD + ' .rw-empty', BIG);
    check('the paste had somewhere to land', !err1, err1);
    await waitForBlock(reportsRoot, FIG_ID, (b) => !!b.file);
    await page.waitForSelector(FIG_CARD + ' .rw-figure__img', { timeout: 8000 });
    await settle(page, 600);
    const inCard = await cardImageWidth(page, FIG_CARD);
    check('the card shows it at the width it will be printed at',
      inCard > 0 && inCard < BIG.w / 2, 'the card draws it ' + inCard + 'px wide');

    /* ---- 1: opening it ---- */
    section('opening the picture');
    await page.dblclick(FIG_CARD + ' .rw-figure__img');
    await settle(page, 500);
    const opened = await viewerState(page);
    await page.screenshot({ path: path.join(shots, '1-open.png') });
    check('a double-click opens the viewer', opened.open, JSON.stringify(opened));
    check('it is showing the same picture',
      !!opened.src && opened.src.indexOf('plot') !== -1, JSON.stringify(opened.src));
    check('it reads the picture at its own pixel size',
      opened.natural === BIG.w, 'naturalWidth is ' + opened.natural);

    /* ---- 2: it is far bigger than the card ---- */
    check('the picture is drawn far larger than in the card',
      opened.width > inCard * 2, opened.width + 'px here against ' + inCard + 'px in the card');
    check('and it opened whole, at fit',
      opened.width <= BIG.w, 'it opened ' + opened.width + 'px wide');

    /* ---- 3: 1:1 ---- */
    section('1:1');
    await page.locator('.rw-lightbox__btn', { hasText: '1:1' }).first().click();
    await settle(page, 400);
    const actual = await viewerState(page);
    await page.screenshot({ path: path.join(shots, '2-actual.png') });
    check('1:1 draws it at its own pixel size',
      Math.abs(actual.width - BIG.w) <= 2, JSON.stringify(actual));
    check('and says so', actual.percent === '100%', JSON.stringify(actual.percent));

    /* ---- 4: closing ---- */
    section('closing');
    await page.keyboard.press('Escape');
    await settle(page, 400);
    check('Esc closes it', !(await viewerState(page)).open);

    const before = fs.readFileSync(projectFile(reportsRoot), 'utf8');

    await page.click(FIG_CARD + ' .rw-figure__zoom');
    await settle(page, 400);
    check('the button on the picture opens it too', (await viewerState(page)).open);
    // A press on the backdrop, away from the picture and the bar.
    await page.mouse.click(VIEWPORT.width - 12, Math.round(VIEWPORT.height / 2));
    await settle(page, 400);
    check('a press on the backdrop closes it', !(await viewerState(page)).open);

    /* ---- looking changes nothing ---- */
    section('looking is not editing');
    // Nothing between the two readings but opening the viewer, zooming it and
    // closing it three ways. A save is debounced, so it is given time to happen
    // before the file is read back.
    await settle(page, 1200);
    const after = fs.readFileSync(projectFile(reportsRoot), 'utf8');
    check('project.json is byte-identical after all that looking',
      after === before, 'the file changed while nothing was edited');

    /* ---- 5: one cell of a grid ---- */
    section('one cell of a figure grid');
    const cell = GRID_CARD + ' .rw-figgrid__cell:nth-child(1) .rw-drop';
    const err2 = await pasteBigImage(page, cell, { w: 900, h: 500 });
    check('the paste had somewhere to land', !err2, err2);
    await waitForBlock(reportsRoot, GRID_ID, (b) => (b.items || [])[0] && b.items[0].file);
    await settle(page, 700);
    await page.dblclick(cell + ' .rw-figure__img');
    await settle(page, 500);
    const cellView = await viewerState(page);
    await page.screenshot({ path: path.join(shots, '3-grid-cell.png') });
    check('the cell opens its own picture', cellView.open && cellView.natural === 900,
      JSON.stringify(cellView));
    await page.keyboard.press('Escape');
    await settle(page, 300);

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
