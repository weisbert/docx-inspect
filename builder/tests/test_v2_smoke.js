#!/usr/bin/env node
'use strict';
/*
 * test_v2_smoke.js -- open every screen of the v2 interface in a real browser
 * and assert that it renders, quietly.
 *
 * Run:  node builder/tests/test_v2_smoke.js
 *       node builder/tests/test_v2_smoke.js --headed        (watch it work)
 *       node builder/tests/test_v2_smoke.js --keep-root      (leave the fixture on disk)
 *
 * WHAT IT CHECKS, PER SCREEN
 *   * zero console errors and zero uncaught page errors
 *   * zero failed network requests (any response >= 400, and any request the
 *     browser could not complete at all)
 *   * the screen's key element is on the page
 *   * none of the eleven cut features from 00_INDEX.md section 4 has come back
 *   * no horizontal scroll at 1440px, the one width this tool targets
 *   * a screenshot, saved for a human to look at
 * and once, before the first screen: that the shell actually mounted -- #app
 * has element children and index.html's start-up failure panel is not showing.
 *
 * WHAT IT CHECKS BEFORE THE BROWSER STARTS
 *   * the cut-feature rules still catch their own examples and still leave the
 *     copy that survived alone. A scan that matches nothing would pass a screen
 *     full of cut features, so it is checked rather than trusted.
 *   * the fixture root is a fresh directory in the OS temporary directory.
 *
 * IT NEVER TOUCHES REAL REPORTS. The fixture below is generated from scratch
 * into a temporary directory -- a small neutral report with prose, a figure, a
 * plain table and a compliance table carrying one deliberate over-spec value --
 * and the server is booted against THAT with an explicit --root. The server's
 * own default root is a sibling folder of real work, so --root is not optional
 * here; it is the safety rule this file is built around.
 *
 * THE FIXTURE HAS TO BE A REPORT THE PRODUCT COULD HAVE WRITTEN. It carries
 * schema_version 1 and a complete template config, because Export and the
 * section proof render both go through the engine. An almost-report makes the
 * engine answer 400 or 500 and reads like a server bug when it is not one.
 *
 * SKIPPING IS A FEATURE. The public repository carries no node_modules, so a
 * missing playwright-core (or a machine with no Edge to drive) exits 0 with a
 * one-line explanation instead of failing a suite that has nothing wrong with
 * it. Any other problem is a real failure and exits non-zero.
 *
 * The browser is the system Edge -- channel 'msedge' -- so nothing is ever
 * downloaded.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');

const HERE = __dirname;                                   // builder/tests
const REPO = path.resolve(HERE, '..', '..');              // repository root
const SERVER_PY = path.join(REPO, 'builder', 'web', 'server.py');

const ARGS = process.argv.slice(2);
const HEADED = ARGS.includes('--headed');
const KEEP_ROOT = ARGS.includes('--keep-root');
const VIEWPORT = { width: 1440, height: 900 };

/* ------------------------------------------------------------------ *
 * skip cleanly when the tooling is not installed
 * ------------------------------------------------------------------ */

let chromium = null;
try {
  chromium = require('playwright-core').chromium;
} catch (err) {
  console.log('SKIP: playwright-core is not installed.');
  console.log('      This repository does not carry node_modules. To run the browser');
  console.log('      smoke test:  npm install     (then re-run this file)');
  process.exit(0);
}

/* ------------------------------------------------------------------ *
 * the fixture: a neutral report, generated, never copied from real work
 * ------------------------------------------------------------------ */

// A 160x90 checkerboard, so a figure block has something real to load and the
// image route is genuinely exercised.
const SAMPLE_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAKAAAABaCAAAAAAarQKOAAAAaUlEQVR42u3XsREAQARFQWVficq6jBa+mRWKNuNVz7yZpF0B' +
  'AgICAoYDM1m7AwQEBARMB7rFgICAgICaBBAQEBBQk3gWAAEBATWJZwEQEBBQk7jFgICAgICaBBAQEBBQk3gWAAEBAY8BP3KI' +
  'Kg5OSOamAAAAAElFTkSuQmCC';

const PROJECT_ID = '1108';
const MODULE_ID = 'CLKDIV_5G';
const REPORT_DIR = PROJECT_ID + '/' + MODULE_ID + '/CDR';
const SECOND_DIR = PROJECT_ID + '/' + MODULE_ID + '/PDR';

// Section titles the screen probes click on. Neutral, and stable.
const SECTION_PROSE = 'Design description';
const SECTION_TABLE = 'Simulation results';

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function para(text, cardStart) {
  const block = { type: 'para', runs: [{ t: text }] };
  if (cardStart) block.cardStart = true;
  return block;
}

