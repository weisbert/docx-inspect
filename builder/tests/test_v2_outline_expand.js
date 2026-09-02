#!/usr/bin/env node
'use strict';
/*
 * test_v2_outline_expand.js -- a twisty that opens actually shows something.
 *
 * Run:  node builder/tests/test_v2_outline_expand.js
 *       node builder/tests/test_v2_outline_expand.js --headed   (watch it work)
 *
 * WHY THIS FILE EXISTS
 *   The outline rail draws the first two levels unconditionally and hides
 *   anything deeper behind its parent's twisty. Two rules decide that, and they
 *   disagreed about which rows own an expanded state:
 *
 *     OutlineRow   canTwisty = hasChildren && row.depth >= 1
 *                  -- a top-level chapter (depth 0) is NEVER given a twisty,
 *                     because its sections are already on screen.
 *     visibleRows  a row deeper than 1 is shown only if EVERY ancestor is in
 *                  `expanded` -- the depth-0 chapter included.
 *
 *   So a grandchild demanded that its chapter be expanded, and the chapter had
 *   no control that could expand it. `expanded[chapter]` stayed false for the
 *   life of the session, and EVERY depth-2 row in EVERY report was unreachable:
 *   a section with children showed a twisty, the twisty turned from > to v, and
 *   nothing appeared underneath it. Reported from a real report as "5.3
 *   Simulation Results says it can expand, but expanding shows nothing".
 *
 *   The only way a chapter's flag could ever go true was adding a subsection
 *   (the create path sets it), which is why the bug could hide in a session
 *   that happened to build the tree by hand.
 *
 * WHAT IT ASSERTS
 *   static (no browser needed):
 *     1. the rail's two always-on levels: chapters and their sections show with
 *        nothing expanded at all;
 *     2. expanding ONLY the section reveals that section's children -- the
 *        chapter above it is not a gate, because it has no twisty;
 *     3. collapsing the section hides them again;
 *     4. depth 3 still needs its own parent: expanding the section is not
 *        enough, expanding the subsection too is;
 *     5. a gate is exactly a row that renders a twisty -- the set of rows that
 *        can hold an expanded state and the set that draw the control are the
 *        same set, which is the invariant the bug broke;
 *     6. search is unaffected: a hit deeper than 2 shows with its ancestors and
 *        no expansion at all.
 *   in a real browser, against a generated report on disk:
 *     7. the rail opens with the chapter and its sections and no grandchildren;
 *     8. clicking the section's twisty puts its three children on screen, with
 *        their real section numbers;
 *     9. clicking it again takes them away;
 *    10. no console errors during any of it.
 *
 * AGAINST THE PRE-FIX FILE: assertions 2, 4, 5 and 8 fail -- 2 and 8 because
 * the rows stay hidden, 4 for the same reason one level down, and 5 because
 * depth-0 rows gate without being able to draw a twisty. The teeth for the
 * static ones are demonstrated inline against a copy of the old rule.
 *
 * IT NEVER TOUCHES REAL REPORTS. The fixture is generated from scratch into the
 * OS temporary directory and the server is booted against THAT with an explicit
 * --root, exactly as the other v2 browser tests are.
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
const { spawn } = require('node:child_process');

const HERE = __dirname;
const REPO = path.resolve(HERE, '..', '..');
const SERVER_PY = path.join(REPO, 'builder', 'web', 'server.py');
const V2_JS = path.join(REPO, 'builder', 'web', 'assets', 'v2', 'js');

const ARGS = process.argv.slice(2);
const HEADED = ARGS.includes('--headed');
const KEEP_ROOT = ARGS.includes('--keep-root');
const VIEWPORT = { width: 1440, height: 900 };

let chromium = null;
try {
  chromium = require('playwright-core').chromium;
} catch (err) {
  chromium = null;
}

/* ------------------------------------------------------------------ *
 * the fixture -- a four-level tree, the shape the bug was found in
 * ------------------------------------------------------------------ */

const PROJECT_ID = '1108';
const MODULE_ID = 'CLKDIV_5G';
const REPORT_DIR = PROJECT_ID + '/' + MODULE_ID + '/CDR';

const CHAPTER = 'Measurement methods and results';   // depth 0  -> "5"
const SECTION = 'Measured results';                  // depth 1  -> "5.3"
const SUBS = ['Function check', 'Timing', 'Power'];  // depth 2  -> "5.3.1..3"
const LEAF = 'Mode path check';                      // depth 3  -> "5.3.1.1"

function para(t) {
  return { type: 'para', runs: [{ t: t }] };
}

function node(id, title, children, text) {
  return {
    id: id, title: title,
    blocks: text ? [para(text)] : [],
    children: children || [],
  };
}

function sampleOutline() {
  return [
    node('n-intro', 'Objective', [], 'What this document sets out to show.'),
    node('n-chapter', CHAPTER, [
      node('n-strategy', 'Strategy and test bench', [], 'How the runs are set up.'),
      node('n-setting', 'Setting and condition', [], 'The conditions every run shares.'),
      node('n-results', SECTION, [
        node('n-sub-0', SUBS[0], [
          node('n-leaf', LEAF, [], 'The deepest row in the tree.'),
        ], 'Divider function over the whole code range.'),
        node('n-sub-1', SUBS[1], [], 'Edge timing at the nominal corner.'),
        node('n-sub-2', SUBS[2], [], 'Current in each mode.'),
      ]),
    ]),
  ];
}

