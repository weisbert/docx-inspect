#!/usr/bin/env node
'use strict';
/*
 * test_v2_card_move.js -- the card-move rule, asserted twice: once against the
 * pure function, and once against what a real browser writes to disk.
 *
 * Run:  node builder/tests/test_v2_card_move.js
 *       node builder/tests/test_v2_card_move.js --headed     (watch it work)
 *
 * WHY THIS FILE EXISTS
 *   A prose card is a RANGE of consecutive paragraph blocks, and a card
 *   boundary is recorded in only one place: `cardStart` on the first block of a
 *   run. So a move can destroy the document's card structure in two opposite
 *   ways, and both survive the save with nothing to undo them:
 *
 *     SPLITTING   -- stepping by a single block offset drops the moved card
 *                    INSIDE a two-paragraph prose card and cuts it in half.
 *     WELDING     -- landing so that two prose runs become adjacent lets
 *                    groupBlocks swallow the second run into the first, because
 *                    a paragraph without cardStart reads as "continues the card
 *                    above". Three cards become two, and moving the card back
 *                    does NOT undo it: by then the boundary is gone from the
 *                    document, so there is nothing left to restore.
 *
 *   Welding is the common case, not the exotic one. Legacy content carries no
 *   cardStart anywhere, so EVERY paragraph in it reads as a continuation, and
 *   any figure moved past one welds it to whatever prose now precedes it.
 *
 * WHAT IT ASSERTS
 *   static (no browser needed):
 *     1. the three-card legacy fixture [A] <FIG> [B] survives a move down and a
 *        move back -- three cards before, three after, same order, same
 *        boundaries;
 *     2. a move that makes two prose runs adjacent stamps cardStart on the
 *        second run's first block, and copies that block rather than editing
 *        the caller's document in place;
 *     3. the move is still a no-op at either end and at a non-boundary index;
 *     4. nothing in the tree imports BlockCanvas -- there is one canvas, and
 *        js/views/editor.js draws it.
 *   in a real browser, against project.json on disk:
 *     5. a figure moved up past a two-paragraph prose card clears BOTH
 *        paragraphs and does not split the card;
 *     6. moving it back down returns the section to its starting shape;
 *     7. the same down-then-up round trip on the three-card legacy fixture
 *        returns the same three cards, in the same order;
 *     8. the over-spec count comes from the shared numeric parser, so a value
 *        the engine cannot read as a number ("0x10") never counts as over spec.
 *
 * Assertions 1 and 7 FAIL against a mover that does not stamp cardStart, and
 * assertions 5 and 6 FAIL against a plus-or-minus-one block offset; the teeth
 * are demonstrated inline, next to each one.
 *
 * IT NEVER TOUCHES REAL REPORTS. The fixture is generated from scratch into the
 * OS temporary directory and the server is booted against THAT with an explicit
 * --root, exactly as the smoke test is.
 *
 * SKIPPING IS A FEATURE: no playwright-core (the public repository carries no
 * node_modules) or no system browser still runs the static half and exits 0.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const { spawn, spawnSync } = require('node:child_process');

const HERE = __dirname;
const REPO = path.resolve(HERE, '..', '..');
const SERVER_PY = path.join(REPO, 'builder', 'web', 'server.py');
const V2_JS = path.join(REPO, 'builder', 'web', 'assets', 'v2', 'js');

const ARGS = process.argv.slice(2);
const HEADED = ARGS.includes('--headed');
const KEEP_ROOT = ARGS.includes('--keep-root');
const VIEWPORT = { width: 1440, height: 900 };

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

const SECTION = 'Design description';
const FIGURE_ID = 'b-figure-1';
const P1 = 'The divider takes a differential input and produces a divided clock.';
const P2 = 'The second paragraph of the same card, so the card has a span to split.';

// The second section is the WELDING shape, written the way legacy content is:
// the trailing paragraph carries no cardStart at all, so it only reads as its
// own card while the figure keeps it apart from the paragraph above.
const SECTION2 = 'Simulation setup';
const FIGURE2_ID = 'b-figure-2';
const A1 = 'The first card of the section, ending before the figure.';
const B1 = 'A separate card after the figure, carrying no cardStart of its own.';

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function para(t, cardStart) {
  const block = { type: 'para', runs: [{ t: t }] };
  if (cardStart) block.cardStart = true;
  return block;
}

function figure(id, caption) {
  return {
    type: 'image', id: id, file: 'images/divider_response.png',
    caption: caption, width_cm: 8,
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
        id: 'n-design',
        title: SECTION,
        // The SPLITTING shape: one prose card of TWO paragraphs, then a figure.
        // Moving the figure up must clear both paragraphs.
        blocks: [
          para(P1, true),
          para(P2),
          figure(FIGURE_ID, 'Divider output over temperature'),
        ],
        children: [],
      },
      {
        id: 'n-setup',
        title: SECTION2,
        // The WELDING shape: three cards, and the third one's boundary exists
        // only because the figure sits between the two prose runs.
        blocks: [
          para(A1, true),
          figure(FIGURE2_ID, 'Test bench'),
          para(B1),
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
    skeleton: [{ title: SECTION, children: [] }, { title: SECTION2, children: [] }],
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

// A 160x90 checkerboard, so the figure block has something real to load.
const SAMPLE_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAKAAAABaCAAAAAAarQKOAAAAaUlEQVR42u3XsREAQARFQWVficq6jBa+mRWKNuNVz7yZpF0B' +
  'AgICAoYDM1m7AwQEBARMB7rFgICAgICaBBAQEBBQk3gWAAEBATWJZwEQEBBQk7jFgICAgICaBBAQEBBQk3gWAAEBAY8BP3KI' +
  'Kg5OSOamAAAAAElFTkSuQmCC';

function buildReportsRoot(root) {
  fs.mkdirSync(root, { recursive: true });
  writeJson(path.join(root, 'templates', 'sample', 'config.json'), sampleTemplateConfig());
  writeJson(path.join(root, 'templates', 'sample', 'skeleton.json'), sampleTemplateConfig().skeleton);
  writeJson(path.join(root, PROJECT_ID, 'project_meta.json'), { name: 'Sample project' });
  writeJson(path.join(root, PROJECT_ID, MODULE_ID, 'project_meta.json'), { name: MODULE_ID });
  const reportDir = path.join(root, ...REPORT_DIR.split('/'));
  writeJson(path.join(reportDir, 'project.json'), sampleReport());
  fs.mkdirSync(path.join(reportDir, 'images'), { recursive: true });
  fs.writeFileSync(path.join(reportDir, 'images', 'divider_response.png'),
    Buffer.from(SAMPLE_PNG_B64, 'base64'));
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
 * shapes
 *
 * Two of them, and the difference is the whole point of this file:
 *
 *   blockShape() is the raw block list, cardStart marked with '*'.
 *   cardShape()  is what the reader SEES -- the cards groupBlocks builds out of
 *                that list. A weld is invisible in the first and obvious in the
 *                second, which is why the contract is written over the second.
 * ------------------------------------------------------------------ */

