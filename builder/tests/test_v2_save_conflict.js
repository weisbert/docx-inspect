#!/usr/bin/env node
'use strict';
/*
 * test_v2_save_conflict.js -- a save the loop will not repeat is a state the
 * user can leave, not a dead end.
 *
 * Run:  node builder/tests/test_v2_save_conflict.js
 *       node builder/tests/test_v2_save_conflict.js --headed   (watch it work)
 *
 * THE DEFECTS
 *   One 409 used to end the session: scheduleSave returned early for that
 *   report for good, saveNow rejected for good, leaving was refused for good,
 *   the chip fell through to the grey "Unsaved changes", and the only exit was
 *   a fresh read -- which discarded the edit. A save that landed after the
 *   report had been moved to the trash brought it back with none of its
 *   images, baseline or history, then blocked the trash restore. The refusal
 *   to leave named the problem and offered nothing. A load that failed in
 *   report A stayed pinned above healthy report B. A corrupt project.json
 *   showed the parser's own words and the shelf said nothing beforehand. And
 *   the browser's unsaved-changes prompt fired for the debounce window, which
 *   the flush covers on its own.
 *
 * WHAT IT ASSERTS, in a real browser, against a real server and the disk
 *   A. a real 409: the chip says blocked in red; the banner offers Keep my
 *      version / Copy my version / Load theirs; nothing is retried with the
 *      token dropped; an edit made while blocked raises the banner again
 *      rather than vanishing; Copy puts the in-memory report on the
 *      clipboard; Keep writes once, explicitly, after snapshotting the other
 *      version; afterwards saving is ordinary again
 *   B. Load theirs asks first, then reads the file; saving resumes
 *   C. a real 410: a save that lands after the delete writes nothing, does
 *      not recreate the folder, offers Copy my version only, and the trash
 *      restore still works
 *   D. the refusal to leave offers Retry and Leave and discard, and both do
 *      what they say
 *   E. a corrupt project.json is said in plain words; the banner does not
 *      follow the user into a healthy report; the shelf marks the row
 *   F. an edit inside the debounce window is flushed on the way out with no
 *      prompt; a write in flight still gets one
 *   G. a new report inheriting from this one waits for the flush and refuses
 *      when it cannot land
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
const CDR_DIR = PROJECT_ID + '/' + MODULE_ID + '/CDR';
const PDR_DIR = PROJECT_ID + '/' + MODULE_ID + '/PDR';
const FDR_DIR = PROJECT_ID + '/' + MODULE_ID + '/FDR';   // its project.json is not JSON

const START_TEXT = 'First section, as it was saved.';
const PDR_MARKER = 'Design description, second stage';
const THEIRS = 'First section, written by the other window.';
const THEIRS_2 = 'First section, written by the other window again.';

/* ------------------------------------------------------------------ *
 * fixture
 * ------------------------------------------------------------------ */

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function sampleReport(first, stage, secondTitle) {
  return {
    schema_version: 1,
    template: 'sample',
    meta: { title: MODULE_ID + ' ' + stage + ' report', doc_no: 'DOC-1', version: 'V1.0' },
    outline: [
      {
        id: 'n-1',
        title: 'Overview',
        blocks: [{ type: 'para', runs: [{ t: first || START_TEXT }], cardStart: true }],
        children: [],
      },
      {
        id: 'n-2',
        title: secondTitle || 'Design description',
        blocks: [{ type: 'para', runs: [{ t: 'Second section.' }], cardStart: true }],
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

function buildReportsRoot(root) {
  fs.mkdirSync(root, { recursive: true });
  writeJson(path.join(root, 'templates', 'sample', 'config.json'), sampleTemplateConfig());
  writeJson(path.join(root, PROJECT_ID, 'project_meta.json'),
    { name: 'Sample project', description: 'Generated by this test' });
  writeJson(path.join(root, PROJECT_ID, MODULE_ID, 'project_meta.json'),
    { name: MODULE_ID, description: 'Divider block' });
  writeJson(path.join(root, ...CDR_DIR.split('/'), 'project.json'), sampleReport(START_TEXT, 'CDR'));
  writeJson(path.join(root, ...CDR_DIR.split('/'), '_baseline.json'), sampleReport(START_TEXT, 'CDR'));
  fs.mkdirSync(path.join(root, ...CDR_DIR.split('/'), 'images'), { recursive: true });
  fs.writeFileSync(path.join(root, ...CDR_DIR.split('/'), 'images', 'plot.png'),
    Buffer.from('89504e470d0a1a0a', 'hex'));
  writeJson(path.join(root, ...PDR_DIR.split('/'), 'project.json'),
    sampleReport('First section of the second stage.', 'PDR', PDR_MARKER));
  const broken = path.join(root, ...FDR_DIR.split('/'), 'project.json');
  fs.mkdirSync(path.dirname(broken), { recursive: true });
  fs.writeFileSync(broken, '{ this is not json', 'utf8');
  return root;
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
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (err) { /* not json */ }
        resolve({ status: res.statusCode, text: text, json: json });
      });
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
 * browser helpers (page scripts)
 * ------------------------------------------------------------------ */

// Edit the document through the store, the way every view does, so the state
// under test is exactly "a save is owed".
function editScript(text) {
  return `(async () => {
    const { store } = await import('/assets/v2/js/store.js');
    const project = store.get().project;
    if (!project) return 'no document';
    project.outline[0].blocks[0].runs[0].t = ${JSON.stringify(text)};
    store.markDirty();
    return 'edited';
  })()`;
}

const MEMORY = `(async () => {
  const { store } = await import('/assets/v2/js/store.js');
  const s = store.get();
  const outline = (s.project && s.project.outline) || [];
  const read = (i) => {
    try { return outline[i].blocks[0].runs[0].t; } catch (err) { return ''; }
  };
  return {
    first: read(0), dirty: !!s.dirty, saveState: s.saveState, saveBlock: s.saveBlock || null,
    projectDir: s.projectDir, routeDir: s.route && s.route.dir,
    banners: (s.banners || []).map((b) => b.code || ''),
  };
})()`;

const CHIP = `(() => {
  const el = document.querySelector('.rw-save');
  if (!el) return { text: '', failed: false, state: '' };
  return {
    text: el.textContent.trim(),
    failed: el.classList.contains('rw-save--failed'),
    state: el.getAttribute('data-save-state') || '',
  };
})()`;

function bannerScript(code) {
  return `(() => {
    const el = document.querySelector('.rw-banner[data-code=' + ${JSON.stringify(JSON.stringify(code))} + ']');
    if (!el) return null;
    return {
      title: (el.querySelector('.rw-banner__title') || {}).textContent || '',
      message: (el.querySelector('.rw-banner__message') || {}).textContent || '',
      buttons: Array.from(el.querySelectorAll('button')).map((b) => b.textContent.trim()),
    };
  })()`;
}

function clickBannerScript(code, label) {
  return `(() => {
    const el = document.querySelector('.rw-banner[data-code=' + ${JSON.stringify(JSON.stringify(code))} + ']');
    if (!el) return 'no banner ' + ${JSON.stringify(code)};
    const hit = Array.from(el.querySelectorAll('button'))
      .filter((b) => b.textContent.trim() === ${JSON.stringify(label)})[0];
    if (!hit) return 'no button ' + ${JSON.stringify(label)};
    hit.click();
    return 'clicked';
  })()`;
}

function clickButtonScript(label) {
  return `(() => {
    const all = Array.from(document.querySelectorAll('button'));
    const hit = all.filter((b) => b.textContent.trim() === ${JSON.stringify(label)})[0];
    if (!hit) return 'no button: ' + JSON.stringify(all.map((b) => b.textContent.trim()).slice(0, 30));
    if (hit.disabled) return 'disabled';
    hit.click();
    return 'clicked';
  })()`;
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

(async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-save-conflict-'));
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

  const folderOf = (dir) => path.join(root, ...dir.split('/'));
  const fileOf = (dir) => path.join(folderOf(dir), 'project.json');
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
  const snapshotsHolding = (dir, text) => {
    const d = path.join(folderOf(dir), '_autosave');
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

    browser = await chromium.launch({ channel: 'msedge', headless: !HEADED });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const page = await context.newPage();

    // Every dialog is recorded and accepted, so a prompt can never hang the
    // run -- and so the run can say whether one fired.
    const dialogs = [];
    page.on('dialog', async (d) => {
      dialogs.push(d.type());
      try { await d.accept(); } catch (err) { /* already gone */ }
    });

    // Every write of the document, as it left the page.
    const puts = [];
    page.on('request', (r) => {
      if (r.method() !== 'PUT') return;
      const u = new URL(r.url());
      if (u.pathname !== '/api/project') return;
      puts.push({
        dir: u.searchParams.get('dir'),
        savedAt: u.searchParams.get('saved_at'),
        overwrite: u.searchParams.get('overwrite'),
      });
    });
    const posts = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' || r.method() === 'PUT') posts.push(r.method() + ' ' + new URL(r.url()).pathname);
    });

    const urlOf = (dir) => base + '/#/r/' + dir.split('/').map(encodeURIComponent).join('/');
    const open = async (dir) => {
      await page.goto('about:blank');
      await page.goto(urlOf(dir), { waitUntil: 'load' });
      await wait(1400);
    };
    const go = async (dir) => {
      await page.evaluate((href) => { window.location.hash = href; },
        dir ? '#/r/' + dir.split('/').map(encodeURIComponent).join('/') : '#/');
    };
    const hashDir = () => page.evaluate(() => decodeURIComponent(window.location.hash.replace(/^#\/r\//, '').replace(/\?.*$/, '')));
    const onScreen = (text) => page.evaluate((t) => {
      const el = document.querySelector('.rw-app') || document.body;
      return !!el && String(el.innerText || '').indexOf(t) !== -1;
    }, text);
    const edit = (text) => page.evaluate(editScript(text));
    const memory = () => page.evaluate(MEMORY);
    const chip = () => page.evaluate(CHIP);
    const banner = (code) => page.evaluate(bannerScript(code));
    const pressInBanner = (code, label) => page.evaluate(clickBannerScript(code, label));
    const press = (label) => page.evaluate(clickButtonScript(label));
    const failEveryPut = async () => {
      await page.route('**/api/project?*', async (route) => {
        if (route.request().method() !== 'PUT') return route.continue();
        return route.fulfill({
          status: 500, contentType: 'application/json',
          body: '{"error":"the disk refused this write"}',
        });
      });
    };
    const letPutsThrough = () => page.unroute('**/api/project?*');

    /* ============================================================ *
     * A. a conflict, for real
     * ============================================================ */

    console.log('\nA. one 409 is not the end of the session  (PIN: fails before the fix)');
    await open(CDR_DIR);
    puts.length = 0;
    // The other window writes the file: the token this page holds is now stale.
    writeJson(fileOf(CDR_DIR), sampleReport(THEIRS, 'CDR'));
    await wait(200);
    const EDIT_A = 'First section, typed after the other window wrote.';
    check('the edit was made', (await edit(EDIT_A)) === 'edited');
    await wait(2500);

    let c = await chip();
    check('the chip says the loop is blocked, in red',
      /changed somewhere else/.test(c.text) && c.failed && c.state === 'blocked', JSON.stringify(c));
    let b = await banner('save-blocked');
    check('the banner offers Keep my version, Copy my version and Load theirs',
      !!b && ['Keep my version', 'Copy my version', 'Load theirs'].every((l) => b.buttons.indexOf(l) >= 0),
      JSON.stringify(b));
    check('the refused write was not repeated with the token dropped',
      puts.length === 1 && puts[0].savedAt !== null && !puts[0].overwrite, JSON.stringify(puts));
    check('the file still holds the other window\'s version', para(CDR_DIR, 0) === THEIRS,
      JSON.stringify(para(CDR_DIR, 0)));

    // Close the banner, type again: the choice comes back, nothing goes out.
    const closed = await page.evaluate(`(() => {
      const el = document.querySelector('.rw-banner[data-code="save-blocked"]');
      const hit = el && Array.from(el.querySelectorAll('button')).filter((x) => x.textContent.trim() === 'Close')[0];
      if (!hit) return 'no close'; hit.click(); return 'closed';
    })()`);
    check('the banner can be closed', closed === 'closed', String(closed));
    await wait(200);
    const EDIT_A2 = 'First section, typed again while blocked.';
    await edit(EDIT_A2);
    await wait(1600);
    b = await banner('save-blocked');
    check('an edit made while blocked raises the choice again instead of vanishing',
      !!b && b.buttons.indexOf('Keep my version') >= 0, JSON.stringify(b));
    check('and still nothing was sent', puts.length === 1, JSON.stringify(puts));
    const saveNowCode = await page.evaluate(`(async () => {
      const { store } = await import('/assets/v2/js/store.js');
      try { await store.saveNow(); return 'resolved'; } catch (err) { return err.code || 'rejected'; }
    })()`);
    check('Ctrl+S (saveNow) is refused as a conflict rather than hanging or writing',
      saveNowCode === 'save-conflict' && puts.length === 1, saveNowCode + ' ' + JSON.stringify(puts));
    let m = await memory();
    check('the edit is still in memory and the document is still dirty',
      m.first === EDIT_A2 && m.dirty === true && m.saveState === 'blocked', JSON.stringify(m));

    // Copy my version: the in-memory document, whole.
    const copied = await pressInBanner('save-blocked', 'Copy my version');
    check('Copy my version is pressable', copied === 'clicked', String(copied));
    await wait(800);
    let clip = '';
    try {
      clip = await page.evaluate(() => navigator.clipboard.readText());
    } catch (err) {
      clip = 'clipboard unreadable: ' + err.message;
    }
    check('the clipboard holds the version that is only in this window',
      clip.indexOf(EDIT_A2) >= 0, clip.slice(0, 120));

    // Keep my version: one explicit write, the other version snapshotted first.
    const kept = await pressInBanner('save-blocked', 'Keep my version');
    check('Keep my version is pressable', kept === 'clicked', String(kept));
    await wait(2500);
    check('the file now holds this window\'s version', para(CDR_DIR, 0) === EDIT_A2,
      JSON.stringify(para(CDR_DIR, 0)));
    check('it went out once, without the token, as an explicit overwrite',
      puts.length === 2 && puts[1].savedAt === null && puts[1].overwrite === '1', JSON.stringify(puts));
    check('the other window\'s version was snapshotted before it was replaced',
      snapshotsHolding(CDR_DIR, THEIRS).some((n) => /__overwrite/.test(n)),
      JSON.stringify(snapshotsHolding(CDR_DIR, THEIRS)));
    c = await chip();
    m = await memory();
    check('the chip reads Saved and the block is gone',
      /^Saved/.test(c.text) && !c.failed && m.dirty === false && m.saveState === 'saved',
      JSON.stringify({ chip: c, mem: m }));
    check('the banner is gone', (await banner('save-blocked')) === null);

    const EDIT_A3 = 'First section, typed after keeping my version.';
    await edit(EDIT_A3);
    await wait(2500);
    check('ordinary saving resumed: the next edit reached the disk with a token',
      para(CDR_DIR, 0) === EDIT_A3 && puts.length === 3 && puts[2].savedAt !== null && !puts[2].overwrite,
      JSON.stringify({ disk: para(CDR_DIR, 0), puts: puts }));

    /* ============================================================ *
     * B. load theirs
     * ============================================================ */

    console.log('\nB. Load theirs asks first, then reads the file');
    await open(CDR_DIR);
    puts.length = 0;
    writeJson(fileOf(CDR_DIR), sampleReport(THEIRS_2, 'CDR'));
    await wait(200);
    const EDIT_B = 'First section, typed before loading theirs.';
    await edit(EDIT_B);
    await wait(2500);
    check('blocked again', (await memory()).saveState === 'blocked');
    check('Load theirs is pressable', (await pressInBanner('save-blocked', 'Load theirs')) === 'clicked');
    await wait(300);
    b = await banner('save-blocked');
    check('it asks before discarding, with a way back',
      !!b && /Discard my version/.test(b.title)
        && b.buttons.indexOf('Discard and load theirs') >= 0 && b.buttons.indexOf('Keep editing') >= 0,
      JSON.stringify(b));
    check('Keep editing goes back to the choice',
      (await pressInBanner('save-blocked', 'Keep editing')) === 'clicked');
    await wait(300);
    b = await banner('save-blocked');
    check('and the choice is back', !!b && b.buttons.indexOf('Keep my version') >= 0, JSON.stringify(b));
    m = await memory();
    check('nothing was lost on the way', m.first === EDIT_B && m.dirty === true, JSON.stringify(m));
    await pressInBanner('save-blocked', 'Load theirs');
    await wait(300);
    puts.length = 0;   // the refused write is counted; loading must add nothing
    check('Discard and load theirs is pressable',
      (await pressInBanner('save-blocked', 'Discard and load theirs')) === 'clicked');
    await wait(1800);
    m = await memory();
    c = await chip();
    check('the file\'s version is on screen, clean, and the block is gone',
      m.first === THEIRS_2 && m.dirty === false && m.saveState === 'saved' && /^Saved/.test(c.text)
        && (await onScreen(THEIRS_2)),
      JSON.stringify({ mem: m, chip: c }));
    check('the banner is gone', (await banner('save-blocked')) === null);
    check('nothing was written by loading', puts.length === 0 && para(CDR_DIR, 0) === THEIRS_2,
      JSON.stringify(puts));
    const EDIT_B2 = 'First section, typed after loading theirs.';
    await edit(EDIT_B2);
    await wait(2500);
    check('ordinary saving resumed after loading theirs',
      para(CDR_DIR, 0) === EDIT_B2 && puts.length === 1 && puts[0].savedAt !== null,
      JSON.stringify({ disk: para(CDR_DIR, 0), puts: puts }));

    /* ============================================================ *
     * C. the report is deleted while a save is owed
     * ============================================================ */

    console.log('\nC. a save never brings a deleted report back  (PIN: fails before the fix)');
    await open(CDR_DIR);
    puts.length = 0;
    const deleted = await req('POST', base + '/api/project-delete', JSON.stringify({ dir: CDR_DIR }));
    check('the report was moved to the trash from the shelf',
      deleted.status === 200 && deleted.json && deleted.json.id && !fs.existsSync(folderOf(CDR_DIR)),
      deleted.text.slice(0, 200));
    const EDIT_C = 'First section, typed after the report was deleted.';
    await edit(EDIT_C);
    await wait(2500);
    check('the folder was NOT recreated by the save', !fs.existsSync(folderOf(CDR_DIR)));
    c = await chip();
    check('the chip says the report is gone, in red',
      /no longer on disk/.test(c.text) && c.failed && c.state === 'blocked', JSON.stringify(c));
    b = await banner('save-blocked');
    check('the banner offers Copy my version and nothing that would write',
      !!b && b.buttons.indexOf('Copy my version') >= 0
        && b.buttons.indexOf('Keep my version') < 0 && b.buttons.indexOf('Load theirs') < 0,
      JSON.stringify(b));
    check('the write was not repeated', puts.length === 1, JSON.stringify(puts));
    m = await memory();
    check('the edit is still in memory, still dirty', m.first === EDIT_C && m.dirty === true, JSON.stringify(m));
    const restored = await req('POST', base + '/api/trash-restore', JSON.stringify({ id: deleted.json.id }));
    check('the trashed copy can be put back, because nothing occupies its path',
      restored.status === 200 && fs.existsSync(path.join(folderOf(CDR_DIR), 'images', 'plot.png'))
        && fs.existsSync(path.join(folderOf(CDR_DIR), '_baseline.json')),
      restored.text.slice(0, 200));

    /* ============================================================ *
     * D. the refusal to leave offers the two ways past it
     * ============================================================ */

    console.log('\nD. leaving is refused with Retry and Leave and discard  (PIN: fails before the fix)');
    await open(CDR_DIR);
    await failEveryPut();
    const EDIT_D = 'First section, typed while the disk refused writes.';
    await edit(EDIT_D);
    await go(PDR_DIR);
    await wait(4500);
    check('the address bounced back', (await hashDir()) === CDR_DIR, await hashDir());
    b = await banner('leave-blocked');
    check('the refusal offers Retry and Leave and discard',
      !!b && b.buttons.indexOf('Retry') >= 0 && b.buttons.indexOf('Leave and discard') >= 0,
      JSON.stringify(b));
    check('Retry with the disk still refusing keeps the user here',
      (await pressInBanner('leave-blocked', 'Retry')) === 'clicked');
    await wait(4500);
    check('still here, still refused', (await hashDir()) === CDR_DIR && !!(await banner('leave-blocked')));
    await letPutsThrough();
    check('Retry once the disk answers', (await pressInBanner('leave-blocked', 'Retry')) === 'clicked');
    await wait(3500);
    check('the save landed and the address moved', para(CDR_DIR, 0) === EDIT_D && (await hashDir()) === PDR_DIR,
      JSON.stringify({ disk: para(CDR_DIR, 0), hash: await hashDir() }));
    check('the other report is on screen', await onScreen(PDR_MARKER));
    check('the refusal did not follow into the other report',
      (await banner('leave-blocked')) === null && (await banner('save-failed')) === null,
      JSON.stringify((await memory()).banners));

    await open(CDR_DIR);
    await failEveryPut();
    const EDIT_D2 = 'First section, typed and then discarded on purpose.';
    await edit(EDIT_D2);
    await go(PDR_DIR);
    await wait(4500);
    check('refused again', !!(await banner('leave-blocked')) && (await hashDir()) === CDR_DIR);
    check('Leave and discard is pressable',
      (await pressInBanner('leave-blocked', 'Leave and discard')) === 'clicked');
    await wait(2500);
    check('the address moved and the other report is on screen',
      (await hashDir()) === PDR_DIR && (await onScreen(PDR_MARKER)), await hashDir());
    check('the discarded edit was not written', para(CDR_DIR, 0) === EDIT_D, JSON.stringify(para(CDR_DIR, 0)));
    check('no banner is left standing', (await memory()).banners.length === 0,
      JSON.stringify((await memory()).banners));
    await letPutsThrough();
    await go(CDR_DIR);
    await wait(2000);
    check('coming back shows the file, not the discarded edit',
      (await memory()).first === EDIT_D && !(await onScreen(EDIT_D2)), JSON.stringify(await memory()));

    /* ============================================================ *
     * E. a corrupt file, said plainly, and not carried into another report
     * ============================================================ */

    console.log('\nE. a corrupt project.json  (PIN: fails before the fix)');
    await open(FDR_DIR);
    await wait(1200);
    b = await banner('project');
    check('opening it raises one banner about the file',
      !!b && /cannot be opened/.test(b.title) && /not valid JSON/.test(b.message), JSON.stringify(b));
    check('the parser\'s own words are not the message',
      !!b && !/Expecting property name/.test(b.message), JSON.stringify(b));
    await go(CDR_DIR);
    await wait(2500);
    check('moving to a healthy report drops that banner',
      (await banner('project')) === null && (await onScreen(EDIT_D)),
      JSON.stringify((await memory()).banners));
    await go(null);
    await wait(1800);
    const rows = await page.evaluate(`(() => Array.from(document.querySelectorAll('.rw-row')).map((r) => ({
      dir: r.getAttribute('data-dir'),
      unreadable: !!r.querySelector('.rw-row__unreadable'),
      muted: r.classList.contains('rw-row--unreadable'),
      badge: (r.querySelector('.rw-row__unreadable') || {}).textContent || '',
    })))()`);
    const fdrRow = rows.filter((r) => r.dir === FDR_DIR)[0];
    const cdrRow = rows.filter((r) => r.dir === CDR_DIR)[0];
    check('the shelf marks the unreadable report before it is opened',
      !!fdrRow && fdrRow.unreadable && fdrRow.muted && /Unreadable/.test(fdrRow.badge), JSON.stringify(rows));
    check('and leaves the healthy ones alone', !!cdrRow && !cdrRow.unreadable && !cdrRow.muted, JSON.stringify(rows));

    /* ============================================================ *
     * F. the unload prompt tells the truth
     * ============================================================ */

    console.log('\nF. the browser prompt only when the flush cannot cover it  (PIN: fails before the fix)');
    await open(CDR_DIR);
    dialogs.length = 0;
    const EDIT_F = 'First section, typed and the page closed at once.';
    await edit(EDIT_F);
    await page.goto('about:blank').catch(() => {});
    await wait(2500);
    check('an edit inside the debounce window is on disk after leaving at once',
      para(CDR_DIR, 0) === EDIT_F, JSON.stringify(para(CDR_DIR, 0)));
    check('and no prompt was raised for it', dialogs.length === 0, JSON.stringify(dialogs));

    await open(CDR_DIR);
    dialogs.length = 0;
    let releaseHeld = null;
    const held = new Promise((resolve) => { releaseHeld = resolve; });
    await page.route('**/api/project?*', async (route) => {
      if (route.request().method() !== 'PUT') return route.continue();
      await held;
      try { await route.continue(); } catch (err) { /* the page went away */ }
    });
    const EDIT_F2 = 'First section, typed while a write was in flight.';
    await edit(EDIT_F2);
    await wait(1400);   // past the debounce: the PUT is in flight, held open
    check('a write is in flight', (await memory()).saveState === 'saving', JSON.stringify(await memory()));
    await page.goto('about:blank').catch(() => {});
    await wait(500);
    check('a write in flight still gets the prompt', dialogs.indexOf('beforeunload') >= 0, JSON.stringify(dialogs));
    releaseHeld();
    await wait(1500);
    await page.unroute('**/api/project?*');

    /* ============================================================ *
     * G. a new report inheriting from this one waits for the flush
     * ============================================================ */

    console.log('\nG. inheriting waits for the flush  (PIN: fails before the fix)');
    await open(CDR_DIR);
    await failEveryPut();
    posts.length = 0;
    const EDIT_G = 'First section, typed just before creating a new report.';
    await edit(EDIT_G);
    const plus = await page.evaluate(`(() => {
      const hit = document.querySelector('.rw-seg button[title="New report"]');
      if (!hit) return 'no plus'; hit.click(); return 'clicked';
    })()`);
    check('the stage strip\'s + opens the dialog', plus === 'clicked', String(plus));
    await wait(500);
    check('Create report is pressable', (await press('Create report')) === 'clicked');
    await wait(4500);
    const body = await page.evaluate(() => String(document.body.innerText || ''));
    check('the create is held, in the export\'s words',
      /Not created — this report is not saved/.test(body), body.slice(0, 300).replace(/\s+/g, ' '));
    check('no report was created', posts.indexOf('POST /api/report-new') < 0
      && !fs.existsSync(path.join(root, PROJECT_ID, MODULE_ID, 'XDR')), JSON.stringify(posts));
    await letPutsThrough();
    posts.length = 0;
    check('Create report again once the disk answers', (await press('Create report')) === 'clicked');
    await wait(4500);
    const putAt = posts.indexOf('PUT /api/project');
    const newAt = posts.indexOf('POST /api/report-new');
    check('the flush landed before the new report was built',
      putAt >= 0 && newAt > putAt && fs.existsSync(path.join(root, PROJECT_ID, MODULE_ID, 'XDR', 'project.json'))
        && para(CDR_DIR, 0) === EDIT_G,
      JSON.stringify({ posts: posts, disk: para(CDR_DIR, 0) }));
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
  console.log('save conflict: all checks passed');
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
