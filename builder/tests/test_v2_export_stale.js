#!/usr/bin/env node
'use strict';
/*
 * test_v2_export_stale.js -- three actions that read project.json ON DISK must
 * not run against a stale file while a newer document sits unsaved in memory.
 *
 * Run:  node builder/tests/test_v2_export_stale.js
 *       node builder/tests/test_v2_export_stale.js --headed     (watch it work)
 *
 * THE DEFECT
 *   The export flushed the pending save and then threw the verdict away:
 *
 *       const flush = store.saveNow ? store.saveNow() : Promise.resolve();
 *       Promise.resolve(flush).catch(() => null).then(() => api.exportStream(...))
 *
 *   With every write of the document refused, the export ran anyway, off the
 *   last file that reached the disk, and reported success -- while its own
 *   dialog promised "a snapshot of the moment you pressed the button". The
 *   delivered .docx silently lacked the author's most recent work.
 *
 *   The asset tray had the same shape at its rename and delete call sites. A
 *   rename rewrites every reference in project.json, so running it against a
 *   stale file while a newer document is unsaved is how a figure reference ends
 *   up pointing nowhere; and neither refusal was ever NAMED -- the screen said
 *   "Something went wrong", which is not the same fact as "not renamed".
 *
 * WHAT IT ASSERTS, in a real browser, with every PUT of the document answered 500
 *   1. Export does not silently produce a document that omits the unsaved edit:
 *      no export request is issued at all, the dialog names the refusal, and
 *      the export is offered as a choice rather than taken on the user's behalf.
 *      (before the fix: the export ran and the dialog said "Export finished")
 *   2. Taking that choice is honest: the finished dialog says the file came from
 *      the last saved version and does not repeat the snapshot promise.
 *   3. Asset rename does not reach /api/asset-rename, and the screen names it.
 *      (before the fix: the operation aborted on an uncaught rejection and the
 *      screen said only "Something went wrong")
 *   4. Asset delete does not reach /api/asset-delete, and the screen names it.
 *   5. With saves working, all three behave exactly as before: the export
 *      finishes with no stale notice, the rename lands, the delete lands.
 *   6. A SECOND kind of staleness, in the same finished panel: a Word-only
 *      export overwrites the .docx and leaves any .pdf of an earlier export
 *      beside it, same name, same folder, one render out of date. The panel
 *      names that file and calls it older than the document, and the file is
 *      still there -- reporting it is the answer, deleting the user's copy is
 *      not. (before the fix: the panel listed only the .docx and said nothing)
 *   7. That same panel, as the design spells it: every artefact carries its
 *      size, and a run that produced no PDF reports no PDF timing.
 *      (before the fix: no sizes, and a flat "PDF 0.0s")
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
const START_TEXT = 'First section, as it was saved.';
const EDIT_TEXT = 'First section, edited while the disk was refusing writes.';

// The TOC field code is full of backslashes; naming the character once keeps
// this source free of sequences that read as Unicode escapes.
const BS = String.fromCharCode(92);

const USED_FILE = 'divider_response.png';
const FREE_FILE = 'spare_marker.png';

// A 160x90 checkerboard. One copy is placed in the document, one is left loose,
// which is what makes the loose one deletable and both of them renameable.
const SAMPLE_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAKAAAABaCAAAAAAarQKOAAAAaUlEQVR42u3XsREAQARFQWVficq6jBa+mRWKNuNVz7yZpF0B' +
  'AgICAoYDM1m7AwQEBARMB7rFgICAgICaBBAQEBBQk3gWAAEBATWJZwEQEBBQk7jFgICAgICaBBAQEBBQk3gWAAEBAY8BP3KI' +
  'Kg5OSOamAAAAAElFTkSuQmCC';

/* ------------------------------------------------------------------ *
 * fixture
 * ------------------------------------------------------------------ */

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function sampleReport() {
  return {
    schema_version: 1,
    template: 'sample',
    meta: { title: MODULE_ID + ' CDR report', doc_no: 'DOC-1', version: 'V1.0' },
    outline: [
      {
        id: 'n-1',
        title: 'Overview',
        blocks: [
          { id: 'b-1', type: 'para', runs: [{ t: START_TEXT }], cardStart: true },
          { id: 'b-2', type: 'image', file: 'images/' + USED_FILE, caption: 'Divider response', width_cm: 12 },
        ],
        children: [],
      },
      {
        id: 'n-2',
        title: 'Design description',
        blocks: [{ id: 'b-3', type: 'para', runs: [{ t: 'Second section.' }], cardStart: true }],
        children: [],
      },
    ],
  };
}

