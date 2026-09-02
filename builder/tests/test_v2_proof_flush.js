#!/usr/bin/env node
'use strict';
/*
 * test_v2_proof_flush.js -- the preview panel must show what the DOCUMENT says,
 * not an older version of it, and not a version with parts of it missing.
 *
 * Run:  node builder/tests/test_v2_proof_flush.js
 *       node builder/tests/test_v2_proof_flush.js --headed     (watch it work)
 *
 * DEFECT 1 -- "Proof this section" rendered the file, not the screen
 *
 *   The proof asks the server to render one section with Word, and the server
 *   renders the project.json ON DISK. The export knows that and flushes the
 *   pending save first:
 *
 *       const landed = await flushEdits();          // views/preview.js
 *       if (!landed && !opts.force) { ...held... }
 *
 *   The proof did not. It called api.previewSection() straight away, so a proof
 *   pressed inside the 800ms save debounce -- which is to say a proof pressed
 *   the moment after typing, the only time anybody presses it -- came back as
 *   page images of the last SAVED text, presented as "This section, rendered by
 *   Word" with nothing to say the paragraph on the screen was not in them. With
 *   saves failing outright it was every proof, forever.
 *
 *   The fix flushes first, and keeps the verdict. A refusal is answered
 *   differently from the export's, on purpose: the export delivers a file
 *   somebody will send on, so it stops and asks; a proof only shows pages, and
 *   the pages of the last saved version are still worth seeing, so it renders
 *   and SAYS which version it is.
 *
 * DEFECT 2 -- an image grid's per-panel labels never reached the preview
 *
 *   `sub_captions` is a boolean ("label every panel"); the label of a panel is
 *   that panel's own `sub`, and a panel without one falls back to (a)(b)(c).
 *   That is what core/engine.py::_render_image_grid writes into the exported
 *   document and what the editor card edits. The preview read the boolean as if
 *   it were the list of labels:
 *
 *       const subs = Array.isArray(block.sub_captions) ? block.sub_captions : [];
 *
 *   true is not an array, so `subs` was always empty and no panel ever carried a
 *   label. The paper silently disagreed with the document it is a picture of.
 *
 * WHAT IT ASSERTS, in a real browser against a generated report
 *   1. A proof pressed immediately after an edit is rendered from a file that
 *      ALREADY holds that edit: the document is written before the render is
 *      asked for. (before the fix: the render was asked for first)
 *   2. With every write of the document refused, the proof still renders -- the
 *      panel never blanks -- and says the pages are the last saved version.
 *      (before the fix: it said nothing at all)
 *   3. With saves working, no such notice appears.
 *   4. Every panel of an image grid carries its label, and a panel with no
 *      label of its own gets the engine's (c). (before the fix: none of them)
 *   5. Jump to editor lands ON the block: the editor goes to its section, the
 *      card is scrolled into view and it is marked. (before the fix: the
 *      section switched, the canvas stayed at its top with the block below the
 *      fold, and nothing was marked -- the jump ran before the new section's
 *      cards existed, and the mark is keyed on the card's start index, which
 *      nothing set)
 *   6. A cross-reference pointing at a block that no longer exists shows the
 *      red [ref: id] marker the exported file will carry, and the Check tab
 *      reports it as an error in the lint's own sentence. (before the fix: the
 *      paper printed nothing at all where the reference was, and the checklist
 *      had no rule for it)
 *
 * The section render itself is answered by the test, not by Word: this file is
 * about which bytes the render is asked to work from, and a machine without
 * Word must still be able to run it.
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
const START_TEXT = 'First section, as it was last saved.';
const EDIT_TEXT = 'First section, typed a moment before the proof was asked for.';
// Part 2 types something else again, so "the render read an older file" can be
// asserted as a fact about the bytes rather than inferred from a notice.
const LATER_TEXT = 'First section, typed while the disk was refusing writes.';

// The TOC field code is full of backslashes; naming the character once keeps
// this source free of sequences that read as Unicode escapes.
const BS = String.fromCharCode(92);

const GRID_FILES = ['corner_tt.png', 'corner_ff.png', 'corner_ss.png'];
const GRID_BLOCK = 'b-grid';
const GONE_BLOCK = 'b-deleted-figure';
const FILLER_IDS = ['b-f1', 'b-f2', 'b-f3', 'b-f4', 'b-f5', 'b-f6'];
const FILLER = ('The divider is characterised across supply and temperature, and the '
  + 'measured figures are collected here. ').repeat(6);
const SUB_ONE = 'Typical corner';
const SUB_TWO = 'Fast corner';

// A 160x90 checkerboard, used for the grid panels and, base64 as it stands, as
// the page image the intercepted section render answers with.
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
          {
            id: 'b-refs',
            type: 'para',
            cardStart: true,
            // One reference to a figure that is really there, and one to a
            // block id nothing carries any more -- what is left behind when a
            // figure is deleted after somebody referred to it. The stale run
            // text is the number the reference used to print.
            runs: [
              { t: 'Compare ' },
              { t: '2-1', ref: GRID_BLOCK },
              { t: ' with ' },
              { t: '2-2', ref: GONE_BLOCK },
              { t: '.' },
            ],
          },
        ],
        children: [],
      },
      {
        id: 'n-2',
        title: 'Design description',
        blocks: [
          // Enough text above the grid that a canvas sitting at the top of this
          // section does NOT have the grid on screen: a jump that only switched
          // sections would leave the block it names below the fold.
          ...FILLER_IDS.map((id, i) => ({
            id: id, type: 'para', cardStart: true,
            runs: [{ t: 'Filler paragraph ' + (i + 1) + '. ' + FILLER }],
          })),
          {
            id: GRID_BLOCK,
            type: 'imagegrid',
            cols: 3,
            rows: 1,
            width_cm: 15.5,
            // The flag is a boolean; the labels live on the items. The third
            // panel deliberately has none, so the (a)(b)(c) fallback is covered.
            sub_captions: true,
            items: [
              { file: 'images/' + GRID_FILES[0], sub: SUB_ONE },
              { file: 'images/' + GRID_FILES[1], sub: SUB_TWO },
              { file: 'images/' + GRID_FILES[2], sub: '' },
            ],
            caption: 'Divider response across corners',
          },
        ],
        children: [],
      },
    ],
  };
}

// A complete, ASCII-only template config: the editor loads it for the paper
// styling, so a partial one would change what the preview draws.
function sampleTemplateConfig() {
  return {
    id: 'sample',
    name: 'Sample template',
    caption_prefix: { image: 'Figure', table: 'Table', figure: 'Figure' },
    toc: {
      title: 'Contents',
      field: 'TOC ' + BS + 'o "1-3" ' + BS + 'h ' + BS + 'z ' + BS + 'u',
      placeholder: '(update field)', size_pt: 20,
    },
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
      mybody: {
        name: 'ReportBodyIndent', base: 'ReportBody', ascii: 'Arial',
        left_cm: 0.0, first_line_cm: 0.74,
      },
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
  GRID_FILES.forEach((name) => {
    fs.writeFileSync(path.join(images, name), Buffer.from(SAMPLE_PNG_B64, 'base64'));
  });
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
// save is genuinely owed at the instant the proof is pressed.
const editTo = (text) => `(async () => {
  const { store } = await import('/assets/v2/js/store.js');
  const project = store.get().project;
  project.outline[0].blocks[0].runs[0].t = ${JSON.stringify(text)};
  store.markDirty();
  return store.get().dirty === true;
})()`;

// The fidelity of the preview is remembered in localStorage, so each part says
// which one it starts from rather than inheriting the one before it.
const APPROXIMATE = `(async () => {
  const { store } = await import('/assets/v2/js/store.js');
  store.setUi({ rightOpen: true, rightTab: 'preview', previewFidelity: 'approximate' });
})()`;

const bodyText = (page) => page.evaluate(() => String(document.body.innerText || ''));

// Press the `Proof this section` segment of the fidelity control.
function pressProof(page) {
  return page.evaluate(() => {
    const btn = document.querySelector('[data-seg="proof"]');
    if (!btn) return 'no proof control';
    if (btn.disabled) return 'the proof control is disabled';
    btn.click();
    return 'ok';
  });
}

const proofPages = (page) => page.evaluate(
  () => document.querySelectorAll('.rw-preview__page').length);

const subCaptions = (page) => page.evaluate(() => Array.from(
  document.querySelectorAll('.rw-preview__subcap')).map((el) => el.textContent.trim()));

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

(async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-proof-flush-'));
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

  const projectFile = path.join(root, ...CDR_DIR.split('/'), 'project.json');
  const firstParagraph = () => {
    try {
      return JSON.parse(fs.readFileSync(projectFile, 'utf8')).outline[0].blocks[0].runs[0].t;
    } catch (err) {
      return 'unreadable: ' + err.message;
    }
  };

  let browser = null;
  try {
    await waitForServer(base, child, 20000);

    browser = await chromium.launch({ channel: 'msedge', headless: !HEADED });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    const seen = [];
    page.on('request', (r) => seen.push(r.method() + ' ' + new URL(r.url()).pathname));
    const firstIndex = (line) => seen.findIndex((s) => s === line);
    const forget = () => { seen.length = 0; };

    // What the file held at the moment the section render was asked for. This
    // is the whole question: the server renders that file, so a proof of the
    // screen is a proof asked for AFTER the screen reached it.
    const diskAtProof = [];
    await page.route('**/api/preview-section', (route) => {
      diskAtProof.push(firstParagraph());
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          pages: [{ png_b64: SAMPLE_PNG_B64, w: 160, h: 90 }],
          ms: 120, docx_ms: 40, word_ms: 60, scope: 'section', warnings: [],
        }),
      });
    });

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
    // nothing would reload and the module state of the previous part -- the
    // cache of rendered proofs above all -- would still be standing.
    const openEditor = async () => {
      await page.goto('about:blank');
      await page.goto(editorUrl, { waitUntil: 'load' });
      await wait(1500);
      await page.evaluate(APPROXIMATE);
      await wait(200);
    };

    /* ============================================================ *
     * 1 - a proof pressed the moment after typing
     * ============================================================ */

    console.log('\nproof immediately after an edit  (PIN: fails before the fix)');

    await openEditor();
    forget();
    diskAtProof.length = 0;
    const edited = await page.evaluate(editTo(EDIT_TEXT));
    check('the document is unsaved at the moment the proof is pressed', edited === true, String(edited));

    const pressed = await pressProof(page);
    check('the proof control was reachable', pressed === 'ok', String(pressed));
    await wait(5000);

    check('the section render was asked for exactly once',
      diskAtProof.length === 1, JSON.stringify(diskAtProof));
    check('the file it was asked to render already held the edit',
      diskAtProof[0] === EDIT_TEXT, JSON.stringify(diskAtProof[0]));

    const putAt = firstIndex('PUT /api/project');
    const proofAt = firstIndex('POST /api/preview-section');
    check('the document was written BEFORE the render was asked for',
      putAt >= 0 && proofAt >= 0 && putAt < proofAt,
      'PUT at ' + putAt + ', render at ' + proofAt + ' in ' + JSON.stringify(seen));

    check('the pages are on screen', (await proofPages(page)) === 1);
    let text = await bodyText(page);
    check('nothing calls the pages old, because they are not',
      !/last saved version/i.test(text), text.slice(0, 500).replace(/\s+/g, ' '));

    /* ============================================================ *
     * 2 - a proof while the document cannot be saved
     * ============================================================ */

    console.log('\nproof while the document cannot be saved  (PIN: fails before the fix)');

    await openEditor();
    refuseSaves = true;
    forget();
    diskAtProof.length = 0;
    await page.evaluate(editTo(LATER_TEXT));
    const pressed2 = await pressProof(page);
    check('the proof control was reachable again', pressed2 === 'ok', String(pressed2));
    await wait(6000);

    check('the proof still rendered rather than blanking the panel',
      diskAtProof.length === 1 && (await proofPages(page)) === 1,
      JSON.stringify(diskAtProof) + ' pages=' + (await proofPages(page)));
    check('the pages really are of an older document than the screen',
      diskAtProof[0] !== LATER_TEXT, JSON.stringify(diskAtProof[0]));
    text = await bodyText(page);
    check('and the panel says the pages are the last saved version',
      /last saved version/i.test(text), text.slice(0, 700).replace(/\s+/g, ' '));
    check('the refused edit is still only in the page',
      firstParagraph() !== LATER_TEXT, JSON.stringify(firstParagraph()));

    /* ============================================================ *
     * 3 - with saves working, no such notice
     * ============================================================ */

    console.log('\nwith saves working  (PIN: the notice must not become furniture)');

    refuseSaves = false;
    await openEditor();
    forget();
    diskAtProof.length = 0;
    await page.evaluate(editTo(EDIT_TEXT));
    await pressProof(page);
    await wait(5000);
    text = await bodyText(page);
    check('the pages are not marked as coming from an older file',
      /This section, rendered by Word/i.test(text) && !/last saved version/i.test(text),
      text.slice(0, 700).replace(/\s+/g, ' '));

    /* ============================================================ *
     * 4 - the image grid's per-panel labels
     * ============================================================ */

    console.log('\nimage grid sub-captions  (PIN: fails before the fix)');

    await openEditor();
    await wait(500);
    const subs = await subCaptions(page);
    check('every panel of the grid carries a label',
      subs.length === 3, JSON.stringify(subs));
    check('the labels are the ones the panels hold',
      subs[0] === SUB_ONE && subs[1] === SUB_TWO, JSON.stringify(subs));
    check('a panel with no label of its own gets the engine fallback',
      subs[2] === '(c)', JSON.stringify(subs));

    /* ============================================================ *
     * 5 - Jump to editor lands ON the block
     * ============================================================ */

    console.log('\njump to editor  (PIN: fails before the fix)');

    // The editor is on section 1; the grid is the last card of section 2,
    // under six paragraphs, so a jump that only switched sections leaves it
    // off screen and marks nothing.
    const before = await page.evaluate(async () => {
      const { store } = await import('/assets/v2/js/store.js');
      return store.get().route.node;
    });
    check('the editor starts on another section', before !== 'n-2', String(before));

    const jumped = await page.evaluate((id) => {
      const wrap = document.querySelector('[data-block="' + id + '"]');
      if (!wrap) return 'the block is not in the preview';
      const btn = wrap.querySelector('.rw-paper__jump button');
      if (!btn) return 'no jump control on the block';
      btn.click();
      return 'ok';
    }, GRID_BLOCK);
    check('the preview offers Jump to editor on that block', jumped === 'ok', String(jumped));
    await wait(2500);

    const landing = await page.evaluate(async (id) => {
      const { store } = await import('/assets/v2/js/store.js');
      const card = document.querySelector('[data-block-id="' + id + '"]');
      const canvas = document.querySelector('.rw-canvas');
      if (!card || !canvas) return { node: store.get().route.node, card: !!card };
      const c = card.getBoundingClientRect();
      const v = canvas.getBoundingClientRect();
      return {
        node: store.get().route.node,
        card: true,
        marked: !!card.querySelector('.rw-card--selected'),
        onScreen: c.top < v.bottom && c.bottom > v.top,
      };
    }, GRID_BLOCK);
    check('the editor went to the section that holds it',
      landing.node === 'n-2', JSON.stringify(landing));
    check('the block is scrolled into view rather than left below the fold',
      landing.onScreen === true, JSON.stringify(landing));
    check('and the card it lands on is marked',
      landing.marked === true, JSON.stringify(landing));

    /* ============================================================ *
     * 6 - a cross-reference with nothing at the other end
     * ============================================================ */

    console.log('\ndangling cross-reference  (PIN: fails before the fix)');

    await openEditor();
    const refs = await page.evaluate(() => Array.from(
      document.querySelectorAll('.rw-preview__ref')).map((el) => el.textContent.trim()));
    check('the live reference prints the figure number',
      refs.some((t) => /\b2-1$/.test(t)), JSON.stringify(refs));
    check('the broken one prints the marker the export prints, not nothing',
      refs.indexOf('[ref: ' + GONE_BLOCK + ']') >= 0, JSON.stringify(refs));

    await page.evaluate(async () => {
      const { store } = await import('/assets/v2/js/store.js');
      store.setUi({ rightOpen: true, rightTab: 'check' });
    });
    await wait(700);
    const errors = await page.evaluate(() => Array.from(
      document.querySelectorAll('.rw-check__item--error')).map((el) => el.textContent.trim()));
    check('the Check tab reports it, at error level, in the lint sentence',
      errors.some((t) => /points at a figure or table that no longer exists/.test(t)),
      JSON.stringify(errors));
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
  console.log('proof flush and grid sub-captions: all checks passed');
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
