#!/usr/bin/env node
'use strict';
/*
 * test_v2_preview_resize.js -- the preview column's width belongs to the reader.
 *
 * Run:  node builder/tests/test_v2_preview_resize.js
 *       node builder/tests/test_v2_preview_resize.js --headed   (watch it work)
 *
 * WHY THIS FILE EXISTS
 *   The right-hand preview was a fixed 432px column. That is a reasonable place
 *   to start and a bad place to be stuck: a compliance table thirteen columns
 *   wide is legible at 700px and a smear at 432, and a reader checking prose
 *   against the paper wants the opposite trade. The only controls on that column
 *   were open and closed.
 *
 *   The column now carries a drag handle on its left seam (.rw-editor__grip),
 *   and the width it is dragged to is remembered -- in ui.rightWidth, persisted
 *   by store.js, so it survives a reload and follows the reader between reports.
 *
 *   THE HAZARD THIS FILE GUARDS. A width the user chose is written to the
 *   column's flex-basis as an INLINE style, so it outranks the stylesheet, and
 *   .rw-editor__right has `flex-shrink: 0` (it must: see
 *   test_v2_preview_width.js). Nothing about a wide inline basis expires when
 *   the window gets smaller, so without a ceiling a panel dragged wide on a big
 *   screen would squeeze the block canvas to nothing on a small one. The ceiling
 *   is a max-width on the column stated against the row's own width, and the
 *   drag clamps to the same arithmetic while it runs. The two are written in two
 *   languages -- custom properties in css/app.css, plain numbers in
 *   views/editor.js -- so this file also checks that they still say the same
 *   thing.
 *
 * WHAT IT ASSERTS, in a real browser, with real mouse and key events:
 *     1. the handle is on screen, at the seam, and only while the panel is open;
 *     2. a drag left widens the panel and the paper inside it by the distance
 *        dragged, and takes exactly that much from the canvas;
 *     3. the width is clamped at both ends -- 320px at the narrow end, and at
 *        the wide end whatever leaves the canvas its 420px;
 *     4. the width persists: it is in localStorage and it survives a reload;
 *     5. Escape abandons a drag in flight and puts the panel back;
 *     6. double-click on the seam resets the column to its 432px default;
 *     7. the keyboard works -- ArrowLeft/ArrowRight nudge, Home resets;
 *     8. a drag selects no text on the way past;
 *     9. the dragged width then behaves like the default one did: scrolling the
 *        preview past a wide table does not move it (the rule
 *        test_v2_preview_width.js pins, re-checked at a width nobody hard-coded);
 *    10. the stylesheet and the view still agree on the three numbers;
 *    11. no console errors during any of it.
 *
 * AGAINST THE OLD BEHAVIOUR it fails at assertion 1 and everything after it:
 * there was no .rw-editor__grip in the document and no ui.rightWidth in storage,
 * so the seam was not draggable and every measured width stayed 432.
 *
 * IT NEVER TOUCHES REAL REPORTS. The fixture is generated from scratch into the
 * OS temporary directory and the server is booted against THAT with an explicit
 * --root, exactly as the other v2 browser tests are.
 *
 * SKIPPING IS A FEATURE: no playwright-core (the public repository carries no
 * node_modules) or no system browser still runs the static checks and exits 0.
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
const EDITOR_JS = path.join(REPO, 'builder', 'web', 'assets', 'v2', 'js', 'views', 'editor.js');
const STORE_JS = path.join(REPO, 'builder', 'web', 'assets', 'v2', 'js', 'store.js');

const ARGS = process.argv.slice(2);
const HEADED = ARGS.includes('--headed');
const KEEP_ROOT = ARGS.includes('--keep-root');
const VIEWPORT = { width: 1440, height: 900 };

// The geometry the interface promises. Every one of these is checked against
// the stylesheet and the view below, so this block is the single place a
// deliberate change to the layout has to be restated.
const DEFAULT_W = 432;
const MIN_W = 320;
const CENTRE_MIN = 420;
const KEY_STEP = 16;
const SLOP = 4;             // px, for a drag measured through the compositor

let chromium = null;
try {
  chromium = require('playwright-core').chromium;
} catch (err) {
  chromium = null;
}

/* ------------------------------------------------------------------ *
 * the fixture -- one wide table, and enough sections to scroll
 * ------------------------------------------------------------------ */

const PROJECT_ID = '1108';
const MODULE_ID = 'CLKDIV_5G';
const REPORT_DIR = PROJECT_ID + '/' + MODULE_ID + '/CDR';

const SECTIONS = 16;
const WIDE_AT = [6];
const WIDE_COLS = 13;
const WIDE_ROWS = 10;