function sampleReport() {
  return {
    template: 'sample',
    meta: {
      title: MODULE_ID + ' report', doc_no: 'DOC-1', version: 'V1.0',
      secrecy: 'Internal', author: 'A. Engineer', date: '2026-09-02',
      reviewers: [], approver: '', revisions: [],
    },
    outline: sampleOutline(),
  };
}

function sampleTemplateConfig() {
  return {
    id: 'sample', name: 'Sample template',
    caption_prefix: { figure: 'Figure', table: 'Table' },
    toc: { enabled: true },
    skeleton: [{ title: 'Objective', children: [] }],
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

function section(title) {
  console.log('');
  console.log(title);
}

// What the rail shows, as one readable line: "5 Chapter | 5.3 Section | ...".
function shown(rows) {
  return rows.map((r) => r.number + ' ' + r.node.title).join(' | ');
}

/* ------------------------------------------------------------------ *
 * static assertions
 * ------------------------------------------------------------------ */

// editor.js is a browser module: it reads the vendor UMD globals as it loads.
// These stubs are only enough for the module body to evaluate; the functions
// under test are pure and touch none of them.
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

// The rule as it stood before the fix, kept here so the teeth are visible next
// to the assertions rather than asserted in a comment: every ancestor gates,
// including the depth-0 chapter that has no twisty to open it with.
function visibleRowsOld(rows, query, expanded, findRow) {
  return rows.filter((row) => {
    if (row.depth <= 1) return true;
    let parent = row.parent;
    while (parent) {
      if (!expanded[parent.id]) return false;
      const parentRow = findRow(rows, parent.id);
      parent = parentRow ? parentRow.parent : null;
    }
    return true;
  });
}

async function staticChecks() {
  installBrowserStubs();
  const mod = await import(pathToFileURL(path.join(V2_JS, 'views', 'editor.js')).href);
  const flattenOutline = mod.flattenOutline;
  const visibleRows = mod.visibleRows;

  if (typeof flattenOutline !== 'function' || typeof visibleRows !== 'function') {
    check('editor.js exports flattenOutline and visibleRows', false,
      'visibleRows must be exported for the rail rule to be testable');
    return;
  }

  const rows = flattenOutline(sampleOutline());
  const findRow = (list, id) => list.find((r) => r.node.id === id) || null;
  const byTitle = (t) => rows.find((r) => r.node.title === t);

  const chapter = byTitle(CHAPTER);
  const results = byTitle(SECTION);
  const sub0 = byTitle(SUBS[0]);

  section('the tree the rail is given');
  check('the chapter is depth 0', chapter && chapter.depth === 0,
    'depth=' + (chapter && chapter.depth));
  check('the section is depth 1 and numbered 5.3',
    results && results.depth === 1 && results.number === '2.3',
    results ? results.depth + ' / ' + results.number : 'missing');
  check('its children are depth 2', sub0 && sub0.depth === 2,
    'depth=' + (sub0 && sub0.depth));

  /* ---- 1. the two always-on levels ---- */

  section('nothing expanded');
  const closed = visibleRows(rows, '', {});
  const closedTitles = closed.map((r) => r.node.title);
  check('the chapter and its sections are on screen',
    closedTitles.includes(CHAPTER) && closedTitles.includes(SECTION),
    shown(closed));
  check('no grandchild is on screen',
    SUBS.every((t) => !closedTitles.includes(t)), shown(closed));

  /* ---- 2. the bug: opening the section shows its children ---- */

  section('the section alone is expanded (the reported bug)');
  const openOne = {};
  openOne[results.node.id] = true;
  const afterOpen = visibleRows(rows, '', openOne);
  const afterTitles = afterOpen.map((r) => r.node.title);
  check('all three children appear',
    SUBS.every((t) => afterTitles.includes(t)), shown(afterOpen));
  check('the leaf below them does not', !afterTitles.includes(LEAF), shown(afterOpen));

  // teeth: the same input through the old rule shows nothing new at all
  const oldOpen = visibleRowsOld(rows, '', openOne, findRow)
    .map((r) => r.node.title);
  check('TEETH: the old rule showed none of them',
    SUBS.every((t) => !oldOpen.includes(t)),
    'old rule -> ' + oldOpen.join(' | '));

  /* ---- 3. closing it again ---- */

  section('the section is collapsed again');
  const reclosed = visibleRows(rows, '', { [results.node.id]: false })
    .map((r) => r.node.title);
  check('the children go away', SUBS.every((t) => !reclosed.includes(t)),
    reclosed.join(' | '));

  /* ---- 4. depth 3 needs its own parent, not the chapter ---- */

  section('one level deeper');
  const openTwo = {};
  openTwo[results.node.id] = true;
  openTwo[sub0.node.id] = true;
  const deep = visibleRows(rows, '', openTwo).map((r) => r.node.title);
  check('expanding the subsection too reveals the leaf', deep.includes(LEAF),
    deep.join(' | '));
  const deepOld = visibleRowsOld(rows, '', openTwo, findRow).map((r) => r.node.title);
  check('TEETH: the old rule hid the leaf as well', !deepOld.includes(LEAF),
    'old rule -> ' + deepOld.join(' | '));

  /* ---- 5. a gate is exactly a row that draws a twisty ---- */

  section('gates and twisties are the same set');
  // OutlineRow: canTwisty = hasChildren && row.depth >= 1
  const drawsTwisty = rows
    .filter((r) => (r.node.children || []).length > 0 && r.depth >= 1)
    .map((r) => r.node.id);
  // A gate: a row whose expanded flag changes what the rail shows.
  const gates = [];
  for (let i = 0; i < rows.length; i++) {
    const only = {};
    for (let k = 0; k < rows.length; k++) only[rows[k].node.id] = true;
    const withAll = visibleRows(rows, '', only).length;
    const minusOne = Object.assign({}, only);
    minusOne[rows[i].node.id] = false;
    if (visibleRows(rows, '', minusOne).length !== withAll) gates.push(rows[i].node.id);
  }
  gates.sort();
  drawsTwisty.sort();
  check('every gate has a twisty and every twisty is a gate',
    gates.join(',') === drawsTwisty.join(','),
    'gates=[' + gates.join(',') + ']  twisties=[' + drawsTwisty.join(',') + ']');

  /* ---- 6. search still reaches the deep rows with nothing expanded ---- */

  section('search');
  const hits = visibleRows(rows, LEAF.slice(0, 9), {}).map((r) => r.node.title);
  check('a deep hit shows with its ancestors and no expansion',
    hits.includes(LEAF) && hits.includes(SECTION) && hits.includes(CHAPTER),
    hits.join(' | '));
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

const settle = (page, ms) => page.waitForTimeout(ms == null ? 350 : ms);

// The rail's rows as the reader sees them: "number title".
function railRows(page) {
  return page.$$eval('.rw-tree__row', (els) => els.map((el) => {
    const num = el.querySelector('.rw-tree__count');
    return ((num ? num.textContent : '') + ' ' + (el.textContent || ''))
      .replace(/\s+/g, ' ').trim();
  }));
}

async function clickTwistyOf(page, title) {
  const handle = await page.evaluateHandle((wanted) => {
    const rows = Array.from(document.querySelectorAll('.rw-tree__row'));
    const row = rows.find((el) => (el.textContent || '').indexOf(wanted) >= 0);
    return row ? row.querySelector('.rw-tree__twisty') : null;
  }, title);
  const el = handle.asElement();
  if (!el) return 'no row for ' + title;
  const glyph = (await el.textContent() || '').trim();
  if (!glyph) return 'the row for ' + title + ' draws no twisty';
  await el.click();
  return 'ok';
}

async function browserChecks() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const scratch = path.join(os.tmpdir(), 'report-workbench-v2-outline-expand', stamp);
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
    await settle(page, 1400);

    /* ---- 7. what the rail opens with ---- */

    section('the rail in a real browser');
    const opening = await railRows(page);
    console.log('  rail: ' + opening.join(' | '));
    check('the chapter and its sections are there',
      opening.some((r) => r.indexOf(CHAPTER) >= 0)
      && opening.some((r) => r.indexOf(SECTION) >= 0),
      opening.join(' | '));
    check('no grandchild is there yet',
      SUBS.every((t) => !opening.some((r) => r.indexOf(t) >= 0)),
      opening.join(' | '));

    /* ---- 8. opening the section ---- */

    const opened = await clickTwistyOf(page, SECTION);
    if (opened !== 'ok') {
      check('the section offers a twisty', false, opened);
    } else {
      await settle(page, 400);
      const after = await railRows(page);
      console.log('  rail: ' + after.join(' | '));
      check('its three children are on screen',
        SUBS.every((t) => after.some((r) => r.indexOf(t) >= 0)),
        after.join(' | '));
      check('they carry their real section numbers',
        after.some((r) => r.indexOf('2.3.1') === 0),
        after.join(' | '));

      /* ---- 9. closing it again ---- */

      const closed = await clickTwistyOf(page, SECTION);
      await settle(page, 400);
      const back = await railRows(page);
      check('clicking again takes them away',
        closed === 'ok' && SUBS.every((t) => !back.some((r) => r.indexOf(t) >= 0)),
        back.join(' | '));
    }

    /* ---- 10. a clean console ---- */

    check('no console errors', consoleErrors.length === 0,
      consoleErrors.slice(0, 4).join(' ;; '));
  } finally {
    await cleanup();
  }
}

/* ------------------------------------------------------------------ */

async function main() {
  console.log('test_v2_outline_expand -- the outline rail\'s twisty');
  await staticChecks();

  if (!chromium) {
    console.log('');
    console.log('  SKIP: playwright-core is not installed; static half only.');
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