// Filled from the real js/util.js in main(), so this file cannot drift from the
// grouping rule the interface actually uses.
let groupBlocks = null;

function blockShape(blocks) {
  return (blocks || []).map((b) => {
    if (!b) return '?';
    if (b.type === 'para') {
      const t = ((b.runs || [])[0] || {}).t || '';
      return 'para' + (b.cardStart ? '*' : '') + '(' + t.slice(0, 12) + ')';
    }
    return b.type + '(' + (b.id || '') + ')';
  }).join(' , ');
}

function cardShape(blocks) {
  return groupBlocks(blocks || []).map((card) => {
    if (card.kind === 'prose') {
      return '[' + card.blocks
        .map((b) => (((b.runs || [])[0] || {}).t || '').slice(0, 8))
        .join(' | ') + ']';
    }
    const block = card.block || {};
    return '<' + (block.id || block.type || '?') + '>';
  }).join(' ');
}

/* ------------------------------------------------------------------ *
 * static assertions -- the pure mover, and the one-canvas rule
 * ------------------------------------------------------------------ */

// blocks.js is a browser module: it reads the vendor UMD globals as it loads.
// These stubs are only enough for the module body to evaluate, because the
// function under test is pure and touches none of them.
function installBrowserStubs() {
  globalThis.preact = { h: () => null, Fragment: {}, render: () => {} };
  globalThis.preactHooks = {
    useState: () => [null, () => {}],
    useEffect: () => {},
    useLayoutEffect: () => {},
    useRef: () => ({ current: null }),
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useId: () => 'id',
  };
  globalThis.htm = { bind: () => () => null };
}

