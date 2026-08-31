#!/usr/bin/env node
'use strict';
/*
 * test_v2_apply_update_shelf.js -- receiving an update package has a front door
 * on the report shelf.
 *
 * Run:  node builder/tests/test_v2_apply_update_shelf.js
 *       node builder/tests/test_v2_apply_update_shelf.js --headed
 *
 * THE DEFECT
 *   The only way to apply a returned package was the exchange pill in a
 *   report's top bar, whose visible text is a relative time ("2 days ago") or
 *   "Never exchanged". Three things were wrong with that, and the third is the
 *   one this file pins:
 *
 *     1. an ACTION named with a STATE -- nobody scanning for "how do I apply
 *        the thing I was sent" reads a timestamp as the way in;
 *     2. filed under a single report, when /api/apply-update takes a package
 *        against the reports ROOT and a package can CREATE reports that do not
 *        exist yet -- it belongs to no report already on the shelf;
 *     3. no presence at all on the screen the work starts from.
 *
 *   The owner's words: "I could not find where Apply update is."
 *
 * WHAT IT ASSERTS, cold-started on the shelf, in a real browser
 *   1. an entry point named `Apply an external update` is VISIBLE and hittable
 *      with a real mouse, with no report open and no menu opened
 *                                                     (fails before the fix)
 *   2. choosing a package file opens the import dialog, and the dialog carries
 *      a REAL manifest -- every member of the archive, by name, with its size,
 *      and the note the package's own update.json carries
 *                                                     (fails before the fix)
 *   3. applying a package that CREATES TWO REPORTS works from the shelf: both
 *      land on disk, and both appear in the shelf's list afterwards with no
 *      manual refresh                                 (fails before the fix)
 *   4. dropping a .zip anywhere on the shelf -- not only on the empty state --
 *      opens the same dialog                          (fails before the fix)
 *   5. the words are the same in both places (shelf button, dialog title), so
 *      there is exactly one name for this in the product
 *
 * A NOTE ON THE MOUSE. Every button here is pressed with page.mouse.move /
 * down / up at the element's own centre, never a synthetic click event, so a
 * control that is off screen, zero-sized or covered fails the test. The file
 * DROP is the one exception the platform forces: an operating-system file drag
 * cannot be produced by playwright's mouse at all, so that one is dispatched as
 * real DragEvents carrying a real File, on the element the mouse would have
 * been over.
 *
 * IT NEVER TOUCHES REAL REPORTS. The fixture is generated from scratch into the
 * OS temporary directory and the server is booted against THAT with an explicit
 * --root, exactly as the other v2 browser tests are.
 *
 * SKIPPING IS A FEATURE: no playwright-core (the public repository carries no
 * node_modules) or no system browser still runs the static half and exits 0.
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
const HOME_JS = path.join(REPO, 'builder', 'web', 'assets', 'v2', 'js', 'views', 'home.js');

const ARGS = process.argv.slice(2);
const HEADED = ARGS.includes('--headed');
const KEEP_ROOT = ARGS.includes('--keep-root');
const VIEWPORT = { width: 1440, height: 900 };

// The one name this thing has. It is the shelf button, and it is the import
// dialog's title, and if those two ever differ the product has two names for
// one action -- which is the defect this file exists for.
const ACTION = 'Apply an external update';
const APPLY_BUTTON = 'Apply the package';
const MANIFEST_HEADING = 'What the package contains';

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
const EXISTING_DIR = PROJECT_ID + '/' + MODULE_ID + '/CDR';

// The package creates a module that does not exist yet, holding two reports.
const NEW_MODULE = 'TXBUF_2G';
const NEW_XDR = PROJECT_ID + '/' + NEW_MODULE + '/XDR';
const NEW_PDR = PROJECT_ID + '/' + NEW_MODULE + '/PDR';
const XDR_TITLE = 'TXBUF_2G XDR draft';
const PDR_TITLE = 'TXBUF_2G PDR draft';
const PACKAGE_NOTE = 'Two new reports for the buffer block';

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function sampleReport(title) {
  return {
    template: 'sample',
    meta: { title: title, doc_no: 'DOC-1', version: 'V1.0' },
    outline: [{
      id: 'n-1',
      title: 'Overview',
      blocks: [{ type: 'para', runs: [{ t: 'First section.' }], cardStart: true }],
      children: [],
    }],
  };
}

function buildReportsRoot(root) {
  fs.mkdirSync(root, { recursive: true });
  writeJson(path.join(root, 'templates', 'sample', 'config.json'),
    { id: 'sample', name: 'Sample template', styles: {} });
  writeJson(path.join(root, PROJECT_ID, 'project_meta.json'),
    { name: PROJECT_ID, description: 'Generated by this test' });
  writeJson(path.join(root, PROJECT_ID, MODULE_ID, 'project_meta.json'),
    { name: MODULE_ID, description: 'Divider block' });
  writeJson(path.join(root, ...EXISTING_DIR.split('/'), 'project.json'),
    sampleReport(MODULE_ID + ' CDR report'));
  return root;
}

// A real smart package: an update.json manifest naming two reports that do not
// exist on this machine, plus their documents. Written by python's zipfile so
// the archive is DEFLATED exactly as a hand-made package is -- the shelf has to
// inflate update.json to show the note, and reading only the central directory
// would not get it.
function buildPackage(file) {
  const projects = {};
  projects[NEW_XDR] = { mode: 'replace' };
  projects[NEW_PDR] = { mode: 'replace' };
  const manifest = { note: PACKAGE_NOTE, projects: projects, files: [] };
  const members = {};
  members['update.json'] = JSON.stringify(manifest, null, 2);
  members[NEW_XDR + '/project.json'] = JSON.stringify(sampleReport(XDR_TITLE), null, 2);
  members[NEW_PDR + '/project.json'] = JSON.stringify(sampleReport(PDR_TITLE), null, 2);

  const script = [
    'import json, sys, zipfile',
    'dest = sys.argv[1]',
    'payload = json.loads(sys.argv[2])',
    'zf = zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED)',
    'for name, text in payload.items(): zf.writestr(name, text)',
    'zf.close()',
  ].join('\n');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const python = process.env.RW_PYTHON || 'python';
  const out = spawnSync(python, ['-c', script, file, JSON.stringify(members)],
    { encoding: 'utf8' });
  if (out.status !== 0) {
    throw new Error('could not build the package: ' + (out.stderr || out.stdout));
  }
  return file;
}

/* ------------------------------------------------------------------ *
 * reporting
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
  const child = spawn(python, [SERVER_PY, '--port', String(port), '--root', root,
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
      try { child.kill('SIGKILL'); } catch (err) { /* already gone */ }
      resolve();
    }, 1000);
  });
}

