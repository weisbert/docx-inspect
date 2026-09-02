#!/usr/bin/env node
'use strict';
/*
 * test_v2_sync_flush_guard.js -- the exchange screen's destructive operations
 * must not run on top of a document the disk does not hold.
 *
 * Run:  node builder/tests/test_v2_sync_flush_guard.js
 *       node builder/tests/test_v2_sync_flush_guard.js --headed   (watch it work)
 *
 * THE DEFECT
 *   views/sync.js computed the flush verdict and threw it away: `await
 *   flushEdits();` on its own line, nine times over. The barrier looked present
 *   in the source and was absent in fact. With saves failing, flushEdits()
 *   correctly answered false and every one of these ran anyway:
 *
 *     History restore, roll back, merge apply, apply update package,
 *     paste import
 *
 *   Each of them replaces project.json and is followed by a re-read that
 *   replaces what is in memory, so an edit the save loop still owed ended up in
 *   no version of anything: not in the file, not in the snapshot the server
 *   takes first (that snapshot is a copy of the same older file), not on screen,
 *   and not in the store -- which then reported "saved".
 *
 * WHAT IT ASSERTS, in a real browser, against what lands on disk
 *   with every PUT of the document answered 500:
 *     1. History restore refuses, says so, and leaves project.json alone
 *     2. roll back refuses, says so, and leaves project.json alone
 *     3. merge apply refuses, says so, and leaves project.json alone
 *     4. applying an update package refuses, says so, leaves project.json alone
 *     5. paste import (full replace) refuses, says so, leaves project.json alone
 *   and in every one of the five the edit is still in memory, still on screen,
 *   and the document is still dirty rather than reported as saved.
 *
 *   with saves working, the same five operations all still happen: the restore
 *   installs the snapshot AND the pending edit reaches the pre-restore snapshot
 *   on the way; the roll back installs the backup; the merge writes the merged
 *   report; the package's change lands next to the pending edit that was
 *   flushed before it; and the replace installs the pasted report.
 *
 * Every edit is made through the store and the button is pressed in the SAME
 * synchronous step, so the state under test is exactly "a save is owed" -- typing
 * it would spend the autosave debounce this test is about.
 *
 * IT NEVER TOUCHES REAL REPORTS. The fixture is generated from scratch into the
 * OS temporary directory and the server is booted against THAT with an explicit
 * --root, exactly as the other v2 browser tests do.
 *
 * SKIPPING IS A FEATURE. The public repository carries no node_modules, so a
 * missing playwright-core exits 0 with one line.
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
const HEADED = process.argv.includes('--headed');

let chromium = null;
try {
  chromium = require('playwright-core').chromium;
} catch (err) {
  console.log('SKIP: playwright-core is not installed (npm install to run this file).');
  process.exit(0);
}

const PROJECT_ID = '1108';
const MODULE_ID = 'CLKDIV_5G';
const PLAIN_MODULE = 'MODULE_A';
const KEPT_DIR = PROJECT_ID + '/' + MODULE_ID + '/CDR';       // has a baseline
const FRESH_DIR = PROJECT_ID + '/' + PLAIN_MODULE + '/CDR';   // never exchanged

const START_TEXT = 'First section, as it was saved.';
const SECOND_TEXT = 'Second section, as it was saved.';
const SNAPSHOT_TEXT = 'First section, as it was in the snapshot.';
const BACKUP_TEXT = 'First section, as it was in the backup.';
const RETURNED_TEXT = 'Second section, as it came back from the other side.';
const EDIT = 'First section, edited while the disk was refusing writes.';
const EDIT_OK = 'First section, edited a moment before the operation.';

/* ------------------------------------------------------------------ *
 * fixture
 * ------------------------------------------------------------------ */

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function sampleReport(first, second) {
  return {
    template: 'sample',
    meta: { title: 'Sample CDR report', doc_no: 'DOC-1', version: 'V1.0' },
    outline: [
      {
        id: 'n-1',
        title: 'Overview',
        blocks: [{ type: 'para', runs: [{ t: first || START_TEXT }], cardStart: true }],
        children: [],
      },
      {
        id: 'n-2',
        title: 'Design description',
        blocks: [{ type: 'para', runs: [{ t: second || SECOND_TEXT }], cardStart: true }],
        children: [],
      },
    ],
  };
}

