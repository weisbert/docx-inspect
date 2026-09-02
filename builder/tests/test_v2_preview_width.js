#!/usr/bin/env node
'use strict';
/*
 * test_v2_preview_width.js -- the preview keeps its width while you scroll it.
 *
 * Run:  node builder/tests/test_v2_preview_width.js
 *       node builder/tests/test_v2_preview_width.js --headed   (watch it work)
 *
 * WHY THIS FILE EXISTS
 *   The preview is a virtual document: it mounts the sections near the viewport
 *   and leaves the rest as a measured spacer. So the widest thing on screen
 *   CHANGES as the wheel turns -- a section holding a wide table is mounted at
 *   one scroll position and gone at the next.
 *
 *   The column it lives in, .rw-editor__right, is a flex item with a fixed
 *   basis but no `min-width: 0`. A flex item's automatic minimum size is its
 *   MIN-CONTENT width, and a fixed basis does not override it: the used width
 *   is the basis clamped UP by that minimum. Mounting a wide table therefore
 *   pushed the panel open, and scrolling that section away snapped it shut.
 *   Measured on a 40-section fixture with two 13-column tables, the panel
 *   flipped between 432px and 793px -- nearly double -- while the reader was
 *   doing nothing but scrolling. Its sibling .rw-editor__centre already carried
 *   `min-width: 0`; this column was simply missed.
 *
 *   The wrapper .rw-preview__wide exists precisely so a table too wide for the
 *   panel scrolls sideways INSIDE the paper. It cannot do that job while the
 *   panel is willing to grow instead.
 *
 * WHAT IT ASSERTS, in a real browser against a generated report:
 *     1. the fixture actually exercises the bug -- the wide table is mounted at
 *        some scroll positions and absent at others (without this the rest of
 *        the file proves nothing);
 *     2. the panel, the scroller and the paper keep ONE width for the whole
 *        scroll, mounted wide table or not;
 *     3. the paper never grows a horizontal scrollbar of its own: the doc's
 *        scrollWidth stays equal to its clientWidth;
 *     4. the wide table is still reachable -- its .rw-preview__wide wrapper
 *        scrolls sideways rather than being clipped;
 *     5. TEETH: re-introducing `min-width: auto` on that one column, in the same
 *        page, brings the jitter straight back -- so the assertion above is
 *        pinned to this rule and not to some other accident of the layout;
 *     6. the shipped stylesheet still carries the rule;
 *     7. no console errors during any of it.
 *
 * IT NEVER TOUCHES REAL REPORTS. The fixture is generated from scratch into the
 * OS temporary directory and the server is booted against THAT with an explicit
 * --root, exactly as the other v2 browser tests are.
 *
 * SKIPPING IS A FEATURE: no playwright-core (the public repository carries no
 * node_modules) or no system browser still runs the stylesheet check and exits 0.
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
const APP_CSS = path.join(REPO, 'builder', 'web', 'assets', 'v2', 'css', 'app.css');

const ARGS = process.argv.slice(2);
const HEADED = ARGS.includes('--headed');
const KEEP_ROOT = ARGS.includes('--keep-root');
const VIEWPORT = { width: 1440, height: 900 };

let chromium = null;
try {
  chromium = require('playwright-core').chromium;
} catch (err) {
  chromium = null;
}

/* ------------------------------------------------------------------ *
 * the fixture -- long enough that a wide section leaves the window
 * ------------------------------------------------------------------ */

const PROJECT_ID = '1108';
const MODULE_ID = 'CLKDIV_5G';
const REPORT_DIR = PROJECT_ID + '/' + MODULE_ID + '/CDR';

const SECTIONS = 40;
const WIDE_AT = [15, 30];       // the sections that hold a wide table
const WIDE_COLS = 13;
const WIDE_ROWS = 12;

function para(t) { return { type: 'para', runs: [{ t: t }] }; }

