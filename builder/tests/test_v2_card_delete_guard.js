#!/usr/bin/env node
'use strict';
/*
 * test_v2_card_delete_guard.js -- an ancestor must not claim a gesture that a
 * descendant needs, asserted with a real mouse and a real keyboard.
 *
 * Run:  node builder/tests/test_v2_card_delete_guard.js
 *       node builder/tests/test_v2_card_delete_guard.js --headed
 *
 * WHY THIS FILE EXISTS
 *   The workbench frame owns three gestures that a card's CONTENT also owns:
 *
 *     Delete   the frame deletes the selected card; a grid clears the selected
 *              cell. The frame's only guard tested input/textarea/select and
 *              [contenteditable], and a grid cell is a bare <td>, so one press
 *              on a cell followed by one Delete destroyed the whole compliance
 *              table -- every row, every value, the caption -- leaving `para`
 *              where `para , datatable` had been.
 *     Ctrl+F   the frame moves the caret to the outline search. It was claimed
 *              unconditionally, ABOVE even that guard, so it fired from inside
 *              a prose card mid-sentence and from inside an open cell editor:
 *              the caret was lost and no browser find happened either.
 *     a press  the frame selected a card on ANY mousedown that reached it,
 *              which is what left the selection armed at a table while the
 *              user was working inside it.
 *
 * WHAT IT ASSERTS, all of it through page.mouse / page.keyboard
 *   1. clicking one cell of a four-row compliance table and pressing Delete
 *      once leaves the card, the four rows and every other value on disk --
 *      and the keystroke still reaches the grid, which clears that one cell;
 *   2. Delete with a card GENUINELY selected -- pressed on the card's own head
 *      -- still deletes the card;
 *   3. Ctrl+F inside a prose card does not move the caret;
 *   4. Ctrl+F inside an open cell editor does not close it or move the caret;
 *   5. Ctrl+F with the focus on neither still focuses the outline search;
 *   6. the insert seam's plus is visible without a pointer on it, and the seam
 *      is reachable and openable from the keyboard.
 *
 * Assertion 1 FAILS against the old handler; the failure is the reason this
 * file exists and is printed in full when it happens.
 *
 * IT NEVER TOUCHES REAL REPORTS. The fixture is generated from scratch into the
 * OS temporary directory and the server is booted against THAT with --root.
 *
 * SKIPPING IS A FEATURE: no playwright-core (the public repository carries no
 * node_modules) or no system browser exits 0.
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
const VIEWPORT = { width: 1560, height: 940 };

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

const SECTION = 'Simulation setup';
const TABLE_ID = 'b-table-1';
const CAPTION = 'Divider performance over corners';
const PROSE = 'The divider is measured across the supply and temperature corners.';

// Two values nothing else on the screen carries, so a cell can be found by its
// own text and a lost value is unmistakable on disk.
const CELL_A = '1.11';
const CELL_B = '2.22';

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function complianceTable() {
  return {
    type: 'datatable', id: TABLE_ID, kind: 'compliance', caption: CAPTION,
    data: {
      spec_name: 'Spec', show_spec: true,
      sims: [{ key: 'sim', title: 'CDR', stage: 'CDR', axes: ['MIN', 'TYP', 'MAX', 'NTWC'] }],
      rows: [
        {
          cat: 'Conditions', item: 'Supply', kind: 'common_setting', unit: 'V',
          limit: null, spec_mtm: [null, '1.20', null], spec_ntwc: null,
          sim_mtm: [null, '1.20', null], sim_ntwc: null, sim_span: false,
        },
        {
          cat: 'Conditions', item: 'Temperature', kind: 'common_setting', unit: 'C',
          limit: null, spec_mtm: [null, '25', null], spec_ntwc: null,
          sim_mtm: [null, '25', null], sim_ntwc: null, sim_span: false,
        },
        {
          cat: 'Performance', item: 'Supply current', kind: 'result', unit: 'mA',
          limit: 'le', spec_mtm: [null, null, '5.00'], spec_ntwc: null,
          sim_mtm: [null, CELL_A, null], sim_ntwc: null, sim_span: false,
        },
        {
          cat: 'Performance', item: 'Output swing', kind: 'result', unit: 'mV',
          limit: 'ge', spec_mtm: ['0.30', null, null], spec_ntwc: null,
          sim_mtm: [null, CELL_B, null], sim_ntwc: null, sim_span: false,
        },
      ],
    },
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
        id: 'n-setup',
        title: SECTION,
        blocks: [
          { type: 'para', cardStart: true, runs: [{ t: PROSE }] },
          complianceTable(),
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
 * server lifecycle (the same shape as the other v2 suites)
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
 * reading the document back off the disk
 * ------------------------------------------------------------------ */

