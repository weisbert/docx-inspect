#!/usr/bin/env node
'use strict';
/*
 * test_v2_outline_parity.js -- everything the outline rail lost in the rewrite.
 *
 * Run:  node builder/tests/test_v2_outline_parity.js
 *       node builder/tests/test_v2_outline_parity.js --headed   (watch it work)
 *
 * WHY THIS FILE EXISTS
 *   The old single-file interface let a user do five things to a section that the
 *   new rail could not do at all. None of them failed loudly -- there was simply
 *   no control, which is the kind of gap a screenshot never shows and a test has
 *   to name:
 *
 *     1. change a section's LEVEL. A section written at the wrong depth could
 *        only be fixed by deleting it and typing it again somewhere else, and
 *        dragging moves a section among its siblings but never across levels.
 *     2. override a section pinned to the template's own words (`fixed_body`).
 *        The canvas showed a placeholder card with no controls whatsoever, so
 *        standard text could never be adapted for one report.
 *     3. open or close the whole tree. Only the per-row twisty existed, so
 *        finding a subsection meant opening its chapter by hand, every time.
 *     4. see what KIND a row is. The old rail marked template text, a section
 *        holding a table, and a section the user added; the new one marked none
 *        of them.
 *     5. paste a section. Copying one produced reading text for the assistant
 *        conversation and nothing else -- there was no way to put a section back,
 *        in this report or another.
 *
 * WHAT IT ASSERTS
 *   static (no browser needed):
 *     1. demoteInto / promoteOut move exactly one level and nothing else;
 *     2. a promoted section lands directly BELOW the section it came out of;
 *     3. blocksFromFixedBody mirrors engine._render_fixed_body field for field --
 *        the resolved paragraph style, the runs, the list kind and level;
 *     4. sectionFromPayload accepts the three shapes this product writes and
 *        refuses a whole report and an update delta, by name;
 *     5. the home header's service line is built from the address bar.
 *     6. computeCaptionNumbers agrees with engine.py: a whitespace-only table
 *        caption still consumes a number (no .trim() before the truthiness
 *        check, matching _collect_ref_targets exactly).
 *   in a real browser, against a generated report on disk:
 *     6. the rail marks the template section, the table section and the added
 *        section, and marks nothing else;
 *     7. Expand all puts a depth-2 row on screen, Collapse all takes it away;
 *     8. the row menu offers both level changes, and Raise a level renumbers the
 *        section AND the figure inside it (2.2 / Figure 2-1 -> 3 / Figure 3-1);
 *     9. Alt+-> puts it back, and the numbering follows again;
 *    10. the move survives a save and a reload;
 *    11. a fixed-body section shows its words and an "Edit this text" action;
 *        taking it turns them into an ordinary prose card that survives a reload;
 *    12. Copy whole section then Paste section below inserts the section, with
 *        its blocks, and that survives a reload too;
 *    13. no console errors during any of it.
 *
 * AGAINST THE PRE-FIX FILES every browser assertion from 6 on fails, because the
 * controls do not exist; the static half throws on the missing exports.
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
 * the fixture
 * ------------------------------------------------------------------ */

const PROJECT_ID = '1108';
const MODULE_ID = 'CLKDIV_5G';
const REPORT_DIR = PROJECT_ID + '/' + MODULE_ID + '/CDR';

// A title with nothing to break at: a long unbroken ASCII run, two emoji and a
// right-to-left phrase. It is what a pasted identifier or a title typed in
// another script looks like to a layout engine, and it is the input that pushed
// the whole editor off the right of the window.
const LONG_TITLE = 'Wideband'
  + 'AAAAAAAAAABBBBBBBBBBCCCCCCCCCCDDDDDDDDDDEEEEEEEEEEFFFFFFFFFFGGGGGGGGGG'
  + 'HHHHHHHHHHIIIIIIIIIIJJJJJJJJJJKKKKKKKKKKLLLLLLLLLLMMMMMMMMMMNNNNNNNNNN'
  + 'OOOOOOOOOOPPPPPPPPPPQQQQQQQQQQRRRRRRRRRRSSSSSSSSSSTTTTTTTTTTUUUUUUUUUU'
  + '\u{1F600}\u{1F680}'
  + '\u0627\u0644\u0639\u0631\u0628\u064A\u0629'   // a right-to-left phrase
  + 'VVVVVVVVVVWWWWWWWWWWXXXXXXXXXXYYYYYYYYYY';

