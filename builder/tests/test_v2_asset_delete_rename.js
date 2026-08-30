#!/usr/bin/env node
'use strict';
/*
 * test_v2_asset_delete_rename.js -- regression assertions for two defects that
 * were live in the v2 interface, both of which destroy something the user
 * cannot get back.
 *
 * Run:  node builder/tests/test_v2_asset_delete_rename.js
 *       node builder/tests/test_v2_asset_delete_rename.js --headed
 *
 * DEFECT 1 -- the asset tray's delete
 *   The card posted to /api/asset-delete, which was not in the server's POST
 *   table, so every click ended in "not found: /api/asset-delete". It fired on
 *   the first click, with no confirmation. And "unused" was derived from the
 *   document in memory, which during a report switch is still the PREVIOUS
 *   report's -- so every card of the report being opened read "Not used yet"
 *   and offered delete on files that were in use.
 *
 * DEFECT 2 -- renaming a report
 *   The shelf asked /api/project-rename to rename the FOLDER, and a report's
 *   folder is its address: `dir` is the only thing an update package or an
 *   op-diff carries, and the stage leaf of PROJECT/MODULE/STAGE is where the
 *   shelf reads the stage from. Renaming a report therefore orphaned every
 *   package already cut for it and invented a stage nobody chose.
 *
 * IT NEVER TOUCHES REAL REPORTS. The fixture is generated from scratch into a
 * temporary directory and the server is booted against THAT with an explicit
 * --root, exactly as test_v2_smoke.js does.
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

/* ------------------------------------------------------------------ *
 * fixture
 * ------------------------------------------------------------------ */

// A 160x90 checkerboard: two copies of it, one placed in the document and one
// left loose, are the whole point of the asset half of this file.
const SAMPLE_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAKAAAABaCAAAAAAarQKOAAAAaUlEQVR42u3XsREAQARFQWVficq6jBa+mRWKNuNVz7yZpF0B' +
  'AgICAoYDM1m7AwQEBARMB7rFgICAgICaBBAQEBBQk3gWAAEBATWJZwEQEBBQk7jFgICAgICaBBAQEBBQk3gWAAEBAY8BP3KI' +
  'Kg5OSOamAAAAAElFTkSuQmCC';

const PROJECT_ID = '1108';
const MODULE_ID = 'CLKDIV_5G';
const CDR_DIR = PROJECT_ID + '/' + MODULE_ID + '/CDR';
const PDR_DIR = PROJECT_ID + '/' + MODULE_ID + '/PDR';
const FDR_DIR = PROJECT_ID + '/' + MODULE_ID + '/FDR';
const USED_FILE = 'images/divider_response.png';
const FREE_FILE = 'images/spare_marker.png';
const CDR_TITLE = MODULE_ID + ' CDR report';

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

const para = (t) => ({ type: 'para', runs: [{ t: t }], cardStart: true });

// Section 2 holds the figure, so a use reads as "Used in 2".
function reportWithFigure(title) {
  return {
    template: 'sample',
    meta: { title: title, doc_no: 'DOC-1', version: 'V1.0' },
    outline: [
      { id: 'n-1', title: 'Overview', blocks: [para('First section.')], children: [] },
      {
        id: 'n-2',
        title: 'Design description',
        blocks: [
          para('Second section, which carries the figure.'),
          { type: 'image', id: 'b-fig-1', file: USED_FILE, caption: 'Divider output', width_cm: 8 },
        ],
        children: [],
      },
    ],
  };
}