function para(t) { return { type: 'para', runs: [{ t: t }] }; }

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
  for (let k = 0; k < 5; k++) {
    blocks.push(para('Paragraph ' + (k + 1) + ' of section ' + i
      + '. It carries enough text to give the section a real height, and enough '
      + 'words for a careless drag across it to leave a selection behind.'));
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
      secrecy: 'Internal', author: 'A. Engineer', date: '2026-09-04',
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

function near(a, b, slop) {
  return Math.abs(a - b) <= (slop === undefined ? SLOP : slop);
}

function section(title) {
  console.log('');
  console.log(title);
}

/* ------------------------------------------------------------------ *
 * 10. the stylesheet and the view still say the same three numbers
 * ------------------------------------------------------------------ */

function tokenPx(css, name) {
  const m = new RegExp('--' + name + '\\s*:\\s*(\\d+)px').exec(css);
  return m ? Number(m[1]) : null;
}

function constNumber(js, name) {
  const m = new RegExp('const\\s+' + name + '\\s*=\\s*(\\d+)\\s*;').exec(js);
  return m ? Number(m[1]) : null;
}

function staticChecks() {
  section('the stylesheet and the view');
  const css = fs.readFileSync(APP_CSS, 'utf8');
  const js = fs.readFileSync(EDITOR_JS, 'utf8');
  const store = fs.readFileSync(STORE_JS, 'utf8');

  const pairs = [
    ['lay-right-w', 'RIGHT_DEFAULT', DEFAULT_W],
    ['lay-right-min', 'RIGHT_MIN', MIN_W],
    ['lay-centre-min', 'CENTRE_MIN', CENTRE_MIN],
  ];
  pairs.forEach((p) => {
    const fromCss = tokenPx(css, p[0]);
    const fromJs = constNumber(js, p[1]);
    check('--' + p[0] + ' and ' + p[1] + ' agree, and are ' + p[2],
      fromCss === p[2] && fromJs === p[2],
      'css=' + fromCss + ' js=' + fromJs);
  });

  const grip = /\.rw-editor__grip\s*\{([^}]*)\}/.exec(css);
  check('.rw-editor__grip is declared', !!grip);
  if (grip) {
    check('the grip shows a col-resize cursor', /cursor\s*:\s*col-resize/.test(grip[1]),
      grip[1].replace(/\s+/g, ' ').trim());
    check('the grip takes no room in the row', /flex\s*:\s*0\s+0\s+0/.test(grip[1]),
      grip[1].replace(/\s+/g, ' ').trim());
  }

  const ceiling = /\.rw-editor\s*>\s*\.rw-editor__right\s*\{([^}]*)\}/.exec(css);
  check('the column carries a max-width ceiling',
    !!ceiling && /max-width/.test(ceiling[1]) && /--lay-centre-min/.test(ceiling[1]),
    ceiling ? ceiling[1].replace(/\s+/g, ' ').trim() : 'no rule');

  check('store.js persists rightWidth',
    /PERSISTED_UI\s*=\s*\[[^\]]*'rightWidth'/.test(store.replace(/\n/g, ' ')),
    'not in PERSISTED_UI');
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

/* ------------------------------------------------------------------ *
 * one sample of everything the drag can move
 * ------------------------------------------------------------------ */

const MEASURE = () => {
  const q = (s) => document.querySelector(s);
  const w = (el) => (el ? Math.round(el.getBoundingClientRect().width) : -1);
  const right = q('.rw-editor__right');
  let stored;
  try {
    stored = JSON.parse(window.localStorage.getItem('rw.ui') || '{}').rightWidth;
  } catch (err) {
    stored = 'unreadable';
  }
  const doc = q('.rw-preview__doc');
  return {
    grip: !!q('.rw-editor__grip'),
    panel: w(right),
    centre: w(q('.rw-editor__centre')),
    rail: w(q('.rw-editor__rail')),
    row: w(q('.rw-editor')),
    paper: w(q('.rw-paper')),
    basis: right ? String(right.style.flexBasis || '') : '(no column)',
    stored: stored === undefined ? null : stored,
    docClientW: doc ? doc.clientWidth : -1,
    docScrollW: doc ? doc.scrollWidth : -1,
    selection: String(window.getSelection ? window.getSelection().toString() : ''),
  };
};

// The point on the seam the handle covers: the column's left edge, halfway down.
function seamPoint(page) {
  return page.evaluate(() => {
    const r = document.querySelector('.rw-editor__right').getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top + r.height / 2) };
  });
}