const CH_ONE = 'Objective';
const CH_TWO = 'Measurement methods';
const BENCH = 'Test bench';
const RESULTS = 'Measured results';
const DEEP = 'Mode path check';
const PREFACE = 'Standard preface';

const FIXED_KEY = 'preface';
const FIXED_LEAD = 'Scope of this document.';
const FIXED_TAIL = 'The same words appear in every report of this kind.';

function para(t) {
  return { type: 'para', runs: [{ t: t }], cardStart: true };
}

function figure(id, caption) {
  return { type: 'image', id: id, file: '', caption: caption, width_cm: 14.0 };
}

function dataTable(id, caption) {
  return {
    type: 'datatable', id: id, kind: 'compliance', caption: caption,
    data: {
      spec_name: 'Spec', show_spec: true,
      sims: [{ key: 'sim', title: '', stage: 'CDR', axes: ['MIN', 'TYP', 'MAX', 'NTWC'] }],
      rows: [{
        cat: 'Conditions', item: 'Supply', kind: 'common_setting', unit: 'V',
        spec_mtm: [null, null, null], sim_mtm: [null, '1.8', null], sim_ntwc: null,
      }],
    },
  };
}

function sampleOutline() {
  return [
    {
      id: 'n-one', title: CH_ONE, blocks: [figure('b-fig-a', 'Block diagram')],
      children: [],
    },
    {
      id: 'n-two', title: CH_TWO, blocks: [para('How the runs are set up.')],
      children: [
        { id: 'n-bench', title: BENCH, blocks: [dataTable('b-tab-a', 'Bench settings')], children: [] },
        {
          id: 'n-results', title: RESULTS, origin: 'user',
          blocks: [figure('b-fig-b', 'Divider output')],
          children: [{ id: 'n-deep', title: DEEP, blocks: [para('The deepest row.')], children: [] }],
        },
      ],
    },
    { id: 'n-preface', title: PREFACE, fixed_body: FIXED_KEY, blocks: [], children: [] },
    { id: 'n-long', title: LONG_TITLE, blocks: [para('A section with a very long name.')], children: [] },
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

function sampleFixedBodies() {
  return {
    [FIXED_KEY]: {
      style: 'mybody',
      paragraphs: [
        { runs: [{ t: FIXED_LEAD, b: true }] },
        { style: 'body', list: 'bullet', level: 1, runs: [{ t: FIXED_TAIL, i: true, color: '404040' }] },
      ],
    },
  };
}

function sampleTemplateConfig() {
  return {
    id: 'sample', name: 'Sample template',
    caption_prefix: { figure: 'Figure', table: 'Table' },
    toc: { enabled: true },
    skeleton: [{ title: CH_ONE, children: [] }],
    cover: { secrecy_default: 'Internal' },
    styles: {},
    fixed_bodies: sampleFixedBodies(),
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

/* ------------------------------------------------------------------ *
 * static assertions
 * ------------------------------------------------------------------ */

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

// The rail's tree as one readable line: "2.2 Measured results | ...".
function shape(rows) {
  return rows.map((r) => r.number + ' ' + r.node.title).join(' | ');
}

async function staticChecks() {
  installBrowserStubs();
  const editor = await import(pathToFileURL(path.join(V2_JS, 'views', 'editor.js')).href);
  const home = await import(pathToFileURL(path.join(V2_JS, 'views', 'home.js')).href);
  const util = await import(pathToFileURL(path.join(V2_JS, 'util.js')).href);

  const need = ['flattenOutline', 'demoteInto', 'promoteOut',
    'blocksFromFixedBody', 'sectionFromPayload'];
  const missing = need.filter((n) => typeof editor[n] !== 'function');
  if (missing.length) {
    check('editor.js exports the outline operations', false,
      'missing: ' + missing.join(', '));
    return;
  }
  if (typeof home.serviceHost !== 'function') {
    check('home.js exports serviceHost', false, 'the header cannot read its own port');
  }

  /* ---- 1 + 2. changing a level ---- */

  section('changing a section\'s level');

  let outline = sampleOutline();
  let rows = editor.flattenOutline(outline);
  const results = rows.find((r) => r.node.title === RESULTS);
  check('the section starts at 2.2', results && results.number === '2.2',
    results ? results.number : 'missing');

  editor.promoteOut(results, rows);
  rows = editor.flattenOutline(outline);
  const promoted = rows.find((r) => r.node.title === RESULTS);
  check('promoting makes it a chapter', promoted && promoted.depth === 0,
    shape(rows));
  check('and it lands directly below the chapter it came out of',
    promoted && promoted.number === '3', shape(rows));
  check('its own subsection travelled with it',
    rows.some((r) => r.node.title === DEEP && r.number === '3.1'), shape(rows));

  const back = editor.demoteInto(promoted);
  rows = editor.flattenOutline(outline);
  const demoted = rows.find((r) => r.node.title === RESULTS);
  check('demoting puts it back under the section above it',
    demoted && demoted.number === '2.2', shape(rows));
  check('the demote names the row that has to be opened', back === 'n-two', String(back));

  const chapterOne = editor.flattenOutline(outline).find((r) => r.node.title === CH_ONE);
  check('the first chapter cannot be demoted (nothing above it)',
    editor.demoteInto(chapterOne) === null, shape(editor.flattenOutline(outline)));
  check('a chapter cannot be promoted (nowhere to go)',
    editor.promoteOut(chapterOne, editor.flattenOutline(outline)) === false, '');

  /* ---- 3. the fixed body, converted ---- */

  section('a fixed template body as ordinary blocks');
  const blocks = editor.blocksFromFixedBody(sampleFixedBodies()[FIXED_KEY]);
  check('one block per paragraph', blocks && blocks.length === 2,
    blocks ? String(blocks.length) : 'null');
  if (blocks && blocks.length === 2) {
    check('a paragraph with no style of its own takes the body\'s style',
      blocks[0].style === 'mybody', String(blocks[0].style));
    check('a paragraph that names one keeps it', blocks[1].style === 'body',
      String(blocks[1].style));
    check('the runs travel verbatim',
      blocks[0].runs.length === 1 && blocks[0].runs[0].t === FIXED_LEAD
      && blocks[0].runs[0].b === true, JSON.stringify(blocks[0].runs));
    check('list kind and level travel too',
      blocks[1].list === 'bullet' && blocks[1].level === 1,
      blocks[1].list + '/' + blocks[1].level);
    check('the body arrives as one card', blocks[0].cardStart === true
      && !blocks[1].cardStart, JSON.stringify(blocks.map((b) => !!b.cardStart)));
  }
  check('a body the template does not define converts to nothing',
    editor.blocksFromFixedBody(undefined) === null, '');

  /* ---- 4. what counts as a section to paste ---- */

  section('reading a section back in');
  const node = { id: 'n-x', title: BENCH, blocks: [para('one')], children: [] };
  check('a clipboard record', editor.sectionFromPayload(
    JSON.stringify({ v: 1, dir: 'a/b/CDR', node: node })).node.title === BENCH, '');
  check('and it names the report it came from', editor.sectionFromPayload(
    JSON.stringify({ v: 1, dir: 'a/b/CDR', node: node })).dir === 'a/b/CDR', '');
  check('a bare section', editor.sectionFromPayload(JSON.stringify(node)).node.title === BENCH, '');
  check('a report payload holding one section',
    editor.sectionFromPayload(JSON.stringify({ outline: [node] })).node.title === BENCH, '');
  check('a whole report is refused, and says why',
    /report/i.test(editor.sectionFromPayload(
      JSON.stringify({ outline: [node, node] })).error || ''),
    String(editor.sectionFromPayload(JSON.stringify({ outline: [node, node] })).error));
  check('an update delta is refused, and points at the exchange',
    /exchange/i.test(editor.sectionFromPayload(
      JSON.stringify({ _reportdiff: 1, ops: [] })).error || ''),
    String(editor.sectionFromPayload(JSON.stringify({ _reportdiff: 1, ops: [] })).error));
  check('prose is refused', !!editor.sectionFromPayload('just some words').error, '');
  check('nothing at all is refused', !!editor.sectionFromPayload('').error, '');

  /* ---- 4b. what a typed query names ---- */

  section('jumping to a section');
  if (typeof editor.jumpMatches === 'function') {
    const all = editor.flattenOutline(sampleOutline());
    check('an empty query names everything',
      editor.jumpMatches(all, '').length === all.length, '');
    check('a title matches', editor.jumpMatches(all, 'measured')
      .map((r) => r.node.title).join('|') === RESULTS, '');
    check('a section number matches too',
      editor.jumpMatches(all, '2.2.1').map((r) => r.node.title).join('|') === DEEP, '');
    check('a query that names nothing returns nothing',
      editor.jumpMatches(all, 'zzzz').length === 0, '');
  } else {
    check('editor.js exports jumpMatches', false, 'there is no jump palette');
  }

  /* ---- 5. the header's own address ---- */

  section('the home header');
  if (typeof home.serviceHost === 'function') {
    check('it reads the port off the address bar',
      home.serviceHost({ host: '127.0.0.1:8931' }) === '127.0.0.1:8931',
      home.serviceHost({ host: '127.0.0.1:8931' }));
    check('with no address at all it names no port',
      home.serviceHost({ host: '' }) === '127.0.0.1', home.serviceHost({ host: '' }));
  }

  /* ---- 6. caption numbering matches engine.py's untrimmed rule ---- */

  section('a whitespace-only caption still consumes a table number');
  if (typeof util.computeCaptionNumbers === 'function') {
    // engine.py's _collect_ref_targets does `cap = block.get("caption", "")` /
    // `if cap:` with NO strip() -- a whitespace-only string is still non-empty,
    // so Word numbers this table. util.js used to .trim() first, which skipped
    // it and shifted every later table number relative to the exported file.
    const withBlankCaption = [{
      id: 'ch1', title: 'Chapter 1', children: [],
      blocks: [
        { type: 'table', id: 't-blank', caption: '   ', rows: [] },
        { type: 'datatable', id: 't-real', caption: 'Real caption', data: {} },
      ],
    }];
    const nums = util.computeCaptionNumbers(withBlankCaption);
    check('a whitespace-only caption still takes a number (matches engine.py)',
      nums.has('t-blank') && nums.get('t-blank').label === 'Table 1-1',
      nums.has('t-blank') ? JSON.stringify(nums.get('t-blank')) : 'no entry');
    check('the next real caption follows it, not restarts at 1',
      nums.has('t-real') && nums.get('t-real').label === 'Table 1-2',
      nums.has('t-real') ? JSON.stringify(nums.get('t-real')) : 'no entry');
  } else {
    check('util.js exports computeCaptionNumbers', false, '');
  }
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

/* ---- reading the screen ---- */

function railRows(page) {
  return page.$$eval('.rw-tree__row', (els) => els.map((el) => {
    const num = el.querySelector('.rw-tree__count');
    const label = el.querySelector('.rw-tree__label');
    const badges = Array.from(el.querySelectorAll('.rw-tree__badge'))
      .map((b) => b.textContent.trim());
    return {
      number: num ? num.textContent.trim() : '',
      title: label ? label.textContent.trim() : '',
      badges: badges,
    };
  }));
}

function rowLine(rows) {
  return rows.map((r) => r.number + ' ' + r.title.slice(0, 28)
    + (r.badges.length ? ' [' + r.badges.join(',') + ']' : '')).join(' | ');
}

// What the window has to scroll sideways to show. The product's standing rule is
// that at 1440 it is nothing.
function pageWidth(page) {
  return page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
    rail: Math.round((document.querySelector('.rw-editor__rail') || { getBoundingClientRect: () => ({ width: 0 }) })
      .getBoundingClientRect().width),
  }));
}

function rowFor(rows, title) {
  return rows.find((r) => r.title === title) || null;
}

async function rowHandle(page, title) {
  const handle = await page.evaluateHandle((wanted) => {
    const rows = Array.from(document.querySelectorAll('.rw-tree__row'));
    return rows.find((el) => {
      const label = el.querySelector('.rw-tree__label');
      return label && label.textContent.trim() === wanted;
    }) || null;
  }, title);
  return handle.asElement();
}

// Every gesture starts from a screen with nothing popped open, so a control this
// test could not find does not leave a menu covering the next thing it clicks:
// against a build where an action is MISSING, that difference is between a
// readable list of failures and a click that hangs for thirty seconds.
async function clear(page) {
  await page.keyboard.press('Escape');
  await settle(page, 120);
}

async function tryClick(el, options) {
  try {
    await el.click(Object.assign({ timeout: 4000 }, options || {}));
    return true;
  } catch (err) {
    return false;
  }
}

async function selectRow(page, title) {
  await clear(page);
  const el = await rowHandle(page, title);
  if (!el) return false;
  const ok = await tryClick(el);
  await settle(page, 300);
  return ok;
}

async function openRowMenu(page, title) {
  await clear(page);
  const el = await rowHandle(page, title);
  if (!el) return false;
  const ok = await tryClick(el, { button: 'right' });
  await settle(page, 250);
  return ok;
}

function menuItems(page) {
  return page.$$eval('.rw-menu__item', (els) => els.map((el) => ({
    label: (el.querySelector('.rw-menu__label') || {}).textContent || '',
    disabled: el.disabled === true,
  })));
}

async function clickMenuItem(page, label) {
  const handle = await page.evaluateHandle((wanted) => {
    const items = Array.from(document.querySelectorAll('.rw-menu__item'));
    return items.find((el) => {
      const l = el.querySelector('.rw-menu__label');
      return l && l.textContent.trim() === wanted;
    }) || null;
  }, label);
  const el = handle.asElement();
  if (!el) return false;
  const ok = await tryClick(el);
  await settle(page, 450);
  return ok;
}

async function clickByTitle(page, title) {
  await clear(page);
  const el = await page.$('[title="' + title + '"]');
  if (!el) return false;
  const ok = await tryClick(el);
  await settle(page, 350);
  return ok;
}

async function clickButton(page, label) {
  const handle = await page.evaluateHandle((wanted) => {
    const els = Array.from(document.querySelectorAll('button'));
    return els.find((el) => el.textContent.trim() === wanted) || null;
  }, label);
  const el = handle.asElement();
  if (!el) return false;
  const ok = await tryClick(el);
  await settle(page, 450);
  return ok;
}

// The caption chips on the block cards, e.g. ["Figure 2-1"].
function captionChips(page) {
  return page.$$eval('.rw-numchip', (els) => els.map((el) => el.textContent.trim()));
}

async function saveAndReload(page, url) {
  await page.keyboard.press('Control+s');
  await settle(page, 900);
  await page.goto(url, { waitUntil: 'load' });
  await settle(page, 1400);
}

/* ------------------------------------------------------------------ *
 * browser assertions
 * ------------------------------------------------------------------ */

async function browserChecks() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const scratch = path.join(os.tmpdir(), 'report-workbench-v2-outline-parity', stamp);
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

    const context = await browser.newContext({
      viewport: VIEWPORT,
      permissions: ['clipboard-read', 'clipboard-write'],
    });
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
    await settle(page, 1500);

    /* ---- 6. what each row says about itself ---- */

    section('the marks on the rows');
    let rows = await railRows(page);
    console.log('  rail: ' + rowLine(rows));
    const preface = rowFor(rows, PREFACE);
    const bench = rowFor(rows, BENCH);
    const results = rowFor(rows, RESULTS);
    const objective = rowFor(rows, CH_ONE);
    check('the template section is marked',
      !!preface && preface.badges.length === 1 && preface.badges[0].length <= 3,
      preface ? preface.badges.join(',') : 'no row');
    check('the section holding a table is marked',
      !!bench && bench.badges.length === 1, bench ? bench.badges.join(',') : 'no row');
    check('the section the user added is marked',
      !!results && results.badges.length === 1, results ? results.badges.join(',') : 'no row');
    check('the marks differ from each other',
      !!preface && !!bench && !!results
      && new Set([preface.badges[0], bench.badges[0], results.badges[0]]).size === 3,
      rowLine(rows));
    check('a plain section carries none',
      !!objective && objective.badges.length === 0,
      objective ? objective.badges.join(',') : 'no row');

    /* ---- 6b. a section whose name has nothing to break at ---- */

    section('a very long section title');
    let width = await pageWidth(page);
    check('the window still has nothing to scroll sideways',
      width.scroll === width.client, JSON.stringify(width));
    check('the rail keeps its own width', width.rail > 0 && width.rail <= 300,
      JSON.stringify(width));
    const clipped = await page.evaluate((wanted) => {
      const labels = Array.from(document.querySelectorAll('.rw-tree__label'));
      const el = labels.find((l) => (l.getAttribute('title') || '').indexOf(wanted) === 0);
      if (!el) return null;
      return {
        clipped: el.scrollWidth > el.clientWidth,
        box: Math.round(el.getBoundingClientRect().width),
        title: (el.getAttribute('title') || '').length,
      };
    }, 'Wideband');
    check('the row clips the title instead of growing',
      !!clipped && clipped.clipped && clipped.box <= 300, JSON.stringify(clipped));
    check('and the whole title is still readable, on the tooltip',
      !!clipped && clipped.title === LONG_TITLE.length,
      clipped ? String(clipped.title) : 'no label');

    await selectRow(page, LONG_TITLE);
    width = await pageWidth(page);
    check('selecting it does not push the canvas off the window',
      width.scroll === width.client, JSON.stringify(width));
    const barBox = await page.evaluate(() => {
      const el = document.querySelector('.rw-sectionbar__title');
      if (!el) return null;
      return {
        box: Math.round(el.getBoundingClientRect().width),
        clipped: el.scrollWidth > el.clientWidth,
        titled: !!(el.getAttribute('title') || '').length,
      };
    });
    check('the section bar clips its title too, and keeps it on the tooltip',
      !!barBox && barBox.clipped && barBox.titled && barBox.box <= 1000,
      JSON.stringify(barBox));
    const canvasBox = await page.evaluate(() => {
      const el = document.querySelector('.rw-canvas');
      const r = el ? el.getBoundingClientRect() : null;
      return r ? { x: Math.round(r.x), width: Math.round(r.width) } : null;
    });
    check('the section\'s blocks are on the glass, not past the right edge',
      !!canvasBox && canvasBox.x < 1440 && canvasBox.width > 0,
      JSON.stringify(canvasBox));

    /* ---- 6c. F8 gives the wide table the window ---- */

    section('F8 and the right panel');
    await selectRow(page, BENCH);
    const collapsedState = () => page.evaluate(() =>
      !!document.querySelector('.rw-editor__right--collapsed'));
    check('the panel starts open', (await collapsedState()) === false, '');
    await page.keyboard.press('F8');
    await settle(page, 350);
    check('F8 collapses it', (await collapsedState()) === true,
      'the shortcut the table documentation names does nothing');
    await page.keyboard.press('F8');
    await settle(page, 350);
    check('F8 again opens it', (await collapsedState()) === false, '');
    // It must stand aside while text is being typed, and NOT while the grid
    // merely holds the keyboard -- collapsing the panel is what a wide table
    // wants.
    await page.$eval('.rw-search input', (el) => el.focus());
    await page.keyboard.press('F8');
    await settle(page, 300);
    check('but not while a caret is in a field', (await collapsedState()) === false,
      'F8 fired from inside a text field');
    await page.$eval('.rw-search input', (el) => el.blur());

    /* ---- 7. opening and closing the whole tree ---- */

    section('expand all / collapse all');
    check('the deep row starts hidden', !rowFor(rows, DEEP), rowLine(rows));
    const expandedAll = await clickByTitle(page, 'Expand all');
    rows = await railRows(page);
    check('Expand all brings it on screen', expandedAll && !!rowFor(rows, DEEP),
      expandedAll ? rowLine(rows) : 'no Expand all control');
    const collapsedAll = await clickByTitle(page, 'Collapse all');
    rows = await railRows(page);
    check('Collapse all takes it away again', collapsedAll && !rowFor(rows, DEEP),
      collapsedAll ? rowLine(rows) : 'no Collapse all control');

    /* ---- 8. raising a level, and the numbering that follows ---- */

    section('raising a section a level');
    await selectRow(page, RESULTS);
    let chips = await captionChips(page);
    check('its figure is numbered inside chapter 2', chips.indexOf('Figure 2-1') >= 0,
      chips.join(' | '));

    const menuOpen = await openRowMenu(page, RESULTS);
    const items = menuOpen ? await menuItems(page) : [];
    const labels = items.map((i) => i.label.trim());
    console.log('  menu: ' + labels.join(' | '));
    check('the menu offers a way down a level',
      labels.some((l) => /subsection/i.test(l) && !/^Insert/i.test(l)), labels.join(' | '));
    check('and a way up a level', labels.some((l) => /raise/i.test(l)), labels.join(' | '));
    const raised = await clickMenuItem(page,
      (labels.find((l) => /raise/i.test(l)) || 'Raise a level'));
    rows = await railRows(page);
    const nowChapter = rowFor(rows, RESULTS);
    check('it becomes a chapter of its own, below the one it left',
      raised && !!nowChapter && nowChapter.number === '3', rowLine(rows));
    chips = await captionChips(page);
    check('the figure inside it is renumbered', chips.indexOf('Figure 3-1') >= 0,
      chips.join(' | '));

    /* ---- 9. and back down again, from the keyboard ---- */

    section('putting it back with Alt+arrow');
    await selectRow(page, RESULTS);
    await page.keyboard.press('Alt+ArrowRight');
    await settle(page, 450);
    rows = await railRows(page);
    const backUnder = rowFor(rows, RESULTS);
    check('Alt+-> makes it a subsection again',
      !!backUnder && backUnder.number === '2.2', rowLine(rows));
    chips = await captionChips(page);
    check('and the figure number follows', chips.indexOf('Figure 2-1') >= 0,
      chips.join(' | '));

    /* ---- 10. it survives a save and a reload ---- */

    await page.keyboard.press('Alt+ArrowLeft');
    await settle(page, 450);
    await saveAndReload(page, editorUrl);
    rows = await railRows(page);
    check('the level change is on disk after a reload',
      (rowFor(rows, RESULTS) || {}).number === '3', rowLine(rows));

    /* ---- 11. overriding the template's own words ---- */

    section('a fixed template body');
    await selectRow(page, PREFACE);
    const canvasText = await page.$eval('.rw-canvas', (el) => el.textContent || '');
    check('the canvas shows what the template says',
      canvasText.indexOf(FIXED_LEAD) >= 0, canvasText.slice(0, 160));
    const unlocked = await clickButton(page, 'Edit this text');
    check('there is a way to take it over', unlocked, 'no "Edit this text" control');
    if (unlocked) {
      await settle(page, 500);
      const after = await page.$eval('.rw-canvas', (el) => el.textContent || '');
      check('the words are still there afterwards', after.indexOf(FIXED_LEAD) >= 0,
        after.slice(0, 160));
      rows = await railRows(page);
      check('the row stops being marked as template text',
        (rowFor(rows, PREFACE) || { badges: ['?'] }).badges.length === 0, rowLine(rows));
      await saveAndReload(page, editorUrl);
      const stored = JSON.parse(fs.readFileSync(
        path.join(reportsRoot, ...REPORT_DIR.split('/'), 'project.json'), 'utf8'));
      const saved = (stored.outline || []).find((n) => n.title === PREFACE);
      check('the file no longer pins the section to the template',
        !!saved && !saved.fixed_body, JSON.stringify(saved && saved.fixed_body));
      check('and it holds the words as its own blocks',
        !!saved && (saved.blocks || []).length === 2
        && ((saved.blocks[0].runs || [])[0] || {}).t === FIXED_LEAD,
        JSON.stringify(saved && saved.blocks).slice(0, 200));
    }

    /* ---- 12. copying a section and pasting it back ---- */

    section('copy a section, paste it somewhere else');
    await selectRow(page, BENCH);
    const copied = await clickButton(page, 'Copy whole section');
    check('a section can be copied', copied, 'no "Copy whole section" control');
    const pasteMenu = await openRowMenu(page, CH_ONE);
    const pasteLabels = pasteMenu ? (await menuItems(page)).map((i) => i.label.trim()) : [];
    check('the row menu offers a paste',
      pasteLabels.some((l) => /^Paste section/i.test(l)), pasteLabels.join(' | '));
    const pasteLabel = pasteLabels.find((l) => /^Paste section below/i.test(l));
    const pasted = pasteLabel ? await clickMenuItem(page, pasteLabel) : false;
    await settle(page, 600);
    rows = await railRows(page);
    const at = rows.findIndex((r) => r.title === CH_ONE);
    check('the section lands below the row it was pasted on',
      pasted && rows.filter((r) => r.title === BENCH).length === 2
      && at >= 0 && (rows[at + 1] || {}).title === BENCH, rowLine(rows));
    check('and it is marked as one the user added',
      ((rows[at + 1] || { badges: [] }).badges || []).length === 2, rowLine(rows));

    await saveAndReload(page, editorUrl);
    const afterReload = JSON.parse(fs.readFileSync(
      path.join(reportsRoot, ...REPORT_DIR.split('/'), 'project.json'), 'utf8'));
    const roots = (afterReload.outline || []).map((n) => n.title);
    check('the paste is on disk after a reload',
      roots.filter((t) => t === BENCH).length === 1 && roots[1] === BENCH,
      roots.join(' | '));
    const copy = (afterReload.outline || [])[1] || {};
    const original = ((afterReload.outline || []).find((n) => n.title === CH_TWO) || {});
    const originalBench = (original.children || []).find((n) => n.title === BENCH) || {};
    check('the copy has ids of its own', !!copy.id && copy.id !== originalBench.id,
      copy.id + ' vs ' + originalBench.id);
    const copied0 = (copy.blocks || [])[0] || {};
    check('it brought its blocks with it',
      copied0.type === 'datatable' && copied0.caption === 'Bench settings'
      && copied0.id !== ((originalBench.blocks || [])[0] || {}).id,
      JSON.stringify({ type: copied0.type, caption: copied0.caption }));

    /* ---- 12b. jumping straight to a section ---- */

    section('the jump palette');
    await selectRow(page, CH_ONE);
    await page.keyboard.press('Control+k');
    await settle(page, 400);
    const palette = await page.$('.rw-jump');
    check('Ctrl+K opens a list of every section', !!palette, 'no palette');
    if (palette) {
      const box = await page.$('input[aria-label="Jump to section"]');
      check('the palette puts the caret in its own box',
        !!box && await page.evaluate((el) => document.activeElement === el, box),
        'the query box does not have focus');
      if (box) await box.type('Measured');
      await settle(page, 300);
      const shown = await page.$$eval('.rw-jump .rw-tree__label',
        (els) => els.map((el) => el.textContent.trim()));
      check('typing narrows it to the sections that match',
        shown.length === 1 && shown[0] === RESULTS, shown.join(' | '));
      await page.keyboard.press('Enter');
      await settle(page, 500);
      const landed = await page.$eval('.rw-sectionbar__title',
        (el) => el.getAttribute('title') || '');
      check('Enter lands on it', landed === RESULTS, landed);
      check('and the palette is gone', !(await page.$('.rw-jump')), 'still open');
    }

    /* ---- 13. a clean console ---- */

    section('the console');
    check('no console errors', consoleErrors.length === 0,
      consoleErrors.slice(0, 4).join(' ;; '));
  } finally {
    await cleanup();
  }
}

/* ------------------------------------------------------------------ */

async function main() {
  console.log('test_v2_outline_parity -- what the outline rail can do to a section');
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
