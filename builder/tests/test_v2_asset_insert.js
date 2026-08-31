#!/usr/bin/env node
'use strict';
/*
 * test_v2_asset_insert.js -- one paste stores one file, and the asset tray's
 * drag actually inserts. Driven with a real keyboard and a real mouse.
 *
 * Run:  node builder/tests/test_v2_asset_insert.js
 *       node builder/tests/test_v2_asset_insert.js --headed     (watch it work)
 *
 * WHY THIS FILE EXISTS
 *
 *   1. ONE PASTE, TWO FILES.
 *      js/views/assets.js registers a document-level `paste` listener that
 *      claims any paste carrying image files. Its sibling `drop` listener bails
 *      on ev.defaultPrevented -- "a card that handled it already called
 *      preventDefault" -- but the paste listener had no such check, and the
 *      figure card's own paste handler in js/views/blocks.js did not
 *      preventDefault either. So both ran on ONE keystroke: the card stored the
 *      picture and the tray stored it again. images/ gained two files from one
 *      Ctrl+V, and the second one showed up in the tray as an unused asset the
 *      owner then had to hunt down.
 *
 *   2. A DRAG THE TRAY PROMISED AND DID NOT DELIVER.
 *      The tray's hint reads "Drag onto a figure block or into the text to
 *      insert". Every card is draggable and carries application/x-rw-asset,
 *      and readAssetDrag() was exported for a reader that never existed --
 *      nothing in the tree imported it. So a card dropped on an empty figure
 *      block reached a handler that only looks at dataTransfer.files, which an
 *      asset drag does not carry: a silent no-op. A card dropped into prose was
 *      worse -- the drag also sets text/plain, so the contenteditable took the
 *      browser default and typed the literal string "images/<name>" into the
 *      paragraph. A figure block that already held an image had no drop target
 *      at all.
 *
 * WHAT IT ASSERTS
 *   1. one Ctrl+V of a picture into an empty figure card leaves EXACTLY one new
 *      file in images/, and fills that card with it;
 *   2. dragging a tray card onto an empty figure block fills it;
 *   3. dragging a tray card onto a figure block that already holds an image
 *      replaces the image;
 *   4. dragging a tray card into prose inserts a figure block and never types a
 *      path into the paragraph.
 *
 * Against the old code every one of the four fails: 1 stores two files, 2 and 3
 * do nothing at all, and 4 leaves "images/sample_b.png" sitting in the prose.
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
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');

const HERE = __dirname;
const REPO = path.resolve(HERE, '..', '..');
const SERVER_PY = path.join(REPO, 'builder', 'web', 'server.py');

const ARGS = process.argv.slice(2);
const HEADED = ARGS.includes('--headed');
const KEEP_ROOT = ARGS.includes('--keep-root');
const VIEWPORT = { width: 1600, height: 1000 };

let chromium = null;
let chromiumMissing = '';
try {
  chromium = require('playwright-core').chromium;
} catch (err) {
  chromiumMissing = 'playwright-core is not installed.  npm install, then re-run.';
}

/* ------------------------------------------------------------------ *
 * a real PNG, built here so the fixture needs no binary in the tree
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, body) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  const name = Buffer.from(type, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([name, body])), 0);
  return Buffer.concat([head, name, body, tail]);
}

// A flat RGB rectangle. Small on purpose: the cards size the picture from
// width_cm, so the natural size only has to be a valid image.
function makePng(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;      // bit depth
  ihdr[9] = 2;      // truecolour
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      raw[row + 1 + x * 3] = rgb[0];
      raw[row + 2 + x * 3] = rgb[1];
      raw[row + 3 + x * 3] = rgb[2];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ *
 * the fixture
 * ------------------------------------------------------------------ */

const PROJECT_ID = '1108';
const MODULE_ID = 'CLKDIV_5G';
const REPORT_DIR = PROJECT_ID + '/' + MODULE_ID + '/CDR';

const SECTION = 'Simulation results';
const PROSE = 'The figures below show the divided output.';
const ASSET_A = 'sample_a.png';
const ASSET_B = 'sample_b.png';

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function figure(id, file) {
  return {
    type: 'image', id: id, file: file, caption: '', width_cm: 5, size: 'full',
  };
}

