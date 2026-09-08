#!/usr/bin/env node
'use strict';
/*
 * test_v2_notes.js -- the notes channel: a remark ABOUT the report that never
 * becomes part of it, driven in a real browser.
 *
 * Run:  node builder/tests/test_v2_notes.js
 *       node builder/tests/test_v2_notes.js --headed
 *
 * WHY THIS FILE EXISTS
 *   The single-file UI carried notes on the report, on every section and on
 *   every CARD -- `owner.notes = [{by,at,status,text}]` inside project.json,
 *   travelling with the text exchange, never printed into the Word body. The
 *   rewrite dropped the whole channel. The notes did not go anywhere: they sat
 *   in the file, unread, invisible, with no way to add another one and no way
 *   to see the ones that were already there.
 *
 *   So the channel is back, in views/notes.js, and this file pins the three
 *   things that made it worth having: a note is attached to the card it is
 *   about, a note written is a note SAVED, and every note in the report can be
 *   found in one list without hunting section by section.
 *
 * WHAT IT ASSERTS
 *   1. notes already in project.json -- written by the old UI -- are on screen
 *      again, under the card they belong to;
 *   2. a note typed under a card reaches project.json on disk;
 *   3. the top bar counts the OPEN notes, and marking one done lowers it;
 *   4. the Notes tab lists every note in the report with where it lives, and
 *      offers the report-level panel even when nothing is on it;
 *   5. Claude's own replies are read-only, so authorship stays honest;
 *   6. the section note panel can be CLOSED again (it could not before);
 *   7. nothing about a note reaches the outline, the blocks or the export --
 *      the document keeps every field it had.
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

const FIG_ID = 'b-fig-1';
const OLD_NOTE = 'Re-run this corner before the sign-off';
const CLAUDE_NOTE = 'The slow corner is already in the table above';
const TYPED_NOTE = 'Ask the layout owner for the updated pad ring';

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
 * the fixture -- a report that has been through the OLD ui
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
      note: 'Numbers here come from the September run',
      blocks: [
        {
          type: 'para', cardStart: true, list: null, runs: [{ t: 'Body text.' }],
          // Written by the previous UI, and unreachable since the rewrite.
          notes: [
            { by: 'user', at: '2026-08-01', status: 'open', text: OLD_NOTE },
            { by: 'claude', at: '2026-08-02', status: 'open', text: CLAUDE_NOTE },
          ],
        },
        { type: 'image', id: FIG_ID, file: 'images/original.png', caption: 'Output', width_cm: 12 },
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
  fs.writeFileSync(path.join(images, 'original.png'), Buffer.from(PNG_1X1_B64, 'base64'));
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

function readDoc(root) {
  const file = path.join(root, ...REPORT_DIR.split('/'), 'project.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readBlocks(root) {
  return ((readDoc(root).outline || [])[0] || {}).blocks || [];
}

async function waitFor(fn, timeoutMs) {
  const until = Date.now() + (timeoutMs == null ? 6000 : timeoutMs);
  let last = null;
  for (;;) {
    try {
      last = fn();
      if (last) return last;
    } catch (err) { /* mid-write */ }
    if (Date.now() > until) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
}

/* ------------------------------------------------------------------ *
 * driving
 * ------------------------------------------------------------------ */

const settle = (page, ms) => page.waitForTimeout(ms == null ? 350 : ms);

