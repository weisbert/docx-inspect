#!/usr/bin/env node
'use strict';
/*
 * test_v2_grid_drag.js -- drag ownership inside a block card, driven with a
 * real mouse in a real browser.
 *
 * Run:  node builder/tests/test_v2_grid_drag.js
 *       node builder/tests/test_v2_grid_drag.js --headed     (watch it work)
 *
 * WHY THIS FILE EXISTS
 *   A card used to be reordered by dragging the card WRAPPER, which
 *   js/views/editor.js marked draggable="true". Its dragstart handler stepped
 *   aside for `[contenteditable="true"], input, textarea, select` and nothing
 *   else. A compliance-table cell is a <td>: none of those. So pressing on a
 *   cell and dragging started a native HTML5 drag of the whole card -- the
 *   browser painted the card as a drag ghost and took over the mouse stream, so
 *   the grid never saw mousemove or mouseup, its range selection never
 *   happened, and the mousedown it had already taken left it waiting for a
 *   mouseup that a later click had to absorb before the grid answered again.
 *   Nothing threw, so the global error trap had nothing to report.
 *
 * WHAT IT ASSERTS, all three with mouse.move / mouse.down / mouse.up
 *   1. pressing on a compliance cell and dragging three cells right selects a
 *      1 x 4 range, and NO dragstart fires anywhere while it happens;
 *   2. the page is still responsive afterwards -- the very next click on
 *      another cell moves the selection to it;
 *   3. a press that starts in the grid and is released on an insert seam does
 *      NOT reorder the document -- against the old wrapper it silently did,
 *      because the seam accepted the ghost as a card drop;
 *   4. the drag-to-reorder gesture still works from the card HEAD: it starts a
 *      drag, it highlights the SEAM between cards rather than a card, and the
 *      drop reorders the blocks on disk.
 *
 * Assertion 1 is the one with teeth: against the old wrapper it fails twice
 * over -- a dragstart is recorded on the card, and the footer still reads
 * 1 x 1 because the grid never saw the drag.
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

// U+00D7, the multiplication sign the footer and the card meta line both use.
const TIMES = String.fromCharCode(215);

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
const PROSE = 'The table below states the test conditions and the measured values.';

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function row(cat, item, unit, kind, spec, sim) {
  return {
    cat: cat, item: item, unit: unit, kind: kind, limit: null, sim_span: false,
    spec: null, spec_mtm: spec || [null, null, null], spec_ntwc: null,
    sims: { typ: { mtm: sim || [null, null, null], ntwc: null } },
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
              sims: [{ key: 'typ', title: 'Typical', stage: 'CDR', axes: ['MIN', 'TYP', 'MAX', 'NTWC'] }],
              rows: [
                row('Conditions', 'Supply', 'V', 'common_setting', [null, '1.80', null], [null, '1.80', null]),
                row('Performance', 'Divided frequency', 'GHz', 'result', ['4.8', '5.0', '5.2'], ['4.85', '5.01', '5.14']),
                row('Performance', 'Duty cycle', '%', 'result', ['45', '50', '55'], ['47.2', '49.8', '52.4']),
                row('Performance', 'Current', 'mA', 'result', [null, null, '4.0'], [null, null, '3.7']),
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

function readBlocks(reportsRoot, at) {
  const file = path.join(reportsRoot, ...REPORT_DIR.split('/'), 'project.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  return ((doc.outline || [])[at || 0] || {}).blocks || [];
}

async function waitForBlocks(reportsRoot, at, predicate, timeoutMs) {
  const until = Date.now() + (timeoutMs == null ? 4000 : timeoutMs);
  for (;;) {
    const last = readBlocks(reportsRoot, at);
    if (predicate(last)) return last;
    if (Date.now() > until) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
}

function blockShape(blocks) {
  return (blocks || []).map((b) => (b ? b.type : '?')).join(' , ');
}

// Record every dragstart the document sees, in the capture phase (so nothing a
// handler does can hide it) and again on bubble (so defaultPrevented is what
// the handlers left behind).
async function installDragProbe(page) {
  await page.evaluate(() => {
    window.__rwDrags = [];
    const note = (phase) => (event) => {
      const t = event.target;
      window.__rwDrags.push({
        phase: phase,
        tag: t && t.tagName ? String(t.tagName) : '?',
        inSlot: !!(t && t.closest && t.closest('[data-card-start]')),
        inHead: !!(t && t.closest && t.closest('.rw-card__head')),
        prevented: !!event.defaultPrevented,
      });
    };
    document.addEventListener('dragstart', note('capture'), true);
    window.addEventListener('dragstart', note('bubble'), false);
  });
}

const drags = (page) => page.evaluate(() => (window.__rwDrags || []).slice());
const clearDrags = (page) => page.evaluate(() => { window.__rwDrags = []; });

// Four consecutive, comfortably wide, fully visible cells of one grid row.
async function findCellRun(page) {
  return page.evaluate(() => {
    const cells = Array.from(document.querySelectorAll('td[data-x][data-y]'));
    if (!cells.length) return { error: 'the grid rendered no cells' };
    const byRow = new Map();
    for (const td of cells) {
      const box = td.getBoundingClientRect();
      const y = td.getAttribute('data-y');
      if (!byRow.has(y)) byRow.set(y, []);
      byRow.get(y).push({
        x: Number(td.getAttribute('data-x')), y: Number(y),
        cx: box.left + box.width / 2, cy: box.top + box.height / 2,
        w: box.width, h: box.height,
        ok: box.width >= 30 && box.height >= 10
          && box.left >= 0 && box.top >= 0
          && box.right <= window.innerWidth && box.bottom <= window.innerHeight
          && !td.classList.contains('jss_freezed'),
      });
    }
    for (const list of byRow.values()) {
      list.sort((a, b) => a.x - b.x);
      for (let i = 0; i + 3 < list.length; i++) {
        const run = list.slice(i, i + 4);
        if (run.some((c) => !c.ok)) continue;
        if (run[3].x - run[0].x !== 3) continue;
        return { from: run[0], to: run[3], row: run[0].y, cols: run.map((c) => c.x) };
      }
    }
    return { error: 'no run of four visible cells in one row' };
  });
}

const footText = (page) => page.evaluate(() => {
  const foot = document.querySelector('.rw-grid__foot');
  return foot ? String(foot.innerText || foot.textContent || '').replace(/\s+/g, ' ').trim() : '';
});

// Press, move across in small steps, release. A real mouse, not a synthetic
// click: the whole defect lives between mousedown and mouseup.
async function dragMouse(page, from, to, steps) {
  const n = steps || 10;
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= n; i++) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * i) / n,
      from.y + ((to.y - from.y) * i) / n
    );
    await page.waitForTimeout(16);
  }
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
  const scratch = path.join(os.tmpdir(), 'report-workbench-v2-grid-drag', stamp);
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

    await installDragProbe(page);

    /* ---- 1. press and drag across four cells ---- */

    section('press and drag across a compliance table');
    const run = await findCellRun(page);
    if (run.error) {
      check('the compliance grid rendered cells to press on', false, run.error);
      await page.screenshot({ path: path.join(shots, 'no-grid.png') });
    } else {
      console.log('  dragging row ' + run.row + ' across columns ' + run.cols.join(', '));
      await clearDrags(page);
      await dragMouse(page, { x: run.from.cx, y: run.from.cy }, { x: run.to.cx, y: run.to.cy }, 10);
      const midDrags = await drags(page);
      await page.mouse.up();
      await settle(page, 300);
      await page.screenshot({ path: path.join(shots, 'after-drag-select.png') });

      const foot = await footText(page);
      const wanted = '1 ' + TIMES + ' 4 selected';
      check('dragging three cells right selects a 1 ' + TIMES + ' 4 range',
        foot.indexOf(wanted) >= 0, 'the footer reads: "' + foot + '"');

      const started = midDrags.filter((d) => d.phase === 'capture');
      check('no dragstart fires anywhere while dragging inside the grid',
        started.length === 0,
        started.length + ' dragstart(s): ' + JSON.stringify(started.slice(0, 3)));

      /* ---- 3. the page is still responsive afterwards ---- */

      section('the page after the drag');
      const other = await page.evaluate((arg) => {
        const td = document.querySelector('td[data-x="' + arg.x + '"][data-y="' + arg.y + '"]');
        if (!td) return null;
        const box = td.getBoundingClientRect();
        return { cx: box.left + box.width / 2, cy: box.top + box.height / 2 };
      }, { x: run.cols[1], y: run.row + 1 });
      if (!other) {
        check('there is another cell to click', false, 'no cell one row below the drag');
      } else {
        await page.mouse.click(other.cx, other.cy);
        await settle(page, 300);
        const after = await footText(page);
        check('the next click on another cell moves the selection',
          after.indexOf('1 ' + TIMES + ' 1 selected') >= 0,
          'the footer reads: "' + after + '"');
      }
    }

    /* ---- 2. a press that starts in the grid never reorders anything ---- */

    section('a press that starts in the grid, released on an insert seam');
    // The FIRST seam, above the first card: releasing the ghost there is the
    // one drop that actually moves the table, so the assertion is not vacuous.
    const seamBox = await page.evaluate(() => {
      const first = document.querySelector('.rw-seam');
      if (!first) return null;
      const box = first.getBoundingClientRect();
      return { cx: box.left + box.width / 2, cy: box.top + box.height / 2 };
    });
    const cellRun = run.error ? null : run;
    if (!seamBox || !cellRun) {
      check('there is a seam below the table to release on', false,
        run.error || 'no seam on screen');
    } else {
      await dragMouse(page, { x: cellRun.from.cx, y: cellRun.from.cy },
        { x: seamBox.cx, y: seamBox.cy }, 12);
      await page.mouse.up();
      await settle(page, 400);
      await page.keyboard.press('Control+s');
      const stayed = await waitForBlocks(reportsRoot, 0,
        (b) => b.length === 2 && b[0] && b[0].type === 'datatable', 1600);
      check('the document is not reordered by a drag the user never started',
        stayed.length === 2 && stayed[0].type === 'para' && stayed[1].type === 'datatable',
        'blocks are: ' + blockShape(stayed));
    }

    /* ---- 3. reordering from the card head ---- */

    section('drag-to-reorder from the card head');
    const before = readBlocks(reportsRoot, 0);
    const wanted = [(before[1] || {}).type, (before[0] || {}).type].join(' , ');
    console.log('  on disk before: ' + blockShape(before));

    const handles = await page.evaluate(() => {
      const card = document.querySelector('[data-card-start="0"]');
      const head = card ? card.querySelector('.rw-card__head') : null;
      const seams = Array.from(document.querySelectorAll('.rw-seam'));
      const last = seams[seams.length - 1];
      if (!head || !last) return null;
      const h = head.getBoundingClientRect();
      const s = last.getBoundingClientRect();
      last.setAttribute('data-probe-seam', '1');
      return {
        head: { cx: h.left + 60, cy: h.top + h.height / 2 },
        seam: { cx: s.left + s.width / 2, cy: s.top + s.height / 2 },
        seams: seams.length,
      };
    });
    if (!handles) {
      check('the first card offers a head to drag', false, 'no card head or no seam on screen');
    } else {
      await clearDrags(page);
      await dragMouse(page, { x: handles.head.cx, y: handles.head.cy },
        { x: handles.seam.cx, y: handles.seam.cy }, 12);
      // Two more moves over the seam, so the drag settles there and the state
      // the highlight is drawn from has flushed before it is read.
      await page.mouse.move(handles.seam.cx + 1, handles.seam.cy);
      await settle(page, 150);
      await page.mouse.move(handles.seam.cx, handles.seam.cy);
      await settle(page, 200);

      const started = (await drags(page)).filter((d) => d.phase === 'capture');
      check('dragging the card head starts a drag',
        started.length > 0 && started[0].inHead === true,
        JSON.stringify(started.slice(0, 2)));

      const highlight = await page.evaluate(() => ({
        seam: !!document.querySelector('.rw-seam--over'),
        onProbe: !!document.querySelector('[data-probe-seam].rw-seam--over'),
        card: !!document.querySelector('.rw-card--dragover, .rw-card--over'),
      }));
      check('the drop target drawn is the SEAM, not a card',
        highlight.onProbe && !highlight.card, JSON.stringify(highlight));
      await page.screenshot({ path: path.join(shots, 'seam-highlight.png') });

      await page.mouse.up();
      await settle(page, 400);
      await page.keyboard.press('Control+s');
      const after = await waitForBlocks(reportsRoot, 0,
        (b) => b.length === 2 && blockShape(b) === wanted);
      console.log('  on disk after : ' + blockShape(after));
      check('the drop moves the dragged card to the end, on disk',
        blockShape(after) === wanted,
        'blocks are: ' + blockShape(after) + '   (expected ' + wanted + ')');
    }

    // LAST, deliberately. This drag plants a caret in the prose, and the old
    // wrapper read a caret anywhere on the canvas as "do not drag" -- so running
    // it earlier would switch the defect off for every assertion after it, which
    // is exactly the state the owner was NOT in when they opened the table.
    /* ---- selecting text in a prose card ---- */

    section('press and drag across prose');
    const prose = await page.evaluate(() => {
      const box = document.querySelector('.rw-prose[contenteditable="true"]');
      if (!box) return null;
      const r = box.getBoundingClientRect();
      window.getSelection().removeAllRanges();
      return { x: r.left + 8, y: r.top + 9, w: r.width };
    });
    if (!prose) {
      check('there is a prose card to select in', false, 'no contenteditable on screen');
    } else {
      await clearDrags(page);
      await dragMouse(page, { x: prose.x, y: prose.y },
        { x: prose.x + Math.min(220, prose.w - 20), y: prose.y }, 10);
      const proseDrags = (await drags(page)).filter((d) => d.phase === 'capture');
      await page.mouse.up();
      await settle(page, 200);
      const picked = await page.evaluate(() => String(window.getSelection() || ''));
      check('dragging across prose selects text and starts no drag',
        picked.trim().length > 0 && proseDrags.length === 0,
        'selected "' + picked.slice(0, 40) + '", ' + proseDrags.length + ' dragstart(s)');
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
