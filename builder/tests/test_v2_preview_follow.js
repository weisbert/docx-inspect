#!/usr/bin/env node
'use strict';
/*
 * test_v2_preview_follow.js -- two promises the preview panel makes and did not
 * keep: the control that says "take me to this block", and an export the user
 * asked to run out of their way.
 *
 * Run:  node builder/tests/test_v2_preview_follow.js
 *       node builder/tests/test_v2_preview_follow.js --headed     (watch it work)
 *
 * DEFECT 1 -- the jump button switched off the thing it needed
 *
 *   The scrolling document carried the release of the caret-follow on its own
 *   mousedown:
 *
 *       <div class="rw-preview__doc" onWheel=${release}
 *            onTouchStart=${release} onMouseDown=${release} ...>
 *
 *   Every block in that document has a `Jump to editor` button ON it, so the
 *   ancestor's release ran before the button's own click. Pressing the one
 *   control whose whole job is "take me to this block" cost the follow that had
 *   just put the block on screen, and nothing said why. The keyboard had the
 *   same hole: Space on a focused Jump button is that button being pressed, and
 *   the key list released the follow anyway.
 *
 *   An ancestor must not claim a gesture a descendant needs. The fix does not
 *   ask what was pressed -- any list of "what a control looks like" is one
 *   control out of date the day it is written. A press only ARMS the release;
 *   what fires it is the paper actually moving while the press is held.
 *
 * DEFECT 2 -- a backgrounded export vanished with its file
 *
 *   `Run in the background` closed the dialog and left the chip as the only way
 *   back, and the chip rendered nothing unless `status === 'running'`. The
 *   moment the export FINISHED, the chip disappeared with the file list, the
 *   Open file / Open folder controls, the timings and the check summary -- and
 *   nothing announced the finish. The button pressed so the user could keep
 *   working was the one that made the result unreachable.
 *
 * WHAT IT ASSERTS, in a real browser, with a real mouse and a real keyboard
 *   1. Pressing Jump to editor keeps the follow on (before: it went off), and
 *      the editor really selects that block.
 *   2. Space on a focused Jump button keeps the follow on (before: off).
 *   3. Scrolling the paper by hand -- a wheel, and a drag of its scroll bar --
 *      still releases the follow. The fix must not cost that.
 *   4. A backgrounded export announces that it finished, and its result is still
 *      reachable afterwards: the chip stands, it reopens the finished dialog,
 *      and Open file / Open folder reach a path that really exists on disk.
 *      (before: nothing was announced and the chip was gone)
 *   5. The chip goes away when, and only when, the user dismisses it.
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

// The TOC field code is full of backslashes; naming the character once keeps
// this source free of sequences that read as Unicode escapes.
const BS = String.fromCharCode(92);

// Long enough that the preview really has something to scroll.
const FILLER = ('The divider is characterised across supply and temperature, and the '
  + 'measured figures are collected here. ').repeat(6);

/* ------------------------------------------------------------------ *
 * fixture
 * ------------------------------------------------------------------ */

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function para(id, text) {
  return { id: id, type: 'para', runs: [{ t: text }], cardStart: true };
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
        blocks: [para('b-1', 'First section. ' + FILLER), para('b-2', 'Still the first section. ' + FILLER)],
        children: [],
      },
      {
        id: 'n-2',
        title: 'Design description',
        blocks: [para('b-3', 'Second section. ' + FILLER), para('b-4', 'Still the second section. ' + FILLER)],
        children: [],
      },
      {
        id: 'n-3',
        title: 'Simulation results',
        blocks: [para('b-5', 'Third section. ' + FILLER)],
        children: [],
      },
    ],
  };
}

// A complete, fully renderable, ASCII-only template config, so the export in
// part 4 really produces a .docx -- an assertion about reaching an exported file
// is worth nothing against a config the engine cannot render.
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
  writeJson(path.join(root, ...CDR_DIR.split('/'), 'project.json'), sampleReport());
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

