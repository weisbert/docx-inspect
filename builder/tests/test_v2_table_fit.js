#!/usr/bin/env node
'use strict';
/*
 * test_v2_table_fit.js -- how much of a table the reader can actually see, and
 * what the edges of the grid tell them, driven in a real browser.
 *
 * Run:  node builder/tests/test_v2_table_fit.js
 *       node builder/tests/test_v2_table_fit.js --headed
 *
 * WHAT IT ASSERTS, and what each assertion is there to stop coming back
 *
 * 1. A TABLE IS NOT PROSE, AND DOES NOT TAKE THE PROSE MEASURE.
 *    The block canvas was capped at --lay-canvas-max (900px) because a line of
 *    prose much past that is tiring to read. A compliance table is as wide as
 *    its columns add up to, and inside that cap a 1011px table was shown
 *    through an 848px window -- in a pane 1336px wide that was half empty. A
 *    table card now asks for the width of its own column plan and centres in
 *    what is left; a prose card, and a table that fits, do not move.
 *
 * 2. AT THE END OF THE TRAVEL, NOTHING IS HIDDEN.
 *    The right-edge cue was drawn whenever the table was wider than its pane,
 *    which stays true at the far right-hand end where every column is on
 *    screen. So a 108px wash sat over the last column permanently -- and the
 *    last column of a compliance table is Unit. The cue answers 'what is still
 *    out of sight FROM HERE' now, and it is a border-width shadow.
 *
 * 3. WHAT IS OFF THE EDGE IS SAID IN THE FOOTER, AND CAN BE GONE TO.
 *    The name of the first hidden group used to be painted over the grid, where
 *    it could not be clicked. It is a chip in the footer now, and it scrolls
 *    that group clear of the frozen columns.
 *
 * 4. THE GRID IS AS TALL AS THE PANE CAN SPARE, AND THE READER OVERRULES IT.
 *    It was 420px, always: fifteen rows of a fifty-row table, in a pane 791px
 *    tall. It takes the room the pane has now, a drag on the bottom edge sets
 *    it, the setting survives leaving the section, and a double-click gives it
 *    back.
 *
 * 5. FULL SCREEN IS A MOVE, NOT A REMOUNT.
 *    The panel is the same element repositioned: the selection that was in the
 *    grid is still in it afterwards, the canvas behind does not close up, and
 *    Escape comes back.
 *
 * 6. A MENU OPENED INSIDE FULL SCREEN LANDS UNDER THE POINTER.
 *    Menu.js positions in viewport coordinates. The box was `position:
 *    absolute`, which is viewport coordinates only while no ancestor is
 *    positioned -- and the full-screen panel is `position: fixed`, so every
 *    menu opened inside it would have been offset by the panel's own corner.
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

// Wide enough that the pane beside the 272px rail and the 432px right panel is
// itself wider than the prose measure -- which is what assertion 1 is about.
const VIEWPORT = { width: 1920, height: 1040 };

const MEASURE = 900;        // --lay-canvas-max
const OLD_HEIGHT = 420;     // the height the grid used to be, always
const EDGE_MAX = 16;        // --tbl-edge-w, plus slack

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
const MODULE_ID = 'CLKDIV_12G';
const REPORT_DIR = PROJECT_ID + '/' + MODULE_ID + '/CDR';
const WIDE_SECTION = 'Simulation results';
const NARROW_SECTION = 'Summary';

// Three simulated groups beside the spec block: 4 groups x (10px separator +
// 3 x 62px axis) + 26 + 92 + 176 + 60 + 54 = 1202px of column plan, which no
// pane in this test is wide enough to hold. The narrow table has one group.
const WIDE_SIMS = [
  { key: 'sch', title: 'Schematic', stage: 'CDR', axes: ['MIN', 'TYP', 'MAX'] },
  { key: 'post', title: 'Extracted', stage: 'CDR', axes: ['MIN', 'TYP', 'MAX'] },
  { key: 'ref', title: 'Silicon', stage: 'PDR', axes: ['MIN', 'TYP', 'MAX'] },
];

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function row(cat, item, unit, kind, n) {
  const sims = {};
  WIDE_SIMS.forEach((sim, i) => {
    sims[sim.key] = { mtm: [String(n + i), String(n + i + 1), String(n + i + 2)], ntwc: null };
  });
  return {
    cat: cat, item: item, unit: unit, kind: kind, limit: 'le', sim_span: false,
    spec: null, spec_mtm: [String(n), String(n + 1), String(n + 9)], spec_ntwc: null,
    sims: sims,
  };
}

// Twenty-eight rows: taller than any box this test gives it, so 'how many rows
// can be seen' is always a question about the box and never about the table.
function wideRows() {
  const rows = [row('Conditions', 'Supply', 'V', 'common_setting', 1)];
  for (let i = 0; i < 27; i++) {
    rows.push(row(i < 9 ? 'Timing' : 'Noise', 'Metric ' + (i + 1), 'dBc', 'result', i + 2));
  }
  return rows;
}

function narrowRows() {
  return [
    {
      cat: 'Conditions', item: 'Supply', unit: 'V', kind: 'common_setting',
      limit: null, sim_span: false, spec: null, spec_mtm: [null, '1.80', null],
      spec_ntwc: null, sims: { sch: { mtm: [null, '1.80', null], ntwc: null } },
    },
    {
      cat: 'Timing', item: 'Lock time', unit: 'us', kind: 'result',
      limit: 'le', sim_span: false, spec: null, spec_mtm: [null, null, '30'],
      spec_ntwc: null, sims: { sch: { mtm: [null, null, '24'], ntwc: null } },
    },
  ];
}

function sampleReport() {
  return {
    template: 'sample',
    meta: {
      title: MODULE_ID + ' CDR report', doc_no: 'DOC-1', version: 'V1.0',
      secrecy: 'Internal', author: 'A. Engineer', date: '2026-09-04',
      reviewers: [], approver: '', revisions: [],
    },
    outline: [
      {
        id: 'n-results',
        title: WIDE_SECTION,
        blocks: [
          {
            type: 'para', id: 'b-para-1', cardStart: true,
            runs: [{ t: 'The prose card beside it keeps the reading measure.' }],
          },
          {
            type: 'datatable', id: 'b-wide', kind: 'compliance',
            caption: 'Divider performance',
            data: { spec_name: 'Spec', sims: WIDE_SIMS, rows: wideRows() },
          },
        ],
        children: [],
      },
      {
        id: 'n-summary',
        title: NARROW_SECTION,
        blocks: [
          {
            type: 'datatable', id: 'b-narrow', kind: 'compliance', caption: 'Summary',
            data: {
              spec_name: 'Spec',
              sims: [{ key: 'sch', title: 'Schematic', stage: 'CDR', axes: ['MIN', 'TYP', 'MAX'] }],
              rows: narrowRows(),
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
    skeleton: [{ title: WIDE_SECTION, children: [] }, { title: NARROW_SECTION, children: [] }],
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
  writeJson(path.join(root, 'templates', 'sample', 'skeleton.json'),
    sampleTemplateConfig().skeleton);
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

// Everything this test wants to know about the table on screen, in one pass.
const shape = (page) => page.evaluate(() => {
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      w: Math.round(r.width), h: Math.round(r.height),
      x: Math.round(r.left), y: Math.round(r.top),
    };
  };
  const content = document.querySelector('.rw-grid .jss_content');
  const chip = document.querySelector('.rw-gridmore__chip');
  const canvas = document.querySelector('.rw-canvas');
  const lane = document.querySelector('.rw-canvas__inner');
  const card = document.querySelector('.rw-card--wide');
  const prose = document.querySelector('.rw-card:not(.rw-card--wide)');
  const natural = card ? card.style.getPropertyValue('--tbl-natural') : '';
  return {
    wideCard: box('.rw-card--wide'),
    proseCard: prose ? Math.round(prose.getBoundingClientRect().width) : null,
    natural: natural ? parseInt(natural, 10) : null,
    lane: lane ? Math.round(lane.clientWidth) : null,
    canvasH: canvas ? canvas.clientHeight : null,
    canvasScrollH: canvas ? canvas.scrollHeight : null,
    content: content ? {
      cw: content.clientWidth, sw: content.scrollWidth,
      ch: content.clientHeight, sh: content.scrollHeight,
      sl: Math.round(content.scrollLeft),
      max: Math.round(content.scrollWidth - content.clientWidth),
    } : null,
    edge: box('.rw-gridmore'),
    chip: chip ? String(chip.textContent || '').replace(/\s+/g, ' ').trim() : null,
    grip: !!document.querySelector('.rw-gridgrip'),
    full: box('.rw-tbl--full'),
    // How many body rows have their whole height inside the box. Rows, not
    // cells: a Category cell covers the whole run of rows it names.
    rowsSeen: (() => {
      if (!content) return 0;
      const r = content.getBoundingClientRect();
      let seen = 0;
      document.querySelectorAll('.rw-grid .jss_worksheet > tbody > tr').forEach((tr) => {
        const c = tr.getBoundingClientRect();
        if (c.height > 4 && c.top >= r.top - 1 && c.bottom <= r.bottom + 1) seen += 1;
      });
      return seen;
    })(),
  };
});

const scrollGrid = (page, left) => page.evaluate((to) => {
  const content = document.querySelector('.rw-grid .jss_content');
  if (!content) return null;
  content.scrollLeft = to < 0 ? content.scrollWidth : to;
  return Math.round(content.scrollLeft);
}, left);

// Where a cell is on screen, or null when it is not reachable by a real mouse.
const cellPoint = (page, x, y) => page.evaluate((at) => {
  const td = document.querySelector('td[data-x="' + at.x + '"][data-y="' + at.y + '"]');
  if (!td) return null;
  const r = td.getBoundingClientRect();
  if (r.width < 4 || r.height < 6) return null;
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return null;
  const hit = document.elementFromPoint(cx, cy);
  if (!hit || (hit !== td && !td.contains(hit))) return null;
  return { x: cx, y: cy };
}, { x: x, y: y });

const gripPoint = (page) => page.evaluate(() => {
  const grip = document.querySelector('.rw-gridgrip');
  if (!grip) return null;
  grip.scrollIntoView({ block: 'center' });
  const r = grip.getBoundingClientRect();
  if (r.width < 4 || r.height < 3) return null;
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
});

const selectedCell = (page) => page.evaluate(() => {
  const td = document.querySelector('td.highlight-selected[data-x]')
    || document.querySelector('td.highlight[data-x]');
  return td ? td.getAttribute('data-x') + ',' + td.getAttribute('data-y') : null;
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
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
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
  const scratch = path.join(os.tmpdir(), 'report-workbench-v2-table-fit', stamp);
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
      if (msg.type() !== 'error') return;
      const where = msg.location && msg.location() ? String(msg.location().url) : '';
      if (where.indexOf('favicon') >= 0) return;
      consoleErrors.push(msg.text().slice(0, 200) + '  <- ' + where);
    });
    page.on('pageerror', (err) => pageErrors.push(String(err && err.message)));
    page.on('dialog', (d) => d.dismiss().catch(() => {}));

    const editorUrl = base + '/#/r/' + REPORT_DIR.split('/').map(encodeURIComponent).join('/');
    await page.goto(editorUrl, { waitUntil: 'load' });
    await settle(page, 1400);
    await clickText(page, WIDE_SECTION);
    await settle(page, 900);

    /* -- 1. the measure belongs to the card -------------------------- */
    section('a table takes the width its columns need');
    const wide = await shape(page);
    await page.screenshot({ path: path.join(shots, 'wide-table.png') });
    check('the card asks for a width, and it is the column plan\'s',
      !!wide.natural && wide.natural > MEASURE,
      '--tbl-natural is ' + JSON.stringify(wide.natural));
    check('the table card is wider than the prose measure',
      !!wide.wideCard && wide.wideCard.w > MEASURE,
      'the card is ' + JSON.stringify(wide.wideCard && wide.wideCard.w)
        + 'px wide, the measure is ' + MEASURE);
    check('and no wider than the pane it is in',
      !!wide.wideCard && !!wide.lane && wide.wideCard.w <= wide.lane + 1,
      'card ' + (wide.wideCard || {}).w + ' against a lane of ' + wide.lane);
    check('the prose card beside it keeps the measure',
      wide.proseCard !== null && Math.abs(wide.proseCard - MEASURE) <= 2,
      'the prose card is ' + wide.proseCard + 'px wide');

    /* -- 2. the box is as tall as the pane can spare ----------------- */
    section('the grid is as tall as the pane can spare');
    check('the box is taller than the fixed height it used to have',
      !!wide.content && wide.content.ch > OLD_HEIGHT + 40,
      'the box is ' + (wide.content || {}).ch + 'px tall, it used to be ' + OLD_HEIGHT);
    check('and it still fits inside the pane',
      !!wide.content && !!wide.canvasH && wide.content.ch < wide.canvasH,
      'box ' + (wide.content || {}).ch + ' against a pane of ' + wide.canvasH);
    check('more rows are on screen than the old box could hold',
      wide.rowsSeen > Math.floor(OLD_HEIGHT / 25),
      wide.rowsSeen + ' rows are fully visible');

    /* -- 3. the edge, and what it says ------------------------------- */
    section('the right-hand edge');
    check('a table wider than its pane says so at the edge',
      !!wide.edge && !!wide.content && wide.content.max > 0,
      'overflow ' + ((wide.content || {}).max) + ', edge ' + JSON.stringify(wide.edge));
    check('the cue is a border, not a wash over the last column',
      !!wide.edge && wide.edge.w <= EDGE_MAX,
      'the cue is ' + ((wide.edge || {}).w) + 'px wide');
    check('the footer names the first group that is off the edge',
      !!wide.chip && /^More columns · \S/.test(wide.chip),
      'the chip reads ' + JSON.stringify(wide.chip));

    const named = String(wide.chip || '')
      .replace(/^More columns · /, '').replace(/ ›$/, '');
    await clickText(page, wide.chip);
    await settle(page, 300);
    const afterChip = await shape(page);
    check('and the chip goes there',
      !!afterChip.content && afterChip.content.sl > 0,
      'the grid is at ' + JSON.stringify((afterChip.content || {}).sl));
    const groupSeen = await page.evaluate((title) => {
      const content = document.querySelector('.rw-grid .jss_content');
      const heads = Array.from(document.querySelectorAll('.rw-grid thead td'));
      const head = heads.filter((td) => String(td.textContent || '').trim() === title)[0];
      if (!content || !head) return null;
      const box = content.getBoundingClientRect();
      const r = head.getBoundingClientRect();
      return { left: Math.round(r.left - box.left), width: Math.round(r.width) };
    }, named);
    check('the group it named is on screen once it has',
      !!groupSeen && groupSeen.left >= 0 && groupSeen.width > 0,
      'the ' + JSON.stringify(named) + ' header sits at ' + JSON.stringify(groupSeen));

    await scrollGrid(page, -1);
    await settle(page, 300);
    const atEnd = await shape(page);
    await page.screenshot({ path: path.join(shots, 'scrolled-to-the-end.png') });
    check('at the right-hand end nothing claims to be hidden',
      atEnd.edge === null && atEnd.chip === null,
      'edge ' + JSON.stringify(atEnd.edge) + ', chip ' + JSON.stringify(atEnd.chip));
    await scrollGrid(page, 0);
    await settle(page, 250);

    /* -- 4. a table that fits is left alone -------------------------- */
    section('a table that fits');
    await clickText(page, NARROW_SECTION);
    await settle(page, 900);
    const narrow = await shape(page);
    check('a narrow table keeps the prose measure',
      !!narrow.wideCard && Math.abs(narrow.wideCard.w - MEASURE) <= 2,
      'the card is ' + JSON.stringify(narrow.wideCard && narrow.wideCard.w) + 'px wide');
    check('and carries no edge cue at all',
      narrow.edge === null && narrow.chip === null,
      'edge ' + JSON.stringify(narrow.edge) + ', chip ' + JSON.stringify(narrow.chip));
    await clickText(page, WIDE_SECTION);
    await settle(page, 900);

    /* -- 5. the reader has the last word on the height --------------- */
    section('the height handle');
    const grip = await gripPoint(page);
    check('the grid has a handle on its bottom edge', !!grip, 'no .rw-gridgrip on screen');
    if (grip) {
      const before = (await shape(page)).content.ch;
      await page.mouse.move(grip.x, grip.y);
      await page.mouse.down();
      await page.mouse.move(grip.x, grip.y - 60, { steps: 6 });
      await page.mouse.move(grip.x, grip.y - 140, { steps: 8 });
      await page.mouse.up();
      await settle(page, 300);
      const dragged = (await shape(page)).content.ch;
      check('a drag on it sets the height',
        Math.abs((before - dragged) - 140) <= 12,
        'the box went from ' + before + ' to ' + dragged + ', asked for ' + (before - 140));

      await clickText(page, NARROW_SECTION);
      await settle(page, 700);
      await clickText(page, WIDE_SECTION);
      await settle(page, 900);
      const kept = (await shape(page)).content.ch;
      check('and the height survives leaving the section',
        Math.abs(kept - dragged) <= 4,
        'it came back at ' + kept + ', it was left at ' + dragged);

      const again = await gripPoint(page);
      if (again) {
        await page.mouse.dblclick(again.x, again.y);
        await settle(page, 350);
        const reset = (await shape(page)).content.ch;
        check('a double-click hands the height back to the pane',
          reset > kept + 40 && Math.abs(reset - before) <= 4,
          'it went to ' + reset + ', the pane had offered ' + before);
      }
    }

    /* -- 6. full screen ---------------------------------------------- */
    section('full screen');
    const cell = await cellPoint(page, 5, 3);
    check('there is a cell to put the cursor on', !!cell, 'no reachable cell at 5,3');
    if (cell) await page.mouse.click(cell.x, cell.y);
    await settle(page, 250);
    const selectedBefore = await selectedCell(page);

    const beforeFull = await shape(page);
    const opened = await clickText(page, 'Full screen');
    check('the table can be opened full screen', opened, 'no Full screen control');
    await settle(page, 450);
    const inFull = await shape(page);
    await page.screenshot({ path: path.join(shots, 'full-screen.png') });
    check('the panel fills the window, less its margins',
      !!inFull.full && inFull.full.h > VIEWPORT.height * 0.85
        && inFull.full.w >= Math.min(inFull.natural, VIEWPORT.width * 0.95) - 4,
      'the panel is ' + JSON.stringify(inFull.full));
    check('and the grid grew with it',
      !!inFull.content && !!beforeFull.content
        && inFull.content.ch > beforeFull.content.ch + 100,
      'the box went from ' + (beforeFull.content || {}).ch
        + ' to ' + (inFull.content || {}).ch);
    check('the canvas behind does not close up',
      Math.abs(inFull.canvasScrollH - beforeFull.canvasScrollH) <= 4,
      'the canvas was ' + beforeFull.canvasScrollH + ' tall and is now ' + inFull.canvasScrollH);
    const selectedAfter = await selectedCell(page);
    check('the grid is the same one -- it kept the cell that was selected',
      !!selectedBefore && selectedAfter === selectedBefore,
      'it was on ' + JSON.stringify(selectedBefore) + ' and is on ' + JSON.stringify(selectedAfter));

    /* -- 7. a menu inside a fixed panel ------------------------------- */
    const inner = await cellPoint(page, 6, 4);
    check('there is a cell to point at inside the panel', !!inner, 'no reachable cell at 6,4');
    if (inner) {
      await page.mouse.click(inner.x, inner.y, { button: 'right' });
      await settle(page, 350);
      const menu = await page.evaluate(() => {
        const el = document.querySelector('.rw-menu');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          left: Math.round(r.left), top: Math.round(r.top),
          position: window.getComputedStyle(el).position,
        };
      });
      await page.screenshot({ path: path.join(shots, 'menu-in-full-screen.png') });
      check('a menu opened in the panel lands under the pointer',
        !!menu && Math.abs(menu.left - inner.x) <= 6 && Math.abs(menu.top - inner.y) <= 6,
        'the pointer was at ' + Math.round(inner.x) + ',' + Math.round(inner.y)
          + ' and the menu is at ' + JSON.stringify(menu));
      await page.keyboard.press('Escape');
      await settle(page, 250);
    }

    await page.keyboard.press('Escape');
    await settle(page, 350);
    const back = await shape(page);
    check('Escape comes back out of full screen',
      back.full === null && !!back.wideCard && back.wideCard.w > MEASURE,
      'the panel is ' + JSON.stringify(back.full));
    check('and the card is the width it was',
      !!back.wideCard && !!beforeFull.wideCard
        && Math.abs(back.wideCard.w - beforeFull.wideCard.w) <= 2,
      'it came back at ' + (back.wideCard || {}).w
        + ', it was ' + (beforeFull.wideCard || {}).w);

    if (consoleErrors.length) {
      check('no console errors', false, consoleErrors.slice(0, 4).join(' | '));
    } else {
      console.log('');
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
