#!/usr/bin/env node
'use strict';
/*
 * test_v2_table_editor.js -- the table surface, driven with a real mouse and a
 * real keyboard in a real browser.
 *
 * Run:  node builder/tests/test_v2_table_editor.js
 *       node builder/tests/test_v2_table_editor.js --headed
 *
 * WHAT IT ASSERTS, and what each assertion is there to stop coming back
 *
 * 1. AN OPEN CELL EDITOR IS PART OF THE DOCUMENT.
 *    A value typed into a cell lives inside the grid control until its edition
 *    closes, and nothing outside the control knows it exists. So Ctrl+S wrote a
 *    file without it and the chrome still read `Saved HH:MM`, and a keyboard
 *    move to another section tore the grid host down and took the value with
 *    it, silently. Both paths are asserted against the file on disk.
 *
 * 2. A ROW THAT CANNOT BE JUDGED SAYS SO.
 *    The note under the grid said `No limit set` while the limit was blank and
 *    then went quiet the moment one was chosen -- even when the bound that
 *    limit compares against is empty, which leaves the row exactly as
 *    unflaggable as before and looking exactly like a row that passed.
 *
 * 3. A RED CELL SAYS WHY.
 *    The value, the bound it broke and the limit that condemned it, on the cell
 *    and on the note line.
 *
 * 4. ARROW KEYS DO NOT STOP ON THE SEPARATOR COLUMNS.
 *    The 10px column between two groups holds nothing and takes nothing; the
 *    walk from the spec block to the first simulated value used to stop on it,
 *    and anything typed there vanished with no feedback.
 *
 * 5. A SPREADSHEET CAN BE IMPORTED INTO A TABLE.
 *    The server has parsed .xlsx since before this interface existed and the
 *    old editor called it; nothing in v2 did. The rows land like a paste --
 *    growing the table to fit, one undo step, one toast.
 *
 * 6. THE REFERENCE-COLUMN DIALOG OPENS ON A SOURCE THAT LOADS.
 *    It defaulted to the newest sibling report, which is also the one most
 *    likely to be half-written; when that one could not be parsed the dialog
 *    opened on a raw parser message with nothing selectable.
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
const { spawn, spawnSync } = require('node:child_process');

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
const HEALTHY_SIBLING = PROJECT_ID + '/' + MODULE_ID + '/PDR';
const BROKEN_SIBLING = PROJECT_ID + '/' + MODULE_ID + '/FDR';

const SECTION = 'Simulation results';
const SECOND_SECTION = 'Notes';
const TABLE_ID = 'b-table-1';

/* The column plan this fixture produces, and every index used below:
 *
 *   0 #   1 Category   2 Item   3 Limit
 *   4 sep   5..8  spec MIN TYP MAX NTWC
 *   9 sep   10..12 pre  MIN TYP MAX
 *  13 sep   14..16 post MIN TYP MAX
 *  17 sep   18 Unit                                                        */
const X = {
  item: 2, limit: 3, specMax: 7, specNtwc: 8, sepBeforePre: 9,
  preMin: 10, postMax: 16,
};

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
                // 0 -- a setting row: never judged, never noted.
                row('Conditions', 'Supply', 'V', 'common_setting', null,
                  [null, '1.80', null], [null, '1.80', null], [null, '1.80', null]),
                // 1 -- judged, and the post group breaks the spec MAX.
                row('Performance', 'Divided frequency', 'GHz', 'result', 'le',
                  ['4.8', '5.0', '5.2'], ['4.85', '5.01', '5.14'], ['4.83', '5.00', '5.30']),
                // 2 -- no limit at all: 'No limit set'.
                row('Performance', 'Duty cycle', '%', 'result', null,
                  ['45', '50', '55'], ['47.2', '49.8', '52.4'], ['46.9', '49.6', '52.8']),
                // 3 -- a limit with NOTHING to compare it against.
                row('Performance', 'Settling', 'ns', 'result', 'le',
                  [null, null, null], [null, null, '12'], [null, null, '13']),
              ],
            },
          },
        ],
        children: [],
      },
      {
        id: 'n-notes',
        title: SECOND_SECTION,
        blocks: [
          { type: 'para', id: 'b-para-1', cardStart: true, runs: [{ t: 'Nothing yet.' }] },
          // Exactly one result row, which is what makes '1 result rows' visible.
          {
            type: 'datatable', id: 'b-table-2', kind: 'compliance', caption: 'Summary',
            data: {
              spec_name: 'Spec',
              sims: [{ key: 'sim', title: 'Schematic', stage: 'CDR', axes: ['MIN', 'TYP', 'MAX'] }],
              rows: [
                row('Conditions', 'Supply', 'V', 'common_setting', null,
                  [null, '1.80', null], [null, '1.80', null], null),
                row('Performance', 'Divided frequency', 'GHz', 'result', 'le',
                  ['4.8', '5.0', '5.2'], ['4.85', '5.01', '5.14'], null),
              ],
            },
          },
        ],
        children: [],
      },
    ],
  };
}

