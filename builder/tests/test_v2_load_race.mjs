#!/usr/bin/env node
// test_v2_load_race.mjs -- a slow load must not land on the screen it missed.
//
// Run:  node builder/tests/test_v2_load_race.mjs
//       node builder/tests/test_v2_load_race.mjs --headed   (watch it)
//
// WHY THIS FILE EXISTS
// --------------------
// boot.js::applyHash carries a generation guard: an address that arrives while
// an earlier one is still waiting on a save wins, and the older call returns
// without touching the screen. loadReport() had no such guard, and it is the
// call that actually replaces the document:
//
//     #/r/A          GET /api/project?dir=A   ... slow
//     #/r/B          GET /api/project?dir=B   ... fast, lands, B is on screen
//                    A finally answers        -> store.setProject(A)
//
// The user is now looking at report A having asked for B, with the route, the
// address bar and the outline all saying B. Every later save is addressed to
// the report the document was READ from, so the next keystroke writes A.
//
// WHAT IT COVERS
//   in a real browser, against a real server, with the first GET held back:
//   two rapid report switches, three times over, always end on the report the
//   user asked for LAST -- checked by the section titles on screen, which are
//   unique per report.
//
// AGAINST THE PRE-FIX boot.js this fails on the first round: the delayed
// report's outline replaces the one the user asked for.
//
// IT NEVER TOUCHES REAL REPORTS: the fixture is generated into a fresh
// directory under the OS temporary directory and the server is booted against
// THAT with an explicit --root.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const SERVER_PY = path.join(REPO, 'builder', 'web', 'server.py');
const PYTHON = process.env.RW_PYTHON || 'python';
const HEADED = process.argv.slice(2).includes('--headed');

process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning && warning.code === 'MODULE_TYPELESS_PACKAGE_JSON') return;
  console.warn(warning && warning.stack ? warning.stack : String(warning));
});

const failures = [];
let count = 0;

async function test(name, fn) {
  count += 1;
  try {
    await fn();
    console.log('  [ok  ] ' + name);
  } catch (err) {
    failures.push(name);
    console.log('  [FAIL] ' + name);
    const detail = (err && err.stack ? err.stack : String(err)).split('\n').slice(0, 8);
    for (const line of detail) console.log('         ' + line);
  }
}

/* ------------------------------------------------------------------ *
 * the fixture: two reports of one module, each with a section title that
 * appears in no other report, so the screen says which one it is showing.
 * ------------------------------------------------------------------ */

const PROJECT_ID = '1108';
const MODULE_ID = 'CLKDIV_5G';
const REPORTS = [
  { dir: PROJECT_ID + '/' + MODULE_ID + '/PDR', stage: 'PDR', marker: 'Marker alpha section' },
  { dir: PROJECT_ID + '/' + MODULE_ID + '/CDR', stage: 'CDR', marker: 'Marker beta section' },
];

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function fixtureReport(entry) {
  return {
    schema_version: 1,
    template: 'sample',
    meta: {
      title: MODULE_ID + ' ' + entry.stage + ' report',
      doc_no: 'DOC-1108-' + entry.stage, version: 'V1.0', secrecy: 'Internal',
      author: 'A. Engineer', date: '2026-08-30',
      reviewers: ['B. Engineer'], approver: 'C. Engineer', revisions: [],
    },
    outline: [
      {
        id: 'n-1', title: entry.marker,
        blocks: [{ type: 'para', cardStart: true,
          runs: [{ t: 'Body text of the ' + entry.stage + ' report.' }] }],
        children: [],
      },
    ],
  };
}

function fixtureConfig() {
  return {
    id: 'sample',
    name: 'Sample template',
    caption_prefix: { image: 'Figure', table: 'Table' },
    skeleton: [],
    cover: { fields: [{ key: 'title', label: 'Title', table: 'info', required: true }] },
    compliance: {
      axis_labels: ['MIN', 'TYP', 'MAX', 'NTWC'],
      setting_kinds: ['common_setting', 'module_setting', 'tb'],
      default_limit: { le: '<= upper', ge: '>= target', range: 'within' },
      flag_color: 'FF0000',
      col_w_cm: { cat: 2.0, item: 3.0, spec: 1.5, axis: 1.4, spacer: 0.2, unit: 1.2 },
      font_pt: 7,
      fills: { header: 'FFF2CC', setting: 'EEECE1', result: 'FFFFFF', separator: 'BFBFBF' },
    },
    free_table: { header_fill: 'D9D9D9' },
    ui_strings: {},
    table_presets: [],
  };
}

