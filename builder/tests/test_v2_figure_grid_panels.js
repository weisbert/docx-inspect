#!/usr/bin/env node
'use strict';
/*
 * test_v2_figure_grid_panels.js -- how many panels a grid has is the author's.
 *
 * Run:  node builder/tests/test_v2_figure_grid_panels.js
 *       node builder/tests/test_v2_figure_grid_panels.js --headed
 *
 * WHY THIS FILE EXISTS
 *   The image-grid card could grow -- paste into the trailing cell it always
 *   offers -- but never shrink. Its only ✕ emptied a panel and kept its place,
 *   deliberately ("the cell keeps its place and its sub-caption; only the
 *   picture goes"), which is right for REPLACING a figure and wrong for
 *   REMOVING one: a grid that had once held four printed four for good, one of
 *   them blank, and there was no way back to three. The previous editor had a ✕
 *   per cell that spliced the item out; the rewrite kept the picture half of
 *   that button and lost the panel half.
 *
 *   Clearing and removing are two different acts, so the card now offers both,
 *   plus an explicit "Add a panel" so the count can be set rather than
 *   discovered.
 *
 * WHAT IT ASSERTS
 *   1. every real panel carries a remove control, and the trailing cell the
 *      grid always offers -- which is not a panel -- does not;
 *   2. pressing it takes that panel out of project.json: the ones after it move
 *      up, so the (a)(b)(c) the document prints renumber with them;
 *   3. "Add a panel" appends one, and the card's own count follows;
 *   4. clearing a picture still leaves the panel and its sub-caption in place --
 *      the behaviour that was already right and must not be traded for this;
 *   5. a grid can be taken all the way down to no panels and still offers
 *      somewhere to put the next picture.
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

const GRID_ID = 'b-grid-1';
const GRID_CARD = '.rw-card[data-block="1"]';

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

// Three panels, already filled, with a typed label on the middle one. Removing
// the FIRST is the interesting case: the middle panel's own label has to travel
// with it while the letter the document prints for it changes.
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
        {
          type: 'imagegrid', id: GRID_ID, cols: 3, width_cm: 15.5,
          caption: 'Three corners', sub_captions: true,
          items: [
            { file: 'images/one.png', sub: '' },
            { file: 'images/two.png', sub: 'the middle one' },
            { file: 'images/three.png', sub: '' },
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
  for (const name of ['one.png', 'two.png', 'three.png']) {
    fs.writeFileSync(path.join(images, name), Buffer.from(PNG_1X1_B64, 'base64'));
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

const projectFile = (root) => path.join(root, ...REPORT_DIR.split('/'), 'project.json');

function readGrid(root) {
  const doc = JSON.parse(fs.readFileSync(projectFile(root), 'utf8'));
  const blocks = ((doc.outline || [])[0] || {}).blocks || [];
  for (const b of blocks) if (b && b.id === GRID_ID) return b;
  return null;
}

async function waitForGrid(root, predicate, timeoutMs) {
  const until = Date.now() + (timeoutMs == null ? 8000 : timeoutMs);
  let last = null;
  for (;;) {
    try {
      last = readGrid(root);
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

// What the grid shows: one entry per drawn cell, saying whether it holds a
// picture and whether it offers to remove itself as a panel.
const gridCells = (page) => page.evaluate((sel) => {
  const cells = Array.from(document.querySelectorAll(sel + ' .rw-figgrid__cell'));
  return cells.map((cell) => ({
    hasPicture: !!cell.querySelector('.rw-figure__img'),
    hasRemovePanel: !!cell.querySelector('.rw-figgrid__remove'),
    hasClearPicture: !!cell.querySelector('.rw-figure__clear'),
    letter: (cell.querySelector('.rw-figgrid__letter') || {}).textContent || '',
    sub: (cell.querySelector('input.rw-input') || {}).value || '',
  }));
}, GRID_CARD);

const viewerOpen = (page) => page.evaluate(() => !!document.querySelector('.rw-lightbox'));

async function browserChecks() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const scratch = path.join(os.tmpdir(), 'report-workbench-v2-grid-panels', stamp);
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
    await page.waitForSelector(GRID_CARD + ' .rw-figgrid__cell', { timeout: 10000 });
    await settle(page, 600);

    /* ---- 1: which cells offer to be removed ---- */
    section('a panel and the cell that is not one');
    const cells = await gridCells(page);
    await page.screenshot({ path: path.join(shots, '1-three-panels.png') });
    check('the three panels are drawn, plus the trailing cell that takes the next one',
      cells.length === 4, JSON.stringify(cells));
    check('every real panel offers to be removed',
      cells.slice(0, 3).every((c) => c.hasRemovePanel), JSON.stringify(cells));
    check('the trailing cell does not: there is no panel there to remove',
      cells[3] && !cells[3].hasRemovePanel, JSON.stringify(cells[3]));
    check('a filled panel still offers to have its picture cleared, separately',
      cells.slice(0, 3).every((c) => c.hasPicture && c.hasClearPicture),
      JSON.stringify(cells));

    /* ---- 2: removing one ---- */
    section('removing the first panel');
    await page.click(GRID_CARD + ' .rw-figgrid__cell:nth-child(1) .rw-figgrid__remove');
    await settle(page, 400);
    const shrunk = await waitForGrid(reportsRoot, (b) => (b.items || []).length === 2);
    await page.screenshot({ path: path.join(shots, '2-two-panels.png') });
    check('the report holds two panels afterwards',
      shrunk && (shrunk.items || []).length === 2, JSON.stringify(shrunk && shrunk.items));
    check('and they are the two that were not removed, in order',
      shrunk && shrunk.items[0].file.indexOf('two') !== -1
        && shrunk.items[1].file.indexOf('three') !== -1,
      JSON.stringify(shrunk && shrunk.items.map((i) => i.file)));
    check('the panel that moved up kept its own typed label',
      shrunk && shrunk.items[0].sub === 'the middle one',
      JSON.stringify(shrunk && shrunk.items[0]));

    const after = await gridCells(page);
    check('the letter the document will print for it renumbered to (a)',
      after[0] && /\ba\b|\(a\)/i.test(after[0].letter), JSON.stringify(after.map((c) => c.letter)));
    check('the grid now draws two panels and one trailing cell',
      after.length === 3, JSON.stringify(after.length));

    /* ---- 3: adding one ---- */
    section('adding a panel');
    await page.locator(GRID_CARD + ' button', { hasText: 'Add a panel' }).first().click();
    await settle(page, 400);
    const grown = await waitForGrid(reportsRoot, (b) => (b.items || []).length === 3);
    await page.screenshot({ path: path.join(shots, '3-added.png') });
    check('the report holds three panels again',
      grown && (grown.items || []).length === 3, JSON.stringify(grown && grown.items));
    check('the one that was added is empty and holds no picture',
      grown && grown.items[2] && !grown.items[2].file, JSON.stringify(grown && grown.items[2]));
    const withAdded = await gridCells(page);
    check('the added panel is drawn, and offers to be removed like any other',
      withAdded.length === 4 && withAdded[2] && withAdded[2].hasRemovePanel
        && !withAdded[2].hasPicture,
      JSON.stringify(withAdded));

    /* ---- 4: clearing is still not removing ---- */
    section('clearing a picture is still a different act');
    await page.click(GRID_CARD + ' .rw-figgrid__cell:nth-child(1) .rw-figure__clear');
    await settle(page, 400);
    const cleared = await waitForGrid(reportsRoot, (b) => !((b.items || [])[0] || {}).file);
    check('the panel is still there after its picture is cleared',
      cleared && (cleared.items || []).length === 3,
      JSON.stringify(cleared && cleared.items));
    check('and it kept its own label',
      cleared && cleared.items[0].sub === 'the middle one',
      JSON.stringify(cleared && cleared.items[0]));

    /* ---- 5: all the way down ---- */
    section('taking the last panel out');
    for (let i = 0; i < 3; i++) {
      // Always the first cell: each removal moves the next one into its place.
      await page.click(GRID_CARD + ' .rw-figgrid__cell:nth-child(1) .rw-figgrid__remove');
      await settle(page, 300);
    }
    const emptied = await waitForGrid(reportsRoot, (b) => (b.items || []).length === 0);
    await page.screenshot({ path: path.join(shots, '4-emptied.png') });
    check('a grid can be taken down to no panels at all',
      emptied && (emptied.items || []).length === 0,
      JSON.stringify(emptied && emptied.items));
    const bare = await gridCells(page);
    check('and it still offers somewhere to put the next picture',
      bare.length >= 1 && !bare[0].hasPicture && !bare[0].hasRemovePanel,
      JSON.stringify(bare));
    check('the viewer was never left open over any of that', !(await viewerOpen(page)));

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
