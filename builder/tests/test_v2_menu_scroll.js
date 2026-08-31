#!/usr/bin/env node
'use strict';
/*
 * test_v2_menu_scroll.js -- what a popup menu is anchored to, driven with a
 * real mouse and a real wheel in a real browser.
 *
 * Run:  node builder/tests/test_v2_menu_scroll.js
 *       node builder/tests/test_v2_menu_scroll.js --headed     (watch it work)
 *
 * WHY THIS FILE EXISTS
 *   js/components/Menu.js closed itself on `scroll` registered CAPTURE-phase on
 *   window, so it heard a scroll from ANY element on the page -- including the
 *   grid's own horizontal scroller. A compliance grid is wider than its
 *   viewport by design (frozen columns plus one group per simulation), and half
 *   of the cell menu's entries -- Insert column, Delete column, Merge across
 *   this group -- act on the column under the cursor. Nudging that column into
 *   view to check it was the right one is exactly the gesture that dismissed
 *   the menu about to act on it.
 *
 *   The fix anchors the menu to the element under the point it opened at: it
 *   follows that element while it moves, ignores scrolls from panes the anchor
 *   is not inside, and still closes when the anchor is scrolled out of sight.
 *
 * WHAT IT ASSERTS
 *   1. a menu opened on a grid cell SURVIVES a horizontal wheel scroll of that
 *      grid, travels with the column, and its Insert column entry still adds an
 *      axis to the group the cell belonged to -- and to no other group;
 *   2. the same menu still CLOSES when its anchor is scrolled out of view;
 *   3. it still closes on Escape, on an outside click, and on a window resize.
 *
 *   Assertion 1 is the one with teeth: against the old handler the menu is gone
 *   the moment the wheel turns, so it is not there to click and no axis is
 *   added.
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
const KEEP_ROOT = ARGS.includes('--keep-root');
const VIEWPORT = { width: 1600, height: 940 };

let chromium = null;
let chromiumMissing = '';
try {
  chromium = require('playwright-core').chromium;
} catch (err) {
  chromiumMissing = 'playwright-core is not installed.  npm install, then re-run.';
}

/* ------------------------------------------------------------------ *
 * the fixture -- five simulation groups, so the grid is several panes
 * wide and its horizontal scroller has real travel in it
 * ------------------------------------------------------------------ */

const PROJECT_ID = '1108';
const MODULE_ID = 'CLKDIV_5G';
const REPORT_DIR = PROJECT_ID + '/' + MODULE_ID + '/CDR';

const SECTION = 'Simulation results';
const TABLE_ID = 'b-table-1';
const PROSE = 'The table below states the test conditions and the measured values.';
const AXES = ['MIN', 'TYP', 'MAX'];
const SIM_KEYS = ['s1', 's2', 's3', 's4', 's5'];

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function row(cat, item, unit, kind) {
  const sims = {};
  for (const key of SIM_KEYS) sims[key] = { mtm: ['1.0', '2.0', '3.0'], ntwc: null };
  return {
    cat: cat, item: item, unit: unit, kind: kind, limit: null, sim_span: false,
    spec: null, spec_mtm: ['1.0', '2.0', '3.0'], spec_ntwc: null, sims: sims,
  };
}

