#!/usr/bin/env node
'use strict';
/*
 * test_v2_grid_typing.js -- two spreadsheet reflexes the data grid owes its
 * user, driven with a real keyboard in a real browser.
 *
 * 1. TYPING OVER A SELECTED CELL REPLACES IT.
 *    In every spreadsheet, a printable character pressed on a selected cell
 *    opens the editor EMPTY and puts that character in it. The grid had lost
 *    that: only F2 or a double-click opened an editor, so a value could not be
 *    replaced without a second gesture, and a whole column of numbers had to be
 *    typed twice as slowly as it reads.
 *
 * 2. THE LEADING COLUMNS STAY PUT WHILE THE REST SCROLLS.
 *    The three columns that say WHICH row this is (#, Category, Item) are
 *    frozen. A two-group table is wider than any window, so the moment a
 *    simulated value is on screen the row has nothing left naming it -- the
 *    number being typed belongs to a row whose name scrolled away.
 *
 * Run:  node builder/tests/test_v2_grid_typing.js
 *       node builder/tests/test_v2_grid_typing.js --headed
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
const VIEWPORT = { width: 1280, height: 900 };

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

/* The column plan this fixture produces:
 *
 *   0 #   1 Category   2 Item   3 Limit
 *   4 sep   5..7  spec MIN TYP MAX
 *   8 sep   9..11 pre  MIN TYP MAX
 *  12 sep  13..15 post MIN TYP MAX
 *  16 sep  17 Unit                                                     */
const X = { item: 2, limit: 3, specMax: 7, postMax: 15 };

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function row(cat, item, unit, kind, limit, spec, pre, post) {
  return {
    cat: cat, item: item, unit: unit, kind: kind, limit: limit, sim_span: false,
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
      reviewers: [], approver: '', revisions: [],
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
                row('Conditions', 'Supply', 'V', 'common_setting', null,
                  [null, '1.80', null], [null, '1.80', null], [null, '1.80', null]),
                row('Performance', 'Divided frequency', 'GHz', 'result', 'le',
                  ['4.8', '5.0', '5.2'], ['4.85', '5.01', '5.14'], ['4.83', '5.00', '5.10']),
                row('Performance', 'Duty cycle', '%', 'result', null,
                  ['45', '50', '55'], ['47.2', '49.8', '52.4'], ['46.9', '49.6', '52.8']),
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
  let doc = null;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return null;   // mid-write; the caller polls
  }
  const blocks = ((doc.outline || [])[0] || {}).blocks || [];
  const block = blocks.filter((b) => b && b.id === TABLE_ID)[0];
  return block ? block.data : null;
}

async function waitForTable(reportsRoot, predicate, timeoutMs) {
  const until = Date.now() + (timeoutMs == null ? 6000 : timeoutMs);
  for (;;) {
    const data = readTable(reportsRoot);
    if (data && predicate(data)) return data;
    if (Date.now() > until) return data;
    await new Promise((r) => setTimeout(r, 200));
  }
}

const cellBox = (page, x, y) => page.evaluate((at) => {
  const td = document.querySelector(
    'td[data-x="' + at.x + '"][data-y="' + at.y + '"]');
  if (!td) return null;
  const box = td.getBoundingClientRect();
  if (box.width < 4 || box.height < 6) return null;
  if (box.left < 0 || box.top < 0) return null;
  if (box.right > window.innerWidth || box.bottom > window.innerHeight) return null;
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  const hit = document.elementFromPoint(cx, cy);
  if (!hit || (hit !== td && !td.contains(hit))) return null;
  return { cx: cx, cy: cy };
}, { x: x, y: y });

const cellText = (page, x, y) => page.evaluate((at) => {
  const td = document.querySelector(
    'td[data-x="' + at.x + '"][data-y="' + at.y + '"]');
  return td ? String(td.textContent || '').trim() : null;
}, { x: x, y: y });

const cellLeft = (page, x, y) => page.evaluate((at) => {
  const td = document.querySelector(
    'td[data-x="' + at.x + '"][data-y="' + at.y + '"]');
  if (!td) return null;
  return Math.round(td.getBoundingClientRect().left);
}, { x: x, y: y });

