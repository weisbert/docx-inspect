#!/usr/bin/env node
'use strict';
/*
 * test_v2_formula_off.js -- a cell is text, and '=' is a character like any
 * other. Driven in a real browser, because the fault is inside the control.
 *
 * WHAT WENT WRONG
 * The grid control evaluates any value whose first character is '=' -- it is a
 * spreadsheet library, and formulas are on by default. What it cannot evaluate
 * it turns into the literal string '#ERROR'. Two things in this tool begin with
 * '=':
 *
 *   1. A compliance row whose limit is `range` is DRAWN as '='. Every such row
 *      showed '#ERROR' in its Limit column, so `range` was unusable on screen.
 *      (Word and .xlsx were never affected: core/tables.py reads the field, not
 *      the drawing.)
 *
 *   2. Anything a user types into a plain table starting with '='.
 *
 * HOW FAR THE DAMAGE GOES -- MEASURED, NOT ASSUMED. It is a drawing fault and
 * only that. Both file-side assertions below pass against the pre-fix file as
 * well: what onchange hands over is the raw text, so project.json was never
 * wrong, and opening such a cell and closing it again does not commit the
 * '#ERROR' it shows. They are kept as guards -- if a later change to the grid
 * ever does let '#ERROR' through to the file, they are what catches it. What
 * the fault cost was the screen, which for a `range` row is the whole of it:
 * the limit could not be read in the editor at all.
 *
 * Changing the sign away from '=' would not have been the fix: '=' is also what
 * a user may TYPE to mean `range` (SIGN_TO_LIMIT accepts it), so the trap would
 * have stayed. Formula evaluation is off instead -- this is a data grid.
 *
 * WHAT THIS ASSERTS
 *   1. no cell anywhere on the page reads '#ERROR'
 *   2. the Limit column of a `range` row reads '='
 *   3. '=foo' typed into a plain-table cell stays '=foo' on screen
 *   4. ...and reaches project.json as '=foo'          (guard, true before too)
 *   5. the `range` row's limit is still 'range' in the file (guard)
 *   6. opening that Limit cell and closing it leaves the limit alone (guard)
 *   7. ...and the cell still reads its sign afterwards
 *
 * AGAINST THE PRE-FIX FILE: 1, 2, 3 and 7 fail -- every one of them on screen.
 *
 * Run:  node builder/tests/test_v2_formula_off.js
 *       node builder/tests/test_v2_formula_off.js --headed
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
try {
  chromium = require('playwright-core').chromium;
} catch (err) {
  console.log('Report Workbench v2 -- a cell is text, not a formula');
  console.log('  SKIP: playwright-core is not installed.  npm install, then re-run.');
  process.exit(0);
}

/* ------------------------------------------------------------------ *
 * the fixture
 * ------------------------------------------------------------------ */

const PROJECT_ID = '1108';
const MODULE_ID = 'CLKDIV_5G';
const REPORT_DIR = PROJECT_ID + '/' + MODULE_ID + '/CDR';
const SECTION = 'Simulation results';
const DATA_ID = 'b-table-1';
const PLAIN_ID = 'b-table-2';
const TYPED = '=foo';

/* Compliance plan: 0 #  1 Category  2 Item  3 Limit  4 sep  5..7 spec ...
 * Plain plan:      0 #  1 A  2 B                                        */
const X = { limit: 3 };
const PLAIN_X = 2;              // the second cell column of the plain table
const PLAIN_Y = 1;              // its first body row

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function row(cat, item, unit, kind, limit, spec, sim) {
  return {
    cat: cat, item: item, unit: unit, kind: kind, limit: limit, sim_span: false,
    spec: null, spec_mtm: spec || [null, null, null], spec_ntwc: null,
    sims: { pre: { mtm: sim || [null, null, null], ntwc: null } },
  };
}