// The legacy three-card shape, as a fresh array each time.
const weldFixture = () => [para(A1, true), figure(FIGURE2_ID, ''), para(B1)];

async function staticChecks() {
  section('the pure mover');

  installBrowserStubs();
  const blocksMod = await import(pathToFileURL(path.join(V2_JS, 'views', 'blocks.js')).href);
  const moveCardBySpan = blocksMod.moveCardBySpan;
  if (typeof moveCardBySpan !== 'function') {
    check('blocks.js exports moveCardBySpan', false, 'no such export');
    return;
  }

  const start = weldFixture();
  const startCards = cardShape(start);
  check('the fixture starts as three cards', startCards === '[' + A1.slice(0, 8) + '] <'
    + FIGURE2_ID + '> [' + B1.slice(0, 8) + ']', startCards);

  // Teeth. This is the move WITHOUT the cardStart rule -- the same splice, the
  // stamping left out -- and it welds the two prose runs into one card. Every
  // assertion below is only interesting because this one holds.
  const naive = weldFixture();
  const lifted = naive.splice(1, 1);
  naive.splice(2, 0, lifted[0]);
  check('an unstamped move welds the two prose runs into ONE card (the defect)',
    groupBlocks(naive).length === 2, 'cards are: ' + cardShape(naive));

  /* ---- 1. down, then back up, returns the same three cards ---- */

  const down = moveCardBySpan(start, 1, 1, 1);
  check('moving the figure down leaves three cards, not two',
    groupBlocks(down).length === 3, 'cards are: ' + cardShape(down));
  check('the two prose runs stay separate cards, in order',
    cardShape(down) === '[' + A1.slice(0, 8) + '] [' + B1.slice(0, 8) + '] <' + FIGURE2_ID + '>',
    'cards are: ' + cardShape(down));

  const back = moveCardBySpan(down, 2, 1, -1);
  check('moving it back up restores the original card structure exactly',
    cardShape(back) === startCards,
    'cards are: ' + cardShape(back) + '   (started as ' + startCards + ')');

  /* ---- 2. the stamp, and where it is written ---- */

  check('the second run\'s first block is stamped cardStart',
    down[1] && down[1].type === 'para' && down[1].cardStart === true,
    'blocks are: ' + blockShape(down));
  check('the stamp does not edit the caller\'s document in place',
    start[2] && start[2].cardStart === undefined,
    'the input array now reads: ' + blockShape(start));
  check('nothing else was stamped',
    down.filter((b) => b && b.type === 'para' && b.cardStart).length === 2,
    'blocks are: ' + blockShape(down));

  /* ---- 3. still a no-op where it always was ---- */

  const ends = weldFixture();
  check('the first card cannot move up', moveCardBySpan(ends, 0, 1, -1) === ends);
  check('the last card cannot move down', moveCardBySpan(ends, 2, 1, 1) === ends);
  const spanning = [para(P1, true), para(P2), figure(FIGURE_ID, '')];
  check('an index that is not a card boundary is a no-op',
    moveCardBySpan(spanning, 1, 1, -1) === spanning);
  check('an empty section is a no-op', moveCardBySpan([], 0, 1, -1).length === 0);

  /* ---- 4. one canvas ---- */

  section('one canvas, drawn by js/views/editor.js');
  // Two halves, because either alone can pass while the surface is still there:
  // the module must not publish the name, AND no file may still reach for it.
  check('blocks.js no longer exports a canvas of its own',
    blocksMod.BlockCanvas === undefined && blocksMod.default === undefined,
    'exports: ' + Object.keys(blocksMod).sort().join(', '));

  const hits = scanFor('BlockCanvas');
  check('nothing in the tree imports or exports BlockCanvas',
    hits.length === 0, hits.slice(0, 5).join(' | '));
}