function sampleTemplateConfig() {
  return {
    id: 'sample',
    name: 'Sample template',
    caption_prefix: { figure: 'Figure', table: 'Table' },
    toc: { enabled: true },
    skeleton: [{ title: 'Overview', children: [] }, { title: 'Design description', children: [] }],
    cover: { secrecy_default: 'Internal' },
    styles: {},
    compliance: {
      axis_labels: ['MIN', 'TYP', 'MAX', 'NTWC'],
      setting_kinds: ['common_setting', 'module_setting', 'tb'],
      default_limit: {},
      flag_color: 'FF0000',
      col_w_cm: { cat: 2.4, item: 3.6, unit: 1.4 },
      fills: { header: 'FFF2CC', setting: 'F2EFE9', result: 'FFFFFF' },
    },
    free_table: { header_fill: 'FFF2CC' },
    ui_strings: {},
    table_presets: [],
  };
}

// The two snapshots the History drawer lists: an exchange (which is where its
// `Roll back` lives) and an ordinary one (which is where `Restore this state`
// lives). Their mtimes are set explicitly, because the server orders snapshots
// by mtime and every one of them is written in the same second here.
const SNAP_EXCHANGE = '20260830-100000__preapply.json';
const SNAP_PLAIN = '20260830-100100__save.json';

function buildReportsRoot(root) {
  fs.mkdirSync(root, { recursive: true });
  writeJson(path.join(root, 'templates', 'sample', 'config.json'), sampleTemplateConfig());
  writeJson(path.join(root, PROJECT_ID, 'project_meta.json'),
    { name: 'Sample project', description: 'Generated by this test' });
  writeJson(path.join(root, PROJECT_ID, MODULE_ID, 'project_meta.json'),
    { name: MODULE_ID, description: 'Divider block' });
  writeJson(path.join(root, PROJECT_ID, PLAIN_MODULE, 'project_meta.json'),
    { name: PLAIN_MODULE, description: 'A block that has never been exchanged' });
  resetFixture(root);
  return root;
}

// Put every file this test writes over back the way it started, so each flow
// runs against the same known state.
function resetFixture(root) {
  const kept = path.join(root, ...KEPT_DIR.split('/'));
  const fresh = path.join(root, ...FRESH_DIR.split('/'));

  writeJson(path.join(kept, 'project.json'), sampleReport());
  writeJson(path.join(kept, '_baseline.json'), sampleReport());
  writeJson(path.join(fresh, 'project.json'), sampleReport());
  try {
    fs.rmSync(path.join(fresh, '_baseline.json'), { force: true });
  } catch (err) { /* never exchanged */ }

  try {
    fs.rmSync(path.join(kept, '_autosave'), { recursive: true, force: true });
  } catch (err) { /* windows */ }
  writeJson(path.join(kept, '_autosave', SNAP_EXCHANGE), sampleReport('Exchanged state.'));
  writeJson(path.join(kept, '_autosave', SNAP_PLAIN), sampleReport(SNAPSHOT_TEXT));
  const t0 = new Date('2026-08-30T10:00:00Z');
  const t1 = new Date('2026-08-30T10:01:00Z');
  fs.utimesSync(path.join(kept, '_autosave', SNAP_EXCHANGE), t0, t0);
  fs.utimesSync(path.join(kept, '_autosave', SNAP_PLAIN), t1, t1);

  try {
    fs.rmSync(path.join(root, '_backups'), { recursive: true, force: true });
  } catch (err) { /* windows */ }
  writeJson(path.join(root, '_backups', '20260830-090000', ...KEPT_DIR.split('/'), 'project.json'),
    sampleReport(BACKUP_TEXT));
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

function req(method, url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body == null ? null : Buffer.from(body, 'utf8');
    const r = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: method,
      headers: payload
        ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': payload.length }
        : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode, text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function waitForServer(base, child, deadlineMs) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    if (child.exitCode !== null) throw new Error('the server exited: ' + child.log.join(''));
    try {
      const answer = await req('GET', base + '/api/health');
      if (answer.status === 200) return;
    } catch (err) { /* not up yet */ }
    if (Date.now() > until) throw new Error('the server did not answer: ' + child.log.join(''));
    await new Promise((r) => setTimeout(r, 120));
  }
}