// Every flip of ui.follow, in order, so an assertion can say "the follow was
// never released during that press" rather than reading the end state -- a
// release that is immediately undone by the caret effect is still the defect.
const WATCH_FOLLOW = `(async () => {
  const { store } = await import('/assets/v2/js/store.js');
  window.__followLog = [];
  let last = store.get().ui.follow;
  store.subscribe(() => {
    const now = store.get().ui.follow;
    if (now === last) return;
    last = now;
    window.__followLog.push(now);
  });
  return true;
})()`;

function setCursor(page, node, block) {
  return page.evaluate(async (at) => {
    const { store } = await import('/assets/v2/js/store.js');
    store.setUi({
      rightOpen: true, rightTab: 'preview', follow: true,
      cursorNode: at.node, cursorBlock: at.block,
    });
    return true;
  }, { node: node, block: block });
}

const followLog = (page) => page.evaluate(() => (window.__followLog || []).slice());
const clearLog = (page) => page.evaluate(() => { window.__followLog = []; });
const followNow = (page) => page.evaluate(async () => {
  const { store } = await import('/assets/v2/js/store.js');
  return store.get().ui.follow;
});

// The indicator in the preview bar: 'Following the cursor' or 'Whole report'.
const pillText = (page) => page.evaluate(() => {
  const pill = document.querySelector('.rw-preview__bar .rw-pill');
  return pill ? pill.textContent.trim() : '(no indicator)';
});

// Where the Jump to editor button of one block is, on screen.
const jumpBox = (page, blockId) => page.evaluate((id) => {
  const block = document.querySelector('.rw-paper__block[data-block="' + id + '"]');
  if (!block) return null;
  const btn = block.querySelector('.rw-paper__jump button');
  if (!btn) return null;
  const r = btn.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}, blockId);

const docBox = (page) => page.evaluate(() => {
  const el = document.querySelector('.rw-preview__doc');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return {
    left: r.left, top: r.top, right: r.right, bottom: r.bottom,
    scrollTop: el.scrollTop, bar: el.offsetWidth - el.clientWidth,
  };
});

// Did the centre canvas really travel to this block? Not "was a message sent":
// the block has to be in the canvas, on screen, and the outline has to have
// moved to the section holding it.
const editorAt = (page, blockId) => page.evaluate(async (id) => {
  const { store } = await import('/assets/v2/js/store.js');
  const el = document.querySelector('.rw-canvas [data-block-id="' + id + '"]');
  let inView = false;
  if (el) {
    const r = el.getBoundingClientRect();
    inView = r.bottom > 0 && r.top < window.innerHeight && r.height > 0;
  }
  const state = store.get();
  return {
    present: !!el, inView: inView,
    node: state.route.node, focus: state.ui.focusBlock,
  };
}, blockId);

function clickText(page, label) {
  return page.evaluate((wanted) => {
    const hit = Array.from(document.querySelectorAll('button'))
      .filter((b) => b.textContent.trim() === wanted && b.offsetParent !== null)[0];
    if (!hit || hit.disabled) return false;
    hit.click();
    return true;
  }, label);
}

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

// The chip lives in the chrome, never inside the export dialog and never in the
// preview bar (that one is the follow indicator).
const chip = (page) => page.evaluate(() => {
  const pill = Array.from(document.querySelectorAll('.rw-pill'))
    .filter((p) => !p.closest('.rw-dialog') && !p.closest('.rw-preview__bar'))
    .filter((p) => /^(Exporting|Export finished|Not exported|Something went wrong)/
      .test(p.textContent.trim()))[0];
  return pill ? pill.textContent.trim() : null;
});

const dialogText = (page) => page.evaluate(() => {
  const panel = document.querySelector('.rw-dialog');
  return panel ? String(panel.innerText || '') : '';
});

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