// The shape a per-branch current split has: one long label column and a dozen
// numeric ones, comfortably wider than the panel.
function wideTable(id) {
  const head = ['Branch (module) name, spelled out'];
  for (let c = 1; c < WIDE_COLS; c++) head.push('Corner ' + c + ' measured value (uA)');
  const rows = [head];
  for (let r = 0; r < WIDE_ROWS; r++) {
    const line = ['I_' + (r + 1) + ' some_long_branch_name_' + (r + 1)];
    for (let c = 1; c < WIDE_COLS; c++) line.push(String(1000 + r * 7 + c) + '.' + c + ' uA');
    rows.push(line);
  }
  return {
    type: 'table', id: id, caption: 'A wide table with ' + WIDE_COLS + ' columns',
    header_rows: 1, rows: rows, merges: [], row_fills: {}, col_w: null,
  };
}

function sampleSection(i) {
  const blocks = [];
  for (let k = 0; k < 6; k++) {
    blocks.push(para('Paragraph ' + (k + 1) + ' of section ' + i
      + '. It carries enough text to give the section a real height, so the '
      + 'virtual window has to mount and unmount it while the wheel turns.'));
  }
  if (WIDE_AT.indexOf(i) >= 0) blocks.push(wideTable('b-wide-' + i));
  return { id: 'n-s' + i, title: 'Section ' + i, blocks: blocks, children: [] };
}

function sampleReport() {
  const outline = [];
  for (let i = 1; i <= SECTIONS; i++) outline.push(sampleSection(i));
  return {
    template: 'sample',
    meta: {
      title: MODULE_ID + ' report', doc_no: 'DOC-1', version: 'V1.0',
      secrecy: 'Internal', author: 'A. Engineer', date: '2026-09-02',
      reviewers: [], approver: '', revisions: [],
    },
    outline: outline,
  };
}