function reportWithoutFigures(title) {
  return {
    template: 'sample',
    meta: { title: title, doc_no: 'DOC-0', version: 'V0.9' },
    outline: [{ id: 'p-1', title: 'Overview', blocks: [para('Another report entirely.')], children: [] }],
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

  // The report under test: one figure in the document, one loose file.
  const cdr = path.join(root, ...CDR_DIR.split('/'));
  writeJson(path.join(cdr, 'project.json'), reportWithFigure(CDR_TITLE));
  fs.mkdirSync(path.join(cdr, 'images'), { recursive: true });
  fs.writeFileSync(path.join(cdr, 'images', 'divider_response.png'), Buffer.from(SAMPLE_PNG_B64, 'base64'));
  fs.writeFileSync(path.join(cdr, 'images', 'spare_marker.png'), Buffer.from(SAMPLE_PNG_B64, 'base64'));

  // A second report of the same module, holding NO figures. It is the document
  // that stands in for "the report the editor has not finished switching away
  // from" in the mismatched-pair assertion.
  const pdr = path.join(root, ...PDR_DIR.split('/'));
  writeJson(path.join(pdr, 'project.json'), reportWithoutFigures(MODULE_ID + ' PDR report'));
  fs.mkdirSync(path.join(pdr, 'images'), { recursive: true });

  // A third report, used only by the rename assertions, so that the OLD
  // behaviour -- which moves the folder -- cannot carry the asset fixture off
  // with it and turn the asset failures into confusing 404s.
  const fdr = path.join(root, ...FDR_DIR.split('/'));
  writeJson(path.join(fdr, 'project.json'), reportWithoutFigures(MODULE_ID + ' FDR report'));

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
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const r = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: method,
      headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
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

function findReport(treeAnswer, dir) {
  const projects = ((treeAnswer.json || {}).projects) || [];
  for (const p of projects) {
    for (const m of (p.modules || [])) {
      for (const r of (m.reports || [])) if (r.dir === dir) return r;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

(async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-asset-rename-'));
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

  const abs = (dir, ...rest) => path.join(root, ...dir.split('/'), ...rest);
  let browser = null;

  try {
    await waitForServer(base, child, 20000);

    console.log('\nasset-delete, over HTTP');

    const delUsed = await req('POST', base + '/api/asset-delete', { dir: CDR_DIR, file: USED_FILE });
    check('a used asset is refused, and the refusal names the section using it',
      delUsed.status === 400 && /still used/i.test(delUsed.text),
      delUsed.status + ' ' + delUsed.text.slice(0, 160));
    check('the refused file is still in images/', fs.existsSync(abs(CDR_DIR, 'images', 'divider_response.png')));

    const delFree = await req('POST', base + '/api/asset-delete', { dir: CDR_DIR, file: FREE_FILE });
    check('an unused asset is deleted',
      delFree.status === 200 && delFree.json && delFree.json.ok === true,
      delFree.status + ' ' + delFree.text.slice(0, 160));
    check('and it moved to the trash rather than being unlinked',
      !fs.existsSync(abs(CDR_DIR, 'images', 'spare_marker.png')) &&
      fs.existsSync(abs(CDR_DIR, '_trash', 'assets', 'spare_marker.png')));

    // put it back: the browser half deletes it through the interface
    fs.writeFileSync(abs(CDR_DIR, 'images', 'spare_marker.png'), Buffer.from(SAMPLE_PNG_B64, 'base64'));

    console.log('\nrenaming, over HTTP');

    const NEW_TITLE = 'Divider close-out notes';
    const renamed = await req('POST', base + '/api/project-rename',
      { dir: FDR_DIR, new_name: NEW_TITLE, title: NEW_TITLE });
    check('renaming a report answers with the SAME dir',
      renamed.status === 200 && renamed.json && renamed.json.dir === FDR_DIR && renamed.json.moved === false,
      renamed.status + ' ' + renamed.text.slice(0, 160));
    check('the report folder is still at its old address', fs.existsSync(abs(FDR_DIR, 'project.json')));

    let title = '';
    try { title = JSON.parse(fs.readFileSync(abs(FDR_DIR, 'project.json'), 'utf8')).meta.title; }
    catch (err) { title = 'unreadable: ' + err.message; }
    check('only the title changed', title === NEW_TITLE, JSON.stringify(title));

    const tree = await req('GET', base + '/api/tree');
    const row = findReport(tree, FDR_DIR);
    check('the shelf still reports the original stage', !!row && row.stage === 'FDR',
      row ? 'stage=' + JSON.stringify(row.stage) : 'no row at ' + FDR_DIR);
    check('the shelf shows the new title', !!row && row.title === NEW_TITLE,
      row ? JSON.stringify(row.title) : '-');

    const renamedModule = await req('POST', base + '/api/project-rename',
      { dir: PROJECT_ID + '/' + MODULE_ID, new_name: 'CLKDIV_6G' });
    const moved = renamedModule.json && renamedModule.json.dir === PROJECT_ID + '/CLKDIV_6G' &&
      fs.existsSync(path.join(root, PROJECT_ID, 'CLKDIV_6G', 'CDR', 'project.json'));
    check('renaming a MODULE still moves the folder', moved,
      renamedModule.status + ' ' + renamedModule.text.slice(0, 160));
    if (moved) {
      await req('POST', base + '/api/project-rename',
        { dir: PROJECT_ID + '/CLKDIV_6G', new_name: MODULE_ID });
    }

    console.log('\nthe asset tray, in a real browser');

    browser = await chromium.launch({ channel: 'msedge', headless: !HEADED });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    const consoleErrors = [];
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const where = (m.location() || {}).url || '';
      if (where.indexOf('favicon.ico') !== -1) return;   // the shell serves none
      consoleErrors.push(m.text() + ' @ ' + where);
    });
    page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

    const posts = [];
    page.on('request', (r) => {
      if (r.method() !== 'POST' || r.url().indexOf('/api/') === -1) return;
      let body = null;
      try { body = JSON.parse(r.postData() || 'null'); } catch (e) { body = r.postData(); }
      posts.push({ url: r.url(), body: body });
    });
    const responses = [];
    page.on('response', (r) => {
      if (r.request().method() === 'POST' && r.url().indexOf('/api/') !== -1) {
        responses.push({ url: r.url(), status: r.status() });
      }
    });

    await page.goto(base + '/#/', { waitUntil: 'load' });
    await page.waitForTimeout(700);

    // Mount the tray by hand with an explicit (report, document) pair. That pair
    // is exactly what a report switch breaks for the length of one fetch, and
    // driving it directly is the only way to hold it broken long enough to look.
    const mountTray = async (dir, documentDir) => {
      await page.evaluate(async (arg) => {
        let host = document.getElementById('rw-probe');
        if (!host) {
          host = document.createElement('div');
          host.id = 'rw-probe';
          document.body.appendChild(host);
        }
        const tray = await import('/assets/v2/js/views/assets.js');
        const base2 = await import('/assets/v2/js/components/base.js');
        const api = await import('/assets/v2/js/api.js');
        const payload = await api.getProject(arg.documentDir);
        const project = payload && payload.project ? payload.project : payload;
        base2.render(
          base2.html`<${tray.AssetTray} dir=${arg.dir} project=${project} open=${true} />`, host);
      }, { dir: dir, documentDir: documentDir });
      await page.waitForTimeout(900);
    };

    const cards = () => page.evaluate(() => {
      const out = [];
      document.querySelectorAll('#rw-probe .rw-asset').forEach((card) => {
        out.push({
          name: (card.getAttribute('title') || '').trim(),
          badge: (card.querySelector('.rw-asset__use') || {}).textContent || '',
          hasDelete: !!Array.from(card.querySelectorAll('button')).find(
            (b) => (b.textContent || '').indexOf('✕') !== -1 && !b.classList.contains('rw-chip__x')),
        });
      });
      return out;
    });

    const clickDelete = (name) => page.evaluate((wanted) => {
      const card = Array.from(document.querySelectorAll('#rw-probe .rw-asset'))
        .filter((c) => (c.getAttribute('title') || '') === wanted)[0];
      if (!card) return false;
      const btn = Array.from(card.querySelectorAll('button')).filter(
        (b) => (b.textContent || '').indexOf('✕') !== -1 && !b.classList.contains('rw-chip__x'))[0];
      if (!btn) return false;
      btn.click();
      return true;
    }, name);

    const clickDialog = (label) => page.evaluate((wanted) => {
      const btn = Array.from(document.querySelectorAll('.rw-dialog button'))
        .filter((b) => (b.textContent || '').trim() === wanted)[0];
      if (!btn) return false;
      btn.click();
      return true;
    }, label);

    // The mismatched pair: this report's files, the other report's document.
    await mountTray(CDR_DIR, PDR_DIR);
    let list = await cards();
    const mismatched = list.filter((c) => c.name === 'divider_response.png')[0];
    check('a file in use is not badged "Not used yet" while another report is in memory',
      !!mismatched && mismatched.badge.indexOf('Not used yet') === -1,
      JSON.stringify(mismatched || list));
    check('and no delete control is offered on it',
      !!mismatched && mismatched.hasDelete === false, JSON.stringify(mismatched || list));

    // The matching pair.
    await mountTray(CDR_DIR, CDR_DIR);
    list = await cards();
    const used = list.filter((c) => c.name === 'divider_response.png')[0];
    const spare = list.filter((c) => c.name === 'spare_marker.png')[0];
    check('the used file offers no delete', !!used && used.hasDelete === false, JSON.stringify(used || list));
    check('the unused file does', !!spare && spare.hasDelete === true, JSON.stringify(spare || list));

    const before = posts.filter((p) => p.url.indexOf('/api/asset-delete') !== -1).length;
    check('the delete control is there to click', await clickDelete('spare_marker.png'));
    await page.waitForTimeout(400);
    const dialogText = await page.evaluate(() => {
      const d = document.querySelector('.rw-dialog');
      return d ? d.innerText.replace(/\s+/g, ' ').trim() : '';
    });
    check('it asks first, naming the file', dialogText.indexOf('spare_marker.png') !== -1,
      JSON.stringify(dialogText.slice(0, 200)));
    check('nothing was posted before the confirmation',
      posts.filter((p) => p.url.indexOf('/api/asset-delete') !== -1).length === before);

    await clickDialog('Cancel');
    await page.waitForTimeout(300);
    check('Cancel deletes nothing',
      posts.filter((p) => p.url.indexOf('/api/asset-delete') !== -1).length === before &&
      fs.existsSync(abs(CDR_DIR, 'images', 'spare_marker.png')));

    await clickDelete('spare_marker.png');
    await page.waitForTimeout(350);
    await clickDialog('Move to trash');
    await page.waitForTimeout(1200);
    const answered = responses.filter((r) => r.url.indexOf('/api/asset-delete') !== -1);
    check('confirming reaches a route that exists, and the server answers 200',
      answered.length === 1 && answered[0].status === 200, JSON.stringify(answered));
    check('the file left images/', !fs.existsSync(abs(CDR_DIR, 'images', 'spare_marker.png')));
    list = await cards();
    check('and the card left the tray', list.filter((c) => c.name === 'spare_marker.png').length === 0,
      JSON.stringify(list.map((c) => c.name)));

    console.log('\nrenaming a report from the shelf, in a real browser');

    await page.evaluate(() => {
      const el = document.getElementById('rw-probe');
      if (el) el.remove();
    });
    await page.goto(base + '/#/', { waitUntil: 'load' });
    await page.waitForTimeout(900);

    const mark = posts.length;
    const menuOpened = await page.evaluate((wanted) => {
      const rows = Array.from(document.querySelectorAll('.rw-row'));
      const row = rows.filter((r) => (r.innerText || '').indexOf(wanted) !== -1)[0];
      if (!row) return 'no shelf row for ' + wanted;
      const more = Array.from(row.querySelectorAll('button'))
        .filter((b) => (b.getAttribute('title') || '') === 'More')[0];
      if (!more) return 'no More button on the row';
      more.click();
      return 'ok';
    }, CDR_TITLE);
    check('the row menu opens', menuOpened === 'ok', String(menuOpened).slice(0, 200));

    await page.waitForTimeout(300);
    await page.evaluate(() => {
      const item = Array.from(document.querySelectorAll('[role="menuitem"], .rw-menu__item, button'))
        .filter((b) => (b.textContent || '').trim() === 'Rename')[0];
      if (item) item.click();
    });
    await page.waitForTimeout(350);

    const FINAL_TITLE = 'Divider close-out notes v2';
    await page.evaluate((value) => {
      const input = document.querySelector('.rw-dialog .rw-input');
      if (!input) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, FINAL_TITLE);
    await page.waitForTimeout(200);
    await clickDialog('Rename');
    await page.waitForTimeout(1500);

    const asked = posts.slice(mark).filter((p) => p.url.indexOf('/api/project-rename') !== -1)[0];
    check('the shelf asks for a title change only, never a folder move',
      !!asked && asked.body && asked.body.title === FINAL_TITLE && !asked.body.new_name,
      JSON.stringify(asked && asked.body));

    const treeAfter = await req('GET', base + '/api/tree');
    const rowAfter = findReport(treeAfter, CDR_DIR);
    check('the address is unchanged and the stage survives',
      !!rowAfter && rowAfter.stage === 'CDR' && rowAfter.title === FINAL_TITLE,
      rowAfter ? JSON.stringify({ dir: rowAfter.dir, stage: rowAfter.stage, title: rowAfter.title })
        : 'no row at ' + CDR_DIR);

    check('no console errors along the way', consoleErrors.length === 0,
      JSON.stringify(consoleErrors.slice(0, 4)));
  } catch (err) {
    check('the run completed', false, err && err.stack ? err.stack : String(err));
  } finally {
    if (browser) await browser.close().catch(() => {});
    try { child.kill(); } catch (err) { /* already gone */ }
    await new Promise((r) => setTimeout(r, 400));
    try { child.kill('SIGKILL'); } catch (err) { /* already gone */ }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (err) { /* leave it */ }
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - failed.length) + ' of ' + results.length + ' checks passed');
  process.exit(failed.length ? 1 : 0);
})();