function readSection(reportsRoot) {
  const file = path.join(reportsRoot, ...REPORT_DIR.split('/'), 'project.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  return (doc.outline || [])[0] || {};
}

function blockShape(blocks) {
  return (blocks || []).map((b) => (b ? b.type : '?')).join(' , ');
}

async function waitForBlocks(reportsRoot, predicate, timeoutMs) {
  const until = Date.now() + (timeoutMs == null ? 4000 : timeoutMs);
  for (;;) {
    const blocks = readSection(reportsRoot).blocks || [];
    if (predicate(blocks)) return blocks;
    if (Date.now() > until) return blocks;
    await new Promise((r) => setTimeout(r, 150));
  }
}

// Force the debounced save and give it time to land. A predicate that is
// already true of the file on disk is no proof at all -- it is what the file
// said BEFORE the gesture -- so every disk assertion waits here first.
async function flushSave(page) {
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(1800);
}

const settle = (page, ms) => page.waitForTimeout(ms == null ? 400 : ms);

/* ------------------------------------------------------------------ *
 * real gestures
 * ------------------------------------------------------------------ */

// The centre of the grid cell whose drawn text is exactly `value`, in page
// coordinates, so the press can be made with the real mouse.
async function cellBox(page, value) {
  return page.evaluate((wanted) => {
    const cells = Array.from(document.querySelectorAll('td[data-x][data-y]'));
    const hit = cells.find((td) => String(td.textContent).trim() === wanted);
    if (!hit) return null;
    hit.scrollIntoView({ block: 'center', inline: 'center' });
    const box = hit.getBoundingClientRect();
    if (!box.width || !box.height) return null;
    return {
      x: box.left + box.width / 2, y: box.top + box.height / 2,
      dx: hit.getAttribute('data-x'), dy: hit.getAttribute('data-y'),
    };
  }, value);
}

// A point on the card's own head strip, clear of the tools that sit on it --
// the gesture that MEANS "select this card".
async function cardHeadBox(page, blockId) {
  return page.evaluate((id) => {
    const slot = document.querySelector('[data-block-id="' + id + '"]');
    const head = slot && slot.querySelector('.rw-card__head');
    if (!head) return null;
    head.scrollIntoView({ block: 'center' });
    const box = head.getBoundingClientRect();
    const type = head.querySelector('.rw-card__type');
    const label = type ? type.getBoundingClientRect() : null;
    if (!box.width || !box.height) return null;
    return {
      x: label && label.width ? label.left + label.width / 2 : box.left + 40,
      y: box.top + box.height / 2,
    };
  }, blockId);
}

async function realClick(page, point) {
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.up();
  await settle(page, 250);
}

// What the keyboard is pointed at, in terms this test can print.
function describeFocus(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return 'nothing';
    if (el === document.body) return 'body';
    const cls = typeof el.className === 'string' ? el.className : '';
    return el.tagName.toLowerCase()
      + (el.getAttribute('aria-label') ? '[' + el.getAttribute('aria-label') + ']' : '')
      + (cls ? '.' + cls.split(/\s+/).filter(Boolean).join('.') : '')
      + (el.isContentEditable ? ' (editable)' : '');
  });
}

function searchIsFocused(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    return !!(el && el.getAttribute && el.getAttribute('aria-label') === 'Search sections');
  });
}

function cellEditorIsOpen(page) {
  return page.evaluate(() => {
    const lib = window.jspreadsheet;
    const ws = lib && lib.current;
    return !!(ws && ws.edition && ws.edition.length);
  });
}

/* ------------------------------------------------------------------ *
 * the run
 * ------------------------------------------------------------------ */

