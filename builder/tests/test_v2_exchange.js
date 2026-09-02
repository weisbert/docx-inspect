#!/usr/bin/env node
'use strict';
/*
 * test_v2_exchange.js -- what the exchange screen SAYS about what it is
 * about to do, and what the timeline says about what it holds.
 *
 * Run:  node builder/tests/test_v2_exchange.js
 *       node builder/tests/test_v2_exchange.js --headed   (watch it work)
 *
 * THE DEFECTS, all of them "the screen was silent about the thing that
 * mattered":
 *
 *   1. `Copy whole report (2.5 KB)` put 5.9 KB on the clipboard. The label read
 *      the server's COMPACT byte count while the button copied an indented
 *      document, so the number beside the button was 2.4x under, and the
 *      "% smaller" beside the other button compared the diff against a report
 *      nobody was ever offered. On a channel that carries only what a person
 *      pastes, that percentage is the whole basis for choosing between them.
 *
 *   2. An update that conflicts with nothing could not be read before it was
 *      applied: an empty list, three empty panes, and a primary button reading
 *      `Apply · 0 decided` that wrote four sections. That is the COMMON case.
 *
 *   3. `Restore this state` ran on the click. It replaces the whole report, so
 *      everything done after the state it puts back is gone, with no dialog and
 *      nothing said afterwards -- and every timeline entry read
 *      `just now / Automatic snapshot / 1.4 KB`, so the state from before a
 *      mistake could only be found by restoring one and looking, which costs
 *      the later work every time the guess is wrong.
 *
 *   4. While a save was in flight the import dialog said `Continue · compare 0
 *      passages` and greyed the button: a comparison that had not run yet,
 *      printed as a count of nothing.
 *
 *   5. The drawer light-dismissed on any click in the editor and threw away
 *      text typed into `Or paste text` -- on this machine the one input that
 *      cannot be retyped, because it arrived by hand.
 *
 *   6. The shelf's `Apply an external update` chooser accepted `.zip` alone
 *      while the drawer that does the same job invites `.zip or a single .md`.
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
const DIR = PROJECT_ID + '/' + MODULE_ID + '/CDR';

const OVERVIEW = 'Overview';
const METHOD = 'Method';
const RESULTS = 'Results';

const BASE_TEXT = {
  one: 'The first section, as it stands.',
  two: 'The method, as it stands.',
  three: 'The results, as they stand.',
};
// The four states the timeline holds, oldest first. Each step touches ONE
// section, so the hint on each entry has exactly one right answer.
const SNAPSHOTS = [
  { name: '20260830-100000__save.json', when: '2026-08-30T10:00:00Z',
    text: { one: 'v1 first', two: 'v1 method', three: 'v1 results' } },
  { name: '20260830-100100__save.json', when: '2026-08-30T10:01:00Z',
    text: { one: 'v1 first', two: 'v2 method', three: 'v1 results' } },
  { name: '20260830-100200__preapply.json', when: '2026-08-30T10:02:00Z',
    text: { one: 'v1 first', two: 'v2 method', three: 'v3 results' } },
  { name: '20260830-100300__prerestore.json', when: '2026-08-30T10:03:00Z',
    text: { one: 'v4 first', two: 'v2 method', three: 'v3 results' } },
];

const RETURNED = {
  one: BASE_TEXT.one,
  two: 'The method, rewritten on the other side.',
  three: 'The results, rewritten on the other side.',
};
const EDITED_ONE = BASE_TEXT.one + ' Edited before the exchange.';
const DRAFT = 'A returned report, half pasted, not submitted yet.';
const LOCAL_EDIT = 'The method, edited here a moment ago.';

/* ------------------------------------------------------------------ *
 * fixture
 * ------------------------------------------------------------------ */

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function report(text) {
  const t = text || BASE_TEXT;
  const section = (id, title, body) => ({
    id: id, title: title, children: [],
    blocks: [{ type: 'para', runs: [{ t: body }], cardStart: true }],
  });
  return {
    template: 'sample',
    meta: { title: 'Sample CDR report', doc_no: 'DOC-1', version: 'V1.0' },
    outline: [
      section('n-1', OVERVIEW, t.one),
      section('n-2', METHOD, t.two),
      section('n-3', RESULTS, t.three),
    ],
  };
}