function sampleReport() {
  return {
    template: 'sample',
    meta: {
      title: MODULE_ID + ' CDR report', doc_no: 'DOC-1', version: 'V1.0',
      secrecy: 'Internal', author: 'A. Engineer', date: '2026-08-30',
      reviewers: ['B. Engineer'], approver: 'C. Engineer', revisions: [],
    },
    outline: [
      {
        id: 'n-results',
        title: SECTION,
        blocks: [
          { type: 'para', cardStart: true, list: null, runs: [{ t: PROSE }] },
          {
            type: 'datatable', id: TABLE_ID, kind: 'compliance',
            caption: 'Divider performance',
            data: {
              spec_name: 'Spec',
              sims: SIM_KEYS.map((key, i) => ({
                key: key, title: 'Run ' + (i + 1), stage: 'CDR', axes: AXES.slice(),
              })),
              rows: [
                row('Conditions', 'Supply', 'V', 'common_setting'),
                row('Performance', 'Divided frequency', 'GHz', 'result'),
                row('Performance', 'Duty cycle', '%', 'result'),
                row('Performance', 'Current', 'mA', 'result'),
                row('Performance', 'Jitter', 'ps', 'result'),
              ],
            },
          },
        ],
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
      axis_labels: AXES.slice(),
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
  const reportDir = path.join(root, ...REPORT_DIR.split('/'));
  writeJson(path.join(reportDir, 'project.json'), sampleReport());
  fs.mkdirSync(path.join(reportDir, 'images'), { recursive: true });
  return root;
}

/* The column plan of THIS fixture, mirroring js/views/table.js::planColumns:
 * four fixed columns on the left, then one block of (separator + axes) per
 * group -- the spec group first, then one per simulation. Every group in the
 * fixture carries the same three axes, so each block is four columns wide.
 *
 *   0 #   1 Category   2 Item   3 Limit   4 |   5 6 7 spec   8 |   9 10 11 s1 ...
 *
 * THE CELL THIS TEST RIGHT-CLICKS is the LAST axis of the second simulation
 * group, chosen so that it and the column to its left belong to the same group.
 * That makes the assertion below say what it means -- "the entry still acts on
 * the group the user pointed at" -- without also depending on the grid
 * reporting the pointed-at column exactly. (It does not, today: the entries
 * that act on a column act on the column one to the left of the cell that was
 * right-clicked. That is a defect of js/views/table.js, not of the menu, and it
 * is not what this file is about.) */
const FIXED_COLS = 4;
const BLOCK = 1 + AXES.length;
const TARGET_SIM = 1;                                        // the group it must act on
const TARGET_COL = FIXED_COLS + BLOCK * (TARGET_SIM + 1) + AXES.length;

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

const settle = (page, ms) => page.waitForTimeout(ms == null ? 300 : ms);

function readTable(reportsRoot) {
  const file = path.join(reportsRoot, ...REPORT_DIR.split('/'), 'project.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const blocks = ((doc.outline || [])[0] || {}).blocks || [];
  return blocks.filter((b) => b && b.type === 'datatable')[0] || null;
}

function axisCounts(reportsRoot) {
  const table = readTable(reportsRoot);
  return ((table && table.data && table.data.sims) || []).map((s) => (s.axes || []).length);
}

async function waitForAxes(reportsRoot, predicate, timeoutMs) {
  const until = Date.now() + (timeoutMs == null ? 4000 : timeoutMs);
  for (;;) {
    const counts = axisCounts(reportsRoot);
    if (predicate(counts)) return counts;
    if (Date.now() > until) return counts;
    await new Promise((r) => setTimeout(r, 200));
  }
}

const menuBox = (page) => page.evaluate(() => {
  const el = document.querySelector('.rw-menu');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
});

const menuOpen = async (page) => (await menuBox(page)) !== null;

const scrollLeftOf = (page) => page.evaluate(() => {
  const el = document.querySelector('.rw-grid .jss_content');
  return el ? el.scrollLeft : -1;
});

// The grid's own horizontal scroller, and proof that it really does scroll.
const scrollerFacts = (page) => page.evaluate(() => {
  const el = document.querySelector('.rw-grid .jss_content');
  if (!el) return { error: 'the grid rendered no scroller' };
  const r = el.getBoundingClientRect();
  return {
    scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
    left: r.left, top: r.top, right: r.right, bottom: r.bottom,
  };
});

/* A cell that is really there to be pressed: not frozen, not underneath the
 * pinned left columns, and far enough inside the scroller that nudging the grid
 * 40px sideways leaves it on screen. `cols` limits it to particular grid
 * columns; null takes any. */
const PINNED_W = 296;   // # + Category + Item, pinned over the left edge

async function pickCell(page, wantColumns) {
  return page.evaluate((cols) => {
    const content = document.querySelector('.rw-grid .jss_content');
    if (!content) return { error: 'no scroller' };
    const view = content.getBoundingClientRect();
    const out = [];
    const cells = Array.from(document.querySelectorAll('.rw-grid td[data-x][data-y]'));
    for (const td of cells) {
      const x = Number(td.getAttribute('data-x'));
      const y = Number(td.getAttribute('data-y'));
      if (cols && cols.indexOf(x) < 0) continue;
      if (td.classList.contains('jss_freezed')) continue;
      const b = td.getBoundingClientRect();
      if (b.width < 20 || b.height < 10) continue;
      if (b.left < view.left + 296 || b.right > view.right - 8) continue;
      if (b.top < view.top + 8 || b.bottom > view.bottom - 8) continue;
      if (b.top < 0 || b.bottom > window.innerHeight) continue;
      out.push({ x: x, y: y, cx: b.left + b.width / 2, cy: b.top + b.height / 2, left: b.left });
    }
    out.sort((a, b) => (a.y - b.y) || (a.x - b.x));
    if (out.length) return out[0];
    const census = cells.slice(0, 400).map((td) => {
      const b = td.getBoundingClientRect();
      return td.getAttribute('data-x') + ',' + td.getAttribute('data-y')
        + (td.classList.contains('jss_freezed') ? 'F' : '')
        + '[' + Math.round(b.left) + '-' + Math.round(b.right)
        + '/' + Math.round(b.top) + '-' + Math.round(b.bottom) + ']';
    });
    return {
      error: 'no visible non-frozen cell in the wanted columns'
        + '  view=[' + Math.round(view.left) + '-' + Math.round(view.right)
        + '/' + Math.round(view.top) + '-' + Math.round(view.bottom) + ']'
        + '  win=' + window.innerWidth + 'x' + window.innerHeight
        + '  wanted=' + (cols ? cols.join(',') : 'any')
        + '  cells=' + census.join(' '),
    };
  }, wantColumns);
}

/* A point over the grid that the open menu does not cover -- the wheel has to
 * turn over the grid, not over the menu. */
async function wheelSpot(page) {
  return page.evaluate(() => {
    const content = document.querySelector('.rw-grid .jss_content');
    if (!content) return null;
    const v = content.getBoundingClientRect();
    const menu = document.querySelector('.rw-menu');
    const m = menu ? menu.getBoundingClientRect() : null;
    const candidates = [
      { x: v.left + 30, y: v.top + 12 },
      { x: v.right - 30, y: v.top + 12 },
      { x: v.left + 30, y: v.bottom - 12 },
      { x: v.right - 30, y: v.bottom - 12 },
    ];
    for (const p of candidates) {
      if (p.x < 0 || p.y < 0 || p.x > window.innerWidth || p.y > window.innerHeight) continue;
      if (m && p.x >= m.left - 4 && p.x <= m.right + 4 && p.y >= m.top - 4 && p.y <= m.bottom + 4) continue;
      return p;
    }
    return null;
  });
}

// Turn the wheel sideways over the grid. Falls back to the scrollbar's own
// property if this browser refuses a horizontal wheel, because the assertion is
// about the scroll EVENT, not about how the user produced it.
async function scrollGridBy(page, dx) {
  const spot = await wheelSpot(page);
  const before = await scrollLeftOf(page);
  if (spot) {
    await page.mouse.move(spot.x, spot.y);
    await page.mouse.wheel(dx, 0);
    await settle(page, 220);
  }
  let now = await scrollLeftOf(page);
  if (now === before) {
    await page.evaluate((by) => {
      const el = document.querySelector('.rw-grid .jss_content');
      if (el) el.scrollLeft = el.scrollLeft + by;
    }, dx);
    await settle(page, 220);
    now = await scrollLeftOf(page);
  }
  return { before: before, after: now };
}

/* Setup, not an assertion: park the grid so that one wanted column sits in the
 * middle of the strip that is neither pinned nor off the right edge. Passing
 * null just centres the scroller, which is enough when any cell will do. */
async function primeScroll(page, wantX) {
  await page.evaluate((arg) => {
    const content = document.querySelector('.rw-grid .jss_content');
    if (!content) return;
    if (arg.x == null) {
      content.scrollLeft = Math.round((content.scrollWidth - content.clientWidth) / 2);
      return;
    }
    const td = document.querySelector('.rw-grid td[data-x="' + arg.x + '"]');
    if (!td) return;
    const view = content.getBoundingClientRect();
    const b = td.getBoundingClientRect();
    const free = view.left + arg.pinned;
    const aim = free + (view.right - 8 - free) / 2 - b.width / 2;
    content.scrollLeft += (b.left - aim);
  }, { x: wantX == null ? null : wantX, pinned: PINNED_W });
  await settle(page, 260);
}

async function clickMenuItem(page, label) {
  const spot = await page.evaluate((wanted) => {
    const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    const items = Array.from(document.querySelectorAll('.rw-menu .rw-menu__item'));
    for (const el of items) {
      if (norm(el.innerText || el.textContent).indexOf(wanted) < 0) continue;
      if (el.hasAttribute('disabled')) return { error: 'the entry is disabled' };
      const b = el.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    }
    return { error: 'no menu entry reads "' + wanted + '"' };
  }, label);
  if (spot.error) return spot;
  await page.mouse.click(spot.x, spot.y);
  await settle(page, 300);
  return { clicked: true };
}

async function openMenuOnCell(page, cell) {
  await page.mouse.move(cell.cx, cell.cy);
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });
  await settle(page, 300);
  return menuBox(page);
}

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

/* ------------------------------------------------------------------ *
 * the run
 * ------------------------------------------------------------------ */

async function browserChecks() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const scratch = path.join(os.tmpdir(), 'report-workbench-v2-menu-scroll', stamp);
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
    await settle(page, 1400);
    await clickText(page, SECTION);
    await settle(page, 900);

    /* ---- the fixture really is wider than the pane that shows it ---- */

    section('the grid has a horizontal scroller of its own');
    const facts = await scrollerFacts(page);
    if (facts.error) {
      check('the grid rendered a scroller', false, facts.error);
      await page.screenshot({ path: path.join(shots, 'no-grid.png') });
      return;
    }
    check('the compliance grid is wider than its viewport',
      facts.scrollWidth > facts.clientWidth + 60,
      'scrollWidth ' + facts.scrollWidth + ' vs clientWidth ' + facts.clientWidth);

    /* ---- 1. the menu survives a scroll of the grid it is anchored in ---- */

    section('a cell menu, then a sideways nudge of the same grid');

    await primeScroll(page, TARGET_COL);
    const cell = await pickCell(page, [TARGET_COL]);
    if (cell.error) {
      check('there is a visible simulation cell to right-click', false, cell.error);
      await page.screenshot({ path: path.join(shots, 'no-cell.png') });
      return;
    }
    console.log('  right-clicking column ' + cell.x + ', row ' + cell.y
      + '  (simulation group "' + SIM_KEYS[TARGET_SIM] + '")');

    const opened = await openMenuOnCell(page, cell);
    check('a right-click on a cell opens the menu', !!opened,
      opened ? '' : 'no .rw-menu on screen');
    await page.screenshot({ path: path.join(shots, 'menu-open.png') });

    const moved = await scrollGridBy(page, 40);
    check('the sideways nudge really scrolled the grid', moved.after > moved.before,
      'scrollLeft ' + moved.before + ' -> ' + moved.after);
    await page.screenshot({ path: path.join(shots, 'after-scroll.png') });

    const after = await menuBox(page);
    check('the menu survives a horizontal scroll of the grid it is anchored in',
      !!after, 'the menu closed on a scroll it had no business hearing');

    if (after && opened) {
      const shift = after.left - opened.left;
      const travel = moved.before - moved.after;   // the column moved left by this much
      check('the menu travelled with the column it is anchored to',
        Math.abs(shift - travel) <= 6,
        'the menu moved ' + Math.round(shift) + 'px, the column moved ' + Math.round(travel) + 'px');
    }

    const before = axisCounts(reportsRoot);
    const clicked = await clickMenuItem(page, 'Insert column');
    check('Insert column is still there to click after the scroll',
      !!clicked.clicked, clicked.error || '');
    await page.keyboard.press('Control+s');
    const counts = await waitForAxes(reportsRoot,
      (c) => c[TARGET_SIM] === AXES.length + 1, 4000);
    check('Insert column added an axis to the group the cell belonged to, and only that group',
      counts[TARGET_SIM] === AXES.length + 1
      && counts.every((n, i) => i === TARGET_SIM || n === AXES.length),
      'axes per group were [' + before.join(', ') + '], now [' + counts.join(', ') + ']'
      + '   (expected group ' + TARGET_SIM + ', "' + SIM_KEYS[TARGET_SIM] + '", to grow)');

    /* ---- 2. the menu still closes when its anchor leaves the view ---- */

    section('the same menu, scrolled until its anchor is gone');
    await settle(page, 400);
    await primeScroll(page, null);
    const cell2 = await pickCell(page, null);
    if (cell2.error) {
      check('there is a cell to anchor the second menu on', false, cell2.error);
    } else {
      const opened2 = await openMenuOnCell(page, cell2);
      check('the second menu opened', !!opened2, opened2 ? '' : 'no .rw-menu on screen');
      await scrollGridBy(page, 4000);
      await settle(page, 300);
      check('the menu closes once its anchor has been scrolled out of view',
        !(await menuOpen(page)), 'the menu is still on screen beside nothing');
      await page.screenshot({ path: path.join(shots, 'anchor-gone.png') });
      await primeScroll(page, null);
    }

    /* ---- 3. the ordinary ways out still work ---- */

    section('Escape, an outside click, a window resize');
    await primeScroll(page, null);
    const cell3 = await pickCell(page, null);
    if (cell3.error) {
      check('there is a cell to anchor the third menu on', false, cell3.error);
    } else {
      await openMenuOnCell(page, cell3);
      await page.keyboard.press('Escape');
      await settle(page, 250);
      check('Escape closes the menu', !(await menuOpen(page)));

      await openMenuOnCell(page, cell3);
      const outside = await page.evaluate(() => {
        const prose = document.querySelector('.rw-prose');
        const menu = document.querySelector('.rw-menu');
        if (!prose || !menu) return null;
        const p = prose.getBoundingClientRect();
        const m = menu.getBoundingClientRect();
        const spot = { x: p.left + 20, y: p.top + 10 };
        if (spot.x >= m.left && spot.x <= m.right && spot.y >= m.top && spot.y <= m.bottom) return null;
        return spot;
      });
      if (!outside) {
        check('there is a spot outside the menu to click', false, 'no prose card clear of the menu');
      } else {
        await page.mouse.click(outside.x, outside.y);
        await settle(page, 250);
        check('a click outside closes the menu', !(await menuOpen(page)));
      }

      await openMenuOnCell(page, cell3);
      await page.setViewportSize({ width: VIEWPORT.width - 120, height: VIEWPORT.height });
      await settle(page, 350);
      check('a window resize closes the menu', !(await menuOpen(page)));
      await page.setViewportSize(VIEWPORT);
      await settle(page, 250);
    }

    if (consoleErrors.length) {
      check('no console errors', false, consoleErrors.slice(0, 4).join(' | '));
    } else {
      console.log('  [ok  ] no console errors');
    }

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
