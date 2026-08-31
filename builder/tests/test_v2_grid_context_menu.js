#!/usr/bin/env node
'use strict';
/*
 * test_v2_grid_context_menu.js -- who owns a right-click on the table grid,
 * driven with a real mouse in a real browser.
 *
 * Run:  node builder/tests/test_v2_grid_context_menu.js
 *       node builder/tests/test_v2_grid_context_menu.js --headed
 *
 * WHY THIS FILE EXISTS
 *   js/views/table.js hangs onContextMenu on the grid host and used to
 *   preventDefault unconditionally, then open the row/column menu -- without
 *   ever asking the grid control whether one of its cells was being edited.
 *   Double-click a cell, right-click inside the open editor, and the table menu
 *   appeared instead of the browser's edit menu: no Paste, no Select all, no
 *   Undo, and every entry on the menu that did appear acted on the ROW, not on
 *   the text under the caret.
 *
 *   The same right-click also threw. The handler moved the active cell to the
 *   td under the pointer, which closes the open editor and detaches its node;
 *   the control's own document-level contextmenu listener then ran getRole() on
 *   that detached target, walked parentElement past the document and read
 *   .classList of null. The global error trap turned that into a banner saying
 *   something was broken, when the real answer was "this menu does not apply
 *   here".
 *
 * WHAT IT ASSERTS, all of it with mouse.dblclick / mouse.click({button:'right'})
 *   1. right-clicking inside an OPEN cell editor opens no table menu, throws
 *      nothing, and leaves the editor open;
 *   2. right-clicking a cell that is NOT being edited still opens the table
 *      menu;
 *   3. the menu's row entries act on the right ROW -- 'Setting row' on the row
 *      under the pointer, and on no other;
 *   4. the menu's column entries act on the right COLUMN -- 'Insert column'
 *      inside the first simulation group grows THAT group's axes and leaves
 *      the second group alone.
 *
 * Assertion 1 is the one with teeth: against the old handler it fails three
 * times over -- the table menu is on screen, the page error trap has caught a
 * TypeError, and the editor has been closed underneath the user.
 *
 * IT NEVER TOUCHES REAL REPORTS. The fixture is generated from scratch into the
 * OS temporary directory and the server is booted against THAT with --root.
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
 * the fixture
 * ------------------------------------------------------------------ */

const PROJECT_ID = '1108';
const MODULE_ID = 'CLKDIV_5G';
const REPORT_DIR = PROJECT_ID + '/' + MODULE_ID + '/CDR';