function templateConfig() {
  return {
    id: 'sample',
    name: 'Sample template',
    caption_prefix: { figure: 'Figure', table: 'Table' },
    toc: { enabled: true },
    skeleton: [{ title: OVERVIEW, children: [] }],
    cover: { secrecy_default: 'Internal' },
    styles: {},
    compliance: {
      axis_labels: ['MIN', 'TYP', 'MAX', 'NTWC'],
      setting_kinds: ['common_setting'],
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

function buildRoot(root) {
  fs.mkdirSync(root, { recursive: true });
  writeJson(path.join(root, 'templates', 'sample', 'config.json'), templateConfig());
  writeJson(path.join(root, PROJECT_ID, 'project_meta.json'),
    { name: 'Sample project', description: 'Generated by this test' });
  writeJson(path.join(root, PROJECT_ID, MODULE_ID, 'project_meta.json'),
    { name: MODULE_ID, description: 'A block' });
  resetFixture(root);
  return root;
}

function resetFixture(root) {
  const dir = path.join(root, ...DIR.split('/'));
  writeJson(path.join(dir, 'project.json'), report());
  // The baseline is the report itself, so a returned package that rewrites two
  // sections conflicts with nothing -- the case the merge screen could not
  // describe.
  writeJson(path.join(dir, '_baseline.json'), report());
  try {
    fs.rmSync(path.join(dir, '_autosave'), { recursive: true, force: true });
  } catch (err) { /* windows holds files open now and then */ }
  for (const snap of SNAPSHOTS) {
    const file = path.join(dir, '_autosave', snap.name);
    writeJson(file, report(snap.text));
    const when = new Date(snap.when);
    fs.utimesSync(file, when, when);
  }
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
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: method,
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
      if ((await req('GET', base + '/api/health')).status === 200) return;
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
  console.log(detail && !ok ? line + '\n         ' + String(detail).slice(0, 300) : line);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * browser helpers
 * ------------------------------------------------------------------ */

// Record what the page puts on the clipboard. The label beside a copy button is
// only true if it describes THIS string.
const WATCH_CLIPBOARD = `(() => {
  window.__copied = null;
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: (t) => { window.__copied = String(t); return Promise.resolve(); } },
  });
  return 'watching';
})()`;

// Hold every write of the document for a while, which is the state finding 4 is
// about: a save in flight, not a save that failed.
const DELAY_SAVES = `(() => {
  if (window.__rwDelayed) return 'already';
  window.__rwDelayed = 1;
  const real = window.fetch;
  window.fetch = function (input, init) {
    const url = String((input && input.url) || input || '');
    const method = String((init && init.method) || 'GET').toUpperCase();
    const args = arguments;
    if (method === 'PUT' && url.indexOf('/api/project') !== -1) {
      return new Promise((resolve) => {
        setTimeout(() => resolve(real.apply(window, args)), 4000);
      });
    }
    return real.apply(window, args);
  };
  return 'delayed';
})()`;

function buttonScript(label, scope) {
  return `(() => {
    const want = ${JSON.stringify(label)};
    const root = document.querySelector(${JSON.stringify(scope || 'body')}) || document.body;
    const all = Array.from(root.querySelectorAll('button'));
    const hit = all.filter((b) => {
      const t = b.textContent.trim();
      return t === want || t.indexOf(want) === 0;
    })[0];
    if (!hit) return { found: false, seen: all.map((b) => b.textContent.trim()).slice(0, 30) };
    return { found: true, disabled: !!hit.disabled, text: hit.textContent.trim(), el: hit };
  })()`;
}

function clickScript(label, scope) {
  return `(() => {
    const found = ${buttonScript(label, scope)};
    if (!found.found) return 'no button: ' + JSON.stringify(found.seen);
    if (found.disabled) return 'disabled: ' + found.text;
    found.el.click();
    return 'clicked';
  })()`;
}

function labelScript(label, scope) {
  return `(() => {
    const found = ${buttonScript(label, scope)};
    return found.found ? { text: found.text, disabled: found.disabled } : { text: '', disabled: null };
  })()`;
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

(async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-exchange-'));
  buildRoot(root);
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

  const reportFile = path.join(root, ...DIR.split('/'), 'project.json');
  const onDisk = () => {
    try {
      return JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    } catch (err) {
      return null;
    }
  };
  const para = (i) => {
    const doc = onDisk();
    try {
      return doc.outline[i].blocks[0].runs[0].t;
    } catch (err) {
      return 'unreadable';
    }
  };

  let browser = null;
  try {
    await waitForServer(base, child, 20000);

    browser = await chromium.launch({ channel: 'msedge', headless: !HEADED });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('pageerror', (err) => consoleErrors.push(String(err && err.message)));

    const open = async () => {
      await page.goto('about:blank');
      await page.goto(base + '/#/r/' + DIR.split('/').map(encodeURIComponent).join('/'),
        { waitUntil: 'load' });
      await wait(1500);
    };
    const openExchange = async () => {
      await page.click('[title="Text exchange"]');
      await wait(900);
    };
    const openHistory = async () => {
      const clicked = await page.evaluate(clickScript('History'));
      if (clicked !== 'clicked') throw new Error('no History button: ' + clicked);
      await wait(900);
    };
    const drawerText = () => page.evaluate(() => {
      const el = document.querySelector('.rw-drawer');
      return el ? String(el.innerText || '') : '';
    });
    const dialogText = () => page.evaluate(() => {
      const el = document.querySelector('.rw-dialog');
      return el ? String(el.innerText || '') : '';
    });

    /* ============================================================ *
     * 1 - the shelf and the drawer agree on what a package may be
     * ============================================================ */

    console.log('\n1 - one rule for what a returned package may be  (PIN: fails before the fix)');
    await page.goto(base + '/#/', { waitUntil: 'load' });
    await wait(1200);
    const shelfAccept = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input[type=file]'));
      return inputs.map((i) => i.accept);
    });
    check('the shelf chooser takes the same kinds the drawer invites',
      shelfAccept.some((a) => a.indexOf('.zip') >= 0 && a.indexOf('.md') >= 0),
      'accept filters on the shelf: ' + JSON.stringify(shelfAccept));

    /* ============================================================ *
     * 2 - the size beside Copy whole report is what it copies
     * ============================================================ */

    console.log('\n2 - the copy button says what it copies  (PIN: fails before the fix)');
    await open();
    await page.evaluate(WATCH_CLIPBOARD);
    // One edit, saved, so there is something for the incremental route to carry
    // and both buttons have a payload to be compared by.
    await page.evaluate(`(async () => {
      const { store } = await import('/assets/v2/js/store.js');
      store.get().project.outline[0].blocks[0].runs[0].t = ${JSON.stringify(EDITED_ONE)};
      store.markDirty();
      return 'edited';
    })()`);
    await wait(3000);
    await openExchange();
    const wholeLabel = await page.evaluate(labelScript('Copy whole report'));
    const clickedWhole = await page.evaluate(clickScript('Copy whole report'));
    check('the whole-report button is on screen and takes a press',
      clickedWhole === 'clicked', String(clickedWhole));
    await wait(400);
    const clip = await page.evaluate(async () => {
      const util = await import('/assets/v2/js/util.js');
      const text = window.__copied == null ? '' : window.__copied;
      return { chars: text.length, pretty: util.formatBytes(text.length) };
    });
    check('the size beside the button is the size of what landed on the clipboard',
      wholeLabel.text.indexOf(clip.pretty) >= 0,
      'button read ' + JSON.stringify(wholeLabel.text) + ' and copied ' + clip.chars
      + ' characters (' + clip.pretty + ')');

    const suggestion = await page.evaluate(() => {
      const el = document.querySelector('.rw-drawer');
      const text = el ? String(el.innerText || '') : '';
      const line = text.split('\n').filter((l) => l.indexOf('% smaller') >= 0)[0] || '';
      return line;
    });
    if (suggestion) {
      const pct = Number((suggestion.match(/(\d+)% smaller/) || [])[1]);
      const diffChars = Number((await req('POST',
        base + '/api/copy-diff?dir=' + encodeURIComponent(DIR),
        JSON.stringify(onDisk())).then((a) => JSON.parse(a.text).diff_chars)) || 0);
      const truth = Math.round((1 - diffChars / clip.chars) * 100);
      check('the "% smaller" compares the two things the two buttons produce',
        Math.abs(pct - truth) <= 1,
        'screen says ' + pct + '%, the two clipboard payloads differ by ' + truth + '%');
    } else {
      check('a suggestion line is on screen', false, 'no "% smaller" line in the drawer');
    }

    const statusLine = await drawerText();
    check('"Changes since" says what the delta carries, not just how many sections',
      /section changed/.test(statusLine) && /paragraph/.test(statusLine),
      statusLine.replace(/\s+/g, ' ').slice(0, 300));

    /* ============================================================ *
     * 3 - a half-typed paste survives a click in the editor
     * ============================================================ */

    console.log('\n3 - the paste box is not thrown away  (PIN: fails before the fix)');
    let opened = await page.evaluate(clickScript('Or paste text'));
    check('the drawer offers the paste box', opened === 'clicked', String(opened));
    await page.fill('.rw-sync__paste', DRAFT);
    await wait(200);
    // A click in the editor behind the drawer: the scrim is what receives it.
    await page.mouse.click(300, 500);
    await wait(600);
    const stillOpen = await page.evaluate(() => {
      const box = document.querySelector('.rw-sync__paste');
      return { open: !!document.querySelector('.rw-drawer'), text: box ? box.value : null };
    });
    check('a click outside does not throw away text that was typed in',
      stillOpen.open && stillOpen.text === DRAFT, JSON.stringify(stillOpen));

    await page.keyboard.press('Escape');
    await wait(500);
    await openExchange();
    const reopened = await page.evaluate(() => {
      const box = document.querySelector('.rw-sync__paste');
      return box ? box.value : '(no paste box)';
    });
    check('and closing the drawer on purpose keeps the draft for next time',
      reopened === DRAFT, JSON.stringify(reopened));

    /* ============================================================ *
     * 4 - an update that conflicts with nothing is still readable
     * ============================================================ */

    console.log('\n4 - a conflict-free update says what it writes  (PIN: fails before the fix)');
    // From a known state rather than from whatever the previous flow left: the
    // drawer may or may not still be open, depending on what is being tested.
    await page.keyboard.press('Escape');
    await wait(400);
    await openExchange();
    if (!(await page.$('.rw-sync__paste'))) await page.evaluate(clickScript('Or paste text'));
    await wait(300);
    await page.fill('.rw-sync__paste', JSON.stringify(report(RETURNED), null, 2));
    await wait(200);
    const used = await page.evaluate(clickScript('Use this text'));
    check('the pasted report is taken', used === 'clicked', String(used));
    await wait(1800);
    const carried = await page.evaluate(clickScript('Continue'));
    check('the import dialog offers Continue', carried === 'clicked', String(carried));
    await wait(1200);

    const mergeText = await dialogText();
    check('the merge screen names the sections the package rewrites',
      mergeText.indexOf(METHOD) >= 0 && mergeText.indexOf(RESULTS) >= 0
      && mergeText.indexOf('Nothing here yet') < 0,
      mergeText.replace(/\s+/g, ' ').slice(0, 300));
    check('and shows what the returned version of the selected one says',
      mergeText.indexOf('rewritten on the other side') >= 0,
      mergeText.replace(/\s+/g, ' ').slice(0, 300));
    const applyLabel = await page.evaluate(labelScript('Apply', '.rw-dialog'));
    check('the primary button says what pressing it does',
      /^Apply 2 changes$/.test(applyLabel.text),
      'the button reads ' + JSON.stringify(applyLabel.text));

    const appliedPress = await page.evaluate(clickScript('Apply 2 changes', '.rw-dialog'));
    check('the merge applies', appliedPress === 'clicked', String(appliedPress));
    await wait(2500);
    check('and the two sections it named are the two that changed on disk',
      para(1) === RETURNED.two && para(2) === RETURNED.three && para(0) === EDITED_ONE,
      JSON.stringify([para(0), para(1), para(2)]));

    /* ============================================================ *
     * 5 - a comparison that has not run yet is not printed as a count
     * ============================================================ */

    console.log('\n5 - a save in flight is said, not counted as zero  (PIN: fails before the fix)');
    resetFixture(root);
    await open();
    await page.evaluate(DELAY_SAVES);
    await page.evaluate(`(async () => {
      const { store } = await import('/assets/v2/js/store.js');
      store.get().project.outline[1].blocks[0].runs[0].t = ${JSON.stringify(LOCAL_EDIT)};
      store.markDirty();
      return 'edited';
    })()`);
    await openExchange();
    opened = await page.evaluate(clickScript('Or paste text'));
    await page.fill('.rw-sync__paste', JSON.stringify(report(RETURNED), null, 2));
    await page.evaluate(clickScript('Use this text'));
    await wait(900);
    const waiting = await page.evaluate(labelScript('Continue', '.rw-dialog'));
    check('the button says the comparison is waiting for the save, not "compare 0 passages"',
      waiting.text.indexOf('0 passages') < 0 && waiting.text.length > 0,
      'the button reads ' + JSON.stringify(waiting.text));
    check('and it is still disabled while it waits', waiting.disabled === true,
      JSON.stringify(waiting));
    await wait(7000);
    const settled = await page.evaluate(labelScript('Continue', '.rw-dialog'));
    check('once the save lands the real count appears and the button enables',
      /compare 1 passages/.test(settled.text) && settled.disabled === false,
      'the button reads ' + JSON.stringify(settled.text));
    await page.keyboard.press('Escape');
    await wait(300);
    await page.keyboard.press('Escape');
    await wait(300);

    /* ============================================================ *
     * 6 - the timeline says what each state is and what it changed
     * ============================================================ */

    console.log('\n6 - a timeline entry can be told from the next  (PIN: fails before the fix)');
    resetFixture(root);
    await open();
    await openHistory();
    const timeline = await drawerText();
    check('an entry names its cause rather than reading "Automatic snapshot"',
      timeline.indexOf('Before applying an update') >= 0
      && timeline.indexOf('Before restoring a snapshot') >= 0,
      timeline.replace(/\s+/g, ' ').slice(0, 400));
    check('and says which section it differs from the state before it by',
      timeline.indexOf(OVERVIEW) >= 0 && timeline.indexOf(RESULTS) >= 0,
      timeline.replace(/\s+/g, ' ').slice(0, 400));

    const restores = await page.evaluate(clickScript('Restores'));
    check('the Restores filter is offered', restores === 'clicked', String(restores));
    await wait(400);
    const restoresText = await drawerText();
    check('and it holds the restore this report has been through',
      restoresText.indexOf('Before restoring a snapshot') >= 0
      && restoresText.indexOf('Nothing here yet') < 0,
      restoresText.replace(/\s+/g, ' ').slice(0, 300));
    await page.evaluate(clickScript('All'));
    await wait(400);

    /* ============================================================ *
     * 7 - a restore names what it drops, before it drops it
     * ============================================================ */

    console.log('\n7 - a restore asks first  (PIN: fails before the fix)');
    // The third entry down is an ordinary snapshot two states back: restoring
    // it drops the two states above it.
    const pressed = await page.evaluate(`(() => {
      const items = Array.from(document.querySelectorAll('.rw-timeline__item'));
      const row = items[2];
      if (!row) return 'only ' + items.length + ' entries';
      const button = Array.from(row.querySelectorAll('button'))
        .filter((b) => b.textContent.trim().indexOf('Restore this state') === 0)[0];
      if (!button) return 'no restore button on that entry';
      button.click();
      return 'clicked';
    })()`);
    check('the third entry offers a restore', pressed === 'clicked', String(pressed));
    await wait(600);
    const ask = await dialogText();
    check('pressing it asks before anything is written',
      ask.indexOf('Restore this state?') >= 0, ask.replace(/\s+/g, ' ').slice(0, 300));
    check('and the question names the work that would be dropped',
      /2 later states/.test(ask) && ask.indexOf(OVERVIEW) >= 0 && ask.indexOf(RESULTS) >= 0,
      ask.replace(/\s+/g, ' ').slice(0, 400));
    check('and says the restore can itself be undone',
      /snapshotted first/.test(ask), ask.replace(/\s+/g, ' ').slice(0, 300));
    check('nothing has been written while the question stands',
      para(1) === BASE_TEXT.two, JSON.stringify(para(1)));

    const cancelled = await page.evaluate(clickScript('Cancel', '.rw-dialog'));
    check('the question can be answered no', cancelled === 'clicked', String(cancelled));
    await wait(500);
    check('and answering no writes nothing', para(1) === BASE_TEXT.two, JSON.stringify(para(1)));

    await page.evaluate(`(() => {
      const items = Array.from(document.querySelectorAll('.rw-timeline__item'));
      const button = Array.from(items[2].querySelectorAll('button'))
        .filter((b) => b.textContent.trim().indexOf('Restore this state') === 0)[0];
      button.click();
      return 'clicked';
    })()`);
    await wait(600);
    const confirmed = await page.evaluate(clickScript('Restore this state', '.rw-dialog__foot'));
    check('and answering yes runs the restore', confirmed === 'clicked', String(confirmed));
    await wait(2500);
    check('the report is back at the state that was chosen',
      para(1) === 'v2 method' && para(0) === 'v1 first',
      JSON.stringify([para(0), para(1), para(2)]));

    /* ============================================================ *
     * 8 - the ancestor warning is kept for the day it means something
     * ============================================================ */

    console.log('\n8 - a package with no fingerprint, on an untouched report  (PIN: fails before)');
    resetFixture(root);
    await open();
    await openExchange();
    if (!(await page.$('.rw-sync__paste'))) await page.evaluate(clickScript('Or paste text'));
    await wait(300);
    await page.fill('.rw-sync__paste', JSON.stringify(report(RETURNED), null, 2));
    await page.evaluate(clickScript('Use this text'));
    await wait(1800);
    const quiet = await dialogText();
    check('nothing here can be overwritten, and that is what it says',
      quiet.indexOf('Nothing of yours is at stake here') >= 0
      && quiet.indexOf('The common ancestor could not be checked') < 0,
      quiet.replace(/\s+/g, ' ').slice(0, 300));

    if (consoleErrors.length) {
      check('no uncaught page errors', false, consoleErrors.slice(0, 3).join(' | '));
    } else {
      console.log('  [ok  ] no uncaught page errors');
    }

    await context.close();
  } catch (err) {
    check('the harness ran to the end', false, String(err && err.stack ? err.stack : err));
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (child.exitCode === null) child.kill();
    await wait(300);
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch (err) { /* windows */ }
  }

  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log(results.length - failed.length + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
}());
