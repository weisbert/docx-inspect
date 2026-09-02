#!/usr/bin/env node
'use strict';
/*
 * test_v2_fixed_body_preview.js -- what the paper preview and the standing
 * Check tab say about a section pinned to a body the TEMPLATE owns, and about
 * a table nobody captioned.
 *
 * 1. A PINNED SECTION SHOWS THE WORDS THAT WILL BE EXPORTED.
 *    "Fixed body wins over blocks": the renderer puts the template's paragraphs
 *    on the page and drops the section's own blocks. The preview printed the
 *    raw config KEY as if it were the body text -- a word like "preface" on the
 *    paper that is nowhere in the document -- and showed none of the paragraphs
 *    that actually get exported.
 *
 * 2. A PINNED SECTION IS NOT CHECKED FOR CONTENT IT DOES NOT RENDER.
 *    A section that was pinned after it had been written still carries its old
 *    blocks. They are not in the exported file, so an error about a picture in
 *    one of them is noise the reader cannot act on: the section is pinned,
 *    there is nothing on screen to fix.
 *
 * 3. A KEY THIS TEMPLATE DOES NOT HAVE FALLS BACK TO THE BLOCKS.
 *    Both of the above only hold when the key RESOLVES. When it does not, the
 *    renderer exports the section's own blocks -- so the preview shows them and
 *    the check checks them.
 *
 * 4. AN UNCAPTIONED TABLE IS SAID SO WHILE IT CAN STILL BE FIXED.
 *    The engine warns about one, but only into an export manifest. The standing
 *    check -- the one place it is cheap to fix -- said nothing.
 *
 * The lint mirror is checked against the REAL python linter over the same
 * project, so the two cannot drift apart quietly.
 *
 * Run:  node builder/tests/test_v2_fixed_body_preview.js
 *       node builder/tests/test_v2_fixed_body_preview.js --headed
 *
 * IT NEVER TOUCHES REAL REPORTS. The fixture is generated from scratch into the
 * OS temporary directory and the server is booted against THAT with --root.
 *
 * SKIPPING IS A FEATURE: no playwright-core (the public repository carries no
 * node_modules) or no system browser exits 0 with a note.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const { spawn, spawnSync } = require('node:child_process');

const HERE = __dirname;
const REPO = path.resolve(HERE, '..', '..');
const SERVER_PY = path.join(REPO, 'builder', 'web', 'server.py');
const V2_JS = path.join(REPO, 'builder', 'web', 'assets', 'v2', 'js');

const ARGS = process.argv.slice(2);
const HEADED = ARGS.includes('--headed');
const KEEP_ROOT = ARGS.includes('--keep-root');
const VIEWPORT = { width: 1440, height: 940 };

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

const PROJECT_ID = '1108';
const MODULE_ID = 'CLKDIV_5G';
const REPORT_DIR = PROJECT_ID + '/' + MODULE_ID + '/CDR';

const PINNED = 'Preface';
const STRAY = 'Conventions';
const TABLES = 'Pin list';
const FIXED_KEY = 'preface';
const FIXED_LINE = 'This document is written to the design-stage template.';
const STRAY_LINE = 'Frequencies are given in GHz unless stated otherwise.';
const GONE_PICTURE = 'C:/elsewhere/old-topology.png';

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
    outline: [
      {
        // Pinned to a body this template DOES define, and still carrying the
        // blocks it held before it was pinned -- one of them a picture whose
        // file is not even under images/.
        id: 'n-preface', title: PINNED, fixed_body: FIXED_KEY,
        blocks: [{ type: 'image', id: 'b-old-figure', file: GONE_PICTURE, caption: '' }],
        children: [],
      },
      {
        // Pinned to a body this template does NOT define: the export falls back
        // to these blocks, so they are what the preview and the check are about.
        id: 'n-stray', title: STRAY, fixed_body: 'a-key-this-template-does-not-have',
        blocks: [{ type: 'para', id: 'b-stray', cardStart: true, runs: [{ t: STRAY_LINE }] }],
        children: [],
      },
      {
        id: 'n-tables', title: TABLES,
        blocks: [{
          type: 'table', id: 'b-table-1', header_rows: 1,
          rows: [['Pin', 'Type'], ['VDD', 'supply'], ['CLK', 'input']],
        }],
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
    skeleton: [{ title: PINNED, children: [] }],
    cover: { secrecy_default: 'Internal' },
    styles: {},
    fixed_bodies: {
      [FIXED_KEY]: { style: 'body', paragraphs: [{ runs: [{ t: FIXED_LINE }] }] },
    },
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
  writeJson(path.join(root, PROJECT_ID, 'project_meta.json'), { name: 'Sample project' });
  writeJson(path.join(root, PROJECT_ID, MODULE_ID, 'project_meta.json'), { name: MODULE_ID });
  const reportDir = path.join(root, ...REPORT_DIR.split('/'));
  writeJson(path.join(reportDir, 'project.json'), sampleReport());
  fs.mkdirSync(path.join(reportDir, 'images'), { recursive: true });
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
 * the lint mirror, checked against the linter it mirrors
 * ------------------------------------------------------------------ */