// `grep -a -rn <needle> builder/`, minus this file, which names the thing it is
// asserting the absence of and is therefore the one legitimate hit.
//
// The -a matters: js/views/table.js contains a literal NUL byte, so a plain
// `grep -rn` calls that file binary, prints "Binary file ... matches" and lists
// NO lines -- a tree-wide search silently skips the largest view. Both scans
// below read bytes as text, so neither can skip it.
//
// The real grep runs first when it is on PATH; the in-process walk runs always,
// so the assertion still means something on a machine without grep, and a
// disagreement between the two is reported rather than hidden.
const SELF = path.relative(REPO, __filename).replace(/\\/g, '/');

function scanFor(needle) {
  const hits = [];
  const add = (rel, lineNo) => {
    if (rel === SELF) return;
    const at = rel + ':' + lineNo;
    if (hits.indexOf(at) < 0) hits.push(at);
  };

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '__pycache__') continue;
        walk(full);
        continue;
      }
      if (!/\.(js|mjs|cjs|html|py|json|css)$/i.test(entry.name)) continue;
      const text = fs.readFileSync(full, 'latin1');
      if (text.indexOf(needle) < 0) continue;
      const rel = path.relative(REPO, full).replace(/\\/g, '/');
      text.split('\n').forEach((line, i) => {
        if (line.indexOf(needle) >= 0) add(rel, i + 1);
      });
    }
  };

  const grep = spawnSync('grep', ['-a', '-rn', needle, 'builder'],
    { cwd: REPO, encoding: 'utf8' });
  if (grep.error || typeof grep.stdout !== 'string') {
    console.log('  [note] grep is not on PATH -- the in-process scan is the whole assertion');
  } else {
    const lines = grep.stdout.split('\n').filter((line) => line.trim());
    const other = lines.filter((line) => line.indexOf(SELF + ':') !== 0);
    console.log('  [note] grep -a -rn ' + needle + ' builder/  ->  ' + lines.length
      + ' line(s), ' + other.length + ' outside this test file');
    other.forEach((line) => {
      const parts = line.split(':');
      add(parts[0].replace(/\\/g, '/'), parts[1]);
    });
  }
  walk(path.join(REPO, 'builder'));
  return hits;
}

/* ------------------------------------------------------------------ *
 * server lifecycle (same shape as the smoke test)
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

function readBlocks(reportsRoot, at) {
  const file = path.join(reportsRoot, ...REPORT_DIR.split('/'), 'project.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  return ((doc.outline || [])[at || 0] || {}).blocks || [];
}

// Poll the file until the debounced autosave has landed the shape we are
// waiting for, or the deadline passes -- then whatever is there is the answer.
async function waitForBlocks(reportsRoot, at, predicate, timeoutMs) {
  const until = Date.now() + (timeoutMs == null ? 4000 : timeoutMs);
  for (;;) {
    const last = readBlocks(reportsRoot, at);
    if (predicate(last)) return last;
    if (Date.now() > until) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
}

const settle = (page, ms) => page.waitForTimeout(ms == null ? 350 : ms);

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

// The figure card's own arrow, found through the card wrapper the editor frame
// stamps with the block id -- never a prose card's arrow.
async function clickFigureArrow(page, id, title) {
  const outcome = await page.evaluate((arg) => {
    const slot = document.querySelector('[data-block-id="' + arg.id + '"]');
    if (!slot) return 'no card on screen for ' + arg.id;
    const button = Array.from(slot.querySelectorAll('button')).find((b) => {
      const label = b.getAttribute('title') || b.getAttribute('aria-label') || '';
      return label.replace(/\s+/g, ' ').trim() === arg.title;
    });
    if (!button) return 'no "' + arg.title + '" control on the figure card';
    if (button.disabled) return 'the "' + arg.title + '" control is disabled';
    button.click();
    return 'ok';
  }, { id: id, title: title });
  if (outcome === 'ok') await settle(page);
  return outcome;
}

/* ------------------------------------------------------------------ *
 * the run
 * ------------------------------------------------------------------ */