/* ------------------------------------------------------------------ *
 * assertions
 * ------------------------------------------------------------------ */

const results = [];
function check(name, ok, detail) {
  results.push({ name: name, ok: !!ok });
  const line = (ok ? '  [ok  ] ' : '  [FAIL] ') + name;
  console.log(detail && !ok ? line + '\n         ' + detail : line);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * browser helpers
 * ------------------------------------------------------------------ */

// Answer every write of the document with a 500, and nothing else.
const BLOCK_SAVES = `(() => {
  if (window.__rwBlocked) return 'already';
  window.__rwBlocked = 1;
  const real = window.fetch;
  window.fetch = function (input, init) {
    const url = String((input && input.url) || input || '');
    const method = String((init && init.method) || 'GET').toUpperCase();
    if (method === 'PUT' && url.indexOf('/api/project') !== -1) {
      return Promise.resolve(new Response('{"error":"the disk refused this write"}',
        { status: 500, headers: { 'Content-Type': 'application/json' } }));
    }
    return real.apply(window, arguments);
  };
  return 'blocked';
})()`;

// Find a button by its exact label, or by its first words for the labels that
// carry a count ("Apply · 0 decided").
function buttonScript(label, scope) {
  return `(() => {
    const want = ${JSON.stringify(label)};
    const root = document.querySelector(${JSON.stringify(scope || 'body')}) || document.body;
    const all = Array.from(root.querySelectorAll('button'));
    const hit = all.filter((b) => {
      const t = b.textContent.trim();
      return t === want || t.indexOf(want) === 0;
    })[0];
    if (!hit) return { found: false, seen: all.map((b) => b.textContent.trim()).slice(0, 24) };
    return { found: true, disabled: !!hit.disabled, el: hit };
  })()`;
}

function clickScript(label, scope) {
  return `(() => {
    const found = ${buttonScript(label, scope)};
    if (!found.found) return 'no button: ' + JSON.stringify(found.seen);
    if (found.disabled) return 'disabled: ' + ${JSON.stringify(label)};
    found.el.click();
    return 'clicked';
  })()`;
}

// Edit the document and press the button in ONE synchronous step, so the
// autosave debounce cannot land the edit by luck.
function editAndClickScript(text, label, scope) {
  return `(async () => {
    const { store } = await import('/assets/v2/js/store.js');
    const project = store.get().project;
    project.outline[0].blocks[0].runs[0].t = ${JSON.stringify(text)};
    store.markDirty();
    return ${clickScript(label, scope)};
  })()`;
}

// A restore asks before it drops the work done since the state it puts back
// (see test_v2_exchange.js), so pressing the entry's button opens the question
// and the answer is the second press. Still one step for the purposes of this
// file: the save is blocked throughout, so nothing can reach the disk between
// the two.
function editAndRestoreScript(text) {
  return `(async () => {
    const { store } = await import('/assets/v2/js/store.js');
    const project = store.get().project;
    project.outline[0].blocks[0].runs[0].t = ${JSON.stringify(text)};
    store.markDirty();
    const opened = ${clickScript('Restore this state')};
    if (opened !== 'clicked') return opened;
    await new Promise((r) => setTimeout(r, 120));
    return ${clickScript('Restore this state', '.rw-dialog__foot')};
  })()`;
}

// Null-safe on purpose: against the broken behaviour the document can be gone
// entirely by the time this runs, and a throw here would end the run before the
// later flows had said anything.
const MEMORY = `(async () => {
  const { store } = await import('/assets/v2/js/store.js');
  const s = store.get();
  const outline = (s.project && s.project.outline) || [];
  const read = (i) => {
    try { return outline[i].blocks[0].runs[0].t; } catch (err) { return ''; }
  };
  return { first: read(0), second: read(1), dirty: !!s.dirty, saveState: s.saveState };
})()`;

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

(async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-sync-flush-'));
  buildReportsRoot(root);
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const child = spawn(process.env.RW_PYTHON || 'python',
    [SERVER_PY, '--port', String(port), '--root', root,
      '--config', path.join(root, 'templates', 'sample', 'config.json')],
    { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.log = [];
  child.stdout.on('data', (c) => child.log.push(c));
  child.stderr.on('data', (c) => child.log.push(c));

  const fileOf = (dir) => path.join(root, ...dir.split('/'), 'project.json');
  const readReport = (dir) => {
    try {
      return JSON.parse(fs.readFileSync(fileOf(dir), 'utf8'));
    } catch (err) {
      return null;
    }
  };
  const para = (dir, i) => {
    const doc = readReport(dir);
    try {
      return doc.outline[i].blocks[0].runs[0].t;
    } catch (err) {
      return 'unreadable';
    }
  };
  const snapshotHolding = (text) => {
    const d = path.join(root, ...KEPT_DIR.split('/'), '_autosave');
    try {
      return fs.readdirSync(d).filter((n) => fs.readFileSync(path.join(d, n), 'utf8')
        .indexOf(text) !== -1);
    } catch (err) {
      return [];
    }
  };

  let browser = null;
  try {
    await waitForServer(base, child, 20000);

    // A genuine op-diff, cut by the server itself against this report's
    // baseline, so the package under test has the shape the real channel
    // produces rather than one this file invented.
    const diffAnswer = await req('POST', base + '/api/copy-diff?dir=' + encodeURIComponent(KEPT_DIR),
      JSON.stringify(sampleReport(START_TEXT, RETURNED_TEXT)));
    const diffText = JSON.parse(diffAnswer.text).diff_text;
    if (!diffText) throw new Error('no diff text from /api/copy-diff: ' + diffAnswer.text);
    const returnedReport = JSON.stringify(sampleReport(START_TEXT, RETURNED_TEXT), null, 2);

    browser = await chromium.launch({ channel: 'msedge', headless: !HEADED });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    const urlOf = (dir) => base + '/#/r/' + dir.split('/').map(encodeURIComponent).join('/');
    // about:blank first, because two of these flows open the SAME report twice
    // and a goto that only changes the hash is a same-document navigation: the
    // page would keep its drawers open and keep the fetch stub installed.
    const open = async (dir) => {
      await page.goto('about:blank');
      await page.goto(urlOf(dir), { waitUntil: 'load' });
      await wait(1400);
    };
    const openDrawer = async (label) => {
      const clicked = await page.evaluate(clickScript(label));
      if (clicked !== 'clicked') throw new Error('could not open ' + label + ': ' + clicked);
      await wait(600);
    };
    const openExchange = async () => {
      await page.click('[title="Text exchange"]');
      await wait(900);
    };
    const pastePackage = async (text) => {
      const opened = await page.evaluate(clickScript('Or paste text'));
      if (opened !== 'clicked') throw new Error('no paste control: ' + opened);
      await wait(300);
      await page.fill('.rw-sync__paste', text);
      await wait(200);
      const used = await page.evaluate(clickScript('Use this text'));
      if (used !== 'clicked') throw new Error('could not use the pasted text: ' + used);
      await wait(1600);
    };
    const bodyText = () => page.evaluate(() => String(document.body.innerText || ''));
    const onScreen = (text) => page.evaluate((t) => {
      const el = document.querySelector('.rw-app');
      return !!el && String(el.innerText || '').indexOf(t) !== -1;
    }, text);

    /* ============================================================ *
     * refused: every PUT of the document answered 500
     * ============================================================ */

    console.log('\nHistory restore, with the document only in the page  (PIN: fails before the fix)');
    resetFixture(root);
    await open(KEPT_DIR);
    await page.evaluate(BLOCK_SAVES);
    await openDrawer('History');
    const r1 = await page.evaluate(editAndRestoreScript(EDIT));
    check('the restore was pressed while a save was owed', r1 === 'clicked', String(r1));
    await wait(7000);
    check('project.json was not replaced by the snapshot',
      para(KEPT_DIR, 0) === START_TEXT, JSON.stringify(para(KEPT_DIR, 0)));
    let body = await bodyText();
    check('the screen says the restore was held back',
      /Not restored/.test(body) && /this report is not saved/.test(body),
      body.slice(0, 400).replace(/\s+/g, ' '));
    let mem = await page.evaluate(MEMORY);
    check('the edit is still in memory, and still unsaved',
      mem.first === EDIT && mem.dirty === true, JSON.stringify(mem));
    check('the edit is still on screen', await onScreen(EDIT));

    console.log('\nroll back, with the document only in the page  (PIN: fails before the fix)');
    const r2 = await page.evaluate(clickScript('Roll back'));
    check('the roll back was pressed', r2 === 'clicked', String(r2));
    await wait(7000);
    check('project.json was not replaced by the backup',
      para(KEPT_DIR, 0) === START_TEXT, JSON.stringify(para(KEPT_DIR, 0)));
    body = await bodyText();
    check('the screen says the roll back was held back',
      /Not rolled back/.test(body) && /this report is not saved/.test(body),
      body.slice(0, 400).replace(/\s+/g, ' '));
    mem = await page.evaluate(MEMORY);
    check('the edit survived the roll back attempt',
      mem.first === EDIT && mem.dirty === true, JSON.stringify(mem));
    check('the edit is still on screen after the roll back attempt', await onScreen(EDIT));

    console.log('\nmerge apply, with the document only in the page  (PIN: fails before the fix)');
    resetFixture(root);
    await open(KEPT_DIR);
    await openExchange();
    await pastePackage(returnedReport);
    const c1 = await page.evaluate(clickScript('Continue'));
    check('the comparison ran and Continue was pressed', c1 === 'clicked', String(c1));
    await wait(900);
    await page.evaluate(BLOCK_SAVES);
    const r3 = await page.evaluate(editAndClickScript(EDIT, 'Apply', '.rw-dialog__foot'));
    check('the merge apply was pressed while a save was owed', r3 === 'clicked', String(r3));
    await wait(7000);
    check('project.json was not replaced by the merge',
      para(KEPT_DIR, 1) === SECOND_TEXT, JSON.stringify(para(KEPT_DIR, 1)));
    body = await bodyText();
    check('the screen says the merge was held back',
      /Not merged/.test(body) && /this report is not saved/.test(body),
      body.slice(0, 400).replace(/\s+/g, ' '));
    mem = await page.evaluate(MEMORY);
    check('the edit survived the merge attempt',
      mem.first === EDIT && mem.dirty === true, JSON.stringify(mem));

    console.log('\napply a package, with the document only in the page  (PIN: fails before the fix)');
    resetFixture(root);
    await open(KEPT_DIR);
    await page.evaluate(BLOCK_SAVES);
    await openExchange();
    await pastePackage(diffText);
    const r4 = await page.evaluate(editAndClickScript(EDIT, 'Apply the package'));
    check('the package apply was pressed while a save was owed', r4 === 'clicked', String(r4));
    await wait(7000);
    check('project.json did not take the package',
      para(KEPT_DIR, 1) === SECOND_TEXT, JSON.stringify(para(KEPT_DIR, 1)));
    body = await bodyText();
    check('the screen says the package was not applied',
      /Not applied/.test(body) && /this report is not saved/.test(body),
      body.slice(0, 400).replace(/\s+/g, ' '));
    mem = await page.evaluate(MEMORY);
    check('the edit survived the package apply attempt',
      mem.first === EDIT && mem.dirty === true, JSON.stringify(mem));

    console.log('\npaste import, with the document only in the page  (PIN: fails before the fix)');
    resetFixture(root);
    await open(FRESH_DIR);
    await page.evaluate(BLOCK_SAVES);
    await openExchange();
    await pastePackage(returnedReport);
    const r5 = await page.evaluate(editAndClickScript(EDIT, 'Replace the report'));
    check('the replace was pressed while a save was owed', r5 === 'clicked', String(r5));
    await wait(7000);
    check('project.json was not replaced by the pasted report',
      para(FRESH_DIR, 1) === SECOND_TEXT, JSON.stringify(para(FRESH_DIR, 1)));
    body = await bodyText();
    check('the screen says the replace was held back',
      /Not replaced/.test(body) && /this report is not saved/.test(body),
      body.slice(0, 400).replace(/\s+/g, ' '));
    mem = await page.evaluate(MEMORY);
    check('the edit survived the replace attempt',
      mem.first === EDIT && mem.dirty === true, JSON.stringify(mem));

    console.log('\nthe refusal offers the choice rather than making it');
    resetFixture(root);
    await open(KEPT_DIR);
    await page.evaluate(BLOCK_SAVES);
    await openDrawer('History');
    const r6 = await page.evaluate(editAndRestoreScript(EDIT));
    check('the restore was pressed once more', r6 === 'clicked', String(r6));
    await wait(7000);
    check('nothing happened on its own',
      para(KEPT_DIR, 0) === START_TEXT, JSON.stringify(para(KEPT_DIR, 0)));
    const over = await page.evaluate(clickScript('Restore anyway'));
    check('the override is on screen and pressable', over === 'clicked', String(over));
    await wait(4000);
    check('pressing it does what it says',
      para(KEPT_DIR, 0) === SNAPSHOT_TEXT, JSON.stringify(para(KEPT_DIR, 0)));
    body = await bodyText();
    check('and the refusal is gone afterwards', !/Not restored/.test(body),
      body.slice(0, 300).replace(/\s+/g, ' '));

    /* ============================================================ *
     * allowed: the same five operations, with saves working
     * ============================================================ */

    console.log('\nwith saves working, every one of them still happens');

    resetFixture(root);
    await open(KEPT_DIR);
    await openDrawer('History');
    const b1 = await page.evaluate(editAndRestoreScript(EDIT_OK));
    check('the restore was pressed', b1 === 'clicked', String(b1));
    await wait(4000);
    check('the snapshot was installed',
      para(KEPT_DIR, 0) === SNAPSHOT_TEXT, JSON.stringify(para(KEPT_DIR, 0)));
    check('the pending edit reached a snapshot on the way',
      snapshotHolding(EDIT_OK).length > 0, JSON.stringify(snapshotHolding(EDIT_OK)));
    body = await bodyText();
    check('nothing was held back', !/Not restored/.test(body),
      body.slice(0, 300).replace(/\s+/g, ' '));

    const b2 = await page.evaluate(clickScript('Roll back'));
    check('the roll back was pressed', b2 === 'clicked', String(b2));
    await wait(4000);
    check('the backup was installed',
      para(KEPT_DIR, 0) === BACKUP_TEXT, JSON.stringify(para(KEPT_DIR, 0)));

    resetFixture(root);
    await open(KEPT_DIR);
    await openExchange();
    await pastePackage(returnedReport);
    const c2 = await page.evaluate(clickScript('Continue'));
    check('the comparison ran again', c2 === 'clicked', String(c2));
    await wait(900);
    const b3 = await page.evaluate(clickScript('Apply', '.rw-dialog__foot'));
    check('the merge apply was pressed', b3 === 'clicked', String(b3));
    await wait(5000);
    check('the merged report was written',
      para(KEPT_DIR, 1) === RETURNED_TEXT, JSON.stringify(para(KEPT_DIR, 1)));

    resetFixture(root);
    await open(KEPT_DIR);
    await openExchange();
    await pastePackage(diffText);
    const b4 = await page.evaluate(editAndClickScript(EDIT_OK, 'Apply the package'));
    check('the package apply was pressed', b4 === 'clicked', String(b4));
    await wait(6000);
    check('the package landed',
      para(KEPT_DIR, 1) === RETURNED_TEXT, JSON.stringify(para(KEPT_DIR, 1)));
    check('and it landed on top of the flushed edit, not instead of it',
      para(KEPT_DIR, 0) === EDIT_OK, JSON.stringify(para(KEPT_DIR, 0)));

    resetFixture(root);
    await open(FRESH_DIR);
    await openExchange();
    await pastePackage(returnedReport);
    const b5 = await page.evaluate(clickScript('Replace the report'));
    check('the replace was pressed', b5 === 'clicked', String(b5));
    await wait(5000);
    check('the pasted report replaced this one',
      para(FRESH_DIR, 1) === RETURNED_TEXT, JSON.stringify(para(FRESH_DIR, 1)));
  } catch (err) {
    check('the test ran to the end', false, err && err.stack ? err.stack : String(err));
  } finally {
    if (browser) { try { await browser.close(); } catch (err) { /* closing */ } }
    child.kill();
    await wait(200);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (err) { /* windows */ }
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  if (failed.length) {
    console.log('FAILED: ' + failed.map((r) => r.name).join(' | '));
    process.exit(1);
  }
  console.log('sync flush guard: all checks passed');
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