// A real press-move-release on the seam. dx < 0 drags left, which widens the
// panel. `abandon` presses Escape before letting go.
async function dragSeam(page, dx, opts) {
  const p = await seamPoint(page);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  const steps = 14;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(p.x + Math.round((dx * i) / steps), p.y);
    await page.waitForTimeout(12);
  }
  if (opts && opts.abandon) await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.waitForTimeout(160);
  return page.evaluate(MEASURE);
}

async function wheelPreview(page, steps) {
  const box = await page.$('.rw-preview__doc');
  const bb = await box.boundingBox();
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
  const out = [];
  for (let i = 0; i < steps; i++) {
    out.push(await page.evaluate(MEASURE));
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(180);
  }
  out.push(await page.evaluate(MEASURE));
  return out;
}

/* ------------------------------------------------------------------ */

async function browserChecks() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const scratch = path.join(os.tmpdir(), 'report-workbench-v2-preview-resize', stamp);
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

    /* ---- 1. the handle exists, at the seam ---- */

    section('the handle');
    const rest = await page.evaluate(MEASURE);
    check('the seam carries a drag handle', rest.grip === true,
      'no .rw-editor__grip in the document');
    if (!rest.grip) return;   // nothing below can mean anything without it

    check('the column starts at its ' + DEFAULT_W + 'px default',
      near(rest.panel, DEFAULT_W), 'panel=' + rest.panel);

    const overlap = await page.evaluate(() => {
      const grip = document.querySelector('.rw-editor__grip');
      const right = document.querySelector('.rw-editor__right');
      const g = grip.getBoundingClientRect();
      const r = right.getBoundingClientRect();
      const hit = window.getComputedStyle(grip, '::before');
      return {
        gap: Math.round(g.right - r.left),
        gripW: Math.round(g.width),
        hitW: parseFloat(hit.width) || 0,
        cursor: window.getComputedStyle(grip).cursor,
        tall: Math.round(g.height) > 200,
      };
    });
    check('the handle sits on the seam and takes no width from the row',
      overlap.gap === 0 && overlap.gripW === 0 && overlap.tall,
      JSON.stringify(overlap));
    check('its hit area is wide enough to catch (>= 8px)', overlap.hitW >= 8,
      'hit area ' + overlap.hitW + 'px');

    /* ---- 2. a drag widens the panel and narrows the canvas ---- */

    section('dragging the seam');
    const wider = await dragSeam(page, -220);
    check('dragging left widens the panel by the distance dragged',
      near(wider.panel, rest.panel + 220),
      'was ' + rest.panel + ', now ' + wider.panel);
    check('the paper inside it grows with it',
      near(wider.paper, rest.paper + 220, SLOP + 2),
      'was ' + rest.paper + ', now ' + wider.paper);
    check('the canvas gives up exactly that much',
      near(wider.centre, rest.centre - 220),
      'was ' + rest.centre + ', now ' + wider.centre);
    check('the width is written to the column as an inline basis',
      /^\d+px$/.test(wider.basis), 'flex-basis=' + JSON.stringify(wider.basis));

    /* ---- 8. and selects nothing on the way ---- */

    check('the drag leaves no text selected', wider.selection === '',
      JSON.stringify(wider.selection.slice(0, 60)));

    /* ---- 4. it is remembered ---- */

    section('remembering it');
    check('the width is in localStorage', wider.stored === wider.panel,
      'stored=' + JSON.stringify(wider.stored) + ' panel=' + wider.panel);

    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(1500);
    const reloaded = await page.evaluate(MEASURE);
    check('the width survives a reload', near(reloaded.panel, wider.panel, 1),
      'before ' + wider.panel + ', after ' + reloaded.panel);

    /* ---- 9. and then behaves like the default width did ---- */

    section('scrolling at the dragged width');
    const samples = await wheelPreview(page, 14);
    const seen = Array.from(new Set(samples.map((s) => s.panel + '/' + s.docClientW + '/' + s.paper)));
    console.log('  panel/scroller/paper widths seen: ' + seen.join('   '));
    check('the dragged width does not jitter while the preview scrolls',
      seen.length === 1, seen.join(' vs '));
    check('the paper still grows no horizontal scrollbar of its own',
      samples.every((s) => s.docScrollW <= s.docClientW + 1),
      samples.filter((s) => s.docScrollW > s.docClientW + 1)
        .map((s) => s.docScrollW + '>' + s.docClientW).join(', '));

    /* ---- 3. both ends are clamped ---- */

    section('the limits');
    const narrow = await dragSeam(page, 2000);
    check('a drag to the right stops at ' + MIN_W + 'px',
      narrow.panel === MIN_W, 'panel=' + narrow.panel);

    const widest = await dragSeam(page, -3000);
    const ceiling = widest.row - widest.rail - CENTRE_MIN;
    check('a drag to the left stops with ' + CENTRE_MIN + 'px left for the canvas',
      near(widest.panel, ceiling, 1) && widest.centre >= CENTRE_MIN - 1,
      'panel=' + widest.panel + ' ceiling=' + ceiling + ' centre=' + widest.centre);

    /* ---- 5. Escape abandons a drag in flight ---- */

    section('abandoning a drag');
    const before = await page.evaluate(MEASURE);
    const abandoned = await dragSeam(page, 260, { abandon: true });
    check('Escape puts the panel back where the drag started',
      abandoned.panel === before.panel,
      'was ' + before.panel + ', ended at ' + abandoned.panel);
    check('and leaves the remembered width alone',
      abandoned.stored === before.stored,
      'stored ' + JSON.stringify(before.stored) + ' -> ' + JSON.stringify(abandoned.stored));

    /* ---- 6. double-click resets ---- */

    section('resetting');
    const seam = await seamPoint(page);
    await page.mouse.dblclick(seam.x, seam.y);
    await page.waitForTimeout(200);
    const afterDbl = await page.evaluate(MEASURE);
    check('a double-click on the seam restores the ' + DEFAULT_W + 'px default',
      near(afterDbl.panel, DEFAULT_W, 1), 'panel=' + afterDbl.panel);
    check('and clears the remembered width rather than storing the default',
      afterDbl.stored === null, 'stored=' + JSON.stringify(afterDbl.stored));

    /* ---- 7. the keyboard ---- */

    section('the keyboard');
    await page.evaluate(() => document.querySelector('.rw-editor__grip').focus());
    const focused = await page.evaluate(() => {
      const el = document.activeElement;
      return {
        onGrip: !!(el && el.classList && el.classList.contains('rw-editor__grip')),
        role: el ? el.getAttribute('role') : null,
        orientation: el ? el.getAttribute('aria-orientation') : null,
      };
    });
    check('the handle takes focus and announces itself as a splitter',
      focused.onGrip && focused.role === 'separator' && focused.orientation === 'vertical',
      JSON.stringify(focused));

    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(150);
    const nudged = await page.evaluate(MEASURE);
    check('ArrowLeft widens by ' + KEY_STEP + 'px',
      near(nudged.panel, afterDbl.panel + KEY_STEP, 1),
      'was ' + afterDbl.panel + ', now ' + nudged.panel);

    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(150);
    const back = await page.evaluate(MEASURE);
    check('ArrowRight narrows by the same step',
      near(back.panel, nudged.panel - 2 * KEY_STEP, 1),
      'was ' + nudged.panel + ', now ' + back.panel);

    await page.keyboard.press('Home');
    await page.waitForTimeout(150);
    const homed = await page.evaluate(MEASURE);
    check('Home resets the column', near(homed.panel, DEFAULT_W, 1) && homed.stored === null,
      'panel=' + homed.panel + ' stored=' + JSON.stringify(homed.stored));

    /* ---- 6b. a click that moves nothing is not a resize ---- */

    section('a bare click on the seam');
    await page.waitForTimeout(600);   // clear of the double-click window
    const seamAgain = await seamPoint(page);
    await page.mouse.click(seamAgain.x, seamAgain.y);
    await page.waitForTimeout(220);
    const clicked = await page.evaluate(MEASURE);
    check('pressing the seam without moving stores no width',
      near(clicked.panel, DEFAULT_W, 1) && clicked.stored === null,
      'panel=' + clicked.panel + ' stored=' + JSON.stringify(clicked.stored));

    /* ---- 1b. no handle over the collapsed strip ---- */

    section('the collapsed strip');
    await page.evaluate(() => document.body.click());
    await page.keyboard.press('F8');
    await page.waitForTimeout(300);
    const collapsed = await page.evaluate(MEASURE);
    check('collapsing the panel takes the handle away with it',
      collapsed.grip === false && collapsed.panel < 60,
      'grip=' + collapsed.grip + ' panel=' + collapsed.panel);
    await page.keyboard.press('F8');
    await page.waitForTimeout(300);
    const reopened = await page.evaluate(MEASURE);
    check('reopening it brings the handle back',
      reopened.grip === true && near(reopened.panel, DEFAULT_W, 1),
      'grip=' + reopened.grip + ' panel=' + reopened.panel);

    /* ---- 11. a clean console ---- */

    section('the console');
    check('no console errors', consoleErrors.length === 0,
      consoleErrors.slice(0, 4).join(' ;; '));
  } finally {
    await cleanup();
  }
}

/* ------------------------------------------------------------------ */

async function main() {
  console.log('test_v2_preview_resize -- the preview column can be dragged wider');
  staticChecks();

  if (!chromium) {
    console.log('');
    console.log('  SKIP: playwright-core is not installed; static checks only.');
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