function sampleReport() {
  return {
    template: 'sample',
    meta: {
      title: MODULE_ID + ' CDR report', doc_no: 'DOC-1', version: 'V1.0',
      secrecy: 'Internal', author: 'A. Engineer', date: '2026-09-09',
      reviewers: [], approver: '', revisions: [],
    },
    outline: [
      {
        id: 'n-results',
        title: SECTION,
        blocks: [
          {
            type: 'datatable', id: DATA_ID, kind: 'compliance',
            caption: 'Divider performance',
            data: {
              spec_name: 'Spec',
              sims: [{ key: 'pre', title: 'Schematic', stage: 'CDR',
                       axes: ['MIN', 'TYP', 'MAX'] }],
              rows: [
                row('Conditions', 'Supply', 'V', 'common_setting', null,
                  [null, '1.80', null], [null, '1.80', null]),
                // The row this test exists for: a two-sided limit, drawn as '='.
                row('Performance', 'Duty cycle', '%', 'result', 'range',
                  ['45', '50', '55'], ['47.2', '49.8', '52.4']),
                row('Performance', 'Divided frequency', 'GHz', 'result', 'le',
                  ['4.8', '5.0', '5.2'], ['4.85', '5.01', '5.14']),
              ],
            },
          },
          {
            type: 'table', id: PLAIN_ID, caption: 'Notes',
            header_rows: 1,
            rows: [['Item', 'Note'], ['Duty cycle', '']],
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

// Two grids are on screen, so every cell is addressed by WHICH grid as well.
const gridCellText = (page, grid, x, y) => page.evaluate((at) => {
  const host = document.querySelectorAll('.rw-grid')[at.grid];
  if (!host) return null;
  const td = host.querySelector('td[data-x="' + at.x + '"][data-y="' + at.y + '"]');
  return td ? String(td.textContent || '').trim() : null;
}, { grid: grid, x: x, y: y });

const gridCellBox = (page, grid, x, y) => page.evaluate((at) => {
  const host = document.querySelectorAll('.rw-grid')[at.grid];
  if (!host) return null;
  const td = host.querySelector('td[data-x="' + at.x + '"][data-y="' + at.y + '"]');
  if (!td) return null;
  td.scrollIntoView({ block: 'center', inline: 'nearest' });
  const box = td.getBoundingClientRect();
  if (box.width < 4 || box.height < 6) return null;
  if (box.left < 0 || box.top < 0) return null;
  if (box.right > window.innerWidth || box.bottom > window.innerHeight) return null;
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  const hit = document.elementFromPoint(cx, cy);
  if (!hit || (hit !== td && !td.contains(hit))) return null;
  return { cx: cx, cy: cy };
}, { grid: grid, x: x, y: y });

// Every cell on the page that reads '#ERROR', wherever it is.
const errorCells = (page) => page.evaluate(() => {
  const out = [];
  document.querySelectorAll('.rw-grid td[data-x][data-y]').forEach((td) => {
    if (String(td.textContent || '').trim() === '#ERROR') {
      out.push(td.getAttribute('data-x') + ',' + td.getAttribute('data-y'));
    }
  });
  return out;
});

function readBlocks(reportsRoot) {
  const file = path.join(reportsRoot, ...REPORT_DIR.split('/'), 'project.json');
  let doc = null;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return null;              // mid-write; the caller polls
  }
  const blocks = ((doc.outline || [])[0] || {}).blocks || [];
  const out = {};
  blocks.forEach((b) => { if (b && b.id) out[b.id] = b; });
  return out;
}

async function waitForBlocks(reportsRoot, predicate, timeoutMs) {
  const until = Date.now() + (timeoutMs == null ? 6000 : timeoutMs);
  for (;;) {
    const blocks = readBlocks(reportsRoot);
    if (blocks && predicate(blocks)) return blocks;
    if (Date.now() > until) return blocks;
    await new Promise((r) => setTimeout(r, 200));
  }
}

function plainCellValue(blocks) {
  const block = (blocks || {})[PLAIN_ID] || {};
  const row = (block.rows || [])[PLAIN_Y];
  const cells = (row && !Array.isArray(row) && typeof row === 'object')
    ? (row.cells || []) : (row || []);
  return cells[PLAIN_X - 1];        // the grid's column 0 is the row number
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
  const scratch = path.join(os.tmpdir(), 'report-workbench-v2-formula-off', stamp);
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

    const grids = await page.evaluate(() => document.querySelectorAll('.rw-grid').length);
    if (grids < 2) {
      check('both tables drew a grid', false, 'found ' + grids + ' grid(s) on screen');
      await page.screenshot({ path: path.join(shots, 'no-grid.png') });
      await context.close();
      return;
    }

    /* ---- 1. a two-sided limit is drawn, not evaluated ---- */

    section('a limit that reads "=" is a limit, not a formula');
    const errs = await errorCells(page);
    check('no cell on the page reads #ERROR', errs.length === 0,
      errs.length ? 'at (x,y): ' + errs.join(' ') : '');

    const limitText = await gridCellText(page, 0, X.limit, 1);
    check('the range row shows its sign in the Limit column', limitText === '=',
      'the Limit cell reads ' + JSON.stringify(limitText));

    /* ---- 2. text a user types beginning with '=' stays text ---- */

    section('a cell a user starts with "=" is still what they typed');
    const box = await gridCellBox(page, 1, PLAIN_X, PLAIN_Y);
    if (!box) {
      check('there is a plain-table cell to type into', false,
        'no cell at x=' + PLAIN_X + ', y=' + PLAIN_Y + ' in the second grid');
    } else {
      await page.mouse.click(box.cx, box.cy);
      await settle(page, 250);
      await page.keyboard.type(TYPED, { delay: 40 });
      await page.keyboard.press('Enter');
      await settle(page, 500);

      const shown = await gridCellText(page, 1, PLAIN_X, PLAIN_Y);
      check('the cell on screen holds what was typed', shown === TYPED,
        'the cell reads ' + JSON.stringify(shown));

      const blocks = await waitForBlocks(reportsRoot, (b) => plainCellValue(b) === TYPED);
      check('and that is what reaches project.json', plainCellValue(blocks) === TYPED,
        'the file holds ' + JSON.stringify(plainCellValue(blocks)));

      /* ---- 3. and the save did not launder the limit either ---- */

      section('the row that was only ever drawn is untouched');
      const data = ((blocks || {})[DATA_ID] || {}).data || {};
      const limits = (data.rows || []).map((r) => r.limit);
      check('the range row still carries limit "range" in the file',
        limits[1] === 'range', 'the limits on disk are ' + JSON.stringify(limits));
    }

    /* ---- 4. the file is not touched by any of this ---- */

    section('opening the Limit cell and closing it again is not an edit');
    const limitBox = await gridCellBox(page, 0, X.limit, 1);
    if (!limitBox) {
      check('the Limit cell can be reached', false, 'no cell at x=' + X.limit + ', y=1');
    } else {
      // No typing: open the editor and commit it unchanged, the way a user
      // checks a value. This held before the fix too -- the control does not
      // hand back what it drew -- and it is asserted so that it goes on
      // holding: '#ERROR' committed into the Limit column would read as no
      // limit at all (parseLimit answers null) and the row would silently stop
      // being checked against its spec.
      await page.mouse.click(limitBox.cx, limitBox.cy);
      await settle(page, 200);
      await page.keyboard.press('F2');
      await settle(page, 200);
      await page.keyboard.press('Enter');
      await settle(page, 500);

      const after = await waitForBlocks(reportsRoot,
        (b) => ((((b || {})[DATA_ID] || {}).data || {}).rows || [])[1]
          && true, 3000);
      const kept = ((((after || {})[DATA_ID] || {}).data || {}).rows || [])[1] || {};
      check('the limit survives being looked at', kept.limit === 'range',
        'the row now carries limit ' + JSON.stringify(kept.limit));
      check('and the cell still reads its sign',
        (await gridCellText(page, 0, X.limit, 1)) === '=',
        'the cell reads ' + JSON.stringify(await gridCellText(page, 0, X.limit, 1)));
    }

    check('the page raised no script errors', pageErrors.length === 0,
      pageErrors.slice(0, 3).join(' | '));
    await page.screenshot({ path: path.join(shots, 'grids.png') });
    await context.close();
  } finally {
    await cleanup();
  }
}

(async () => {
  console.log('Report Workbench v2 -- a cell is text, not a formula');
  try {
    await browserChecks();
  } catch (err) {
    check('the run completed', false, String(err && err.stack ? err.stack : err));
  }
  console.log('');
  if (failures.length) {
    console.log('FAILED ' + failures.length + ':');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('all assertions passed');
})();