function sampleReport() {
  return {
    template: 'sample',
    meta: {
      title: MODULE_ID + ' CDR report', doc_no: 'DOC-1', version: 'V1.0',
      secrecy: 'Internal', author: 'A. Engineer', date: '2026-08-30',
      reviewers: ['B. Engineer'], approver: 'C. Engineer', revisions: [],
    },
    outline: [
      {
        id: 'n-results',
        title: SECTION,
        blocks: [
          { type: 'para', cardStart: true, list: null, runs: [{ t: PROSE }] },
          figure('b-fig-paste', ''),
          figure('b-fig-empty', ''),
          figure('b-fig-filled', 'images/' + ASSET_A),
        ],
        children: [],
      },
    ],
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

function buildReportsRoot(root) {
  fs.mkdirSync(root, { recursive: true });
  writeJson(path.join(root, 'templates', 'sample', 'config.json'), sampleTemplateConfig());
  writeJson(path.join(root, 'templates', 'sample', 'skeleton.json'), sampleTemplateConfig().skeleton);
  writeJson(path.join(root, PROJECT_ID, 'project_meta.json'), { name: 'Sample project' });
  writeJson(path.join(root, PROJECT_ID, MODULE_ID, 'project_meta.json'), { name: MODULE_ID });
  const reportDir = path.join(root, ...REPORT_DIR.split('/'));
  writeJson(path.join(reportDir, 'project.json'), sampleReport());
  const images = path.join(reportDir, 'images');
  fs.mkdirSync(images, { recursive: true });
  fs.writeFileSync(path.join(images, ASSET_A), makePng(48, 36, [40, 90, 200]));
  fs.writeFileSync(path.join(images, ASSET_B), makePng(48, 36, [200, 80, 40]));
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
      const status = await httpGet(base + '/api/health');
      if (status === 200) return;
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
 * reading what landed on disk
 * ------------------------------------------------------------------ */

const settle = (page, ms) => page.waitForTimeout(ms == null ? 350 : ms);

function reportFile(root) {
  return path.join(root, ...REPORT_DIR.split('/'), 'project.json');
}

function imagesDir(root) {
  return path.join(root, ...REPORT_DIR.split('/'), 'images');
}

function listImages(root) {
  return fs.readdirSync(imagesDir(root)).filter((n) => /\.png$/i.test(n)).sort();
}

function readBlocks(root) {
  const doc = JSON.parse(fs.readFileSync(reportFile(root), 'utf8'));
  return ((doc.outline || [])[0] || {}).blocks || [];
}

function blockById(blocks, id) {
  return (blocks || []).filter((b) => b && b.id === id)[0] || null;
}

function proseText(blocks) {
  const para = (blocks || []).filter((b) => b && b.type === 'para')[0];
  if (!para) return '';
  return (para.runs || []).map((r) => (r && r.t) || '').join('');
}

function blockShape(blocks) {
  return (blocks || []).map((b) => (b ? b.type : '?')).join(' , ');
}

async function waitForBlocks(root, predicate, timeoutMs) {
  const until = Date.now() + (timeoutMs == null ? 4000 : timeoutMs);
  for (;;) {
    let last = [];
    try { last = readBlocks(root); } catch (err) { last = []; }
    if (predicate(last)) return last;
    if (Date.now() > until) return last;
    await new Promise((r) => setTimeout(r, 180));
  }
}

async function waitForImages(root, count, timeoutMs) {
  const until = Date.now() + (timeoutMs == null ? 6000 : timeoutMs);
  for (;;) {
    const list = listImages(root);
    if (list.length >= count) return list;
    if (Date.now() > until) return list;
    await new Promise((r) => setTimeout(r, 180));
  }
}

/* ------------------------------------------------------------------ *
 * driving the page
 * ------------------------------------------------------------------ */

async function clickText(page, label) {
  const clicked = await page.evaluate((wanted) => {
    const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    const nodes = Array.from(document.querySelectorAll(
      'button, a, summary, label, li, [role="button"], [role="tab"], [tabindex]'));
    let hit = null;
    for (const el of nodes) {
      const own = norm(el.innerText || el.textContent);
      const alt = norm(el.getAttribute('aria-label') || el.getAttribute('title'));
      const text = own || alt;
      if (!(text === wanted || alt === wanted || text.indexOf(wanted) >= 0)) continue;
      const box = el.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      if (!hit || hit.contains(el)) hit = el;
    }
    if (!hit) return false;
    hit.scrollIntoView({ block: 'center', inline: 'nearest' });
    hit.click();
    return true;
  }, label);
  if (clicked) await settle(page);
  return clicked;
}

// The centre of the drop zone of one figure card, scrolled into view first.
// `which` is the card's block index in the section.
async function figureTarget(page, index, filled) {
  return page.evaluate((arg) => {
    const card = document.querySelector('[data-card-start="' + arg.index + '"]');
    if (!card) return { error: 'no card at index ' + arg.index };
    const zone = card.querySelector(arg.filled ? '.rw-figure' : '.rw-empty');
    if (!zone) return { error: 'the card at index ' + arg.index + ' has no drop zone' };
    card.scrollIntoView({ block: 'center', inline: 'nearest' });
    const box = zone.getBoundingClientRect();
    return { cx: box.left + box.width / 2, cy: box.top + box.height / 2, w: box.width, h: box.height };
  }, { index: index, filled: !!filled });
}

async function proseTarget(page) {
  return page.evaluate(() => {
    const box = document.querySelector('.rw-prose[contenteditable="true"]');
    if (!box) return { error: 'no prose card on screen' };
    box.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = box.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width, h: r.height };
  });
}

async function assetCardAt(page, name) {
  return page.evaluate((wanted) => {
    const cards = Array.from(document.querySelectorAll('.rw-asset'));
    const hit = cards.filter((c) => String(c.getAttribute('title') || '') === wanted)[0];
    if (!hit) {
      return { error: 'no tray card titled ' + wanted + ' (' + cards.length + ' cards on screen)' };
    }
    const thumb = hit.querySelector('.rw-asset__thumbwrap') || hit;
    const box = thumb.getBoundingClientRect();
    return { cx: box.left + box.width / 2, cy: box.top + box.height / 2 };
  }, name);
}

// A real HTML5 drag: press, several moves, release. Chromium only starts a
// native drag from a genuine mouse stream, which is the whole point here.
async function dragAndDrop(page, from, to) {
  await page.mouse.move(from.cx, from.cy);
  await page.mouse.down();
  await page.mouse.move(from.cx + 6, from.cy + 6);
  await page.waitForTimeout(40);
  const steps = 14;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(
      from.cx + ((to.cx - from.cx) * i) / steps,
      from.cy + ((to.cy - from.cy) * i) / steps
    );
    await page.waitForTimeout(18);
  }
  await page.mouse.move(to.cx, to.cy);
  await page.waitForTimeout(60);
  await page.mouse.move(to.cx + 1, to.cy);
  await page.waitForTimeout(60);
  await page.mouse.up();
  await settle(page, 400);
}

async function save(page) {
  await page.keyboard.press('Control+s');
  await settle(page, 250);
}

/* ------------------------------------------------------------------ *
 * the run
 * ------------------------------------------------------------------ */

async function browserChecks() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const scratch = path.join(os.tmpdir(), 'report-workbench-v2-asset-insert', stamp);
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

    const context = await browser.newContext({ viewport: VIEWPORT });
    try {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
    } catch (err) {
      console.log('  note: clipboard permissions were refused -- ' + String(err && err.message));
    }
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('console', (msg) => {
      const where = msg.location && msg.location() ? String(msg.location().url) : '';
      if (msg.type() === 'error' && where.indexOf('favicon') < 0) {
        consoleErrors.push(msg.text().slice(0, 200));
      }
    });
    page.on('pageerror', (err) => consoleErrors.push('uncaught: ' + String(err && err.message)));
    // A click on an empty figure zone opens a file picker; nothing in this test
    // wants one, and an unhandled chooser blocks the page.
    page.on('filechooser', (chooser) => { chooser.setFiles([]).catch(() => {}); });

    const editorUrl = base + '/#/r/' + REPORT_DIR.split('/').map(encodeURIComponent).join('/');
    await page.goto(editorUrl, { waitUntil: 'load' });
    await settle(page, 1400);
    await clickText(page, SECTION);
    await settle(page, 900);

    /* ---- 1. one paste, one file ---- */

    section('one Ctrl+V of a picture into a figure card');
    const before = listImages(reportsRoot);
    console.log('  images/ before: ' + before.join(', '));

    const pasted = makePng(60, 40, [20, 160, 90]).toString('base64');
    let clipboardOk = true;
    try {
      await page.evaluate(async (b64) => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const blob = new Blob([bytes], { type: 'image/png' });
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      }, pasted);
    } catch (err) {
      clipboardOk = false;
      console.log('  SKIP: this browser would not accept a picture on the clipboard.');
      console.log('        ' + String(err && err.message ? err.message : err).split('\n')[0]);
    }

    if (clipboardOk) {
      const focused = await page.evaluate(() => {
        const card = document.querySelector('[data-card-start="1"]');
        const zone = card ? card.querySelector('.rw-empty') : null;
        if (!zone) return false;
        zone.scrollIntoView({ block: 'center', inline: 'nearest' });
        zone.focus();
        return document.activeElement === zone;
      });
      check('the empty figure card takes the caret', focused, 'no focusable drop zone');

      await page.keyboard.press('Control+v');
      await settle(page, 900);
      await waitForImages(reportsRoot, before.length + 1, 6000);
      await settle(page, 1200);   // long enough for a SECOND write to land too
      await save(page);

      const after = listImages(reportsRoot);
      console.log('  images/ after : ' + after.join(', '));
      check('one paste leaves exactly one new file in images/',
        after.length === before.length + 1,
        after.length - before.length + ' new file(s): ' + after.join(', '));

      const blocks = await waitForBlocks(reportsRoot,
        (b) => !!(blockById(b, 'b-fig-paste') || {}).file, 4000);
      const filled = blockById(blocks, 'b-fig-paste') || {};
      check('the pasted picture fills the card that was pasted into',
        !!filled.file && after.indexOf(String(filled.file).slice('images/'.length)) >= 0,
        'the card points at "' + (filled.file || '') + '"');
      await page.screenshot({ path: path.join(shots, 'after-paste.png') });
    }

    /* ---- the tray, expanded ---- */

    section('the asset tray');
    await clickText(page, 'Expand');
    await settle(page, 700);
    const trayCards = await page.evaluate(() => document.querySelectorAll('.rw-asset').length);
    check('the tray shows its cards', trayCards > 0, trayCards + ' cards');
    await page.screenshot({ path: path.join(shots, 'tray-open.png') });

    /* ---- 2. drag onto an empty figure block ---- */

    section('dragging a tray card onto an empty figure block');
    let source = await assetCardAt(page, ASSET_B);
    let target = await figureTarget(page, 2, false);
    if (source.error || target.error) {
      check('there is a tray card and an empty figure block on screen', false,
        source.error || target.error);
    } else {
      source = await assetCardAt(page, ASSET_B);
      await dragAndDrop(page, source, target);
      await save(page);
      const blocks = await waitForBlocks(reportsRoot,
        (b) => !!(blockById(b, 'b-fig-empty') || {}).file, 4000);
      const got = (blockById(blocks, 'b-fig-empty') || {}).file || '';
      check('the drop fills the empty figure block',
        got === 'images/' + ASSET_B, 'the block points at "' + got + '"');
      await page.screenshot({ path: path.join(shots, 'after-drop-empty.png') });
    }

    /* ---- 3. drag onto a figure block that already holds a picture ---- */

    section('dragging a tray card onto a figure block that already holds one');
    source = await assetCardAt(page, ASSET_B);
    target = await figureTarget(page, 3, true);
    if (source.error || target.error) {
      check('there is a filled figure block on screen', false, source.error || target.error);
    } else {
      source = await assetCardAt(page, ASSET_B);
      await dragAndDrop(page, source, target);
      await save(page);
      const blocks = await waitForBlocks(reportsRoot,
        (b) => (blockById(b, 'b-fig-filled') || {}).file === 'images/' + ASSET_B, 4000);
      const got = (blockById(blocks, 'b-fig-filled') || {}).file || '';
      check('the drop replaces the picture already in the block',
        got === 'images/' + ASSET_B, 'the block points at "' + got + '"');
      await page.screenshot({ path: path.join(shots, 'after-drop-replace.png') });
    }

    /* ---- 4. drag into prose ---- */

    section('dragging a tray card into prose');
    const shapeBefore = blockShape(readBlocks(reportsRoot));
    console.log('  on disk before: ' + shapeBefore);
    source = await assetCardAt(page, ASSET_B);
    target = await proseTarget(page);
    if (source.error || target.error) {
      check('there is prose to drop into', false, source.error || target.error);
    } else {
      source = await assetCardAt(page, ASSET_B);
      await dragAndDrop(page, source, target);
      await page.evaluate(() => {
        const box = document.querySelector('.rw-prose[contenteditable="true"]');
        if (box && box.blur) box.blur();
      });
      await settle(page, 300);
      await save(page);
      const blocks = await waitForBlocks(reportsRoot,
        (b) => b.length > shapeBefore.split(' , ').length, 4000);
      console.log('  on disk after : ' + blockShape(blocks));
      const added = blocks.filter((b) => b && b.type === 'image' && b.file === 'images/' + ASSET_B);
      check('the drop inserts a figure into the section',
        blocks.length === shapeBefore.split(' , ').length + 1 && added.length >= 1,
        'blocks are: ' + blockShape(blocks));
      const text = proseText(blocks);
      check('the drop never types a path into the paragraph',
        text === PROSE, 'the paragraph reads: "' + text + '"');
      await page.screenshot({ path: path.join(shots, 'after-drop-prose.png') });
    }

    if (consoleErrors.length) {
      check('no console errors', false, consoleErrors.slice(0, 4).join(' | '));
    } else {
      console.log('');
      console.log('  [ok  ] no console errors');
    }

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