(async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-preview-follow-'));
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

  let browser = null;
  try {
    await waitForServer(base, child, 20000);

    browser = await chromium.launch({ channel: 'msedge', headless: !HEADED });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    // Opening a file or a folder is the OS's job, and this test must not start
    // an application on the machine running it. The call is answered here
    // instead, and what it asked for is kept so the path can be checked.
    // This fixture renders in a tenth of a second, which is not enough of a
    // window to press a button in. The export itself is left completely alone;
    // only its START is held back, so the dialog really is in its running state
    // when `Run in the background` is pressed - exactly the shape of a report
    // whose render takes the seconds the real ones take.
    let slowExport = false;
    await page.route('**/api/export-stream*', async (route) => {
      if (slowExport) await new Promise((r) => setTimeout(r, 6000));
      return route.continue();
    });

    const openCalls = [];
    await page.route('**/api/open-path', (route) => {
      let body = null;
      try { body = JSON.parse(route.request().postData() || '{}'); } catch (err) { body = null; }
      openCalls.push(body);
      return route.fulfill({
        status: 200, contentType: 'application/json', body: '{"ok": true, "path": "x"}',
      });
    });

    const editorUrl = base + '/#/r/' + CDR_DIR.split('/').map(encodeURIComponent).join('/');
    const openEditor = async () => {
      await page.goto('about:blank');
      await page.goto(editorUrl, { waitUntil: 'load' });
      await wait(1800);
    };

    /* ============================================================ *
     * 1 - Jump to editor, pressed with a real mouse
     * ============================================================ */

    console.log('\nJump to editor keeps the follow  (PIN: fails before the fix)');

    await openEditor();
    await page.evaluate(WATCH_FOLLOW);
    await setCursor(page, 'n-1', 'b-1');
    await wait(700);

    check('the preview says it is following the cursor',
      (await pillText(page)) === 'Following the cursor', await pillText(page));

    await clearLog(page);
    let box = await jumpBox(page, 'b-1');
    check('the block carries a Jump to editor button', !!box, JSON.stringify(box));
    if (box) {
      await page.mouse.move(box.x, box.y);
      await page.mouse.down();
      await page.mouse.up();
      await wait(700);
    }

    let log = await followLog(page);
    check('pressing it never released the follow',
      log.indexOf(false) === -1, 'ui.follow went ' + JSON.stringify(log));
    check('and the indicator still reads Following the cursor',
      (await pillText(page)) === 'Following the cursor', await pillText(page));
    let landed = await editorAt(page, 'b-1');
    check('the editor really went to that block',
      landed.present && landed.inView && landed.focus === 'b-1', JSON.stringify(landed));

    // A block in another section, so the jump has somewhere to travel to.
    await clearLog(page);
    box = await jumpBox(page, 'b-3');
    check('a block further down carries the same button', !!box, JSON.stringify(box));
    if (box) {
      await page.mouse.move(box.x, box.y);
      await page.mouse.down();
      await page.mouse.up();
      await wait(700);
    }
    log = await followLog(page);
    check('jumping across sections never released the follow either',
      log.indexOf(false) === -1, 'ui.follow went ' + JSON.stringify(log));
    landed = await editorAt(page, 'b-3');
    check('and the editor moved to that block, in the section that holds it',
      landed.present && landed.inView && landed.focus === 'b-3' && landed.node === 'n-2',
      JSON.stringify(landed));

    /* ============================================================ *
     * 2 - the same button, pressed with a real keyboard
     * ============================================================ */

    console.log('\nSpace on a focused Jump button  (PIN: fails before the fix)');

    await clearLog(page);
    const focused = await page.evaluate(() => {
      const btn = document.querySelector('.rw-paper__block[data-block="b-3"] .rw-paper__jump button');
      if (!btn) return false;
      btn.focus();
      return document.activeElement === btn;
    });
    check('the Jump button takes keyboard focus', focused === true, String(focused));
    await page.keyboard.press(' ');
    await wait(700);
    log = await followLog(page);
    check('pressing it with the keyboard never released the follow',
      log.indexOf(false) === -1, 'ui.follow went ' + JSON.stringify(log));
    check('the indicator still reads Following the cursor',
      (await pillText(page)) === 'Following the cursor', await pillText(page));

    /* ============================================================ *
     * 3 - scrolling the paper by hand still releases it
     * ============================================================ */

    console.log('\nscrolling by hand still releases the follow  (PIN: the fix must not cost this)');

    let geometry = await docBox(page);
    check('the preview document is on screen', !!geometry, JSON.stringify(geometry));
    await page.mouse.move((geometry.left + geometry.right) / 2, (geometry.top + geometry.bottom) / 2);
    await page.mouse.wheel(0, 400);
    await wait(500);
    check('a wheel over the paper releases the follow',
      (await followNow(page)) === false, 'ui.follow = ' + (await followNow(page)));
    check('and the indicator says so', (await pillText(page)) === 'Whole report', await pillText(page));

    // Re-attach from the indicator itself, which is what it is for.
    await page.evaluate(() => {
      const pill = document.querySelector('.rw-preview__bar .rw-pill');
      if (pill) pill.click();
    });
    await wait(500);
    check('clicking the indicator re-attaches the follow',
      (await followNow(page)) === true, 'ui.follow = ' + (await followNow(page)));

    // A scroll key, pressed with focus on a control INSIDE the document. This is
    // the press-arms-it path end to end: the key press alone releases nothing,
    // the paper moving under it is what does. Space on the same button, two
    // parts above, scrolls nothing and so releases nothing - the two together
    // are the whole rule.
    //
    // The caret goes back to the first block first, so the document is at the
    // top and a scroll key has somewhere to go.
    await setCursor(page, 'n-1', 'b-1');
    await wait(700);
    const before = (await docBox(page)).scrollTop;
    const armed = await page.evaluate(() => {
      const btn = document.querySelector('.rw-paper__block[data-block="b-1"] .rw-paper__jump button');
      if (!btn) return false;
      btn.focus();
      return document.activeElement === btn;
    });
    check('a control inside the document has the focus', armed === true, String(armed));
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await wait(500);
    const after = (await docBox(page)).scrollTop;
    check('a scroll key really moved the paper', Math.abs(after - before) > 5,
      'scrollTop ' + before + ' -> ' + after);
    check('and moving it that way releases the follow',
      (await followNow(page)) === false, 'ui.follow = ' + (await followNow(page)));

    await page.evaluate(() => {
      const pill = document.querySelector('.rw-preview__bar .rw-pill');
      if (pill) pill.click();
    });
    await wait(500);

    // Dragging the scroll bar: a press that really does move the paper.
    await page.evaluate(() => {
      const el = document.querySelector('.rw-preview__doc');
      if (el) el.scrollTop = 0;
    });
    await wait(300);
    geometry = await docBox(page);
    if (geometry && geometry.bar > 2) {
      const x = geometry.right - geometry.bar / 2;
      await page.mouse.move(x, geometry.top + 10);
      await page.mouse.down();
      await page.mouse.move(x, geometry.top + 140, { steps: 12 });
      await page.mouse.up();
      await wait(400);
      const moved = (await docBox(page)).scrollTop;
      if (moved > 5) {
        check('dragging its scroll bar releases the follow',
          (await followNow(page)) === false, 'ui.follow = ' + (await followNow(page)));
      } else {
        console.log('  [note] the scroll bar drag moved nothing (scrollTop ' + moved
          + ') - the wheel above is the assertion');
      }
    } else {
      console.log('  [note] this platform draws no classic scroll bar - the wheel above is the assertion');
    }

    /* ============================================================ *
     * 4 - a backgrounded export announces itself and stays reachable
     * ============================================================ */

    console.log('\na backgrounded export  (PIN: fails before the fix)');

    await openEditor();
    slowExport = true;
    const started = await pressExport(page, 'Export Word only');
    check('the Export control was reachable', started === 'ok', String(started));
    await wait(1500);
    const backgrounded = await clickText(page, 'Run in the background');
    check('the dialog offers Run in the background', backgrounded === true, String(backgrounded));
    await wait(400);
    check('the dialog stepped out of the way', (await dialogText(page)) === '',
      (await dialogText(page)).slice(0, 200));
    check('a chip stands in for it while it runs',
      /^Exporting/.test(String(await chip(page))), String(await chip(page)));

    // Wait for the job to settle, then read what the interface says about it.
    let settledChip = null;
    for (let i = 0; i < 120; i++) {
      await wait(1000);
      const now = await chip(page);
      if (now && !/^Exporting/.test(now)) { settledChip = now; break; }
    }
    check('the finish is announced without reopening anything',
      settledChip !== null && /^Export finished/.test(settledChip), String(settledChip));

    const announced = await page.evaluate(() => {
      const t = document.querySelector('.rw-toast');
      return t ? String(t.textContent || '') : null;
    });
    check('and it is announced out loud, not only in the chrome',
      announced !== null && /Export finished/.test(announced), String(announced));

    const outFiles = (() => {
      try { return fs.readdirSync(path.join(reportDir, 'out')); } catch (err) { return []; }
    })();
    check('a file really was produced', outFiles.length > 0, JSON.stringify(outFiles));

    // The result must still be reachable: the chip reopens the finished dialog.
    await page.evaluate(() => {
      const pill = Array.from(document.querySelectorAll('.rw-pill'))
        .filter((p) => /^Export finished/.test(p.textContent.trim()))[0];
      if (pill) pill.click();
    });
    await wait(700);
    const panel = await dialogText(page);
    check('clicking the chip brings the finished export back',
      /Export finished/.test(panel), panel.slice(0, 300).replace(/\s+/g, ' '));
    check('with the file it produced', /\.docx/.test(panel), panel.slice(0, 300).replace(/\s+/g, ' '));
    check('and its check summary', /checks:/.test(panel), panel.slice(0, 300).replace(/\s+/g, ' '));

    openCalls.length = 0;
    await clickText(page, 'Open file');
    await wait(700);
    await clickText(page, 'Open folder');
    await wait(700);
    check('Open file and Open folder both reach the machine',
      openCalls.length === 2 && openCalls[0] && openCalls[1]
        && openCalls[0].folder !== true && openCalls[1].folder === true,
      JSON.stringify(openCalls));
    const asked = (openCalls[0] && openCalls[0].file) || '';
    const onDisk = asked && fs.existsSync(path.join(reportDir, ...String(asked).split('/')));
    check('the path it asked for is a file that exists', !!onDisk, JSON.stringify(asked));

    await clickText(page, 'Back to editing');
    await wait(500);
    check('leaving the dialog does not take the result with it',
      /^Export finished/.test(String(await chip(page))), String(await chip(page)));

    // Collapsing the right panel must not take the chip either: it belongs in
    // the header, and only one of its two mounts ever draws.
    await page.evaluate(async () => {
      const { store } = await import('/assets/v2/js/store.js');
      store.setUi({ rightOpen: false });
    });
    await wait(600);
    const chipCount = await page.evaluate(() => Array.from(document.querySelectorAll('.rw-pill'))
      .filter((p) => /^Export finished/.test(p.textContent.trim())).length);
    check('it survives the right panel being collapsed, exactly once',
      chipCount === 1, 'chips on screen: ' + chipCount);

    const dismissed = await page.evaluate(() => {
      const pill = Array.from(document.querySelectorAll('.rw-pill'))
        .filter((p) => /^Export finished/.test(p.textContent.trim()))[0];
      const row = pill && pill.parentElement;
      const cross = row && Array.from(row.querySelectorAll('button'))
        .filter((b) => b.getAttribute('title') === 'Close')[0];
      if (!cross) return 'no dismiss control';
      cross.click();
      return 'ok';
    });
    check('the chip offers a way to dismiss it', dismissed === 'ok', String(dismissed));
    await wait(500);
    check('and dismissing it is what finally clears it',
      (await chip(page)) === null, String(await chip(page)));
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
  console.log('preview follow and background export: all checks passed');
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