function sampleReport(stage) {
  return {
    // The engine refuses a project without this (core/engine.py rejects any
    // schema_version other than 1), and every report the server creates carries
    // it. A fixture without it is not a report the product could ever have
    // written, so leaving it out made the render endpoints answer 400 -- a
    // fixture fault, not a product one.
    schema_version: 1,
    template: 'sample',
    meta: {
      title: MODULE_ID + ' ' + stage + ' report',
      doc_no: 'DOC-' + PROJECT_ID + '-' + stage,
      version: 'V1.0',
      secrecy: 'Internal',
      author: 'A. Engineer',
      date: '2026-08-30',
      reviewers: ['B. Engineer'],
      approver: 'C. Engineer',
      revisions: [{ ver: 'V1.0', date: '2026-08-30', author: 'A. Engineer', note: 'First issue' }],
    },
    outline: [
      {
        id: 'n-overview',
        title: 'Overview',
        blocks: [
          para('This report covers the ' + MODULE_ID + ' divider at the ' + stage + ' stage.', true),
          para('It is a generated sample. Nothing in it describes real hardware.'),
        ],
        children: [],
      },
      {
        id: 'n-design',
        title: SECTION_PROSE,
        blocks: [
          para('The divider takes a differential input and produces a divided clock.', true),
          para('The second paragraph of the same card, so prose grouping has something to group.'),
          {
            type: 'image',
            id: 'b-figure-1',
            file: 'images/divider_response.png',
            caption: 'Divider output over temperature',
            width_cm: 8,
          },
        ],
        children: [
          {
            id: 'n-design-detail',
            title: 'Clock path',
            blocks: [para('A subsection, so the outline has more than one level.', true)],
            children: [],
          },
        ],
      },
      {
        id: 'n-results',
        title: SECTION_TABLE,
        blocks: [
          para('The table below lists the simulated values against the spec.', true),
          {
            type: 'datatable',
            id: 'b-compliance-1',
            caption: 'Divider performance against spec',
            data: {
              spec_name: MODULE_ID + ' spec',
              sims: [{ key: 'typ', title: MODULE_ID + ' run', stage: stage, axes: ['MIN', 'TYP', 'MAX'] }],
              rows: [
                {
                  cat: 'Conditions', item: 'Temperature', kind: 'common_setting', unit: 'degC',
                  limit: null, spec_mtm: [-40, 25, 125], sim_mtm: [-40, 25, 125],
                  spec_ntwc: null, sim_ntwc: null, sim_span: false,
                },
                {
                  cat: 'Conditions', item: 'Supply', kind: 'common_setting', unit: 'V',
                  limit: null, spec_mtm: [0.78, 0.8, 0.82], sim_mtm: [0.78, 0.8, 0.82],
                  spec_ntwc: null, sim_ntwc: null, sim_span: false,
                },
                {
                  cat: 'Performance', item: 'Output duty cycle', kind: 'result', unit: '%',
                  limit: 'le', spec_mtm: [48, 50, 52], sim_mtm: [48.6, 50.1, 51.2],
                  spec_ntwc: null, sim_ntwc: null, sim_span: false,
                },
                {
                  // Deliberately outside its spec: the one verdict this tool has
                  // is "this value violates its spec, so it is red".
                  cat: 'Performance', item: 'Current', kind: 'result', unit: 'mA',
                  limit: 'le', spec_mtm: [null, null, 4.0], sim_mtm: [3.1, 3.6, 4.8],
                  spec_ntwc: null, sim_ntwc: null, sim_span: false,
                },
              ],
            },
          },
          {
            type: 'table',
            id: 'b-table-1',
            caption: 'Pin list',
            header_rows: 1,
            rows: [
              ['Pin', 'Direction', 'Note'],
              ['CK_IN', 'input', 'differential'],
              ['CK_OUT', 'output', 'divided clock'],
            ],
          },
        ],
        children: [],
      },
      {
        id: 'n-summary',
        title: 'Summary',
        blocks: [para('One item is outside its spec and is marked in the table above.', true)],
        children: [],
      },
    ],
  };
}

