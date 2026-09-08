#!/usr/bin/env node
'use strict';
/*
 * test_v2_panel_labels.js -- the (a)(b)(c) label under each panel of a figure
 * grid, driven in a real browser.
 *
 * Run:  node builder/tests/test_v2_panel_labels.js
 *       node builder/tests/test_v2_panel_labels.js --headed
 *
 * WHY THIS FILE EXISTS
 *   core/engine.py has always printed a label under every panel of a figure
 *   grid when the block asks for it -- the panel's own `sub`, or (a)(b)(c) when
 *   it has none. The previous UI offered it as a checkbox that said what it
 *   was: "Sub-labels (a)(b)(c)".
 *
 *   After the rewrite the switch was one line of a card's overflow menu reading
 *   "Sub-captions", with nothing to say whether it was on, and the boxes it
 *   revealed showed no letters at all. A feature the document still rendered
 *   was, in practice, gone: nothing on the screen said the labels existed.
 *
 * WHAT IT ASSERTS
 *   1. the switch is on the card's head and reports its own state;
 *   2. pressing it writes sub_captions to project.json;
 *   3. each panel then shows the letter the document will print for it, in
 *      order -- (a), (b), (c);
 *   4. typing a label stores it on that panel and marks the letter replaced,
 *      because engine prints one or the other and never both;
 *   5. the preview shows exactly what the editor promised, panel by panel --
 *      the typed label where there is one, the letter where there is not.
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
const VIEWPORT = { width: 1600, height: 940 };

const PROJECT_ID = '1108';
const MODULE_ID = 'CLKDIV_5G';
const REPORT_DIR = PROJECT_ID + '/' + MODULE_ID + '/CDR';
const SECTION = 'Simulation results';

const GRID_ID = 'b-grid-1';
const GRID_CARD = '.rw-card[data-block="1"]';
const TYPED = 'TT corner';

const PNG_1X1_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

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

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function sampleReport() {
  return {
    template: 'sample',
    meta: {
      title: MODULE_ID + ' CDR report', doc_no: 'DOC-1', version: 'V1.0',
      secrecy: 'Internal', author: 'A. Engineer', date: '2026-09-08',
      reviewers: [], approver: '', revisions: [],
    },
    outline: [{
      id: 'n-results',
      title: SECTION,
      blocks: [
        { type: 'para', cardStart: true, list: null, runs: [{ t: 'Body text.' }] },
        {
          type: 'imagegrid', id: GRID_ID, cols: 3, width_cm: 15.5,
          caption: 'Three corners',
          // OFF, the way a grid arrives: the switch is what this file is about.
          sub_captions: false,
          items: [
            { file: 'images/cell_a.png', sub: '' },
            { file: 'images/cell_b.png', sub: '' },
            { file: 'images/cell_c.png', sub: '' },
          ],
        },
      ],
      children: [],
    }],
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
      axis_labels: ['MIN', 'TYP', 'MAX'],
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
  const dir = path.join(root, ...REPORT_DIR.split('/'));
  writeJson(path.join(dir, 'project.json'), sampleReport());
  const images = path.join(dir, 'images');
  fs.mkdirSync(images, { recursive: true });
  const png = Buffer.from(PNG_1X1_B64, 'base64');
  for (const name of ['cell_a.png', 'cell_b.png', 'cell_c.png']) {
    fs.writeFileSync(path.join(images, name), png);
  }
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
 * reading the report back off disk
 * ------------------------------------------------------------------ */