const SECTION = 'Simulation results';
const TABLE_ID = 'b-table-1';

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function row(cat, item, unit, kind, spec, pre, post) {
  return {
    cat: cat, item: item, unit: unit, kind: kind, limit: null, sim_span: false,
    spec: null, spec_mtm: spec || [null, null, null], spec_ntwc: null,
    sims: {
      pre: { mtm: pre || [null, null, null], ntwc: null },
      post: { mtm: post || [null, null, null], ntwc: null },
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
        id: 'n-results',
        title: SECTION,
        blocks: [
          {
            type: 'datatable', id: TABLE_ID, kind: 'compliance',
            caption: 'Divider performance',
            data: {
              spec_name: 'Spec',
              sims: [
                { key: 'pre', title: 'Schematic', stage: 'CDR', axes: ['MIN', 'TYP', 'MAX'] },
                { key: 'post', title: 'Extracted', stage: 'CDR', axes: ['MIN', 'TYP', 'MAX'] },
              ],
              rows: [
                row('Conditions', 'Supply', 'V', 'common_setting',
                  [null, '1.80', null], [null, '1.80', null], [null, '1.80', null]),
                row('Performance', 'Divided frequency', 'GHz', 'result',
                  ['4.8', '5.0', '5.2'], ['4.85', '5.01', '5.14'], ['4.83', '5.00', '5.16']),
                row('Performance', 'Duty cycle', '%', 'result',
                  ['45', '50', '55'], ['47.2', '49.8', '52.4'], ['46.9', '49.6', '52.8']),
                row('Performance', 'Current', 'mA', 'result',
                  [null, null, '4.0'], [null, null, '3.7'], [null, null, '3.9']),
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

const settle = (page, ms) => page.waitForTimeout(ms == null ? 350 : ms);

function readTable(reportsRoot) {
  const file = path.join(reportsRoot, ...REPORT_DIR.split('/'), 'project.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const blocks = ((doc.outline || [])[0] || {}).blocks || [];
  const block = blocks.filter((b) => b && b.id === TABLE_ID)[0];
  return block ? block.data : null;
}

async function waitForTable(reportsRoot, predicate, timeoutMs) {
  const until = Date.now() + (timeoutMs == null ? 4000 : timeoutMs);
  for (;;) {
    const data = readTable(reportsRoot);
    if (data && predicate(data)) return data;
    if (Date.now() > until) return data;
    await new Promise((r) => setTimeout(r, 200));
  }
}

// The centre of one grid cell, addressed the way the grid addresses it.
const cellBox = (page, x, y) => page.evaluate((at) => {
  const td = document.querySelector(
    'td[data-x="' + at.x + '"][data-y="' + at.y + '"]');
  if (!td) return null;
  const box = td.getBoundingClientRect();
  if (box.width < 8 || box.height < 6) return null;
  if (box.left < 0 || box.top < 0) return null;
  if (box.right > window.innerWidth || box.bottom > window.innerHeight) return null;
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  // The grid scrolls horizontally inside itself, so a cell can have a sane
  // client rect and still be clipped out of sight. Only a cell the pointer
  // would really land on counts.
  const hit = document.elementFromPoint(cx, cy);
  if (!hit || (hit !== td && !td.contains(hit))) return null;
  return { cx: cx, cy: cy };
}, { x: x, y: y });

// Every column index the grid actually drew, in order.
const columnPlan = (page) => page.evaluate(() => {
  const cells = Array.from(document.querySelectorAll('td[data-x][data-y]'));
  const seen = new Set();
  for (const td of cells) seen.add(Number(td.getAttribute('data-x')));
  return Array.from(seen).sort((a, b) => a - b);
});

const menuLabels = (page) => page.evaluate(() => Array.from(
  document.querySelectorAll('.rw-menu .rw-menu__label')
).map((el) => String(el.textContent || '').trim()));

// Is one of the control's cells being edited? Asked of the DOM the control
// leaves behind, not of a list of element types.
const editorOpen = (page) => page.evaluate(() => {
  if (document.querySelector('td.editor')) return true;
  const active = document.activeElement;
  if (active && active.closest && active.closest('td[data-x]')
      && (active.isContentEditable || active.tagName === 'INPUT'
          || active.tagName === 'TEXTAREA')) return true;
  return !!document.querySelector('td[data-x] input, td[data-x] textarea,'
    + ' td[data-x] [contenteditable="true"]');
});

async function clickMenuItem(page, label) {
  const box = await page.evaluate((wanted) => {
    const items = Array.from(document.querySelectorAll('.rw-menu .rw-menu__item'));
    for (const item of items) {
      const own = item.querySelector('.rw-menu__label');
      const text = String((own || item).textContent || '').replace(/\s+/g, ' ').trim();
      if (text !== wanted) continue;
      const r = item.getBoundingClientRect();
      return {
        cx: r.left + r.width / 2, cy: r.top + r.height / 2,
        off: !!(item.disabled || item.classList.contains('rw-menu__item--disabled')),
      };
    }
    return null;
  }, label);
  if (!box) return false;
  if (box.off) return false;
  await page.mouse.click(box.cx, box.cy);
  await settle(page, 300);
  return true;
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
  const scratch = path.join(os.tmpdir(), 'report-workbench-v2-grid-menu', stamp);
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
    const pageErrors = [];
    const consoleErrors = [];
    page.on('console', (msg) => {
      const where = msg.location && msg.location() ? String(msg.location().url) : '';
      if (msg.type() === 'error' && where.indexOf('favicon') < 0) {
        consoleErrors.push(msg.text().slice(0, 200));
      }
    });
    page.on('pageerror', (err) => pageErrors.push(String(err && err.message)));

    const editorUrl = base + '/#/r/' + REPORT_DIR.split('/').map(encodeURIComponent).join('/');
    await page.goto(editorUrl, { waitUntil: 'load' });
    await settle(page, 1400);
    await clickText(page, SECTION);
    await settle(page, 900);

    const plan = await columnPlan(page);
    console.log('  the grid drew columns ' + JSON.stringify(plan));
    if (!plan.length) {
      check('the compliance grid rendered cells', false, 'no td[data-x][data-y] on screen');
      await page.screenshot({ path: path.join(shots, 'no-grid.png') });
      await context.close();
      return;
    }

    // Column 0 is '#', 1 is Category, 2 is Item. Item is a plain text column
    // and is always on screen, so it is where a cell editor gets opened.
    const ITEM_X = 2;

    /* ---- 1. right-click inside an OPEN cell editor ---- */

    section('right-click inside an open cell editor');
    const itemCell = await cellBox(page, ITEM_X, 2);
    if (!itemCell) {
      check('there is an Item cell to edit', false, 'no cell at x=' + ITEM_X + ', y=2');
    } else {
      await page.mouse.dblclick(itemCell.cx, itemCell.cy);
      await settle(page, 400);
      check('double-click opens the cell editor', await editorOpen(page),
        'no cell carries an open editor');

      pageErrors.length = 0;
      await page.mouse.click(itemCell.cx, itemCell.cy, { button: 'right' });
      await settle(page, 400);
      await page.screenshot({ path: path.join(shots, 'right-click-in-editor.png') });

      const labels = await menuLabels(page);
      check('right-clicking inside the editor opens NO table menu',
        labels.length === 0, 'the menu offered: ' + JSON.stringify(labels));
      check('right-clicking inside the editor throws nothing',
        pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
      check('the cell editor is still open after the right-click',
        await editorOpen(page), 'the editor was closed underneath the caret');

      await page.keyboard.press('Escape');
      await settle(page, 300);
    }

    /* ---- 2. right-click a cell that is NOT being edited ---- */

    section('right-click a cell that is not being edited');
    const plainCell = await cellBox(page, ITEM_X, 3);
    if (!plainCell) {
      check('there is a second Item cell to right-click', false, 'no cell at x=' + ITEM_X + ', y=3');
    } else {
      await page.mouse.click(plainCell.cx, plainCell.cy, { button: 'right' });
      await settle(page, 400);
      const labels = await menuLabels(page);
      await page.screenshot({ path: path.join(shots, 'right-click-idle.png') });
      check('right-clicking an idle cell still opens the table menu',
        labels.indexOf('Setting row') >= 0 && labels.indexOf('Result row') >= 0,
        'the menu offered: ' + JSON.stringify(labels));

      /* ---- 3. the row entries act on the row under the pointer ---- */

      const took = await clickMenuItem(page, 'Setting row');
      check('the menu offers Setting row', took);
      await page.keyboard.press('Control+s');
      const data = await waitForTable(reportsRoot,
        (d) => ((d.rows || [])[3] || {}).kind !== 'result');
      const kinds = ((data || {}).rows || []).map((r) => r.kind);
      check('Setting row acts on the right-clicked row, and on no other',
        kinds[3] && kinds[3] !== 'result' && kinds[1] === 'result' && kinds[2] === 'result',
        'row kinds are ' + JSON.stringify(kinds));
    }

    /* ---- 4. the column entries act on the column under the pointer ---- */

    section('right-click inside a simulation group');
    // The plan is  # | Category | Item | Limit | sep | spec MIN TYP MAX NTWC |
    // sep | pre MIN TYP MAX | sep | post MIN TYP MAX | sep | Unit, so index 10
    // is the MIN axis of the FIRST simulation group. Insert column there must
    // grow that group and leave the second one at three axes.
    const AXIS_X = 10;
    const axisCell = await cellBox(page, AXIS_X, 1);
    if (!axisCell) {
      check('there is an axis cell to right-click', false,
        'no cell on screen at x=' + AXIS_X + ', y=1');
    } else {
      await page.mouse.click(axisCell.cx, axisCell.cy, { button: 'right' });
      await settle(page, 400);
      const took = await clickMenuItem(page, 'Insert column');
      check('the menu offers Insert column on an axis cell', took,
        'the menu read ' + JSON.stringify(await menuLabels(page)));
      await page.keyboard.press('Control+s');
      const data = await waitForTable(reportsRoot,
        (d) => (((d.sims || [])[0] || {}).axes || []).length === 4);
      const axes = ((data || {}).sims || []).map((s) => (s.axes || []).length);
      check('Insert column grows the right-clicked group and no other',
        axes.length === 2 && axes[0] === 4 && axes[1] === 3,
        'axis counts are ' + JSON.stringify(axes));
    }

    if (consoleErrors.length) {
      check('no console errors', false, consoleErrors.slice(0, 4).join(' | '));
    } else {
      console.log('  [ok  ] no console errors');
    }
    if (pageErrors.length) {
      check('nothing threw during the run', false, pageErrors.slice(0, 4).join(' | '));
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