// The template config the server hands to the interface AND to the engine.
//
// It has to be complete, not a stub of the /api/config slice. Anything that
// puts a document on screen or on disk -- Export, and the section proof render --
// goes through core/engine.py, which reads the style block directly: an empty
// `styles` made the render endpoints answer 500 with a bare KeyError. So this is
// a full, renderable, ASCII-only, neutral config; nothing here is copied from a
// real template, and none of the numbers describe anything but paper.
function sampleTemplateConfig() {
  return {
    id: 'sample',
    name: 'Sample template',
    // Keyed by block type, which is what the engine looks up.
    caption_prefix: { image: 'Figure', table: 'Table' },
    toc: {
      title: 'Contents',
      field: 'TOC \\o "1-3" \\h \\z \\u',
      placeholder: '(update field)',
      size_pt: 20,
    },
    logo: '',
    skeleton: [
      { title: 'Overview', children: [] },
      { title: SECTION_PROSE, children: [{ title: 'Clock path' }] },
      { title: SECTION_TABLE, children: [] },
      { title: 'Summary', children: [] },
    ],
    cover: {
      company_line: 'ACME',
      secrecy_default: 'Internal',
      page_count_field: true,
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
          cols_cm: [3.0, 3.0, 4.0, 3.0, 3.0],
          outer: 'double', inner: 'single', sz: 14,
          labels: { title: 'Project', doc_no: 'Code', secrecy: 'Secrecy', pages: 'Pages' },
        },
        signature: {
          cols_cm: [3.0, 3.0, 1.0, 3.0, 3.0],
          rows: [['Author', ''], ['Checked by', ''], ['Approver', '']],
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
    styles: {
      page: {
        w_cm: 21.0, h_cm: 29.7, margin_cm: 2.5,
        header_dist_cm: 1.2, footer_dist_cm: 1.2,
        different_first_page: true,
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
        cols_cm: [1.5, 12.0, 2.5],
        row_h_twips: 751,
        cell_bottom_border: { val: 'single', sz: 6, color: 'auto' },
        logo_cm: 1.13,
        title_font: { ascii: 'Arial', eastAsia: 'Arial', size_pt: 9 },
        title_placeholder: 'Report Title',
        secrecy_label: 'Internal',
      },
      footer_table: {
        cols_cm: [5.0, 6.0, 5.0],
        top_border: { val: 'single', sz: 4 },
        date_format: 'yyyy-MM-dd',
        center_text: '',
        page_text: ['', ' / ', ''],
        font: { ascii: 'Arial', size_pt: 9 },
      },
      colors: { red: 'FF0000', secrecy: '4F81BD' },
    },
    compliance: {
      axis_labels: ['MIN', 'TYP', 'MAX', 'NTWC'],
      setting_kinds: ['common_setting', 'module_setting', 'tb'],
      default_limit: { le: '<= upper', ge: '>= target', range: 'within' },
      flag_color: 'FF0000',
      col_w_cm: { cat: 2.0, item: 3.0, spec: 1.5, axis: 1.4, spacer: 0.2, unit: 1.2 },
      font_pt: 7,
      row_h_pt: { header: 12, data: 10 },
      fills: { header: 'FFF2CC', setting: 'F2EFE9', result: 'FFFFFF', separator: 'BFBFBF' },
      borders: { val: 'single', sz: 4, color: '000000' },
    },
    free_table: {
      header_fill: 'FFF2CC',
      border: { val: 'single', sz: 4, color: '000000' },
    },
    fixed_bodies: {},
    ui_strings: {},
    table_presets: [
      {
        key: 'performance',
        label: 'Performance table',
        base: 'compliance',
        caption: 'Performance against spec',
        sims: [{ key: 'typ', title: 'Run', stage: 'CDR', axes: ['MIN', 'TYP', 'MAX'] }],
        setting_rows: [{ cat: 'Conditions', item: 'Temperature', kind: 'common_setting', unit: 'degC' }],
        result_rows: [{ cat: 'Performance', item: 'Output duty cycle', kind: 'result', unit: '%' }],
      },
    ],
  };
}

function buildReportsRoot(root) {
  fs.mkdirSync(root, { recursive: true });

  writeJson(path.join(root, 'templates', 'sample', 'config.json'), sampleTemplateConfig());
  writeJson(path.join(root, 'templates', 'sample', 'skeleton.json'), sampleTemplateConfig().skeleton);

  writeJson(path.join(root, PROJECT_ID, 'project_meta.json'),
    { name: 'Sample project', description: 'Generated by the v2 smoke test' });
  writeJson(path.join(root, PROJECT_ID, MODULE_ID, 'project_meta.json'),
    { name: MODULE_ID, description: 'Divider block' });

  const reportDir = path.join(root, ...REPORT_DIR.split('/'));
  const report = sampleReport('CDR');
  writeJson(path.join(reportDir, 'project.json'), report);

  // A baseline that differs from the report, so the exchange screen has both a
  // last-exchange time and something to report as changed since.
  const baseline = JSON.parse(JSON.stringify(report));
  baseline.outline[0].blocks[1].runs[0].t = 'The sentence this machine has since rewritten.';
  writeJson(path.join(reportDir, '_baseline.json'), baseline);

  fs.mkdirSync(path.join(reportDir, 'images'), { recursive: true });
  fs.writeFileSync(path.join(reportDir, 'images', 'divider_response.png'),
    Buffer.from(SAMPLE_PNG_B64, 'base64'));

  // A second report in the same module: the shelf needs more than one row, and
  // an earlier stage is what a reference column would be pulled from.
  const second = path.join(root, ...SECOND_DIR.split('/'));
  writeJson(path.join(second, 'project.json'), sampleReport('PDR'));
  fs.mkdirSync(path.join(second, 'images'), { recursive: true });

  return root;
}

/* ------------------------------------------------------------------ *
 * server lifecycle
 * ------------------------------------------------------------------ */

// An unused port, taken from the OS rather than guessed, so parallel test runs
// and the owner's own server on 8765 cannot collide with this one.
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
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
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
    } catch (err) {
      /* not up yet */
    }
    if (Date.now() > until) throw new Error('the server did not answer within ' + deadlineMs + 'ms');
    await new Promise((r) => setTimeout(r, 120));
  }
}

function startServer(root, port) {
  const python = process.env.RW_PYTHON || 'python';
  const config = path.join(root, 'templates', 'sample', 'config.json');
  const child = spawn(python, [SERVER_PY, '--port', String(port), '--root', root, '--config', config], {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const log = [];
  child.stdout.on('data', (chunk) => log.push(chunk));
  child.stderr.on('data', (chunk) => log.push(chunk));
  child.on('error', (err) => log.push('spawn failed: ' + err.message + '\n'));
  child.log = log;
  return child;
}

function stopServer(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => resolve();
    child.once('exit', done);
    try {
      child.kill();
    } catch (err) {
      return resolve();
    }
    // A server that ignores the first signal gets one second, then SIGKILL, so
    // this file never leaves a process holding a port.
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (err) {
        /* already gone */
      }
      resolve();
    }, 1000);
  });
}

/* ------------------------------------------------------------------ *
 * page helpers -- all text-based, because the views share no test-id scheme
 * ------------------------------------------------------------------ */

const settle = (page, ms) => page.waitForTimeout(ms == null ? 350 : ms);