// Where the header cell of one column sits, read the way the control's own
// freeze code addresses it: thead, same column index.
const headLeft = (page, x) => page.evaluate((at) => {
  const heads = document.querySelectorAll('.rw-grid .jss_worksheet > thead > tr');
  for (let r = heads.length - 1; r >= 0; r--) {
    const cell = heads[r].querySelector('td[data-x="' + at.x + '"]');
    if (cell) return Math.round(cell.getBoundingClientRect().left);
  }
  return null;
}, { x: x });

const editorOpen = (page) => page.evaluate(() => !!(
  document.querySelector('td.editor')
  || document.querySelector('td[data-x] input, td[data-x] textarea,'
    + ' td[data-x] [contenteditable="true"]')));

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
  const scratch = path.join(os.tmpdir(), 'report-workbench-v2-grid-typing', stamp);
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
    page.on('pageerror', (err) => pageErrors.push(String(err && err.message)));
    page.on('dialog', (d) => d.dismiss().catch(() => {}));

    const editorUrl = base + '/#/r/' + REPORT_DIR.split('/').map(encodeURIComponent).join('/');
    await page.goto(editorUrl, { waitUntil: 'load' });
    await settle(page, 1400);
    await clickText(page, SECTION);
    await settle(page, 900);

    const drew = await page.evaluate(() => !!document.querySelector('td[data-x][data-y]'));
    if (!drew) {
      check('the compliance grid rendered cells', false, 'no td[data-x][data-y] on screen');
      await page.screenshot({ path: path.join(shots, 'no-grid.png') });
      await context.close();
      return;
    }

    /* ---- 1. type over a selected cell ---- */

    section('typing on a selected cell replaces what was in it');
    const target = await cellBox(page, X.specMax, 1);
    if (!target) {
      check('there is a numeric cell to type into', false,
        'no cell at x=' + X.specMax + ', y=1');
    } else {
      await page.mouse.click(target.cx, target.cy);
      await settle(page, 250);
      check('a single click selects without opening an editor', !(await editorOpen(page)),
        'an editor was already open before anything was typed');

      await page.keyboard.type('4.2', { delay: 40 });
      await settle(page, 200);
      check('the first character opens the cell editor', await editorOpen(page),
        'nothing opened: the keystroke went nowhere');

      await page.keyboard.press('Enter');
      await settle(page, 400);
      check('the cell on screen holds what was typed',
        (await cellText(page, X.specMax, 1)) === '4.2',
        'the cell reads ' + JSON.stringify(await cellText(page, X.specMax, 1)));

      // A numeric column stores a number; what matters is that it is the value
      // that was typed and not the one that was there.
      const same = (v) => String(v) === '4.2';
      const saved = await waitForTable(reportsRoot,
        (d) => same((((d.rows || [])[1] || {}).spec_mtm || [])[2]));
      check('and the typed value is what reaches the file',
        same(((((saved || {}).rows || [])[1] || {}).spec_mtm || [])[2]),
        'row 1 spec_mtm on disk is '
          + JSON.stringify((((saved || {}).rows || [])[1] || {}).spec_mtm));
    }

    // The column that shows it REPLACES rather than appends: a word, typed over
    // by another word. A cell editor opened on the old content instead of an
    // empty one reads 'Divided frequencyDuty' and looks like it worked.
    const wordCell = await cellBox(page, X.item, 1);
    if (!wordCell) {
      check('there is a text cell to type into', false, 'no cell at x=' + X.item + ', y=1');
    } else {
      await page.mouse.click(wordCell.cx, wordCell.cy);
      await settle(page, 250);
      await page.keyboard.type('Duty', { delay: 40 });
      await page.keyboard.press('Enter');
      await settle(page, 400);
      const saved = await waitForTable(reportsRoot,
        (d) => ((d.rows || [])[1] || {}).item === 'Duty');
      check('typing over a word replaces it rather than appending to it',
        (((saved || {}).rows || [])[1] || {}).item === 'Duty',
        'row 1 item on disk is '
          + JSON.stringify((((saved || {}).rows || [])[1] || {}).item));
    }

    /* ---- 1b. the gestures that were already there still work ---- */

    section('the gestures around it are unchanged');
    const second = await cellBox(page, X.specMax, 2);
    if (second) {
      await page.mouse.dblclick(second.cx, second.cy);
      await settle(page, 300);
      check('a double-click still opens the editor', await editorOpen(page),
        'no editor after a double-click');
      await page.keyboard.press('Escape');
      await settle(page, 200);

      await page.mouse.click(second.cx, second.cy);
      await settle(page, 200);
      await page.keyboard.press('Delete');
      await settle(page, 400);
      const cleared = await waitForTable(reportsRoot,
        (d) => (((d.rows || [])[2] || {}).spec_mtm || [])[2] === null
          || (((d.rows || [])[2] || {}).spec_mtm || [])[2] === '');
      const value = ((((cleared || {}).rows || [])[2] || {}).spec_mtm || [])[2];
      check('Delete still clears a selected cell', value === null || value === '',
        'row 2 spec MAX on disk is ' + JSON.stringify(value));
    }

    /* ---- 2. the leading columns stay put ---- */

    section('the leading columns stay put while the rest scrolls');
    const beforeItem = await cellLeft(page, X.item, 1);
    const beforeLoose = await cellLeft(page, X.postMax, 1);
    const beforeHead = await headLeft(page, X.item);

    // A SMALL scroll first. The control only pins its frozen columns once the
    // body has moved more than fifty pixels, so the first half-inch of every
    // sideways scroll dragged the row's name off the left edge and then snapped
    // it back -- the one part of the gesture the eye is actually following.
    const nudged = await page.evaluate(() => {
      const content = document.querySelector('.rw-grid .jss_content');
      if (!content) return null;
      content.scrollLeft = 40;
      content.dispatchEvent(new Event('scroll'));
      return content.scrollLeft;
    });
    await settle(page, 300);
    if (nudged === 40) {
      const nudgedItem = await cellLeft(page, X.item, 1);
      check('a small sideways scroll does not drag the Item column with it',
        beforeItem != null && nudgedItem != null
          && Math.abs(nudgedItem - beforeItem) <= 2,
        'x was ' + beforeItem + 'px and is ' + nudgedItem + 'px after 40px of scrolling');
      const nudgedHead = await headLeft(page, X.item);
      check('nor its name with it',
        beforeHead != null && nudgedHead != null
          && Math.abs(nudgedHead - beforeHead) <= 2,
        'the header was at ' + beforeHead + 'px and is at ' + nudgedHead + 'px');
    }

    const scrolled = await page.evaluate(() => {
      const content = document.querySelector('.rw-grid .jss_content');
      if (!content) return null;
      content.scrollLeft = content.scrollWidth;
      content.dispatchEvent(new Event('scroll'));
      return content.scrollLeft;
    });
    await settle(page, 400);
    if (!scrolled || scrolled < 60) {
      check('the grid can be scrolled sideways', false,
        'the grid body did not move: scrollLeft is ' + JSON.stringify(scrolled));
    } else {
      const afterItem = await cellLeft(page, X.item, 1);
      const afterLoose = await cellLeft(page, X.postMax, 1);
      check('the Item column is still where it was',
        beforeItem != null && afterItem != null && Math.abs(afterItem - beforeItem) <= 2,
        'x was ' + beforeItem + 'px, is now ' + afterItem + 'px after '
          + scrolled + 'px of scrolling');
      // The control assertion: the columns that are NOT frozen did move, so the
      // one above is a frozen column and not a grid that failed to scroll.
      check('the columns behind it did move',
        beforeLoose != null && afterLoose != null
          && Math.abs(afterLoose - beforeLoose) > 20,
        'the last group\'s MAX was at ' + beforeLoose + 'px and is at ' + afterLoose + 'px');
      const afterHead = await headLeft(page, X.item);
      check('the Item column KEEPS ITS NAME: the header stays with the cells',
        beforeHead != null && afterHead != null && Math.abs(afterHead - beforeHead) <= 2,
        'the header was at ' + beforeHead + 'px and is at ' + afterHead + 'px');
      const froze = await page.evaluate(
        () => document.querySelectorAll('.rw-grid td.jss_freezed').length);
      check('the control marks the frozen cells as frozen', froze > 0,
        'no cell carries jss_freezed');
      await page.screenshot({ path: path.join(shots, 'scrolled-right.png') });
    }

    check('no uncaught error was raised in the page', pageErrors.length === 0,
      pageErrors.slice(0, 3).join(' | '));
    await context.close();
  } finally {
    await cleanup();
  }
}

async function main() {
  console.log('grid typing and frozen columns');
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
  console.log('grid typing: all checks passed');
  return 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