async function browserChecks() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const scratch = path.join(os.tmpdir(), 'report-workbench-v2-delete-guard', stamp);
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
    await settle(page, 1600);

    /* ---- 1. a cell, then Delete ---- */

    section('one cell, one Delete  (the blocker)');
    const before = readSection(reportsRoot).blocks || [];
    console.log('  on disk before : ' + blockShape(before));

    const cell = await cellBox(page, CELL_B);
    if (!cell) {
      check('the compliance table draws a cell holding ' + CELL_B, false,
        'no such cell on screen');
    } else {
      console.log('  pressing cell x=' + cell.dx + ' y=' + cell.dy
        + ' at (' + Math.round(cell.x) + ',' + Math.round(cell.y) + ')');
      await realClick(page, cell);
      console.log('  focus after the press: ' + (await describeFocus(page)));
      await page.screenshot({ path: path.join(shots, '1-cell-pressed.png') });
      await page.keyboard.press('Delete');
      await settle(page, 500);
      await page.screenshot({ path: path.join(shots, '2-after-delete.png') });

      const onScreen = await page.evaluate((id) =>
        !!document.querySelector('[data-block-id="' + id + '"]'), TABLE_ID);
      check('the table card is still on screen after Delete on a cell', onScreen,
        'the card was removed from the canvas');

      await flushSave(page);
      const after = readSection(reportsRoot).blocks || [];
      console.log('  on disk after  : ' + blockShape(after));

      const table = after.find((b) => b && b.type === 'datatable');
      check('the compliance table card still exists after Delete on a cell',
        !!table, 'the section now reads: ' + blockShape(after));
      const rows = table ? ((table.data || {}).rows || []) : [];
      console.log('  rows on disk   : '
        + JSON.stringify(rows.map((r) => [r.item, (r.sim_mtm || [])[1]])));
      check('all four rows survive', rows.length === 4, 'rows on disk: ' + rows.length);
      check('the caption survives', !!table && table.caption === CAPTION,
        'caption is: ' + JSON.stringify(table && table.caption));
      check('the row values the press did not touch survive',
        rows.length === 4
          && (rows[2].sim_mtm || [])[1] === CELL_A
          && rows[0].item === 'Supply' && rows[3].item === 'Output swing',
        'rows read: ' + JSON.stringify(rows.map((r) => [r.item, (r.sim_mtm || [])[1]])));
      // The other half of stepping aside: the keystroke has to REACH the grid.
      // Clearing the pressed cell is what the user asked for, and it is the
      // proof that the frame did not swallow the key on its way down.
      check('the grid still gets the keystroke -- the pressed cell is cleared',
        rows.length === 4 && (rows[3].sim_mtm || [])[1] == null,
        'the pressed cell reads ' + JSON.stringify(rows.length === 4
          ? (rows[3].sim_mtm || [])[1] : null));
    }

    /* ---- 3. Ctrl+F inside a prose card ---- */

    section('Ctrl+F where a descendant holds the caret');
    const prose = await page.evaluate(() => {
      const el = document.querySelector('.rw-canvas [contenteditable="true"]');
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const box = el.getBoundingClientRect();
      return { x: box.left + Math.min(80, box.width / 2), y: box.top + box.height / 2 };
    });
    if (!prose) {
      check('the prose card is editable on screen', false, 'no contenteditable in the canvas');
    } else {
      await realClick(page, prose);
      const wasProse = await describeFocus(page);
      await page.keyboard.press('Control+f');
      await settle(page, 250);
      const nowProse = await describeFocus(page);
      check('Ctrl+F in a prose card leaves the caret where it was',
        nowProse === wasProse && !(await searchIsFocused(page)),
        'focus was ' + wasProse + ', is now ' + nowProse);
    }

    /* ---- 4. Ctrl+F inside an open cell editor ---- */

    const editCell = await cellBox(page, CELL_A);
    if (!editCell) {
      check('the compliance table draws a cell holding ' + CELL_A, false, 'no such cell');
    } else {
      await page.mouse.move(editCell.x, editCell.y);
      await page.mouse.click(editCell.x, editCell.y, { clickCount: 2 });
      await settle(page, 350);
      const opened = await cellEditorIsOpen(page);
      check('a double press opens the cell editor', opened,
        'the grid reports no open edition');
      if (opened) {
        await page.keyboard.press('Control+f');
        await settle(page, 250);
        const stillOpen = await cellEditorIsOpen(page);
        const stolen = await searchIsFocused(page);
        check('Ctrl+F in an open cell editor does not close it or steal the caret',
          stillOpen && !stolen,
          'editor open: ' + stillOpen + ', focus: ' + (await describeFocus(page)));
        await page.keyboard.press('Escape');
        await settle(page, 250);
      }
    }

    /* ---- 5. Ctrl+F with the focus on neither ---- */

    const bar = await page.evaluate(() => {
      const el = document.querySelector('.rw-sectionbar');
      if (!el) return null;
      const box = el.getBoundingClientRect();
      return { x: box.right - 240, y: box.top + box.height / 2 };
    });
    if (!bar) {
      check('the section bar is on screen', false, 'no .rw-sectionbar');
    } else {
      await realClick(page, bar);
      console.log('  focus before Ctrl+F: ' + (await describeFocus(page)));
      await page.keyboard.press('Control+f');
      await settle(page, 250);
      check('Ctrl+F with the focus on neither focuses the outline search',
        await searchIsFocused(page), 'focus is ' + (await describeFocus(page)));
      await page.keyboard.press('Escape');
      await settle(page, 200);
    }

    // A control that has the focus but no caret is not busy. Guarding on "the
    // focus is somewhere" instead would kill Ctrl+F for the rest of the
    // session after one press on any button in the frame.
    const railRow = await page.evaluate(() => {
      // The tree's own rows, never the pinned cover row above them: landing on
      // the cover form would take the card canvas off screen.
      const el = Array.from(document.querySelectorAll('.rw-tree .rw-tree__row'))
        .find((r) => r.getBoundingClientRect().height > 0);
      if (!el) return null;
      const box = el.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    });
    if (!railRow) {
      check('the outline draws a section row', false, 'no .rw-tree__row');
    } else {
      await realClick(page, railRow);
      const held = await describeFocus(page);
      await page.keyboard.press('Control+f');
      await settle(page, 250);
      check('Ctrl+F still works after pressing a control that holds no caret',
        await searchIsFocused(page),
        'focus was ' + held + ', is now ' + (await describeFocus(page)));
      await page.keyboard.press('Escape');
      await settle(page, 200);
    }

    /* ---- 6. the insert seam ---- */

    section('the insert seam');
    const seam = await page.evaluate(() => {
      const el = document.querySelector('.rw-canvas .rw-seam');
      const plus = el && el.querySelector('.rw-seam__plus');
      if (!plus) return null;
      return {
        opacity: Number(window.getComputedStyle(plus).opacity),
        tabIndex: el.tabIndex,
        role: el.getAttribute('role'),
        label: el.getAttribute('aria-label') || el.getAttribute('title'),
      };
    });
    if (!seam) {
      check('the canvas draws an insert seam', false, 'no .rw-seam');
    } else {
      check('the plus is visible with no pointer on it',
        seam.opacity > 0, 'computed opacity is ' + seam.opacity);
      check('the seam is reachable from the keyboard',
        seam.tabIndex >= 0 && seam.role === 'button',
        'tabIndex ' + seam.tabIndex + ', role ' + seam.role);
      check('the seam names itself', seam.label === 'Insert here',
        'the seam reads ' + JSON.stringify(seam.label));

      const focused = await page.evaluate(() => {
        const el = document.querySelector('.rw-canvas .rw-seam');
        if (!el) return false;
        el.focus();
        return document.activeElement === el;
      });
      check('the seam takes the focus', focused);
      if (focused) {
        await page.keyboard.press('Enter');
        await settle(page, 300);
        const menu = await page.evaluate(
          () => String(document.body.textContent).indexOf('Insert prose') >= 0);
        check('Enter on the seam opens the insert menu', menu);
        await page.keyboard.press('Escape');
        await settle(page, 250);
      }
    }

    /* ---- 2. Delete with a card genuinely selected ---- */

    section('Delete with a card genuinely selected');
    const head = await cardHeadBox(page, TABLE_ID);
    if (!head) {
      check('the table card has a head to press', false, 'no .rw-card__head');
    } else {
      await realClick(page, head);
      await page.screenshot({ path: path.join(shots, '3-card-selected.png') });
      const marked = await page.evaluate((id) => {
        const slot = document.querySelector('[data-block-id="' + id + '"]');
        const card = slot && slot.querySelector('.rw-card');
        return !!(card && card.classList.contains('rw-card--selected'));
      }, TABLE_ID);
      check('pressing the card head selects the card', marked,
        'the card does not draw as selected');

      await page.keyboard.press('Delete');
      await settle(page, 500);
      await flushSave(page);
      const after = await waitForBlocks(reportsRoot, (b) => b.length === 1, 2000);
      console.log('  on disk after  : ' + blockShape(after));
      check('Delete on a selected card deletes the card',
        after.length === 1 && after[0] && after[0].type === 'para',
        'the section now reads: ' + blockShape(after));
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