// A complete, fully renderable, ASCII-only template config, so an export in
// this fixture really produces a .docx -- an assertion about what an export
// delivered is worth nothing against a config the engine cannot render.
function sampleTemplateConfig() {
  return {
    id: 'sample',
    name: 'Sample template',
    caption_prefix: { image: 'Figure', table: 'Table', figure: 'Figure' },
    toc: { title: 'Contents', field: 'TOC ' + BS + 'o "1-3" ' + BS + 'h ' + BS + 'z ' + BS + 'u', placeholder: '(update field)', size_pt: 20 },
    logo: '',
    skeleton: [{ title: 'Overview', children: [] }, { title: 'Design description', children: [] }],
    styles: {
      page: {
        w_cm: 21.0, h_cm: 29.7, margin_cm: 2.5,
        header_dist_cm: 1.2, footer_dist_cm: 1.2, different_first_page: true,
      },
      normal: { ascii: 'Arial', eastAsia: 'Arial', size_pt: 10.5 },
      headings: {
        levels: {
          1: { ascii: 'Arial', size_pt: 16, bold: true },
          2: { ascii: 'Arial', size_pt: 14, bold: true },
          3: { ascii: 'Arial', size_pt: 12, bold: true },
          default: { ascii: 'Arial', size_pt: 12, bold: false },
        },
        space_before_pt: { 1: 12, 2: 10, 3: 8, 4: 6, 5: 6 },
        h1_after_pt: 24,
        h1_bottom_border: { val: 'single', sz: 6, color: 'auto' },
        autonumber: { num_id: 88, suffix: 'space', ascii: 'Arial' },
      },
      caption: { ascii: 'Arial', size_pt: 9, bold: true, align: 'center' },
      body: { name: 'ReportBody', base: 'Normal', size_pt: 10.5, left_cm: 0.0, first_line_cm: 0.74 },
      mybody: { name: 'ReportBodyIndent', base: 'ReportBody', ascii: 'Arial', left_cm: 0.0, first_line_cm: 0.74 },
      header_table: {
        cols_cm: [1.5, 12.0, 2.5], row_h_twips: 751,
        cell_bottom_border: { val: 'single', sz: 6, color: 'auto' },
        logo_cm: 1.13,
        title_font: { ascii: 'Arial', eastAsia: 'Arial', size_pt: 9 },
        title_placeholder: 'Report Title', secrecy_label: 'Internal',
      },
      footer_table: {
        cols_cm: [5.0, 6.0, 5.0], top_border: { val: 'single', sz: 4 },
        date_format: 'yyyy-MM-dd', center_text: '', page_text: ['', ' / ', ''],
        font: { ascii: 'Arial', size_pt: 9 },
      },
      colors: { red: 'FF0000', secrecy: '4F81BD' },
    },
    cover: {
      company_line: 'ACME', secrecy_default: 'Internal', page_count_field: true,
      page_text: ['', ' pages'],
      company_names: [{ text: 'ACME Corp', ascii: 'Arial', size_pt: 16 }],
      logo_cm: 2.6,
      big_title: { placeholder: 'Report Title', subtitle: '', size_pt: 24 },
      fields: [
        { key: 'title', label: 'Title', table: 'info', required: true },
        { key: 'author', label: 'Author', table: 'signature', required: false },
      ],
      tables: {
        info: {
          cols_cm: [3.0, 3.0, 4.0, 3.0, 3.0], outer: 'double', inner: 'single', sz: 14,
          labels: { title: 'Project', doc_no: 'Code', secrecy: 'Secrecy', pages: 'Pages' },
        },
        signature: {
          cols_cm: [3.0, 3.0, 1.0, 3.0, 3.0],
          rows: [['Author', ''], ['Reviewers', ''], ['Approver', '']],
          sign_underline: true, sign_cols: [1, 4],
        },
        revision: {
          cols_cm: [4.0, 3.0, 6.0, 3.0],
          headers: ['Date', 'Version', 'Note', 'Author'],
          header_font: { ascii: 'Arial', size_pt: 10.5 },
          border: 'single',
          title: { text: 'Revision History', ascii: 'Arial', eastAsia: 'Arial', size_pt: 16 },
        },
      },
    },
    compliance: {
      col_w_cm: { cat: 2.0, item: 3.0, spec: 1.5, axis: 1.4, spacer: 0.2, unit: 1.2 },
      font_pt: 7,
      row_h_pt: { header: 12, data: 10 },
      axis_labels: ['MIN', 'TYP', 'MAX', 'NTWC'],
      fills: { header: 'FFF2CC', setting: 'DDEBF7', result: 'FFFFFF', separator: 'BFBFBF' },
      setting_kinds: ['common_setting', 'module_setting', 'tb'],
      default_limit: { le: '<= upper', ge: '>= target', range: 'within' },
      flag_color: 'FF0000',
      borders: { val: 'single', sz: 4, color: '000000' },
    },
    free_table: { header_fill: 'D9D9D9', border: { val: 'single', sz: 4, color: '000000' } },
    fixed_bodies: {},
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
  const reportDir = path.join(root, ...CDR_DIR.split('/'));
  writeJson(path.join(reportDir, 'project.json'), sampleReport());
  const images = path.join(reportDir, 'images');
  fs.mkdirSync(images, { recursive: true });
  fs.writeFileSync(path.join(images, USED_FILE), Buffer.from(SAMPLE_PNG_B64, 'base64'));
  fs.writeFileSync(path.join(images, FREE_FILE), Buffer.from(SAMPLE_PNG_B64, 'base64'));
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

function req(method, url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: method,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
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

// Edit the loaded document and mark it dirty in one synchronous step, so the
// save is genuinely owed at the instant the control under test is pressed.
const EDIT = `(async () => {
  const { store } = await import('/assets/v2/js/store.js');
  const project = store.get().project;
  project.outline[0].blocks[0].runs[0].t = ${JSON.stringify(EDIT_TEXT)};
  store.markDirty();
  return store.get().dirty === true;
})()`;

const OPEN_TRAY = `(async () => {
  const { store } = await import('/assets/v2/js/store.js');
  store.setUi({ assetsOpen: true });
})()`;

const bodyText = (page) => page.evaluate(() => String(document.body.innerText || ''));

// Press a button by its exact visible text. Returns false when there is none,
// or when the one that is there is disabled.
function clickText(page, label) {
  return page.evaluate((wanted) => {
    const hit = Array.from(document.querySelectorAll('button'))
      .filter((b) => b.textContent.trim() === wanted && b.offsetParent !== null)[0];
    if (!hit || hit.disabled) return false;
    hit.click();
    return true;
  }, label);
}

// The header's Export control opens a menu; the menu item does the work.
async function pressExport(page, item) {
  const opened = await page.evaluate(() => {
    const hit = Array.from(document.querySelectorAll('button'))
      .filter((b) => b.textContent.trim().indexOf('Export') === 0)[0];
    if (!hit) return false;
    hit.click();
    return true;
  });
  if (!opened) return 'no export control';
  await wait(300);
  const picked = await clickText(page, item);
  return picked ? 'ok' : 'no menu item: ' + item;
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

(async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-export-stale-'));
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

  const reportDir = path.join(root, ...CDR_DIR.split('/'));
  const projectFile = path.join(reportDir, 'project.json');
  const outDir = path.join(reportDir, 'out');
  const firstParagraph = () => {
    try {
      return JSON.parse(fs.readFileSync(projectFile, 'utf8')).outline[0].blocks[0].runs[0].t;
    } catch (err) {
      return 'unreadable: ' + err.message;
    }
  };
  const exported = () => {
    try {
      return fs.readdirSync(outDir).filter((f) => /\.(docx|pdf)$/i.test(f));
    } catch (err) {
      return [];
    }
  };
  const images = () => {
    try {
      return fs.readdirSync(path.join(reportDir, 'images')).sort();
    } catch (err) {
      return [];
    }
  };

  let browser = null;
  try {
    await waitForServer(base, child, 20000);

    browser = await chromium.launch({ channel: 'msedge', headless: !HEADED });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    // Every request the page makes, so an assertion can say "this endpoint was
    // never reached" rather than inferring it from what landed on disk.
    const seen = [];
    page.on('request', (r) => seen.push(r.method() + ' ' + new URL(r.url()).pathname));
    const reached = (pathname) => seen.filter((line) => line.endsWith(' ' + pathname));
    const forget = () => { seen.length = 0; };

    // Refuse every write of the document, and nothing else.
    let refuseSaves = false;
    await page.route('**/api/project*', (route) => {
      if (refuseSaves && route.request().method() === 'PUT') {
        return route.fulfill({
          status: 500, contentType: 'application/json', body: '{"error": "the disk said no"}',
        });
      }
      return route.continue();
    });

    const editorUrl = base + '/#/r/' + CDR_DIR.split('/').map(encodeURIComponent).join('/');

    // A goto to the URL the page is already on differs only in its fragment, so
    // the browser treats it as a same-document navigation and nothing reloads --
    // the previous part's dialogs and module state would still be standing.
    // Leaving the origin first makes each part start from a fresh page.
    const openEditor = async () => {
      await page.goto('about:blank');
      await page.goto(editorUrl, { waitUntil: 'load' });
      await wait(1500);
    };
    /* ============================================================ *
     * 1 - export, with the document unsaved
     * ============================================================ */

    console.log('\nexport while the document cannot be saved  (PIN: fails before the fix)');

    await openEditor();
    refuseSaves = true;
    const edited = await page.evaluate(EDIT);
    check('the document is unsaved at the moment Export is pressed', edited === true, String(edited));

    forget();
    const opened = await pressExport(page, 'Export Word only');
    check('the Export control was reachable', opened === 'ok', String(opened));
    await wait(6000);

    const exportCalls = reached('/api/export-stream').concat(reached('/api/export'));
    check('no export was issued off the stale file',
      exportCalls.length === 0, JSON.stringify(exportCalls));
    check('nothing was written to out/', exported().length === 0, JSON.stringify(exported()));

    let text = await bodyText(page);
    check('the dialog says the export was held back, and why',
      /Not exported/i.test(text) && /not saved/i.test(text),
      text.slice(0, 600).replace(/\s+/g, ' '));
    check('it does not claim the export finished', !/Export finished/i.test(text),
      text.slice(0, 600).replace(/\s+/g, ' '));
    check('it does not repeat the snapshot promise',
      !/snapshot of the moment/i.test(text), text.slice(0, 600).replace(/\s+/g, ' '));

    /* ============================================================ *
     * 2 - taking the choice anyway is honest about what it produced
     * ============================================================ */

    console.log('\nexporting anyway  (PIN: the state of the export must be honest)');

    const anyway = await page.evaluate(() => {
      const hit = Array.from(document.querySelectorAll('button'))
        .filter((b) => /^Export anyway/.test(b.textContent.trim()))[0];
      if (!hit || hit.disabled) return false;
      hit.click();
      return true;
    });
    check('the dialog offers the export as a choice', anyway === true);
    await wait(20000);
    text = await bodyText(page);
    check('the export ran once it was asked for',
      reached('/api/export-stream').concat(reached('/api/export')).length > 0,
      JSON.stringify(seen.slice(-8)));
    check('and it says the file came from the last saved version',
      /last saved version/i.test(text), text.slice(0, 800).replace(/\s+/g, ' '));
    check('the unsaved edit is still only in the page',
      firstParagraph() === START_TEXT, JSON.stringify(firstParagraph()));

    /* ============================================================ *
     * 3 - asset rename and delete, with the document unsaved
     * ============================================================ */

    console.log('\nasset rename and delete while the document cannot be saved  (PIN)');

    await openEditor();
    await page.evaluate(OPEN_TRAY);
    await wait(800);
    refuseSaves = true;
    await page.evaluate(EDIT);

    forget();
    const renamed = await page.evaluate((file) => {
      const cards = Array.from(document.querySelectorAll('.rw-asset'));
      const card = cards.filter((c) => String(c.getAttribute('title') || '') === file)[0];
      if (!card) return 'no card for ' + file;
      const pencil = Array.from(card.querySelectorAll('button'))
        .filter((b) => b.getAttribute('title') === 'Rename')[0];
      if (!pencil) return 'no rename control';
      pencil.click();
      return 'ok';
    }, FREE_FILE);
    check('the rename control opened', renamed === 'ok', String(renamed));
    await wait(300);
    await page.evaluate(() => {
      const input = document.querySelector('.rw-asset__rename');
      if (!input) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'renamed_marker.png');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await wait(6000);

    check('no rename was issued off the stale file',
      reached('/api/asset-rename').length === 0, JSON.stringify(reached('/api/asset-rename')));
    check('the file on disk still has its old name',
      images().indexOf(FREE_FILE) !== -1, JSON.stringify(images()));
    text = await bodyText(page);
    check('the screen names the refusal rather than only "Something went wrong"',
      /Not renamed/i.test(text), text.slice(0, 600).replace(/\s+/g, ' '));

    // Dismiss the refusal from inside its own dialog: the app banner stack also
    // carries a button labelled Close, and clicking that one would leave the
    // dialog standing over the card the next step has to reach.
    const dismissed = await page.evaluate(() => {
      const panel = document.querySelector('.rw-dialog');
      if (!panel) return 'no dialog';
      const hit = Array.from(panel.querySelectorAll('button'))
        .filter((b) => b.textContent.trim() === 'Close')[0];
      if (!hit) return 'no Close in the dialog';
      hit.click();
      return 'ok';
    });
    await wait(500);
    const stillThere = await page.evaluate(() => {
      const panel = document.querySelector('.rw-dialog');
      return panel ? String(panel.innerText || '').slice(0, 160) : '';
    });
    check('the refusal can be dismissed from its own dialog',
      dismissed === 'ok' && stillThere === '',
      String(dismissed) + ' | remains: ' + JSON.stringify(stillThere));

    forget();
    const deleting = await page.evaluate((file) => {
      const cards = Array.from(document.querySelectorAll('.rw-asset'));
      const card = cards.filter((c) => String(c.getAttribute('title') || '') === file)[0];
      if (!card) return 'no card for ' + file;
      const cross = Array.from(card.querySelectorAll('button'))
        .filter((b) => /can be deleted/.test(String(b.getAttribute('title') || '')))[0];
      if (!cross) return 'no delete control';
      cross.click();
      return 'ok';
    }, FREE_FILE);
    check('the delete control opened', deleting === 'ok', String(deleting));
    await wait(300);
    await clickText(page, 'Move to trash');
    await wait(6000);

    check('no delete was issued off the stale file',
      reached('/api/asset-delete').length === 0, JSON.stringify(reached('/api/asset-delete')));
    check('the file is still in images/', images().indexOf(FREE_FILE) !== -1, JSON.stringify(images()));
    text = await bodyText(page);
    check('the screen names that refusal too',
      /Not deleted/i.test(text), text.slice(0, 600).replace(/\s+/g, ' '));

    /* ============================================================ *
     * 4 - with saves working, all three behave exactly as before
     * ============================================================ */

    console.log('\nwith saves working  (PIN: nothing above may cost the working path)');

    refuseSaves = false;
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (err) { /* windows */ }

    // A PDF from an EARLIER export, sitting where the next one will write its
    // .docx. A Word-only export does not touch it, so once the export below has
    // run this file is a render of a report that no longer exists -- same name,
    // same folder, nothing in a listing to say so. The finished panel has to.
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'CDR.pdf'), '%PDF-1.4 from an earlier export\n');

    await openEditor();
    await page.evaluate(OPEN_TRAY);
    await wait(800);
    await page.evaluate(EDIT);

    forget();
    const opened2 = await pressExport(page, 'Export Word only');
    check('the Export control was reachable again', opened2 === 'ok', String(opened2));
    await wait(25000);
    text = await bodyText(page);
    check('the export finished', /Export finished/i.test(text),
      text.slice(0, 800).replace(/\s+/g, ' '));
    check('it was not marked as coming from an older file',
      !/last saved version/i.test(text), text.slice(0, 800).replace(/\s+/g, ' '));
    check('the edit reached the disk before the render',
      firstParagraph() === EDIT_TEXT, JSON.stringify(firstParagraph()));
    check('a file was produced', exported().length > 0, JSON.stringify(exported()));
    check('the PDF this export did not rewrite is named, and called older',
      /CDR\.pdf/.test(text) && /Older than the document/i.test(text),
      text.slice(0, 900).replace(/\s+/g, ' '));
    check('and it is still on disk -- nothing of the user\'s was deleted',
      fs.existsSync(path.join(outDir, 'CDR.pdf')), JSON.stringify(exported()));

    // The finished panel, as the design spells it: file name, folder and size
    // per artefact, and no PDF timing on a run that produced no PDF.
    const names = await page.evaluate(() => Array.from(
      document.querySelectorAll('.rw-export__filename')).map((el) => el.textContent.trim()));
    check('each artefact is listed with its size',
      names.length === 2 && names.every((n) => /\d+(\.\d+)?\s(B|KB|MB|GB)$/.test(n)),
      JSON.stringify(names));
    check('a Word-only export reports no PDF timing',
      /Word \d/.test(text) && !/PDF \d/.test(text),
      text.slice(0, 900).replace(/\s+/g, ' '));

    await clickText(page, 'Back to editing');
    await wait(500);

    forget();
    await page.evaluate((file) => {
      const cards = Array.from(document.querySelectorAll('.rw-asset'));
      const card = cards.filter((c) => String(c.getAttribute('title') || '') === file)[0];
      const pencil = card && Array.from(card.querySelectorAll('button'))
        .filter((b) => b.getAttribute('title') === 'Rename')[0];
      if (pencil) pencil.click();
    }, FREE_FILE);
    await wait(300);
    await page.evaluate(() => {
      const input = document.querySelector('.rw-asset__rename');
      if (!input) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'renamed_marker.png');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await wait(4000);
    check('the rename lands when the document can be saved',
      images().indexOf('renamed_marker.png') !== -1, JSON.stringify(images()));

    forget();
    const deleting2 = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('.rw-asset'));
      const card = cards.filter((c) => String(c.getAttribute('title') || '') === 'renamed_marker.png')[0];
      if (!card) return 'no card';
      const cross = Array.from(card.querySelectorAll('button'))
        .filter((b) => /can be deleted/.test(String(b.getAttribute('title') || '')))[0];
      if (!cross) return 'no delete control';
      cross.click();
      return 'ok';
    });
    check('the delete control is offered on the renamed file', deleting2 === 'ok', String(deleting2));
    await wait(300);
    await clickText(page, 'Move to trash');
    await wait(4000);
    check('the delete lands when the document can be saved',
      images().indexOf('renamed_marker.png') === -1, JSON.stringify(images()));
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
  console.log('export and asset staleness: all checks passed');
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