// A second, healthy report in the same module, so the reference-column dialog
// has somewhere to land.
function siblingReport() {
  return {
    template: 'sample',
    meta: {
      title: MODULE_ID + ' PDR report', doc_no: 'DOC-0', version: 'V0.9',
      secrecy: 'Internal', author: 'A. Engineer', date: '2026-06-01',
      reviewers: [], approver: '', revisions: [],
    },
    outline: [
      {
        id: 'n-results',
        title: SECTION,
        blocks: [
          {
            type: 'datatable', id: 'b-table-9', kind: 'compliance',
            caption: 'Divider performance',
            data: {
              spec_name: 'Spec',
              sims: [{ key: 'sim', title: 'Schematic', stage: 'PDR', axes: ['MIN', 'TYP', 'MAX'] }],
              rows: [
                row('Performance', 'Divided frequency', 'GHz', 'result', 'le',
                  ['4.8', '5.0', '5.2'], ['4.9', '5.05', '5.18'], null),
                row('Performance', 'Duty cycle', '%', 'result', null,
                  ['45', '50', '55'], ['48', '50.2', '52'], null),
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
    skeleton: [{ title: SECTION, children: [] }, { title: SECOND_SECTION, children: [] }],
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

/* The spreadsheet the import test feeds in: the three-row header band the
 * renderer writes (group titles, stages, axis labels), then six data rows --
 * two more than the table has, so the paste-shaped growth is exercised too.
 * Built with the same openpyxl the server parses it with. */
const IMPORT_SHEET = [
  ['', '', 'Spec', '', '', '', 'Schematic', '', '', '', 'Extracted', '', '', ''],
  ['', '', '', '', '', '', 'CDR', '', '', '', 'CDR', '', '', ''],
  ['Category', 'Item', 'MIN', 'TYP', 'MAX', '', 'MIN', 'TYP', 'MAX', '',
    'MIN', 'TYP', 'MAX', 'Unit'],
  ['Conditions', 'Supply', '', 1.8, '', '', '', 1.8, '', '', '', 1.8, '', 'V'],
  ['Performance', 'Divided frequency', 4.8, 5.0, 5.2, '', 4.9, 5.02, 5.15, '',
    4.88, 5.03, 5.18, 'GHz'],
  ['Performance', 'Duty cycle', 45, 50, 55, '', 47, 49.9, 52, '', 46, 49.5, 53, '%'],
  ['Performance', 'Settling', '', '', 20, '', '', '', 11, '', '', '', 13, 'ns'],
  ['Performance', 'Jitter', '', '', 300, '', '', '', 214, '', '', '', 231, 'fs'],
  ['Performance', 'Current', '', '', 4.0, '', '', '', 3.7, '', '', '', 3.9, 'mA'],
];

function buildImportSheet(target) {
  const python = process.env.RW_PYTHON || 'python';
  const script = [
    'import json, sys',
    'try:',
    '    import openpyxl',
    'except Exception as exc:',
    '    print("NO-OPENPYXL " + str(exc))',
    '    sys.exit(0)',
    'rows = json.loads(sys.argv[1])',
    'wb = openpyxl.Workbook()',
    'ws = wb.active',
    'for line in rows:',
    '    ws.append([None if c == "" else c for c in line])',
    'wb.save(sys.argv[2])',
    'print("OK")',
  ].join('\n');
  const done = spawnSync(python, ['-c', script, JSON.stringify(IMPORT_SHEET), target],
    { encoding: 'utf8' });
  const out = String((done.stdout || '') + (done.stderr || '')).trim();
  return out.indexOf('OK') === 0 ? '' : (out || 'the spreadsheet could not be written');
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

  const healthy = path.join(root, ...HEALTHY_SIBLING.split('/'));
  writeJson(path.join(healthy, 'project.json'), siblingReport());

  // The sibling the dialog would open on: newest, and unparseable. The tree
  // still lists it (it is read quietly), so it is still offered as a source.
  const broken = path.join(root, ...BROKEN_SIBLING.split('/'));
  fs.mkdirSync(broken, { recursive: true });
  fs.writeFileSync(path.join(broken, 'project.json'), '{ "outline": [ , ]', 'utf8');
  const now = Date.now() / 1000;
  fs.utimesSync(path.join(broken, 'project.json'), now, now);
  fs.utimesSync(path.join(healthy, 'project.json'), now - 600, now - 600);
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

const editorOpen = (page) => page.evaluate(() => !!(
  document.querySelector('td.editor')
  || document.querySelector('td[data-x] input, td[data-x] textarea,'
    + ' td[data-x] [contenteditable="true"]')));

// Which column the grid says is selected, read from the control's own classes.
const selectedX = (page) => page.evaluate(() => {
  const one = document.querySelector('td.highlight-selected[data-x]')
    || document.querySelector('td.highlight[data-x]');
  return one ? Number(one.getAttribute('data-x')) : null;
});

const noteText = (page) => page.evaluate(() => {
  const el = document.querySelector('.rw-tblnote:not(.rw-tblnote--warn)');
  return el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : '';
});

const footText = (page) => page.evaluate(() => {
  const el = document.querySelector('.rw-grid__foot');
  return el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : '';
});

const toastText = (page) => page.evaluate(() => {
  const el = document.querySelector('.rw-toast__text');
  return el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : '';
});

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

// Type into an already-open cell editor: select everything, then the new text.
async function typeInEditor(page, text) {
  await page.keyboard.press('Control+a');
  await page.keyboard.type(text, { delay: 12 });
}

/* ------------------------------------------------------------------ *
 * the run
 * ------------------------------------------------------------------ */

async function browserChecks() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const scratch = path.join(os.tmpdir(), 'report-workbench-v2-table-editor', stamp);
  const reportsRoot = path.join(scratch, 'reports');
  const shots = path.join(scratch, 'screens');
  fs.mkdirSync(shots, { recursive: true });
  buildReportsRoot(reportsRoot);
  const sheetPath = path.join(scratch, 'results.xlsx');
  const sheetProblem = buildImportSheet(sheetPath);
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
      if (msg.type() !== 'error') return;
      if (where.indexOf('favicon') >= 0) return;
      // The fixture deliberately holds ONE unreadable report, and the request
      // for it is the thing being tested: the browser logs that failed fetch
      // whatever the page then does about it.
      if (where.indexOf('FDR') >= 0 || where.indexOf('%2FFDR') >= 0) return;
      consoleErrors.push(msg.text().slice(0, 200) + '  <- ' + where);
    });
    page.on('pageerror', (err) => pageErrors.push(String(err && err.message)));
    // Nothing here should raise a browser dialog; if something does, dismiss it
    // rather than hanging the run.
    page.on('dialog', (d) => d.dismiss().catch(() => {}));

    const editorUrl = base + '/#/r/' + REPORT_DIR.split('/').map(encodeURIComponent).join('/');
    const openReport = async () => {
      await page.goto(editorUrl, { waitUntil: 'load' });
      await settle(page, 1400);
      await clickText(page, SECTION);
      await settle(page, 900);
    };
    await openReport();

    const drew = await page.evaluate(() => !!document.querySelector('td[data-x][data-y]'));
    if (!drew) {
      check('the compliance grid rendered cells', false, 'no td[data-x][data-y] on screen');
      await page.screenshot({ path: path.join(shots, 'no-grid.png') });
      await context.close();
      return;
    }

    /* ---- 1a. Ctrl+S over an open cell editor ---- */

    section('an open cell editor is part of the document');
    const cell2 = await cellBox(page, X.item, 2);
    if (!cell2) {
      check('there is an Item cell to edit', false, 'no cell at x=' + X.item + ', y=2');
    } else {
      await page.mouse.dblclick(cell2.cx, cell2.cy);
      await settle(page, 400);
      check('double-click opens the cell editor', await editorOpen(page),
        'no cell carries an open editor');
      await typeInEditor(page, 'Duty ratio');
      await page.screenshot({ path: path.join(shots, 'editor-open-before-save.png') });

      await page.keyboard.press('Control+s');
      const saved = await waitForTable(reportsRoot,
        (d) => ((d.rows || [])[2] || {}).item === 'Duty ratio');
      check('Ctrl+S writes the value the open cell editor is holding',
        ((saved || {}).rows || [])[2] && saved.rows[2].item === 'Duty ratio',
        'row 2 item on disk is ' + JSON.stringify(((saved || {}).rows || [])[2] || {}).slice(0, 120));

      await openReport();
      const afterReload = readTable(reportsRoot) || {};
      check('the value is still there after a reload',
        ((afterReload.rows || [])[2] || {}).item === 'Duty ratio',
        'row 2 item on disk is ' + JSON.stringify(((afterReload.rows || [])[2] || {}).item));
    }

    /* ---- 1b. a keyboard move to another section ---- */

    const cell3 = await cellBox(page, X.item, 3);
    if (!cell3) {
      check('there is a second Item cell to edit', false, 'no cell at x=' + X.item + ', y=3');
    } else {
      await page.mouse.dblclick(cell3.cx, cell3.cy);
      await settle(page, 400);
      await typeInEditor(page, 'Settling time');
      await page.keyboard.press('Alt+ArrowDown');   // the next section
      await settle(page, 600);
      const moved = await waitForTable(reportsRoot,
        (d) => ((d.rows || [])[3] || {}).item === 'Settling time');
      check('a keyboard move to another section keeps the open cell editor',
        ((moved || {}).rows || [])[3] && moved.rows[3].item === 'Settling time',
        'row 3 item on disk is ' + JSON.stringify(((moved || {}).rows || [])[3] || {}).slice(0, 120));
      await openReport();
    }

    /* ---- 2. a row with a limit and nothing to compare it against ---- */

    section('a row that cannot be judged says so');
    const noLimit = await cellBox(page, X.item, 2);
    if (noLimit) {
      await page.mouse.click(noLimit.cx, noLimit.cy);
      await settle(page, 300);
      const text = await noteText(page);
      check('a row with no limit still says it is never marked over spec',
        text.indexOf('No limit set') >= 0, 'the note read ' + JSON.stringify(text));
    }
    const noBound = await cellBox(page, X.item, 3);
    if (!noBound) {
      check('there is a row to select', false, 'no cell at x=' + X.item + ', y=3');
    } else {
      await page.mouse.click(noBound.cx, noBound.cy);
      await settle(page, 300);
      const text = await noteText(page);
      await page.screenshot({ path: path.join(shots, 'limit-without-a-bound.png') });
      check('a limit with no spec bound says which bound is missing',
        text.indexOf('spec MAX') >= 0 && text.indexOf('never marked over spec') >= 0,
        'the note read ' + JSON.stringify(text));
    }

    /* ---- 3. a red cell says why ---- */

    section('a red cell says why');
    const why = await page.evaluate(() => {
      const el = document.querySelector('td.rw-grid__cell--overspec');
      return el ? String(el.getAttribute('title') || '') : null;
    });
    check('an over-spec cell carries the comparison as its tooltip',
      !!why && why.indexOf('>') > 0 && why.indexOf('spec MAX') > 0,
      'the tooltip read ' + JSON.stringify(why));

    const redCell = await cellBox(page, X.postMax, 1);
    if (redCell) {
      await page.mouse.click(redCell.cx, redCell.cy);
      await settle(page, 300);
      const text = await noteText(page);
      check('the note line names the comparison for the selected red cell',
        text.indexOf('spec MAX') >= 0 && text.indexOf('>') >= 0,
        'the note read ' + JSON.stringify(text));
    } else {
      console.log('  [note] the over-spec cell is off screen; the tooltip check stands alone');
    }

    /* ---- 4. arrow keys and the separator columns ---- */

    section('arrow keys do not stop on the separator columns');
    const walkFrom = await cellBox(page, X.specNtwc, 1);
    if (!walkFrom) {
      check('there is a cell to walk from', false, 'no cell at x=' + X.specNtwc + ', y=1');
    } else {
      await page.mouse.click(walkFrom.cx, walkFrom.cy);
      await settle(page, 250);
      check('the walk starts on the last spec axis', await selectedX(page) === X.specNtwc,
        'the selected column is ' + await selectedX(page));
      await page.keyboard.press('ArrowRight');
      await settle(page, 250);
      const landed = await selectedX(page);
      check('one press crosses the separator into the first simulation column',
        landed === X.preMin, 'the arrow landed on column ' + landed);
      await page.keyboard.press('ArrowLeft');
      await settle(page, 250);
      const back = await selectedX(page);
      check('and one press back crosses it again', back === X.specNtwc,
        'the arrow landed on column ' + back);
    }

    const sepCell = await cellBox(page, X.sepBeforePre, 1);
    if (sepCell) {
      await page.mouse.click(sepCell.cx, sepCell.cy);
      await settle(page, 250);
      const landed = await selectedX(page);
      check('clicking a separator puts the cursor on a cell that can be typed into',
        landed !== X.sepBeforePre, 'the cursor stayed on the separator (column ' + landed + ')');
    }

    /* ---- 5. counts read like a person wrote them ---- */

    section('counts read like a person wrote them');
    const foot = await footText(page);
    check('a table with several result rows says rows',
      foot.indexOf('3 result rows') >= 0, 'the footer read ' + JSON.stringify(foot));
    await clickText(page, SECOND_SECTION);
    await settle(page, 900);
    const oneFoot = await footText(page);
    check('a table with one result row says row, not rows',
      oneFoot.indexOf('1 result row') >= 0 && oneFoot.indexOf('1 result rows') < 0,
      'the footer read ' + JSON.stringify(oneFoot));
    await clickText(page, SECTION);
    await settle(page, 900);

    /* ---- 6. the reference-column dialog ---- */

    section('the reference-column dialog opens on a source that loads');
    const opened = await clickText(page, 'Add a reference column');
    if (!opened) {
      check('the toolbar offers Add a reference column', false, 'no such control');
    } else {
      await settle(page, 1400);
      await page.screenshot({ path: path.join(shots, 'reference-column-dialog.png') });
      const state = await page.evaluate(() => {
        const fields = Array.from(document.querySelectorAll('.rw-field'));
        const find = (label) => {
          for (const f of fields) {
            const own = f.querySelector('.rw-field__label');
            if (own && String(own.textContent || '').trim() === label) {
              return f.querySelector('select');
            }
          }
          return null;
        };
        const source = find('Source report');
        const column = find('Which column');
        const banner = document.querySelector('.rw-refcol .rw-banner--blocking');
        return {
          source: source ? source.value : null,
          columns: column ? column.options.length : 0,
          banner: banner ? String(banner.textContent || '').replace(/\s+/g, ' ').trim() : '',
        };
      });
      check('the dialog opens on the sibling that can actually be read',
        state.source === HEALTHY_SIBLING,
        'Source report is ' + JSON.stringify(state.source));
      check('and it offers columns from it', state.columns > 0,
        'Which column holds ' + state.columns + ' entries');
      check('no raw parser message is on screen', state.banner === '',
        'the banner read ' + JSON.stringify(state.banner));
      await clickText(page, 'Cancel');
      await settle(page, 400);
    }

    /* ---- 7. importing a spreadsheet ---- */

    section('a spreadsheet can be imported into a table');
    if (sheetProblem) {
      console.log('  SKIP: ' + sheetProblem);
    } else {
      const input = await page.$('input[type="file"][accept=".xlsx"]');
      if (!input) {
        check('the table toolbar offers an .xlsx import', false,
          'no input[type=file][accept=".xlsx"] in the table card');
      } else {
        await input.setInputFiles(sheetPath);
        const grown = await waitForTable(reportsRoot,
          (d) => (d.rows || []).length >= 6
            && (((d.rows || [])[1] || {}).sims || {}).post
            && String(d.rows[1].sims.post.mtm[2]) === '5.18', 9000);
        const rows = (grown || {}).rows || [];
        check('the imported rows land in the table',
          rows.length >= 6 && String(((rows[1] || {}).sims || {}).post
            ? rows[1].sims.post.mtm[2] : '') === '5.18',
          'row 1 post MAX is ' + JSON.stringify(((rows[1] || {}).sims || {}).post || null)
            + ', ' + rows.length + ' rows');
        check('each group keeps its own values',
          rows[1] && String(rows[1].sims.pre.mtm[2]) === '5.15',
          'row 1 pre MAX is ' + JSON.stringify(((rows[1] || {}).sims || {}).pre || null));
        check('the import leaves the limit alone, which a spreadsheet cannot carry',
          rows[1] && rows[1].limit === 'le',
          'row 1 limit is ' + JSON.stringify((rows[1] || {}).limit));
        const said = await toastText(page);
        await page.screenshot({ path: path.join(shots, 'after-import.png') });
        check('the import reports itself the way a paste does',
          said.indexOf('Rows were added to fit') >= 0 || said.indexOf('Imported') >= 0,
          'the toast read ' + JSON.stringify(said));
        const undoable = await page.evaluate(
          () => !!document.querySelector('.rw-toast__action'));
        check('and offers Undo', undoable, 'the toast carries no action');
      }
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