function readGrid(root) {
  const file = path.join(root, ...REPORT_DIR.split('/'), 'project.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const blocks = ((doc.outline || [])[0] || {}).blocks || [];
  return blocks.find((b) => b && b.id === GRID_ID) || null;
}

async function waitForGrid(root, predicate, timeoutMs) {
  const until = Date.now() + (timeoutMs == null ? 8000 : timeoutMs);
  let last = null;
  for (;;) {
    try {
      last = readGrid(root);
      if (last && predicate(last)) return last;
    } catch (err) { /* mid-write */ }
    if (Date.now() > until) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
}

/* ------------------------------------------------------------------ *
 * driving
 * ------------------------------------------------------------------ */

const settle = (page, ms) => page.waitForTimeout(ms == null ? 350 : ms);

const letters = (page) => page.evaluate(() => Array.from(
  document.querySelectorAll('.rw-figgrid__letter')).map((el) => ({
  text: String(el.textContent || '').trim(),
  replaced: /rw-figgrid__letter--replaced/.test(String(el.className || '')),
})));

const previewSubs = (page) => page.evaluate(() => Array.from(
  document.querySelectorAll('.rw-preview__subcap')).map(
  (el) => String(el.textContent || '').trim()));

const switchState = (page, card) => page.evaluate((sel) => {
  const buttons = Array.from(document.querySelectorAll(sel + ' .rw-card__head .rw-btn'));
  const el = buttons.find((b) => /panel labels/i.test(String(b.textContent || '')));
  if (!el) return null;
  return {
    pressed: el.getAttribute('aria-pressed'),
    on: /rw-btn--on/.test(String(el.className || '')),
    text: String(el.textContent || '').replace(/\s+/g, ' ').trim(),
  };
}, card);

async function browserChecks() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const scratch = path.join(os.tmpdir(), 'report-workbench-v2-panel-labels', stamp);
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
    if (browser) { try { await browser.close(); } catch (err) { /* gone */ } }
    await stopServer(child);
  };

  try {
    try {
      await waitForServer(base, child, 12000);
    } catch (err) {
      console.log('  SKIP: ' + String(err && err.message));
      console.log((child.log || []).join('').slice(-800));
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

    await page.goto(base + '/#/r/' + REPORT_DIR, { waitUntil: 'load' });
    await page.waitForSelector(GRID_CARD + ' .rw-figgrid', { timeout: 10000 });
    await settle(page, 600);

    /* ---- 1: the switch is on the head, and says it is off ---- */
    section('the switch');
    const off = await switchState(page, GRID_CARD);
    check('the card head carries a panel-label switch', !!off, JSON.stringify(off));
    check('and it reports that it is off',
      !!off && off.pressed === 'false' && !off.on, JSON.stringify(off));
    check('no letters are shown while it is off',
      (await letters(page)).length === 0);
    await page.screenshot({ path: path.join(shots, '1-off.png') });

    /* ---- 2: pressing it ---- */
    section('turning the labels on');
    await page.locator(GRID_CARD + ' .rw-card__head .rw-btn', { hasText: /Panel labels/i })
      .first().click();
    await settle(page, 400);
    const on = await switchState(page, GRID_CARD);
    check('the switch now reports that it is on',
      !!on && on.pressed === 'true' && on.on, JSON.stringify(on));
    const stored = await waitForGrid(reportsRoot, (b) => b.sub_captions === true);
    check('and project.json says so', !!stored && stored.sub_captions === true,
      JSON.stringify(stored && stored.sub_captions));

    /* ---- 3: the letters ---- */
    const shown = await letters(page);
    await page.screenshot({ path: path.join(shots, '2-on.png') });
    check('every panel shows the letter it will print, in order',
      shown.length === 3 && shown[0].text === '(a)' && shown[1].text === '(b)'
      && shown[2].text === '(c)', JSON.stringify(shown));
    check('none of them is marked replaced yet',
      shown.every((s) => !s.replaced), JSON.stringify(shown));

    /* ---- 4: typing one ---- */
    section('typing a label of your own');
    const boxes = page.locator(GRID_CARD + ' .rw-figgrid__sub .rw-input');
    await boxes.nth(1).fill(TYPED);
    await boxes.nth(1).blur();
    await settle(page, 500);
    const typed = await waitForGrid(reportsRoot,
      (b) => ((b.items || [])[1] || {}).sub === TYPED);
    check('the label is stored on that panel',
      !!typed && typed.items[1].sub === TYPED, JSON.stringify(typed && typed.items));
    check('and only that panel',
      !!typed && !typed.items[0].sub && !typed.items[2].sub,
      JSON.stringify(typed && typed.items));
    const afterType = await letters(page);
    check('its letter is marked replaced, because the document prints one or the other',
      afterType.length === 3 && !afterType[0].replaced && afterType[1].replaced
      && !afterType[2].replaced, JSON.stringify(afterType));

    /* ---- 5: the preview agrees ---- */
    section('the preview shows what was promised');
    await settle(page, 900);
    const subs = await previewSubs(page);
    await page.screenshot({ path: path.join(shots, '3-preview.png') });
    check('the paper labels every panel',
      subs.length === 3, JSON.stringify(subs));
    check('the typed label where one was typed, the letter everywhere else',
      subs[0] === '(a)' && subs[1] === TYPED && subs[2] === '(c)', JSON.stringify(subs));

    section('console');
    if (consoleErrors.length) {
      check('no console errors', false, consoleErrors.slice(0, 4).join(' | '));
    } else {
      console.log('  [ok  ] no console errors');
    }

    console.log('');
    console.log('  screenshots: ' + shots);
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