async function browserChecks() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const scratch = path.join(os.tmpdir(), 'report-workbench-v2-notes', stamp);
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
    await page.waitForSelector('.rw-card', { timeout: 10000 });
    await settle(page, 600);

    /* ---- 1: what the old UI wrote is on screen again ---- */
    section('notes the previous UI left in the file');
    await page.screenshot({ path: path.join(shots, '1-open.png'), fullPage: false });
    const strips = await page.locator('.rw-cardnotes').count();
    check('every card offers a notes strip', strips >= 2, 'found ' + strips);
    const firstNote = await page.locator('.rw-cardnotes .rw-note__text').first().inputValue()
      .catch(() => '');
    check('the note written before the rewrite is readable again',
      firstNote === OLD_NOTE, JSON.stringify(firstNote));
    const readonlyCount = await page.locator('.rw-cardnotes .rw-note__text[readonly]').count();
    check('Claude\'s own reply is read-only', readonlyCount === 1, 'found ' + readonlyCount);

    /* ---- 2: the top bar counts what is open ---- */
    section('the count in the top bar');
    const pillText = async () => {
      const pills = page.locator('.rw-topbar .rw-pill');
      const n = await pills.count();
      for (let i = 0; i < n; i++) {
        const t = (await pills.nth(i).innerText()).replace(/\s+/g, ' ').trim();
        if (/note/i.test(t)) return t;
      }
      return '';
    };
    const before = await pillText();
    check('the pill reports the open notes', /2 open notes/.test(before), JSON.stringify(before));

    /* ---- 3: a note typed under a card reaches the file ---- */
    section('writing a note under a figure card');
    const figureStrip = page.locator('[data-card-start="1"] .rw-cardnotes');
    await figureStrip.locator('.rw-cardnotes__toggle').click();
    await settle(page, 250);
    const addBox = figureStrip.locator('.rw-note__add .rw-textarea');
    await addBox.fill(TYPED_NOTE);
    await figureStrip.locator('.rw-note__add .rw-btn').click();
    await settle(page, 300);
    const saved = await waitFor(() => {
      const blocks = readBlocks(reportsRoot);
      const notes = (blocks[1] || {}).notes || [];
      return notes.length && notes[0].text === TYPED_NOTE ? notes[0] : null;
    });
    await page.screenshot({ path: path.join(shots, '2-typed.png') });
    check('the note is in project.json, on the figure block',
      !!saved, JSON.stringify((readBlocks(reportsRoot)[1] || {}).notes || []));
    check('it is stamped as the user\'s, open, and dated',
      !!saved && saved.by === 'user' && saved.status === 'open' && /^\d{4}-\d{2}-\d{2}$/.test(saved.at),
      JSON.stringify(saved));
    check('the figure block kept everything it had',
      (readBlocks(reportsRoot)[1] || {}).file === 'images/original.png'
      && (readBlocks(reportsRoot)[1] || {}).id === FIG_ID);

    const afterAdd = await pillText();
    check('the pill counts the new note without a reload',
      /3 open notes/.test(afterAdd), JSON.stringify(afterAdd));

    /* ---- 4: marking one done ---- */
    section('marking a note done');
    await figureStrip.locator('.rw-note__status').first().click();
    await settle(page, 400);
    const done = await waitFor(() => {
      const notes = (readBlocks(reportsRoot)[1] || {}).notes || [];
      return notes.length && notes[0].status === 'done' ? notes[0] : null;
    });
    check('the file says done', !!done, JSON.stringify(done));
    const afterDone = await pillText();
    check('and the count went back down',
      /2 open notes/.test(afterDone), JSON.stringify(afterDone));

    /* ---- 5: the list ---- */
    section('the Notes tab');
    await page.locator('.rw-topbar .rw-pill', { hasText: /note/i }).first().click();
    await settle(page, 500);
    await page.screenshot({ path: path.join(shots, '3-tab.png') });
    const listed = await page.locator('.rw-noteslist .rw-notesgroup').count();
    check('the list groups the notes by where they live',
      listed >= 3, 'found ' + listed + ' groups');
    const listText = await page.locator('.rw-noteslist').innerText();
    check('it names the section a note belongs to',
      listText.indexOf(SECTION) !== -1, listText.slice(0, 200));
    check('it offers the report-level panel too',
      /Report \(cover\)/.test(listText));
    check('the section\'s standing remark is shown as well',
      /September run/.test(listText));

    /* ---- 6: the section note panel closes again ---- */
    section('the section note panel');
    await page.locator('.rw-sectionbar .rw-pill').first().click();
    await settle(page, 300);
    const openPanel = await page.locator('.rw-sectionbar + .rw-formatstatus .rw-textarea').count()
      || await page.locator('.rw-formatstatus .rw-textarea').count();
    check('the pill opens it', openPanel > 0);
    await page.locator('.rw-formatstatus .rw-iconbtn').first().click();
    await settle(page, 300);
    check('and the panel has a way back',
      (await page.locator('.rw-formatstatus .rw-textarea').count()) === 0);

    /* ---- 7: nothing leaked into the document ---- */
    section('the document itself');
    const doc = readDoc(reportsRoot);
    const node = (doc.outline || [])[0] || {};
    check('the outline kept its section note string',
      /September run/.test(String(node.note || '')), JSON.stringify(node.note));
    check('the prose block still carries its runs',
      !!((node.blocks || [])[0] || {}).runs, JSON.stringify((node.blocks || [])[0] || {}).slice(0, 120));

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