// preview.js is a browser module: it reads the vendor UMD globals as it loads.
// These stubs are only enough for the module body to evaluate; the functions
// under test are pure and touch none of them.
function installBrowserStubs() {
  globalThis.preact = { h: () => null, Fragment: {}, render: () => {} };
  globalThis.preactHooks = {
    useState: () => [null, () => {}],
    useEffect: () => {},
    useLayoutEffect: () => {},
    useRef: () => ({ current: null }),
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useId: () => 'id',
  };
  globalThis.htm = { bind: () => () => null };
}

// The same project through the real python linter -> its finding codes, or null
// when python is not on this machine.
function pythonCodes(project, cfg) {
  const python = process.env.RW_PYTHON || 'python';
  const script = [
    'import json, os, sys',
    'sys.path.insert(0, os.path.join(sys.argv[1], "builder"))',
    'import buildpath',
    'import content_lint as cl',
    'project = json.loads(sys.argv[2])',
    'cfg = json.loads(sys.argv[3])',
    'rep = cl.lint_project(project, cfg)',
    'print(json.dumps(sorted(f["code"] for f in rep.flat)))',
  ].join('\n');
  const done = spawnSync(python,
    ['-c', script, REPO, JSON.stringify(project), JSON.stringify(cfg)],
    { cwd: REPO, encoding: 'utf8' });
  if (done.status !== 0) return null;
  try {
    return JSON.parse(String(done.stdout).trim().split('\n').pop());
  } catch (err) {
    return null;
  }
}