// Click the first visible element whose own text is `label`. Deliberately not
// selector-based: six views are written independently, and their shared
// vocabulary is the frozen string list, not a class name.
// `options.within` narrows the search to one region: `Expand` is a word two
// different controls use (the asset tray and the collapsed right panel), so the
// asset screen says which one it means instead of hoping about DOM order.
async function clickText(page, label, options) {
  const exact = !!(options && options.exact);
  const within = (options && options.within) || null;
  const clicked = await page.evaluate((arg) => {
    const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    const wanted = norm(arg.label);
    let scope = document;
    if (arg.within) {
      const found = document.querySelector(arg.within);
      if (!found) return false;
      scope = found;
    }
    const nodes = Array.from(scope.querySelectorAll(
      'button, a, summary, label, li, [role="button"], [role="tab"], [role="menuitem"], ' +
      '[role="option"], [role="link"], [tabindex]'
    ));
    let hit = null;
    for (const el of nodes) {
      const own = norm(el.innerText || el.textContent);
      const alt = norm(el.getAttribute('aria-label') || el.getAttribute('title'));
      const text = own || alt;
      const match = arg.exact
        ? (text === wanted || alt === wanted)
        : (text === wanted || alt === wanted || text.indexOf(wanted) >= 0);
      if (!match) continue;
      const box = el.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      // Prefer the innermost match, so a row wrapping a button does not swallow it.
      if (!hit || hit.contains(el)) hit = el;
    }
    if (!hit) return false;
    hit.scrollIntoView({ block: 'center', inline: 'nearest' });
    hit.click();
    return true;
  }, { label: label, exact: exact, within: within });
  if (clicked) await settle(page);
  return clicked;
}