async function browserChecks() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const scratch = path.join(os.tmpdir(), 'report-workbench-v2-card-move', stamp);
  const reportsRoot = path.join(scratch, 'reports');
  const shots = path.join(scratch, 'screens');
  fs.mkdirSync(shots, { recursive: true });
  buildReportsRoot(reportsRoot);
  console.log('  fixture: ' + reportsRoot);

  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const child = startServer(reportsRoot, port);
  let browser = null;
  let skipped = false;

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
      return false;
    }

    try {
      browser = await chromium.launch({ channel: 'msedge', headless: !HEADED });
    } catch (err) {
      console.log('  SKIP: the system browser could not be launched.');
      console.log('        ' + String(err && err.message ? err.message : err).split('\n')[0]);
      skipped = true;
      return true;
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
    await settle(page, 1200);
    await clickText(page, SECTION);
    await settle(page, 600);

    /* ---- 5/6. a figure jumping a two-paragraph prose card ---- */

    section('a figure moved past a two-paragraph card (in the browser)');
    const before = readBlocks(reportsRoot, 0);
    console.log('  on disk before  : ' + blockShape(before));

    const up = await clickFigureArrow(page, FIGURE_ID, 'Move up');
    if (up !== 'ok') {
      check('the figure card offers Move up', false, up);
    } else {
      await page.keyboard.press('Control+s');       // flush the debounced save
      const after = await waitForBlocks(reportsRoot, 0,
        (b) => b.length === 3 && b[0] && b[0].type === 'image');
      console.log('  on disk after up: ' + blockShape(after));
      await page.screenshot({ path: path.join(shots, 'after-move-up.png') });

      check('the figure lands BEFORE both paragraphs of the prose card',
        after.length === 3 && after[0] && after[0].type === 'image',
        'blocks are: ' + blockShape(after));
      check('the prose card is still whole -- its paragraphs stay adjacent',
        after.length === 3
          && after[1] && after[1].type === 'para' && ((after[1].runs || [])[0] || {}).t === P1
          && after[2] && after[2].type === 'para' && ((after[2].runs || [])[0] || {}).t === P2,
        'blocks are: ' + blockShape(after));
      check('the tail paragraph was not promoted to a card of its own',
        after.length === 3 && after[2] && !after[2].cardStart,
        'blocks are: ' + blockShape(after));

      const down = await clickFigureArrow(page, FIGURE_ID, 'Move down');
      if (down !== 'ok') {
        check('the figure card offers Move down', false, down);
      } else {
        await page.keyboard.press('Control+s');
        const backAgain = await waitForBlocks(reportsRoot, 0,
          (b) => b.length === 3 && b[2] && b[2].type === 'image');
        console.log('  on disk after dn: ' + blockShape(backAgain));
        check('moving it back down restores the original order',
          blockShape(backAgain) === blockShape(before), 'blocks are: ' + blockShape(backAgain));
      }
    }

    /* ---- 7. the legacy three-card round trip, on disk ---- */

    section('three cards, moved and moved back (in the browser)');
    await clickText(page, SECTION2);
    await settle(page, 600);

    const startBlocks = readBlocks(reportsRoot, 1);
    const startCards = cardShape(startBlocks);
    console.log('  on disk before  : ' + startCards);
    check('the section starts as three cards',
      groupBlocks(startBlocks).length === 3, startCards);

    const d2 = await clickFigureArrow(page, FIGURE2_ID, 'Move down');
    if (d2 !== 'ok') {
      check('the figure card offers Move down', false, d2);
    } else {
      await page.keyboard.press('Control+s');
      const moved = await waitForBlocks(reportsRoot, 1,
        (b) => b.length === 3 && b[2] && b[2].type === 'image');
      console.log('  on disk after dn: ' + cardShape(moved) + '   ' + blockShape(moved));
      await page.screenshot({ path: path.join(shots, 'three-cards-after-down.png') });

      check('three cards before, three cards after the move down',
        groupBlocks(moved).length === 3, 'cards are: ' + cardShape(moved));
      check('the second prose run keeps its own boundary, stamped on disk',
        moved[1] && moved[1].type === 'para' && moved[1].cardStart === true,
        'blocks are: ' + blockShape(moved));

      const u2 = await clickFigureArrow(page, FIGURE2_ID, 'Move up');
      if (u2 !== 'ok') {
        check('the figure card offers Move up', false, u2);
      } else {
        await page.keyboard.press('Control+s');
        const restored = await waitForBlocks(reportsRoot, 1,
          (b) => b.length === 3 && b[1] && b[1].type === 'image');
        console.log('  on disk after up: ' + cardShape(restored));
        await page.screenshot({ path: path.join(shots, 'three-cards-after-up.png') });
        check('moving it back returns the same three cards, in the same order',
          cardShape(restored) === startCards,
          'cards are: ' + cardShape(restored) + '   (started as ' + startCards + ')');
      }
    }

    /* ---- 8. the over-spec count uses the shared numeric parser ---- */

    section('the over-spec count');
    const counted = await page.evaluate(async () => {
      let mod;
      try {
        mod = await import('/assets/v2/js/views/editor.js');
      } catch (err) {
        return { error: 'editor.js did not import: ' + String(err && err.message) };
      }
      if (typeof mod.countOverSpec !== 'function') return { error: 'no countOverSpec export' };
      const doc = (simMax) => ({
        outline: [{
          id: 'n', title: 'T', children: [], blocks: [{
            type: 'datatable', id: 'b',
            data: {
              spec_name: 'S',
              sims: [{ key: 'typ', title: 'r', stage: 'CDR', axes: ['MIN', 'TYP', 'MAX'] }],
              rows: [{
                cat: 'Performance', item: 'Current', kind: 'result', unit: 'mA',
                limit: 'le', spec_mtm: [null, null, 4.0],
                sims: { typ: { mtm: [null, null, simMax], ntwc: null } },
              }],
            },
          }],
        }],
      });
      return {
        hex: mod.countOverSpec(doc('0x10')),      // the engine cannot read this
        blank: mod.countOverSpec(doc('   ')),     // nor this
        real: mod.countOverSpec(doc('4.8')),      // this one really is over spec
        ok: mod.countOverSpec(doc('3.9')),
      };
    });
    if (counted.error) {
      check('the over-spec count is reachable', false, counted.error);
    } else {
      check('a value the engine cannot read ("0x10") is not counted as over spec',
        counted.hex === 0, 'counted ' + counted.hex);
      check('a blank value is not counted as over spec',
        counted.blank === 0, 'counted ' + counted.blank);
      check('a value that really is over its spec is counted',
        counted.real === 1, 'counted ' + counted.real);
      check('a value inside its spec is not counted',
        counted.ok === 0, 'counted ' + counted.ok);
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
  return skipped;
}

async function main() {
  const util = await import(pathToFileURL(path.join(V2_JS, 'util.js')).href);
  groupBlocks = util.groupBlocks;

  await staticChecks();

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
