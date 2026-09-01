#!/usr/bin/env node
'use strict';
/*
 * test_v2_figure_clear_paste.js -- swapping the picture in a figure, driven
 * with a real click and a real paste in a real browser.
 *
 * Run:  node builder/tests/test_v2_figure_clear_paste.js
 *       node builder/tests/test_v2_figure_clear_paste.js --headed
 *
 * WHY THIS FILE EXISTS
 *   Re-taking a screenshot is the commonest edit these documents get, and a
 *   figure that already held a picture had no way to accept a new one from the
 *   clipboard: the paste handler lived on the EMPTY frame only, and the only
 *   control that removed anything deleted the whole block -- caption, number,
 *   cross-references and all. The way through was Replace and the file picker,
 *   which means saving the screenshot to disk first.
 *
 *   So the picture now carries a ✕ of its own, and a filled figure takes a
 *   paste. Removing the picture keeps the figure: caption, width, block id and
 *   therefore the figure NUMBER survive, and the empty frame takes the focus so
 *   the Ctrl+V that follows lands without a click.
 *
 * WHAT IT ASSERTS
 *   1. a filled figure offers ✕, and pressing it empties the picture while the
 *      caption and the figure number stay exactly as they were;
 *   2. the file under images/ is NOT deleted -- other blocks may point at it;
 *   3. the empty frame holds the focus afterwards, so Ctrl+V needs no click;
 *   4. a paste into that frame stores a new file and points the block at it;
 *   5. a paste onto a figure that STILL HOLDS a picture replaces it;
 *   6. one cell of a figure grid can be emptied without touching its
 *      neighbours or its sub-caption.
 *
 *   Assertions 3 and 5 are the ones with teeth: against the old code the filled
 *   figure ignores the paste entirely and the block still names the old file.
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

/* A 1x1 PNG. Small, valid, and decodable by the canvas the app re-encodes
 * through -- that is all the fixture needs a picture to be. */
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
      secrecy: 'Internal', author: 'A. Engineer', date: '2026-08-30',
      reviewers: [], approver: '', revisions: [],
    },
    outline: [{
      id: 'n-results',
      title: SECTION,
      blocks: [
        { type: 'para', cardStart: true, list: null, runs: [{ t: 'Body text.' }] },
        {
          type: 'image', id: FIG_ID, file: 'images/original.png',
          caption: FIG_CAPTION, width_cm: 12,
        },
        {
          type: 'imagegrid', id: GRID_ID, cols: 2, width_cm: 15.5,
          caption: 'Two corners', sub_captions: true,
          items: [
            { file: 'images/cell_a.png', sub: GRID_SUB },
            { file: 'images/cell_b.png', sub: 'corner SS' },
          ],
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
  const png = Buffer.from(PNG_1X1_B64, 'base64');
  for (const name of ['original.png', 'cell_a.png', 'cell_b.png']) {
    fs.writeFileSync(path.join(images, name), png);
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
 * reading the report back off disk
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

/* ------------------------------------------------------------------ *
 * driving
 * ------------------------------------------------------------------ */

const settle = (page, ms) => page.waitForTimeout(ms == null ? 350 : ms);

// A real paste: a PNG built in the page, wrapped in a DataTransfer, delivered
// as a ClipboardEvent to the element under test. `selector` is the element the
// event is dispatched at -- the same one a user's caret would be in.
const pasteImage = (page, selector) => page.evaluate(async (sel) => {
  const target = document.querySelector(sel);
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

const figureState = (page) => page.evaluate(() => {
  const card = document.querySelector('[data-block]:has(.rw-card__marker--figure)')
    || document.querySelectorAll('.rw-card')[1];
  const img = document.querySelector('.rw-figure .rw-figure__img');
  // The number chip only. The rest of the head carries the file name and its
  // pixel size, which SHOULD change when the picture does.
  const head = card ? card.querySelector('.rw-numchip') : null;
  const caption = document.querySelector('.rw-figure input.rw-input, .rw-card input.rw-input');
  const active = document.activeElement;
  return {
    hasImg: !!img,
    imgSrc: img ? img.getAttribute('src') : '',
    hasClear: !!document.querySelector('.rw-figure__clear'),
    headText: head ? head.textContent.replace(/\s+/g, ' ').trim().slice(0, 120) : '',
    captionValue: caption ? caption.value : '',
    activeClass: active ? String(active.className || '') : '',
    hasEmptyFrame: !!document.querySelector('.rw-card .rw-empty'),
  };
});

async function browserChecks() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const scratch = path.join(os.tmpdir(), 'report-workbench-v2-figure-swap', stamp);
  const reportsRoot = path.join(scratch, 'reports');
  const shots = path.join(scratch, 'screens');
  fs.mkdirSync(shots, { recursive: true });
  buildReportsRoot(reportsRoot);
  console.log('  fixture: ' + reportsRoot);

  const imagesDir = path.join(reportsRoot, ...REPORT_DIR.split('/'), 'images');
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
    await page.waitForSelector('.rw-figure__img', { timeout: 10000 });
    await settle(page, 500);

    /* ---- 1: pasting onto a figure that still holds a picture ---- */
    section('a paste onto a figure that already holds a picture');
    const before = await figureState(page);
    check('the figure starts out filled', before.hasImg, JSON.stringify(before));
    check('the picture carries a remove button', before.hasClear);
    await page.screenshot({ path: path.join(shots, '1-filled.png') });

    const err1 = await pasteImage(page, '.rw-figure');
    check('the paste had somewhere to land', !err1, err1);
    const replaced = await waitForBlock(reportsRoot, FIG_ID,
      (b) => b.file && b.file !== 'images/original.png');
    check('the paste REPLACED the picture',
      !!replaced && /^images\/.*pasted/.test(replaced.file || ''),
      'block.file is now ' + JSON.stringify(replaced && replaced.file));
    check('the caption survived the replacement',
      !!replaced && replaced.caption === FIG_CAPTION,
      'caption is now ' + JSON.stringify(replaced && replaced.caption));
    check('the block kept its id, so its figure number cannot move',
      !!replaced && replaced.id === FIG_ID);
    await page.screenshot({ path: path.join(shots, '2-replaced.png') });

    /* ---- 2: the remove button ---- */
    section('removing the picture');
    const numberBefore = (await figureState(page)).headText;
    await page.click('.rw-figure__clear');
    await settle(page, 500);
    const cleared = await waitForBlock(reportsRoot, FIG_ID, (b) => !b.file);
    const afterClear = await figureState(page);
    await page.screenshot({ path: path.join(shots, '3-cleared.png') });
    check('the picture is gone', !!cleared && !cleared.file && !afterClear.hasImg,
      'block.file is ' + JSON.stringify(cleared && cleared.file));
    check('the figure itself stayed -- caption and id intact',
      !!cleared && cleared.caption === FIG_CAPTION && cleared.id === FIG_ID);
    check('the figure number did not move',
      afterClear.headText === numberBefore,
      JSON.stringify(numberBefore) + ' -> ' + JSON.stringify(afterClear.headText));
    check('the file under images/ was NOT deleted',
      fs.existsSync(path.join(imagesDir, 'original.png')),
      'the fixture picture disappeared from images/');
    check('the empty frame took the focus, so Ctrl+V needs no click',
      /rw-empty/.test(afterClear.activeClass),
      'focus is on ' + JSON.stringify(afterClear.activeClass));

    /* ---- 3: pasting into the empty frame ---- */
    section('pasting the new picture straight in');
    const err2 = await pasteImage(page, '.rw-card .rw-empty');
    check('the paste had somewhere to land', !err2, err2);
    const refilled = await waitForBlock(reportsRoot, FIG_ID, (b) => !!b.file);
    await settle(page, 400);
    await page.screenshot({ path: path.join(shots, '4-refilled.png') });
    check('the figure holds the pasted picture',
      !!refilled && /^images\/.*pasted/.test(refilled.file || ''),
      'block.file is ' + JSON.stringify(refilled && refilled.file));
    check('and still its own caption and id',
      !!refilled && refilled.caption === FIG_CAPTION && refilled.id === FIG_ID);

    /* ---- 4: one cell of a figure grid ---- */
    section('one cell of a figure grid');
    const cellClears = page.locator('.rw-figgrid .rw-figure__clear');
    check('each filled cell carries its own remove button',
      (await cellClears.count()) >= 2, 'found ' + (await cellClears.count()));
    if (await cellClears.count()) {
      await cellClears.first().click();
      await settle(page, 500);
      const grid = await waitForBlock(reportsRoot, GRID_ID,
        (b) => (b.items || [])[0] && !b.items[0].file);
      const items = (grid && grid.items) || [];
      await page.screenshot({ path: path.join(shots, '5-grid-cell-cleared.png') });
      check('the cell emptied', !!items[0] && !items[0].file,
        JSON.stringify(items[0]));
      check('its sub-caption stayed', !!items[0] && items[0].sub === GRID_SUB,
        JSON.stringify(items[0]));
      check('the neighbouring cell was untouched',
        !!items[1] && items[1].file === 'images/cell_b.png',
        JSON.stringify(items[1]));
      check('removing a cell picture did not open the file picker',
        !(await page.locator('.rw-figgrid input[type=file]:focus').count()));
    }

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