async function staticChecks() {
  installBrowserStubs();
  const mod = await import(pathToFileURL(path.join(V2_JS, 'views', 'preview.js')).href);
  const lintProject = mod.lintProject;
  if (typeof lintProject !== 'function') {
    check('preview.js exports lintProject', false, 'nothing to check the mirror with');
    return;
  }
  const codes = (project, cfg) => (lintProject(project, cfg) || [])
    .map((f) => f.code).sort();

  const cfg = sampleTemplateConfig();
  const project = sampleReport();

  section('the standing check, in the browser');
  const all = codes(project, cfg);
  // ABOUT THE TABLE, not about any block that happens to want a caption: the
  // pinned section holds an uncaptioned picture too, and it is the one thing
  // this check must NOT be satisfied by.
  const aboutTheTable = (p, c) => (lintProject(p, c) || [])
    .filter((f) => f.blockId === 'b-table-1').map((f) => f.code).sort();
  check('a table with no caption is reported',
    aboutTheTable(project, cfg).indexOf('no_caption') >= 0,
    'about the table: ' + JSON.stringify(aboutTheTable(project, cfg)));
  check('the pinned section says nothing about the blocks the export drops',
    all.indexOf('image_path') < 0, 'codes=' + JSON.stringify(all));

  const captioned = JSON.parse(JSON.stringify(project));
  captioned.outline[2].blocks[0].caption = 'Pin list';
  check('and it is silent once the table has one',
    aboutTheTable(captioned, cfg).indexOf('no_caption') < 0,
    'about the table: ' + JSON.stringify(aboutTheTable(captioned, cfg)));

  const noBodies = JSON.parse(JSON.stringify(cfg));
  delete noBodies.fixed_bodies;
  check('a key this template does not have is checked as the blocks it renders',
    codes(project, noBodies).indexOf('image_path') >= 0,
    'codes=' + JSON.stringify(codes(project, noBodies)));

  section('and it agrees with the linter it mirrors');
  for (const [what, p, c] of [['as written', project, cfg],
    ['with the table captioned', captioned, cfg],
    ['with no fixed bodies at all', project, noBodies]]) {
    const theirs = pythonCodes(p, c);
    if (theirs === null) {
      console.log('  SKIP: python could not be run for "' + what + '"');
      continue;
    }
    check('the two lints agree ' + what,
      JSON.stringify(codes(p, c)) === JSON.stringify(theirs),
      'browser: ' + JSON.stringify(codes(p, c)) + '\n         python : '
        + JSON.stringify(theirs));
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
 * driving the page
 * ------------------------------------------------------------------ */

const settle = (page, ms) => page.waitForTimeout(ms == null ? 400 : ms);

const paperText = (page, nodeId) => page.evaluate((id) => {
  const el = document.querySelector('.rw-paper[data-node="' + id + '"]');
  return el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : null;
}, nodeId);

async function browserChecks() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const scratch = path.join(os.tmpdir(), 'report-workbench-v2-fixed-body-preview', stamp);
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
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(String(err && err.message)));
    page.on('dialog', (d) => d.dismiss().catch(() => {}));

    const editorUrl = base + '/#/r/' + REPORT_DIR.split('/').map(encodeURIComponent).join('/');
    await page.goto(editorUrl, { waitUntil: 'load' });
    await settle(page, 1600);

    section('the paper preview');
    const drew = await page.evaluate(() => !!document.querySelector('.rw-paper'));
    if (!drew) {
      check('the paper preview drew a section', false, 'no .rw-paper on screen');
      await page.screenshot({ path: path.join(shots, 'no-paper.png') });
      await context.close();
      return;
    }

    const pinned = await paperText(page, 'n-preface');
    check('a pinned section shows the words the template will export',
      !!pinned && pinned.indexOf(FIXED_LINE) >= 0, 'the sheet reads ' + JSON.stringify(pinned));
    check('and not the config key that names them',
      !!pinned && pinned.indexOf(FIXED_KEY) < 0, 'the sheet reads ' + JSON.stringify(pinned));

    const stray = await paperText(page, 'n-stray');
    check('a key this template does not have falls back to the section\'s blocks',
      !!stray && stray.indexOf(STRAY_LINE) >= 0, 'the sheet reads ' + JSON.stringify(stray));
    check('and that sheet does not print its key either',
      !!stray && stray.indexOf('a-key-this-template-does-not-have') < 0,
      'the sheet reads ' + JSON.stringify(stray));
    await page.screenshot({ path: path.join(shots, 'paper.png') });

    section('the standing check on screen');
    const opened = await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll(
        '.rw-panel [role="tab"], .rw-panel button, .rw-tabs button, [role="tab"]'));
      // The tab carries a badge with the error count when there is one, so its
      // text can read 'Check' or 'Check3' with nothing between them.
      const hit = tabs.find((el) => /^check\d*$/i.test(
        String(el.textContent || '').replace(/\s+/g, ' ').trim()));
      if (!hit) return false;
      hit.click();
      return true;
    });
    await settle(page, 900);
    check('the Check tab opens', opened, 'no tab named Check');
    if (opened) {
      const said = await page.evaluate(() => Array.from(
        document.querySelectorAll('.rw-checklist .rw-check__text'))
        .map((el) => String(el.textContent || '').replace(/\s+/g, ' ').trim()));
      check('the checklist has something to say', said.length > 0, JSON.stringify(said));
      check('it says the table takes no table number without a caption',
        said.some((line) => /table has no caption/i.test(line)), JSON.stringify(said));
      check('and says nothing about the picture the pinned section no longer exports',
        !said.some((line) => line.indexOf('old-topology') >= 0), JSON.stringify(said));
      await page.screenshot({ path: path.join(shots, 'check.png') });
    }

    check('no uncaught error was raised in the page', pageErrors.length === 0,
      pageErrors.slice(0, 3).join(' | '));
    await context.close();
  } finally {
    await cleanup();
  }
}

async function main() {
  console.log('a pinned section, on the paper and in the check');
  await staticChecks();
  if (!chromium) {
    console.log('');
    console.log('  SKIP: ' + chromiumMissing);
  } else {
    await browserChecks();
  }
  console.log('');
  if (failures.length) {
    console.log(failures.length + ' check(s) failed:');
    for (const line of failures) console.log('  - ' + line);
    return 1;
  }
  console.log('fixed body preview: all checks passed');
  return 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