// Poll a condition instead of sleeping longer everywhere: a view that paints
// after its first fetch is fine, a view that never paints still fails.
async function waitUntil(check, timeoutMs) {
  const until = Date.now() + (timeoutMs == null ? 2500 : timeoutMs);
  for (;;) {
    if (await check()) return true;
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function pageText(page) {
  return page.evaluate(() => {
    const body = document.body;
    return String((body && body.innerText) || '').replace(/\s+/g, ' ');
  });
}

async function hasText(page, needle) {
  const text = await pageText(page);
  return text.indexOf(String(needle).replace(/\s+/g, ' ')) >= 0;
}

// Same, with every space removed on both sides. A file name shown with a
// middle truncation is split across two elements, so `divider_response.png`
// reaches innerText as `divider_respon se.png`. The name is on screen; only the
// whitespace is an artefact of how it is drawn.
async function hasTightText(page, needle) {
  const text = (await pageText(page)).replace(/\s+/g, '');
  return text.indexOf(String(needle).replace(/\s+/g, '')) >= 0;
}

async function visibleCount(page, selector) {
  return page.evaluate((sel) => {
    let nodes;
    try {
      nodes = Array.from(document.querySelectorAll(sel));
    } catch (err) {
      return 0;
    }
    return nodes.filter((el) => {
      const box = el.getBoundingClientRect();
      return box.width > 0 || box.height > 0;
    }).length;
  }, selector);
}

// Horizontal overflow, measured against the layout width this tool targets. A
// vertical scrollbar narrowing the client box is not overflow; content wider
// than 1440 is, and the widest offenders are named so the failure is actionable.
async function horizontalOverflow(page, width) {
  return page.evaluate((limit) => {
    const doc = document.documentElement;
    const scrollWidth = Math.max(doc.scrollWidth, document.body ? document.body.scrollWidth : 0);
    if (scrollWidth <= limit + 1) return null;
    const offenders = [];
    const nodes = document.querySelectorAll('body *');
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      const box = el.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      if (box.right > limit + 1) {
        const id = el.id ? '#' + el.id : '';
        const cls = el.className && typeof el.className === 'string'
          ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
          : '';
        offenders.push(el.tagName.toLowerCase() + id + cls + ' (right ' + Math.round(box.right) + ')');
      }
      if (offenders.length >= 4) break;
    }
    return { scrollWidth: scrollWidth, offenders: offenders };
  }, width);
}

/* ------------------------------------------------------------------ *
 * the eleven cut features
 * ------------------------------------------------------------------ *
 * 00_INDEX.md section 4 lists eleven things the design prototype still draws
 * and the owner removed. They come back by accident, because the prototype is
 * the most detailed picture of the product anyone has. So every screen is read
 * for them, and finding one is a failure like any other.
 *
 * Each rule is written to catch the cut feature WITHOUT catching the thing that
 * survived next to it. The two that are easy to get wrong:
 *   * `Empty` is a legend word in the outline rail (a section with no content),
 *     and stays. What is gone is `empty` as a verdict a value can carry, which
 *     shows up as a COUNT -- `3 empty`, `2 unjudged`.
 *   * a percentage during an export ("Rendering Word ... 40%") is specified and
 *     stays. What is gone is a percentage of the report being FINISHED.
 * `allowed` below is the standing proof of that distinction: it is real copy
 * from the frozen glossary, and the self-check refuses to let any rule match it.
 */

const CUT_FEATURES = [
  {
    what: 'a verdict badge, verdict counter or verdict filter',
    bad: [/\bverdicts?\b/i, /\bpass\s*\/\s*fail\b/i, /\bfilter by verdict\b/i,
          /\b\d+\s+(passed|passing|unjudged|not judged|unknown|empty)\b/i,
          /\b(unjudged|not judged)\b/i],
    sample: ['Verdict', '2 unjudged', '3 empty', 'pass / fail', 'Filter by verdict'],
  },
  {
    what: 'a completion percentage or a progress ring',
    bad: [/\bcompletion\b/i, /\bprogress ring\b/i,
          /\b\d{1,3}\s*%\s*(complete|done|filled|of the report)\b/i],
    sample: ['Completion', '62% complete', 'progress ring'],
  },
  {
    what: 'a to-do tab or a next-step jump',
    bad: [/\bto-?dos?\b/i, /\bnext step\b/i],
    sample: ['To-do', 'todo', 'Next step'],
  },
  {
    what: 'an empty slot card driven by template slots',
    bad: [/\bempty slot\b/i, /\btemplate slots?\b/i, /\bslot card\b/i],
    sample: ['Empty slot', 'Template slot', 'slot card'],
  },
  {
    what: 'a paste column-mapping dialog',
    bad: [/\bcolumn mapping\b/i, /\bmap (the )?columns\b/i, /\bmatch columns\b/i,
          /\bwhich column is\b/i],
    sample: ['Column mapping', 'Map the columns', 'Match columns', 'Which column is the spec?'],
  },
  {
    what: 'a corner expansion or worst-corner control',
    bad: [/\bexpand corners?\b/i, /\bprocess corners?\b/i, /\bworst corner\b/i,
          /\b\d+\s+corners\b/i, /\bcorner view\b/i],
    sample: ['Expand corners', '9 process corners', 'Worst corner only', 'corner view'],
  },
  {
    what: 'a finished-look strip under a wide table',
    bad: [/\bfinished look\b/i, /\bfinal look\b/i, /\bword look\b/i],
    sample: ['Finished look', 'Word look'],
  },
  {
    what: 'a template editing screen',
    bad: [/\bedit (the )?template\b/i, /\btemplate editor\b/i],
    sample: ['Edit template', 'Template editor'],
  },
  {
    what: 'a flag-as-doubtful mark',
    bad: [/\bdoubtful\b/i, /\bflag as\b/i],
    sample: ['Flag as doubtful'],
  },
  {
    what: 'continuous read as its own mode',
    bad: [/\bcontinuous read\b/i, /\bread mode\b/i, /\bunread paragraphs?\b/i],
    sample: ['Continuous read', 'Read mode', '4 unread paragraphs'],
  },
  {
    what: 'an appendix of raw per-corner values',
    bad: [/\bappendix\b/i, /\braw per-corner\b/i, /\braw corner values\b/i],
    sample: ['Appendix', 'Raw corner values'],
  },
];

// Class names of ours that would only exist to draw a cut feature. Only `rw-`
// classes are read: the spreadsheet vendor ships a `.corner` handle of its own,
// and that is not ours to judge.
const CUT_CLASS_RE = /^rw-[a-z0-9-]*(verdict|todo|doubtful|completion|slot|progressring)/i;

// Pure, so it can be checked without a browser.
function cutFeatureHits(text, classNames) {
  const flat = String(text || '').replace(/\s+/g, ' ');
  const hits = [];
  for (const rule of CUT_FEATURES) {
    for (const re of rule.bad) {
      const found = flat.match(re);
      if (found) {
        hits.push(rule.what + ': "' + String(found[0]).slice(0, 60) + '"');
        break;
      }
    }
  }
  for (const name of classNames || []) {
    if (CUT_CLASS_RE.test(name)) hits.push('a class drawing a cut feature: .' + name);
  }
  return hits;
}

// Copy that is specified and must never be mistaken for a cut feature. Every
// line is from 02_GLOSSARY_EN.md or a spec's own diagram.
const CUT_ALLOWED_SAMPLE = [
  'Filled In progress Empty Over spec',
  '1 over spec',
  'Nothing to fix',
  'Errors Warnings Notes',
  '4 rows 1 over spec',
  'Matched 3 of 5 rows by item name unmatched rows are left empty, never guessed',
  'Rendering Word block 3 of 15 (Summary) 40%',
  'Converting to PDF this step has no progress',
  'Approximate layout Proof this section',
  'Following the cursor Whole report',
  'Not used yet Used in 4.1',
  'Reference columns are read-only, are not checked against a spec',
  'Preview Check Export Word and PDF Export Word only',
  'The assistant cannot see images',
].join(' \n ');

// A gate that cannot fail is decoration. This runs before the browser starts:
// every rule must catch its own sample, and no rule may catch the copy that
// stayed. If either half stops holding, the run stops here and says so.
function checkCutPatterns() {
  const faults = [];
  for (const rule of CUT_FEATURES) {
    for (const sample of rule.sample) {
      if (!cutFeatureHits(sample, []).length) {
        faults.push('no rule catches "' + sample + '" (' + rule.what + ')');
      }
    }
  }
  const falsePositives = cutFeatureHits(CUT_ALLOWED_SAMPLE, []);
  for (const hit of falsePositives) {
    faults.push('a rule fires on copy that is specified and must stay -- ' + hit);
  }
  if (!cutFeatureHits('', ['rw-verdict-badge']).length) {
    faults.push('the class scan does not catch .rw-verdict-badge');
  }
  if (cutFeatureHits('', ['jss_worksheet', 'corner', 'rw-asset__name']).length) {
    faults.push('the class scan fires on a class that is not ours or not a cut feature');
  }
  return faults;
}

async function cutFeaturesOnScreen(page) {
  const seen = await page.evaluate(() => {
    const classes = new Set();
    const nodes = document.querySelectorAll('[class]');
    for (let i = 0; i < nodes.length; i++) {
      const raw = nodes[i].className;
      if (typeof raw !== 'string') continue;
      raw.trim().split(/\s+/).forEach((c) => { if (c) classes.add(c); });
    }
    const body = document.body;
    return {
      text: String((body && body.innerText) || ''),
      classes: Array.from(classes),
    };
  });
  return cutFeatureHits(seen.text, seen.classes);
}

/* ------------------------------------------------------------------ *
 * the screens
 * ------------------------------------------------------------------ */

// Each screen: a name, how to get there, and what must be on it. An expectation
// is {what, text} (that string is visible), {what, anyText:[...]} (at least one
// of them is) or {what, sel} (at least one visible node matches).
function screens(base) {
  const editorUrl = base + '/#/r/' + REPORT_DIR.split('/').map(encodeURIComponent).join('/');

  const openEditor = async (page) => {
    if (page.url().indexOf('#/r/') < 0) {
      await page.goto(editorUrl, { waitUntil: 'load' });
      await settle(page, 900);
    }
  };

  return [
    {
      name: 'home',
      async go(page) {
        await page.goto(base + '/#/', { waitUntil: 'load' });
        await settle(page, 900);
      },
      expect: [
        { what: 'the shelf heading', text: 'Reports' },
        { what: 'the sample module is listed', text: MODULE_ID },
        { what: 'a report row is listed', anyText: ['CDR', 'PDR'] },
      ],
    },
    {
      name: 'create-dialog',
      async go(page) {
        await page.goto(base + '/#/', { waitUntil: 'load' });
        await settle(page, 700);
        if (!(await clickText(page, 'New report'))) {
          await clickText(page, 'New project or module');
        }
        await settle(page, 400);
      },
      expect: [
        { what: 'a dialog is open', sel: '.rw-dialog, [role="dialog"]' },
        { what: 'the create form', anyText: ['Create report', 'Start from', 'Stage'] },
      ],
      async after(page) {
        await clickText(page, 'Cancel');
      },
    },
    {
      name: 'editor',
      async go(page) {
        await openEditor(page);
      },
      expect: [
        { what: 'the outline', text: 'Sections' },
        { what: 'the report opened', anyText: ['Overview', SECTION_PROSE] },
      ],
    },
    {
      name: 'prose-section',
      async go(page) {
        await openEditor(page);
        await clickText(page, SECTION_PROSE);
        await settle(page, 500);
      },
      expect: [
        { what: 'the prose is on screen', text: 'The divider takes a differential input' },
        { what: 'the figure caption', anyText: ['Divider output over temperature', 'Caption'] },
      ],
    },
    {
      name: 'compliance-table-section',
      async go(page) {
        await openEditor(page);
        await clickText(page, SECTION_TABLE);
        await settle(page, 900);
      },
      expect: [
        { what: 'the grid rendered', sel: '.jexcel, .jss, table' },
        { what: 'the spec axes', anyText: ['MIN', 'TYP', 'MAX'] },
        { what: 'a row from the table', anyText: ['Output duty cycle', 'Current'] },
      ],
    },
    {
      name: 'cover-and-metadata',
      async go(page) {
        await openEditor(page);
        await clickText(page, 'Cover and metadata');
        await settle(page, 500);
      },
      expect: [
        { what: 'the cover form', anyText: ['Report title', 'Document information'] },
        { what: 'a metadata field', anyText: ['Document number', 'Version', 'Approver'] },
      ],
    },
    {
      name: 'preview-tab',
      async go(page) {
        await openEditor(page);
        await clickText(page, 'Preview');
        await settle(page, 900);
      },
      expect: [
        { what: 'the preview panel', anyText: ['Approximate layout', 'Proof this section', 'Preview'] },
      ],
    },
    {
      name: 'check-tab',
      async go(page) {
        await openEditor(page);
        await clickText(page, 'Check');
        await settle(page, 700);
      },
      expect: [
        { what: 'the checklist', anyText: ['Errors', 'Warnings', 'Nothing to fix'] },
      ],
    },
    {
      // `Export` is a menu, not a button that exports (40_preview_export.md:
      // "Export offers Export Word and PDF (default) and Export Word only").
      // Asserting a dialog straight after clicking it was this file's own bug.
      name: 'export-menu',
      async go(page) {
        await openEditor(page);
        await clickText(page, 'Export');
        await settle(page, 400);
      },
      expect: [
        { what: 'the menu is open', sel: '[role="menu"]' },
        { what: 'the default choice', text: 'Export Word and PDF' },
        { what: 'the second choice', text: 'Export Word only' },
      ],
      async after(page) {
        await page.keyboard.press('Escape');
        await settle(page, 300);
      },
    },
    {
      // Chooses Word only, deliberately: that path is pure python-docx and
      // finishes in a fraction of a second, so the gate proves the whole export
      // -- menu, dialog, engine, finished state -- on any machine. The PDF half
      // needs a live Word instance, which is not a thing a browser smoke test
      // should be starting on the owner's desktop.
      name: 'export-dialog',
      async go(page) {
        await openEditor(page);
        await clickText(page, 'Export');
        await settle(page, 400);
        await clickText(page, 'Export Word only');
        await settle(page, 900);
      },
      expect: [
        { what: 'a dialog is open', sel: '.rw-dialog, [role="dialog"]' },
        { what: 'the export copy', anyText: ['Exporting Word', 'Export Word only'] },
        { what: 'the export ran to the end', anyText: ['Export finished', 'Open folder'] },
      ],
      async after(page) {
        await page.keyboard.press('Escape');
        await settle(page, 300);
      },
    },
    {
      name: 'sync-drawer',
      async go(page) {
        await openEditor(page);
        await clickText(page, 'Text exchange');
        await settle(page, 700);
      },
      expect: [
        { what: 'a drawer is open', sel: '.rw-drawer, [role="dialog"]' },
        { what: 'the exchange actions', anyText: ['Copy changes', 'Copy whole report', 'Last exchange'] },
      ],
      async after(page) {
        await page.keyboard.press('Escape');
        await settle(page, 300);
      },
    },
    {
      name: 'history-drawer',
      async go(page) {
        await openEditor(page);
        await clickText(page, 'History');
        await settle(page, 700);
      },
      expect: [
        { what: 'a drawer is open', sel: '.rw-drawer, [role="dialog"]' },
        {
          what: 'the timeline',
          anyText: ['One timeline: snapshots, exchanges, restores', 'Restore this state', 'Exchanges'],
        },
      ],
      async after(page) {
        await page.keyboard.press('Escape');
        await settle(page, 300);
      },
    },
    {
      // The tray has two heights (60_assets.md): a 37px bar with counts and
      // three thumbnails, and the 236px panel where the cards -- file names,
      // tags, usage -- live. It starts collapsed, so a screen that wants a file
      // name has to open it. Clicking the word `Assets` did nothing: the label
      // is a label. The control is `Expand`, and it is scoped, because the
      // collapsed right panel offers an `Expand` of its own.
      name: 'asset-tray',
      async go(page) {
        await openEditor(page);
        await clickText(page, 'Expand', { within: '.rw-assets' });
        await settle(page, 900);
      },
      expect: [
        { what: 'the tray is open', anyText: ['Search by file name or tag', 'Add files'] },
        { what: 'the stored figure is listed', tightText: 'divider_response.png' },
        { what: 'the usage badge', anyText: ['Used in', 'Not used yet'] },
        {
          what: 'the footer note about file names',
          text: 'The assistant cannot see images',
        },
      ],
      async after(page) {
        await clickText(page, 'Collapse', { within: '.rw-assets' });
      },
    },
  ];
}

/* ------------------------------------------------------------------ *
 * the run
 * ------------------------------------------------------------------ */

// Requests the browser makes on its own that say nothing about the interface.
const IGNORED_REQUESTS = [/\/favicon\.ico(\?|$)/, /^data:/, /^chrome-extension:/];

function ignoredRequest(url) {
  return IGNORED_REQUESTS.some((re) => re.test(url));
}

// The one thing this file must never get wrong. `--root` is what keeps the
// server off the owner's reports; a scratch root that had drifted into the
// repository (or into the server's own default root, the reports folder that
// sits beside it) would point a writing server at real work, so the run stops.
function assertScratchRoot(root) {
  const resolved = path.resolve(root);
  const inRepo = resolved === REPO || resolved.startsWith(REPO + path.sep);
  const defaultRoot = path.resolve(REPO, 'local');
  const inDefault = resolved === defaultRoot || resolved.startsWith(defaultRoot + path.sep);
  const inTmp = resolved.startsWith(path.resolve(os.tmpdir()) + path.sep);
  if (inRepo || inDefault || !inTmp) {
    console.log('FAIL: refusing to run. The fixture root must be a fresh directory in the');
    console.log('      OS temporary directory, never the repository and never the reports root.');
    console.log('      Got: ' + resolved);
    process.exit(1);
  }
}

async function main() {
  const patternFaults = checkCutPatterns();
  if (patternFaults.length) {
    console.log('FAIL: the cut-feature scan is broken, so it would pass anything.');
    for (const fault of patternFaults) console.log('      ' + fault);
    process.exit(1);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  // Everything this test writes lives in the OS temporary directory -- outside
  // the repository, so no screenshot or fixture can ever be committed by
  // accident, and outside the reports root, so real work is untouchable.
  const scratch = path.join(os.tmpdir(), 'report-workbench-v2-smoke', stamp);
  const reportsRoot = path.join(scratch, 'reports');
  const shots = path.join(scratch, 'screens');
  assertScratchRoot(reportsRoot);
  fs.mkdirSync(shots, { recursive: true });
  buildReportsRoot(reportsRoot);

  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const child = startServer(reportsRoot, port);

  let browser = null;
  const results = [];
  let mountFailure = null;

  const cleanup = async () => {
    if (browser) await browser.close().catch(() => {});
    await stopServer(child);
    if (!KEEP_ROOT) fs.rmSync(reportsRoot, { recursive: true, force: true });
  };
  process.on('SIGINT', () => {
    cleanup().finally(() => process.exit(130));
  });

  try {
    try {
      await waitForServer(base, child, 20000);
    } catch (err) {
      console.log('FAIL: the server did not start (' + err.message + ')');
      console.log(child.log.join('').split('\n').slice(-12).join('\n'));
      await cleanup();
      process.exit(1);
    }

    try {
      browser = await chromium.launch({ channel: 'msedge', headless: !HEADED });
    } catch (err) {
      console.log('SKIP: the system Edge browser could not be launched.');
      console.log('      ' + String(err && err.message ? err.message : err).split('\n')[0]);
      await cleanup();
      process.exit(0);
    }

    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();

    // Every noise channel funnels into the screen being worked on.
    let bucket = { console: [], network: [] };
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      // A console error is often just the browser reporting a request that
      // failed; when that request is one of the ones we ignore (the favicon the
      // browser asks for on its own), so is the message.
      const where = msg.location && msg.location() ? msg.location().url : '';
      if (where && ignoredRequest(where)) return;
      bucket.console.push(msg.text().slice(0, 300));
    });
    page.on('pageerror', (err) => {
      bucket.console.push('uncaught: ' + String(err && err.message ? err.message : err).slice(0, 300));
    });
    page.on('requestfailed', (req) => {
      if (ignoredRequest(req.url())) return;
      const failure = req.failure();
      bucket.network.push(req.url() + ' (' + ((failure && failure.errorText) || 'failed') + ')');
    });
    page.on('response', (res) => {
      if (res.status() < 400 || ignoredRequest(res.url())) return;
      bucket.network.push(res.url() + ' -> HTTP ' + res.status());
    });

    // Before the screens: did the shell mount at all, or is index.html showing
    // its start-up failure panel?
    await page.goto(base + '/#/', { waitUntil: 'load' });
    await settle(page, 1200);
    const mount = await page.evaluate(() => {
      const app = document.getElementById('app');
      const panel = document.getElementById('rw-boot-fail');
      const shown = panel && window.getComputedStyle(panel).display !== 'none';
      return {
        children: app ? app.childElementCount : 0,
        failing: !!shown,
        detail: shown ? String(panel.innerText || '').replace(/\s+/g, ' ').slice(0, 300) : '',
      };
    });
    await page.screenshot({ path: path.join(shots, '00-shell.png') });
    if (mount.failing || mount.children === 0) {
      mountFailure = mount.failing
        ? 'the start-up failure panel is showing: ' + mount.detail
        : '#app has no element children';
    }

    const plan = screens(base);
    for (let i = 0; i < plan.length; i++) {
      const screen = plan[i];
      bucket = { console: [], network: [] };
      const problems = [];
      const shot = path.join(shots, String(i + 1).padStart(2, '0') + '-' + screen.name + '.png');

      try {
        await screen.go(page);
      } catch (err) {
        problems.push('navigation failed: ' + String(err && err.message ? err.message : err));
      }

      // boot.js renders a named placeholder when a view module is missing. That
      // is a finding about the view, not a crash, and it is reported as one.
      const placeholder = await hasText(page, 'This screen is not available yet');
      if (placeholder) problems.push('the view module is not available yet');

      const meets = async (want) => {
        if (want.sel) return (await visibleCount(page, want.sel)) > 0;
        if (want.tightText) return hasTightText(page, want.tightText);
        if (want.anyText) {
          for (const candidate of want.anyText) {
            if (await hasText(page, candidate)) return true;
          }
          return false;
        }
        return hasText(page, want.text);
      };

      let missing = 0;
      for (const want of screen.expect) {
        let ok = await meets(want);
        if (!ok) ok = await waitUntil(() => meets(want), 2500);
        if (!ok) {
          missing += 1;
          problems.push('missing: ' + want.what);
        }
      }
      // What the screen DID show, so a failure names the state it found rather
      // than only the state it wanted.
      if (missing) {
        const text = (await pageText(page)).trim();
        problems.push('on screen: ' + (text ? text.slice(0, 200) : '(no text at all)'));
      }

      for (const hit of await cutFeaturesOnScreen(page)) {
        problems.push('a cut feature is on screen (00_INDEX.md section 4) -- ' + hit);
      }

      const overflow = await horizontalOverflow(page, VIEWPORT.width);
      if (overflow) {
        problems.push('horizontal scroll at ' + VIEWPORT.width + 'px (content ' +
          overflow.scrollWidth + 'px): ' + overflow.offenders.join(', '));
      }
      for (const line of bucket.console) problems.push('console error: ' + line);
      for (const line of bucket.network) problems.push('request failed: ' + line);

      try {
        await page.screenshot({ path: shot });
      } catch (err) {
        problems.push('screenshot failed: ' + String(err && err.message ? err.message : err));
      }
      if (screen.after) await screen.after(page).catch(() => {});

      results.push({ name: screen.name, problems: problems, shot: shot });
      console.log((problems.length ? '  [FAIL] ' : '  [ok  ] ') + screen.name);
      for (const problem of problems) console.log('         ' + problem);
    }

    await context.close();
  } finally {
    await cleanup();
  }

  /* ---- the report ---- */

  const failed = results.filter((r) => r.problems.length);
  console.log('');
  console.log('Screen                      Result   Screenshot');
  console.log('--------------------------- -------- ----------------------------------------');
  if (mountFailure) {
    console.log('shell mounted               FAIL     ' + path.join(shots, '00-shell.png'));
    console.log('  ' + mountFailure);
  } else {
    console.log('shell mounted               PASS     ' + path.join(shots, '00-shell.png'));
  }
  for (const result of results) {
    const status = result.problems.length ? 'FAIL' : 'PASS';
    console.log(result.name.padEnd(28) + status.padEnd(9) + result.shot);
  }
  console.log('');
  console.log('Screenshots: ' + shots);
  console.log(results.length - failed.length + ' of ' + results.length + ' screens passed'
    + (mountFailure ? ', and the shell did not mount' : ''));

  process.exit(failed.length || mountFailure ? 1 : 0);
}

main().catch((err) => {
  console.log('FAIL: the harness itself failed');
  console.log(String(err && err.stack ? err.stack : err));
  process.exit(1);
});