function sampleTemplateConfig() {
  return {
    id: 'sample', name: 'Sample template',
    caption_prefix: { figure: 'Figure', table: 'Table' },
    toc: { enabled: true },
    skeleton: [{ title: 'Section 1', children: [] }],
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

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function buildReportsRoot(root) {
  fs.mkdirSync(root, { recursive: true });
  writeJson(path.join(root, 'templates', 'sample', 'config.json'), sampleTemplateConfig());
  writeJson(path.join(root, 'templates', 'sample', 'skeleton.json'), sampleTemplateConfig().skeleton);
  writeJson(path.join(root, PROJECT_ID, 'project_meta.json'), { name: 'Sample project' });
  writeJson(path.join(root, PROJECT_ID, MODULE_ID, 'project_meta.json'), { name: MODULE_ID });
  const reportDir = path.join(root, ...REPORT_DIR.split('/'));
  writeJson(path.join(reportDir, 'project.json'), sampleReport());
  fs.mkdirSync(path.join(reportDir, 'images'), { recursive: true });
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
 * the stylesheet rule itself
 * ------------------------------------------------------------------ */

function cssChecks() {
  section('the stylesheet');
  const css = fs.readFileSync(APP_CSS, 'utf8');
  const block = /\.rw-editor__right\s*\{([^}]*)\}/.exec(css);
  check('.rw-editor__right is declared', !!block);
  if (!block) return;
  check('it pins min-width to 0', /min-width\s*:\s*0/.test(block[1]),
    block[1].replace(/\s+/g, ' ').trim());
}

/* ------------------------------------------------------------------ *
 * browser plumbing
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
  const child = spawn(python,
    [SERVER_PY, '--port', String(port), '--root', root, '--config', config],
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
    child.kill();
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} resolve(); }, 2500);
  });
}

// One sample of everything that could move, taken inside the page.
const MEASURE = () => {
  const q = (s) => document.querySelector(s);
  const w = (el) => (el ? Math.round(el.getBoundingClientRect().width) : -1);
  const doc = q('.rw-preview__doc');
  const wides = Array.from(document.querySelectorAll('.rw-preview__wide'));
  const tables = Array.from(document.querySelectorAll('.rw-preview__doc table'));
  return {
    panel: w(q('.rw-editor__right')),
    doc: w(doc),
    docClientW: doc ? doc.clientWidth : -1,
    docScrollW: doc ? doc.scrollWidth : -1,
    paper: w(q('.rw-paper')),
    scrollTop: doc ? Math.round(doc.scrollTop) : -1,
    wideMounted: tables.some((t) => t.getBoundingClientRect().width > 600),
    wideScrolls: wides.some((el) => el.scrollWidth > el.clientWidth + 1),
  };
};

// Wheel down the preview, sampling at every step. Returns the samples.
async function wheelThrough(page, steps) {
  const box = await page.$('.rw-preview__doc');
  const bb = await box.boundingBox();
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
  const out = [];
  for (let i = 0; i < steps; i++) {
    out.push(await page.evaluate(MEASURE));
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(200);
  }
  out.push(await page.evaluate(MEASURE));
  return out;
}

function widthsOf(samples) {
  const set = new Set(samples.map((s) => s.panel + '/' + s.docClientW + '/' + s.paper));
  return Array.from(set);
}

async function browserChecks() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const scratch = path.join(os.tmpdir(), 'report-workbench-v2-preview-width', stamp);
  const reportsRoot = path.join(scratch, 'reports');
  buildReportsRoot(reportsRoot);
  console.log('  fixture: ' + reportsRoot);

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
    const consoleErrors = [];
    page.on('console', (msg) => {
      const where = msg.location && msg.location() ? String(msg.location().url) : '';
      if (msg.type() === 'error' && where.indexOf('favicon') < 0) {
        consoleErrors.push(msg.text().slice(0, 200));
      }
    });
    page.on('pageerror', (err) => consoleErrors.push('uncaught: ' + String(err && err.message)));

    const editorUrl = base + '/#/r/' + REPORT_DIR.split('/').map(encodeURIComponent).join('/');
    await page.goto(editorUrl, { waitUntil: 'load' });
    await page.waitForTimeout(1500);

    if (!(await page.$('.rw-preview__doc'))) {
      check('the preview panel is on screen', false, 'no .rw-preview__doc');
      return;
    }

    /* ---- 1/2/3/4. the shipped stylesheet ---- */

    section('scrolling the preview (shipped stylesheet)');
    const shipped = await wheelThrough(page, 26);
    const mounted = shipped.filter((s) => s.wideMounted).length;

    check('the fixture mounts and unmounts the wide table',
      mounted > 0 && mounted < shipped.length,
      'wide table mounted in ' + mounted + ' of ' + shipped.length + ' samples');

    const seen = widthsOf(shipped);
    console.log('  panel/scroller/paper widths seen: ' + seen.join('   '));
    check('the width never changes while scrolling', seen.length === 1, seen.join(' vs '));

    check('the paper grows no horizontal scrollbar of its own',
      shipped.every((s) => s.docScrollW <= s.docClientW + 1),
      shipped.filter((s) => s.docScrollW > s.docClientW + 1)
        .map((s) => s.docScrollW + '>' + s.docClientW).join(', '));

    check('the wide table stays reachable -- its wrapper scrolls sideways',
      shipped.some((s) => s.wideMounted && s.wideScrolls),
      'no mounted wide table had a scrollable wrapper');

    /* ---- 5. teeth: put the old rule back, in this same page ---- */

    section('the same scroll with min-width:auto put back (teeth)');
    await page.addStyleTag({ content: '.rw-editor__right{min-width:auto!important}' });
    await page.evaluate(() => {
      const box = document.querySelector('.rw-preview__doc');
      if (box) box.scrollTop = 0;
    });
    await page.waitForTimeout(400);
    const broken = await wheelThrough(page, 26);
    const brokenSeen = widthsOf(broken);
    console.log('  panel/scroller/paper widths seen: ' + brokenSeen.join('   '));
    check('TEETH: the old rule makes the width jump', brokenSeen.length > 1,
      'expected more than one width, saw ' + brokenSeen.join(' '));

    /* ---- 7. a clean console ---- */

    section('the console');
    check('no console errors', consoleErrors.length === 0,
      consoleErrors.slice(0, 4).join(' ;; '));
  } finally {
    await cleanup();
  }
}

/* ------------------------------------------------------------------ */

async function main() {
  console.log('test_v2_preview_width -- the preview keeps its width while you scroll');
  cssChecks();

  if (!chromium) {
    console.log('');
    console.log('  SKIP: playwright-core is not installed; stylesheet check only.');
  } else {
    await browserChecks();
  }

  console.log('');
  if (failures.length) {
    console.log(failures.length + ' failure(s):');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('all checks passed');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