/* ------------------------------------------------------------------ *
 * driving the page WITH THE MOUSE
 * ------------------------------------------------------------------ */

const settle = (page, ms) => page.waitForTimeout(ms == null ? 350 : ms);

// Every visible element whose own text (or aria-label / title) is exactly the
// wanted string, with the box the mouse would aim at. Only the innermost match
// is kept, so a wrapper never impersonates the button inside it.
function visibleTargets(page, wanted) {
  return page.evaluate((label) => {
    const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    const out = [];
    const all = Array.from(document.querySelectorAll('*'));
    for (const el of all) {
      const own = norm(el.innerText || el.textContent);
      const alt = norm(el.getAttribute('aria-label') || el.getAttribute('title'));
      if (own !== label && alt !== label) continue;
      const deeper = Array.from(el.querySelectorAll('*')).some((kid) => {
        const t = norm(kid.innerText || kid.textContent);
        const a = norm(kid.getAttribute('aria-label') || kid.getAttribute('title'));
        return t === label || a === label;
      });
      if (deeper) continue;
      const box = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      if (box.width < 1 || box.height < 1) continue;
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      const top = document.elementFromPoint(cx, cy);
      out.push({
        tag: el.tagName.toLowerCase(),
        x: cx, y: cy, w: box.width, h: box.height,
        hittable: !!top && (top === el || el.contains(top) || top.contains(el)),
      });
    }
    return out;
  }, wanted);
}

// A real mouse press at the element's centre. No synthetic click events.
async function mouseClick(page, wanted, which) {
  const targets = await visibleTargets(page, wanted);
  const hit = targets.filter((t) => t.hittable)[which || 0];
  if (!hit) return 'nothing visible and hittable reads "' + wanted + '"';
  await page.mouse.move(hit.x, hit.y);
  await page.mouse.down();
  await page.mouse.up();
  await settle(page);
  return 'ok';
}

