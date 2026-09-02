#!/usr/bin/env node
'use strict';
/*
 * test_v2_crossref.js -- inserting a cross-reference, and what happens to one
 * whose target is deleted. Driven with a real mouse and a real keyboard.
 *
 * Run:  node builder/tests/test_v2_crossref.js
 *       node builder/tests/test_v2_crossref.js --headed
 *
 * WHY THIS FILE EXISTS
 *   1. The picker took the focus, and the insertion then read the live
 *      selection -- which was no longer in the paragraph. No chip appeared, the
 *      characters typed next landed at CHARACTER 0 of the paragraph, and that
 *      mangled sentence was saved. A second reference picked beside an existing
 *      one nested inside its span and both were dropped on the next repaint.
 *      The caret is now recorded the way the model counts it, and survives the
 *      repaint that follows the insertion.
 *   2. A reference whose target was deleted showed the raw internal id, styled
 *      exactly like a live one: 'The spread is shown in n-mtk7n0w6-v88sc',
 *      saved, and reported by nothing. It now reads as broken where it is
 *      written, and content_lint reports it as an error.
 *   3. The picker listed bare numbers, so a document with thirty figures had to
 *      be counted through. Each entry carries its caption.
 *   4. The figure width control renders EMPTY for any stored width that is not
 *      one of the five offered -- which is most widths in an imported report --
 *      and the first click on it silently replaced the value it was hiding.
 *
 * WHAT IT ASSERTS
 *   1. a reference picked with the caret at the end of a sentence lands THERE,
 *      and the characters typed next follow it -- in the DOM, on disk, and
 *      after a reload;
 *   2. a second reference picked beside the first is its sibling, never nested,
 *      and neither the text nor the first chip is lost;
 *   3. the picker shows the caption beside each number, truncated;
 *   4. deleting the target leaves a chip that says so, and content_lint reports
 *      a dangling_ref ERROR for the paragraph;
 *   5. a figure stored at 8.3 cm shows 'Width 8.3 cm', with the five presets
 *      still on offer.
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
const { spawn, spawnSync } = require('node:child_process');

const HERE = __dirname;
const REPO = path.resolve(HERE, '..', '..');
const SERVER_PY = path.join(REPO, 'builder', 'web', 'server.py');
const LINT_PY = path.join(REPO, 'builder', 'core', 'content_lint.py');

const ARGS = process.argv.slice(2);
const HEADED = ARGS.includes('--headed');
const VIEWPORT = { width: 1600, height: 940 };

const PROJECT_ID = '1108';
const MODULE_ID = 'CLKDIV_5G';
const REPORT_DIR = PROJECT_ID + '/' + MODULE_ID + '/CDR';
const SECTION = 'Simulation results';

const PARA_ID = 'b-para-1';
const FIG_A = 'b-fig-a';
const FIG_B = 'b-fig-b';
const SENTENCE = 'The divider takes a differential input.';
const CAPTION_A = 'Corner spread of the divided clock';
const CAPTION_B = 'Duty cycle of the divided clock across temperature and supply corners';
const ODD_WIDTH = 8.3;

/* A 1x1 PNG -- the fixture only needs a valid picture. */
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
      secrecy: 'Internal', author: 'A. Engineer', date: '2026-08-30',
      reviewers: [], approver: '', revisions: [],
    },
    outline: [{
      id: 'n-results',
      title: SECTION,
      blocks: [
        {
          type: 'para', id: PARA_ID, cardStart: true, list: null,
          runs: [{ t: SENTENCE }],
        },
        // width_cm is deliberately NOT one of the five the control offers.
        {
          type: 'image', id: FIG_A, file: 'images/spread.png',
          caption: CAPTION_A, width_cm: ODD_WIDTH,
        },
        {
          type: 'image', id: FIG_B, file: 'images/duty.png',
          caption: CAPTION_B, width_cm: 12,
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
  for (const name of ['spread.png', 'duty.png']) {
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

function readBlocks(root) {
  const file = path.join(root, ...REPORT_DIR.split('/'), 'project.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  return ((doc.outline || [])[0] || {}).blocks || [];
}

function paragraph(root) {
  const blocks = readBlocks(root);
  for (const block of blocks) if (block && block.id === PARA_ID) return block;
  return blocks[0] || null;
}

// The paragraph's runs as a readable line: text as it is, a reference as
// <ref:id>. That is the whole of what the fix has to get right.
function runLine(block) {
  return ((block && block.runs) || [])
    .map((run) => (run.ref ? '<ref:' + run.ref + '>' : String(run.t == null ? '' : run.t)))
    .join('');
}

async function waitFor(read, predicate, timeoutMs) {
  const until = Date.now() + (timeoutMs == null ? 6000 : timeoutMs);
  let last = null;
  for (;;) {
    try {
      last = read();
      if (predicate(last)) return last;
    } catch (err) { /* mid-write */ }
    if (Date.now() > until) return last;
    await new Promise((r) => setTimeout(r, 150));
  }
}

// content_lint on the report as it now stands: [exit code, codes it reported].
function lintReport(root) {
  const python = process.env.RW_PYTHON || 'python';
  const dir = path.join(root, ...REPORT_DIR.split('/'));
  const config = path.join(root, 'templates', 'sample', 'config.json');
  const out = spawnSync(python, [LINT_PY, dir, '--config', config, '--json'],
    { cwd: REPO, encoding: 'utf8' });
  let findings = [];
  try { findings = JSON.parse(out.stdout || '[]'); } catch (err) { findings = []; }
  return { code: out.status, findings: findings, raw: String(out.stdout || out.stderr || '') };
}

/* ------------------------------------------------------------------ *
 * driving
 * ------------------------------------------------------------------ */

const settle = (page, ms) => page.waitForTimeout(ms == null ? 350 : ms);

const PROSE_CARD = '.rw-card:has(.rw-card__marker--prose)';
const FIGURE_CARD = '.rw-card:has(.rw-card__marker--figure)';

// What the prose card looks like right now: its text, its chips, and whether
// any chip sits INSIDE another.
const proseState = (page) => page.evaluate(() => {
  const box = document.querySelector('.rw-prose');
  if (!box) return { missing: true };
  const chips = Array.prototype.slice.call(box.querySelectorAll('.rw-ref'));
  const tail = (chip) => {
    let text = '';
    let node = chip.nextSibling;
    while (node) {
      text += node.textContent || '';
      node = node.nextSibling;
    }
    return text;
  };
  return {
    missing: false,
    text: (box.textContent || '').replace(/ /g, ' '),
    chipCount: chips.length,
    nested: box.querySelectorAll('.rw-ref .rw-ref').length,
    labels: chips.map((c) => (c.textContent || '').trim()),
    bad: chips.map((c) => c.className.indexOf('rw-ref--bad') >= 0),
    titles: chips.map((c) => c.getAttribute('title') || ''),
    afterFirst: chips.length ? tail(chips[0]).replace(/ /g, ' ') : '',
    focusIsProse: document.activeElement === box,
  };
});

// Open the prose card's menu and pick the cross-reference entry. Returns what
// the picker offered, so the caption assertion reads the real chips.
async function openPicker(page) {
  await page.click(PROSE_CARD + ' [title="More"]');
  await settle(page, 200);
  await page.click('.rw-menu__item:has-text("Cross-reference")');
  await page.waitForSelector('.rw-scrim .rw-chip--add', { timeout: 4000 });
  return page.$$eval('.rw-scrim .rw-chip--add', (nodes) => nodes.map((n) => n.textContent.trim()));
}

async function pickTarget(page, startsWith) {
  const chips = page.locator('.rw-scrim .rw-chip--add');
  const count = await chips.count();
  for (let i = 0; i < count; i++) {
    const text = (await chips.nth(i).textContent()).trim();
    if (text.indexOf(startsWith) === 0) {
      await chips.nth(i).click();
      return text;
    }
  }
  return '';
}

async function browserChecks() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const scratch = path.join(os.tmpdir(), 'report-workbench-v2-crossref', stamp);
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
    await page.waitForSelector('.rw-prose', { timeout: 10000 });
    await settle(page, 500);

    /* ---- 1: the width the figure is actually set to ---- */
    section('the width a figure is actually set to');
    const widthSelect = page.locator(FIGURE_CARD + ' select').first();
    const widthState = await widthSelect.evaluate((el) => ({
      value: el.value,
      shown: el.selectedIndex >= 0 ? el.options[el.selectedIndex].textContent.trim() : '',
      options: Array.prototype.map.call(el.options, (o) => o.value),
    }));
    check('the stored width is the one selected',
      widthState.value === String(ODD_WIDTH), JSON.stringify(widthState));
    check('and it is spelled out, not left blank',
      widthState.shown === 'Width ' + ODD_WIDTH + ' cm', JSON.stringify(widthState));
    check('the five presets are still on offer',
      ['5', '7.5', '10', '12', '15.5'].every((w) => widthState.options.indexOf(w) >= 0),
      JSON.stringify(widthState.options));
    check('the stored width was not rewritten by drawing the control',
      readBlocks(reportsRoot).some((b) => b.id === FIG_A && b.width_cm === ODD_WIDTH),
      JSON.stringify(readBlocks(reportsRoot).map((b) => b.width_cm)));

    /* ---- 2: a reference lands where the caret is ---- */
    section('a reference picked with the caret at the end of a sentence');
    await page.click('.rw-prose p');
    await page.keyboard.press('End');
    await page.keyboard.type(' See ');
    await settle(page, 250);

    const offered = await openPicker(page);
    check('the picker offers both figures', offered.length === 2, JSON.stringify(offered));
    check('each entry carries its caption, not a bare number',
      offered.some((t) => t.indexOf('Figure 1-1') === 0 && t.indexOf(CAPTION_A) > 0),
      JSON.stringify(offered));
    check('a long caption is truncated rather than wrapped',
      offered.some((t) => t.indexOf('Figure 1-2') === 0
        && t.length < ('Figure 1-2 · ' + CAPTION_B).length
        && t.slice(-1) === '…'),
      JSON.stringify(offered));
    await page.screenshot({ path: path.join(shots, '1-picker.png') });

    const picked = await pickTarget(page, 'Figure 1-1');
    check('the first figure could be picked', !!picked, 'offered=' + JSON.stringify(offered));
    await settle(page, 300);

    // No click in between: this is the whole point -- the caret must still be
    // in the paragraph, right after the chip.
    await page.keyboard.type(' for the response.');
    await settle(page, 400);

    const afterTyping = await proseState(page);
    check('a chip was inserted', afterTyping.chipCount === 1, JSON.stringify(afterTyping));
    check('it reads as the figure number',
      afterTyping.labels[0] === 'Figure 1-1', JSON.stringify(afterTyping.labels));
    check('what was typed next FOLLOWS it',
      afterTyping.afterFirst.indexOf(' for the response.') === 0,
      'after the chip: ' + JSON.stringify(afterTyping.afterFirst));
    check('and the sentence is still in one piece',
      afterTyping.text.indexOf(SENTENCE + ' See ') === 0,
      JSON.stringify(afterTyping.text));
    await page.screenshot({ path: path.join(shots, '2-inserted.png') });

    const wanted = SENTENCE + ' See <ref:' + FIG_A + '> for the response.';
    const saved = await waitFor(() => paragraph(reportsRoot), (b) => runLine(b) === wanted, 8000);
    check('that is exactly what was saved', runLine(saved) === wanted,
      'on disk: ' + JSON.stringify(runLine(saved)));

    /* ---- 3: it survives a reload ---- */
    section('after a reload');
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('.rw-prose', { timeout: 10000 });
    await settle(page, 500);
    const reloaded = await proseState(page);
    check('the chip is still there, in its place',
      reloaded.chipCount === 1 && reloaded.labels[0] === 'Figure 1-1'
      && reloaded.afterFirst.indexOf(' for the response.') === 0,
      JSON.stringify(reloaded));

    /* ---- 4: a second reference beside the first ---- */
    section('a second reference picked beside the first');
    // Against the pre-fix code there is no chip to pick beside, and the point
    // of a regression test is to REPORT that, not to die on it.
    const haveChip = await page.locator('.rw-prose .rw-ref').count();
    check('there is a first chip to pick beside', haveChip > 0);
    if (haveChip) {
      await page.click('.rw-prose .rw-ref');
      await page.keyboard.press('ArrowRight');
      await settle(page, 200);
      await openPicker(page);
      await pickTarget(page, 'Figure 1-2');
      await settle(page, 400);
    }

    const twoChips = await proseState(page);
    check('there are two chips now', twoChips.chipCount === 2, JSON.stringify(twoChips));
    check('and neither is inside the other', twoChips.nested === 0, JSON.stringify(twoChips));
    check('the words around them survived',
      twoChips.text.indexOf(SENTENCE) === 0
      && twoChips.text.indexOf('for the response.') > 0,
      JSON.stringify(twoChips.text));
    await page.screenshot({ path: path.join(shots, '3-second-ref.png') });

    const both = await waitFor(() => paragraph(reportsRoot),
      (b) => ((b && b.runs) || []).filter((r) => r.ref).length === 2, 8000);
    const refRuns = ((both && both.runs) || []).filter((r) => r.ref);
    check('both references are separate runs on disk',
      refRuns.length === 2 && refRuns[0].ref === FIG_A && refRuns[1].ref === FIG_B,
      'on disk: ' + JSON.stringify(runLine(both)));

    /* ---- 5: the target is deleted ---- */
    section('the figure the first reference points at is deleted');
    await page.click(FIGURE_CARD + ' [title="Delete block"]');
    await settle(page, 600);
    await waitFor(() => readBlocks(reportsRoot),
      (blocks) => !blocks.some((b) => b && b.id === FIG_A), 8000);
    await settle(page, 400);

    const broken = await proseState(page);
    await page.screenshot({ path: path.join(shots, '4-target-deleted.png') });
    check('the broken reference says so',
      broken.labels.indexOf('Reference missing') >= 0, JSON.stringify(broken.labels));
    check('it is not dressed as a live reference',
      broken.bad.some((b) => b), JSON.stringify(broken.bad));
    check('the internal id is nowhere in the text',
      broken.text.indexOf(FIG_A) < 0, JSON.stringify(broken.text));
    check('the id is in the tooltip instead, where it helps',
      broken.titles.some((t) => t.indexOf(FIG_A) >= 0), JSON.stringify(broken.titles));

    const lint = lintReport(reportsRoot);
    const dangling = lint.findings.filter((f) => f.code === 'dangling_ref');
    check('content_lint reports it', dangling.length === 1,
      'codes=' + JSON.stringify(lint.findings.map((f) => f.code)));
    check('as an error', dangling.length === 1 && dangling[0].level === 'error',
      JSON.stringify(dangling));
    check('and the CLI exits 1 on it', lint.code === 1, 'exit=' + lint.code);
    check('it names the paragraph it is in',
      dangling.length === 1 && dangling[0].blockId === PARA_ID, JSON.stringify(dangling));

    /* ---- 6: a card that was never clicked in ---- */
    section('a reference picked without ever putting the caret in the card');
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('.rw-prose', { timeout: 10000 });
    await settle(page, 500);
    const beforeBlind = runLine(paragraph(reportsRoot));
    await openPicker(page);          // straight to the menu, no click in the text
    await pickTarget(page, 'Figure 1-1');
    await settle(page, 500);
    const blind = await waitFor(() => paragraph(reportsRoot),
      (b) => runLine(b) !== beforeBlind, 8000);
    const line = runLine(blind);
    check('the reference is appended at the END of the paragraph',
      line.indexOf(SENTENCE) === 0 && line.slice(-('<ref:' + FIG_B + '>').length)
        === '<ref:' + FIG_B + '>',
      'on disk: ' + JSON.stringify(line));

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