function buildRoot(root) {
  writeJson(path.join(root, 'templates', 'sample', 'config.json'), fixtureConfig());
  writeJson(path.join(root, PROJECT_ID, 'project_meta.json'),
    { name: 'Sample project', description: 'Generated fixture' });
  writeJson(path.join(root, PROJECT_ID, MODULE_ID, 'project_meta.json'),
    { name: MODULE_ID, description: 'Divider block' });
  for (const entry of REPORTS) {
    const dir = path.join(root, ...entry.dir.split('/'));
    writeJson(path.join(dir, 'project.json'), fixtureReport(entry));
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
  }
  return root;
}

/* ------------------------------------------------------------------ *
 * server plumbing
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
    if (child.exitCode !== null) {
      throw new Error('the server exited before it answered:\n' + child.log.join(''));
    }
    try {
      if (await httpGet(base + '/api/health') === 200) return;
    } catch (err) { /* not up yet */ }
    if (Date.now() > until) {
      throw new Error('the server did not answer within ' + deadlineMs + 'ms:\n'
        + child.log.join(''));
    }
    await new Promise((r) => setTimeout(r, 120));
  }
}

function startServer(root, port) {
  const config = path.join(root, 'templates', 'sample', 'config.json');
  const child = spawn(PYTHON, [SERVER_PY, '--port', String(port), '--root', root,
    '--config', config], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
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
      try { child.kill('SIGKILL'); } catch (err) { /* gone */ }
      resolve();
    }, 1000);
  });
}

/* ------------------------------------------------------------------ *
 * the race
 * ------------------------------------------------------------------ */

console.log('Report Workbench v2 -- a superseded load lands on the floor');

let chromium = null;
try {
  chromium = require('playwright-core').chromium;
} catch (err) {
  chromium = null;
}

if (!chromium) {
  console.log('\n  SKIP: playwright-core is not installed (npm install, then re-run).');
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-race-'));
  buildRoot(root);
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const server = startServer(root, port);
  let browser = null;
  try {
    await waitForServer(base, server, 20000);
    browser = await chromium.launch({ channel: 'msedge', headless: !HEADED });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const consoleErrors = [];
    const ignored = (url) => /\/favicon\.ico(\?|$)/.test(String(url || ''));
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const where = msg.location && msg.location() ? msg.location().url : '';
      if (where && ignored(where)) return;
      consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(String(err && err.message)));

    // Hold back the read of the FIRST report only. Everything else -- the
    // shelf, the template config, the second report -- answers at full speed,
    // so the slow answer really does arrive after the user has moved on.
    const DELAY_MS = 2500;
    const slow = REPORTS[0];
    await page.route('**/api/project?*', async (route) => {
      const url = route.request().url();
      if (url.indexOf(encodeURIComponent(slow.dir)) >= 0
          || url.indexOf(slow.dir) >= 0) {
        await new Promise((r) => setTimeout(r, DELAY_MS));
      }
      await route.continue();
    });

    await page.goto(base + '/v2#/', { waitUntil: 'load' });
    await page.waitForTimeout(600);

    // Read what the document on screen actually is, by the section title the
    // outline draws. Only the loaded report's marker can be on the page.
    async function markerOnScreen() {
      return page.evaluate((markers) => {
        const text = document.body.innerText || '';
        return markers.filter((m) => text.indexOf(m) >= 0);
      }, REPORTS.map((r) => r.marker));
    }

    for (let round = 1; round <= 3; round++) {
      await test('round ' + round + ': the report asked for last is the one on screen',
        async () => {
          // Start from the shelf so both switches are report-to-report reads.
          await page.evaluate(() => { window.location.hash = '#/'; });
          await page.waitForTimeout(400);

          await page.evaluate((dir) => {
            window.location.hash = '#/r/' + dir.split('/').map(encodeURIComponent).join('/');
          }, REPORTS[0].dir);
          await page.waitForTimeout(250);          // inside the delayed GET
          await page.evaluate((dir) => {
            window.location.hash = '#/r/' + dir.split('/').map(encodeURIComponent).join('/');
          }, REPORTS[1].dir);

          // Wait past the moment the held-back answer arrives.
          await page.waitForTimeout(DELAY_MS + 1500);

          const shown = await markerOnScreen();
          const hash = await page.evaluate(() => window.location.hash);
          assert.deepEqual(shown, [REPORTS[1].marker],
            'the address bar says ' + hash + ' and the screen shows [' + shown + ']');
        });
    }

    await test('the switching raised no console error', () => {
      assert.deepEqual(consoleErrors, [], 'console said: ' + consoleErrors.join(' | '));
    });

    await context.close();
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

console.log('\n' + (failures.length
  ? failures.length + ' of ' + count + ' failed: ' + failures.join(', ')
  : 'all ' + count + ' passed'));
process.exit(failures.length ? 1 : 0);