// The one interaction the mouse cannot produce: an operating-system file drag.
// Real DragEvents, a real DataTransfer, a real File -- dispatched on whatever
// element sits at the given point, which is where the pointer would have been.
async function dropFileAt(page, x, y, name, base64) {
  return page.evaluate((arg) => {
    const target = document.elementFromPoint(arg.x, arg.y);
    if (!target) return 'nothing at that point';
    const binary = atob(arg.base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const file = new File([bytes], arg.name, { type: 'application/zip' });
    const dt = new DataTransfer();
    dt.items.add(file);
    for (const kind of ['dragenter', 'dragover', 'drop']) {
      target.dispatchEvent(new DragEvent(kind, {
        bubbles: true, cancelable: true, composed: true, dataTransfer: dt,
      }));
    }
    return 'ok on ' + target.tagName.toLowerCase()
      + '.' + String(target.className || '').split(' ')[0];
  }, { x: x, y: y, name: name, base64: base64 });
}

function pageText(page) {
  return page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
}

async function waitForText(page, needle, timeoutMs) {
  const until = Date.now() + (timeoutMs == null ? 8000 : timeoutMs);
  for (;;) {
    if ((await pageText(page)).indexOf(needle) >= 0) return true;
    if (Date.now() > until) return false;
    await page.waitForTimeout(150);
  }
}

/* ------------------------------------------------------------------ *
 * static checks -- these need no browser
 * ------------------------------------------------------------------ */

function staticChecks() {
  section('the shelf owns the entry point, and reuses the dialog');
  const src = fs.readFileSync(HOME_JS, 'utf8');

  check('home.js names the action with the frozen string, not a timestamp',
    src.indexOf(ACTION) >= 0,
    'home.js does not contain "' + ACTION + '"');

  check('home.js mounts sync.js\'s ImportDialog rather than a second one',
    /from\s+'\.\/sync\.js'/.test(src) && src.indexOf('ImportDialog') >= 0,
    'no ImportDialog imported from ./sync.js');

  check('home.js never names a path under the private directory',
    !/local\//.test(src));
}

/* ------------------------------------------------------------------ *
 * the run
 * ------------------------------------------------------------------ */

async function browserChecks() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const scratch = path.join(os.tmpdir(), 'report-workbench-v2-apply-shelf', stamp);
  const reportsRoot = path.join(scratch, 'reports');
  const shots = path.join(scratch, 'screens');
  fs.mkdirSync(shots, { recursive: true });
  buildReportsRoot(reportsRoot);
  const pkgFile = buildPackage(path.join(scratch, 'inbox', 'returned_update.zip'));
  const pkgB64 = fs.readFileSync(pkgFile).toString('base64');
  console.log('  fixture: ' + reportsRoot);
  console.log('  package: ' + pkgFile);

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
    const consoleErrors = [];
    page.on('console', (msg) => {
      const where = msg.location && msg.location() ? String(msg.location().url) : '';
      if (msg.type() === 'error' && where.indexOf('favicon') < 0) {
        consoleErrors.push(msg.text().slice(0, 200));
      }
    });
    page.on('pageerror', (err) => consoleErrors.push('uncaught: ' + String(err && err.message)));

    /* ---- 1. cold start on the shelf ---- */

    section('1 - the front door is on the shelf, cold, with nothing opened');
    await page.goto(base + '/#/', { waitUntil: 'load' });
    await settle(page, 1200);
    await page.screenshot({ path: path.join(shots, '1-shelf.png') });

    const doors = await visibleTargets(page, ACTION);
    const hittable = doors.filter((d) => d.hittable);
    check('"' + ACTION + '" is on screen without opening a report or a menu',
      doors.length > 0,
      'the shelf shows no control reading "' + ACTION + '"');
    check('and a real mouse can reach it', hittable.length > 0,
      doors.length
        ? 'it is on screen but nothing can be pressed at its centre'
        : 'there is nothing to press');

    /* ---- 2. choosing a package opens the dialog, with a real manifest ---- */

    section('2 - choosing a package opens the import dialog');
    let opened = false;
    if (hittable.length) {
      const chooserPromise = page.waitForEvent('filechooser', { timeout: 6000 })
        .catch(() => null);
      const pressed = await mouseClick(page, ACTION);
      check('the entry point takes a mouse press', pressed === 'ok', pressed);
      const chooser = await chooserPromise;
      check('pressing it asks for a file', !!chooser, 'no file chooser opened within 6s');
      if (chooser) {
        await chooser.setFiles(pkgFile);
        opened = await waitForText(page, MANIFEST_HEADING, 8000);
      }
    }
    await page.screenshot({ path: path.join(shots, '2-dialog.png') });
    check('the import dialog opens', opened, 'the manifest heading never appeared');

    if (opened) {
      const text = await pageText(page);
      check('the dialog is titled with the SAME words as the shelf button',
        text.indexOf(ACTION) >= 0);
      check('the manifest lists both documents the package carries',
        text.indexOf(NEW_XDR + '/project.json') >= 0
        && text.indexOf(NEW_PDR + '/project.json') >= 0,
        'manifest rows are missing from: ' + text.slice(0, 400));
      check('the package own note is read out of its update.json',
        text.indexOf(PACKAGE_NOTE) >= 0,
        'the note never reached the screen -- update.json was not inflated');
      // The before/after summary and its "nothing has been written yet" caveat
      // belong to the per-report merge path, where there IS one report to count
      // before and after. A root package has no single before -- the reports it
      // creates do not exist to be counted -- so what the dialog owes here is
      // the package's own facts and the promise that the button is the only
      // thing that writes.
      check('the dialog names the package it is about to apply',
        text.indexOf('returned_update.zip') >= 0,
        'the package name is not on screen');
      check('and nothing has been applied until the button is pressed',
        text.indexOf(APPLY_BUTTON) >= 0
        && !fs.existsSync(path.join(reportsRoot, ...NEW_XDR.split('/'), 'project.json')),
        'the package was written before anyone pressed anything');
    }

    /* ---- 3. applying it creates two reports, and the shelf shows them ---- */

    section('3 - applying it from the shelf creates two reports');
    if (opened) {
      const pressed = await mouseClick(page, APPLY_BUTTON);
      check('the dialog offers "' + APPLY_BUTTON + '"', pressed === 'ok', pressed);
      if (pressed === 'ok') await waitForText(page, XDR_TITLE, 12000);
    }
    await settle(page, 600);
    await page.screenshot({ path: path.join(shots, '3-after-apply.png') });

    const onDisk = (rel) =>
      fs.existsSync(path.join(reportsRoot, ...rel.split('/'), 'project.json'));
    check('the package created ' + NEW_XDR + ' on disk', onDisk(NEW_XDR));
    check('the package created ' + NEW_PDR + ' on disk', onDisk(NEW_PDR));

    const after = await pageText(page);
    check('both new reports appear on the shelf with no manual refresh',
      after.indexOf(XDR_TITLE) >= 0 && after.indexOf(PDR_TITLE) >= 0,
      'the shelf still reads: ' + after.slice(0, 300));

    /* ---- 4. a .zip dropped anywhere on the shelf ---- */

    section('4 - a .zip dropped on the shelf, not only on the empty state');
    await page.goto(base + '/#/', { waitUntil: 'load' });
    await settle(page, 1200);
    // Aim at the report table, which is the busiest part of the shelf and the
    // part that is NOT the empty state's drop target.
    const spot = await page.evaluate(() => {
      const list = document.querySelector('.rw-rows') || document.querySelector('.rw-home__list');
      if (!list) return null;
      const box = list.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + Math.min(60, box.height / 2) };
    });
    check('the report table is on screen to drop onto', !!spot);
    if (spot) {
      const where = await dropFileAt(page, spot.x, spot.y, 'returned_update.zip', pkgB64);
      console.log('  dropped ' + where);
      const reopened = await waitForText(page, MANIFEST_HEADING, 8000);
      await page.screenshot({ path: path.join(shots, '4-after-drop.png') });
      check('dropping a .zip on the shelf opens the same dialog', reopened,
        'no import dialog after the drop');
      if (reopened) {
        check('and it is the same dialog, with the same name',
          (await pageText(page)).indexOf(ACTION) >= 0);
      }
    }

    /* ---- 5. the empty state answers a dropped .zip the same way ---- */

    section('5 - the empty state takes a .zip too, not only a .docx');
    await page.keyboard.press('Escape');
    await settle(page, 300);
    await page.fill('.rw-search .rw-input', 'nothing matches this');
    await settle(page, 400);
    const emptySpot = await page.evaluate(() => {
      const box = document.querySelector('.rw-empty');
      if (!box) return null;
      const r = box.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + 8 };
    });
    check('the empty state is on screen', !!emptySpot,
      'no .rw-empty after a search that matches nothing');
    if (emptySpot) {
      const where = await dropFileAt(page, emptySpot.x, emptySpot.y,
        'returned_update.zip', pkgB64);
      console.log('  dropped ' + where);
      check('a .zip dropped on the empty state opens the import dialog',
        await waitForText(page, MANIFEST_HEADING, 8000),
        'no import dialog after the empty-state drop');
      // One drop, one dialog: the empty state answers first and the shelf
      // behind it must not read the same file a second time.
      const scrims = await page.evaluate(() => document.querySelectorAll('.rw-scrim').length);
      check('one drop opens exactly one dialog', scrims === 1,
        scrims + ' scrims are on screen');
    }

    if (consoleErrors.length) {
      check('no console errors', false, consoleErrors.slice(0, 4).join(' | '));
    } else {
      console.log('  [ok  ] no console errors');
    }

    await context.close();
  } finally {
    await cleanup();
  }
}

async function main() {
  staticChecks();

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
