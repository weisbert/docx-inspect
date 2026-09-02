#!/usr/bin/env node
// test_v2_api.mjs -- the wire contract of builder/web/assets/v2/js/api.js.
//
// Run:  node builder/tests/test_v2_api.mjs
//
// WHY THIS FILE EXISTS
// --------------------
// api.js is the only place the v2 interface talks to the server, and until this
// file there was no coverage of it anywhere. The defect that motivated it had
// already shipped once: merge3Apply built its request body without `merged` and
// without `token`, so every apply was refused by the server -- and nothing in
// the suite noticed, because the merge endpoints are otherwise exercised only
// from Python, against the server's own view of the exchange.
//
// So this test asserts the REQUEST, not the answer. A stub fetch records exactly
// what the client sent; the assertions read that recording. Four of them fail
// against the pre-fix client and are tagged PIN in the output:
//
//   * merge3Apply posts `merged`                  (pre-fix: absent)
//   * merge3Apply posts `token`                   (pre-fix: absent)
//   * merge3Apply posts nothing else              (pre-fix: sent the conflict list)
//   * merge3Apply refuses locally without a token (pre-fix: posted anyway, and
//     the only possible answer was a refusal)
//
// The rest pin the parts of the wire contract that are cheap to break silently:
// the three typed errors, `dir` never being interpolated into a URL path, image
// URL encoding, and the NDJSON export feed with its fallback.
//
// Standard library only, no browser: api.js reads fetch / AbortController /
// URLSearchParams / TextDecoder off the global object, and node has all four.

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_PATH = path.resolve(HERE, '..', 'web', 'assets', 'v2', 'js', 'api.js');

// The interface ships .js files that the browser loads as modules through
// <script type="module">, and the repo's package.json deliberately has no
// "type" field so the older CommonJS harnesses next to this file keep working.
// Importing a .js module from node therefore prints one advisory that says
// nothing about this code. Swallow that single code and leave every other
// warning printing as usual.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning && warning.code === 'MODULE_TYPELESS_PACKAGE_JSON') return;
  console.warn(warning && warning.stack ? warning.stack : String(warning));
});

const api = await import(pathToFileURL(API_PATH).href);
const {
  ApiError, TruncatedPackageError, StaleMergeError, MergeTokenMissingError,
} = api;

// A report path with a slash in it, so "never interpolated into the path" is a
// claim with teeth: if any function built '/api/project/1108/CLKDIV_5G/CDR' the
// pathname assertions below would see the extra segments.
const DIR = '1108/CLKDIV_5G/CDR';

/* ------------------------------------------------------------------ *
 * tiny runner
 * ------------------------------------------------------------------ */

const failures = [];
let count = 0;

async function test(name, fn, options) {
  count += 1;
  const tag = options && options.pin ? ' [PIN]' : '';
  try {
    await fn();
    console.log('  [ok  ] ' + name + tag);
  } catch (err) {
    failures.push(name);
    console.log('  [FAIL] ' + name + tag);
    const detail = (err && err.stack ? err.stack : String(err)).split('\n').slice(0, 6);
    for (const line of detail) console.log('         ' + line);
  }
}

function section(title) {
  console.log('');
  console.log(title);
}

/* ------------------------------------------------------------------ *
 * the stub fetch
 * ------------------------------------------------------------------ */

// Each stub answer is either a plain object (JSON, 200), a reply(status, json),
// a stream answer, or an Error to throw. The recorder keeps one entry per call:
// {method, url, pathname, query, headers, raw, body}, where `body` is the parsed
// JSON body when the request carried one.
function stubFetch(answers) {
  const calls = [];
  const queue = Array.isArray(answers) ? answers.slice() : [answers];
  const impl = async (url, init) => {
    const options = init || {};
    const parsed = new URL(url, 'http://127.0.0.1');
    const raw = options.body === undefined ? null : options.body;
    let body = null;
    if (typeof raw === 'string') {
      try {
        body = JSON.parse(raw);
      } catch (err) {
        body = raw;
      }
    }
    calls.push({
      method: options.method || 'GET',
      url: String(url),
      pathname: parsed.pathname,
      query: parsed.searchParams,
      headers: options.headers || {},
      raw: raw,
      body: body,
    });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return makeResponse(next);
  };
  impl.calls = calls;
  globalThis.fetch = impl;
  return impl;
}

function makeResponse(spec) {
  if (spec instanceof Error) throw spec;
  const answer = spec && spec.__response ? spec : { __response: true, status: 200, json: spec };
  const status = answer.status == null ? 200 : answer.status;
  const text = answer.text !== undefined
    ? answer.text
    : JSON.stringify(answer.json === undefined ? {} : answer.json);
  return {
    ok: status >= 200 && status < 300,
    status: status,
    body: answer.stream === undefined ? null : answer.stream,
    text: async () => text,
  };
}

const reply = (status, json) => ({ __response: true, status: status, json: json });
const streamed = (chunks) => ({ __response: true, status: 200, stream: byteStream(chunks) });
const throwing = (message) => new Error(message);

// A ReadableStream-alike that hands out the byte chunks it was given, so the
// NDJSON reader can be fed lines split anywhere -- including mid-object.
function byteStream(chunks) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    getReader() {
      return {
        async read() {
          if (i >= chunks.length) return { done: true, value: undefined };
          const chunk = chunks[i];
          i += 1;
          return { done: false, value: encoder.encode(chunk) };
        },
      };
    },
  };
}

async function rejects(fn) {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to reject, but it resolved');
}

/* ------------------------------------------------------------------ *
 * 1. merge3 -- the request body
 * ------------------------------------------------------------------ */

section('POST /api/merge3');

const INCOMING = { meta: { title: 'Sample Report' }, outline: [{ id: 'n1', title: 'Section 1' }] };
const MERGE_OK = {
  merged: { meta: { title: 'Sample Report' }, outline: [], conflictMarkers: ['n1'] },
  conflicts: [{ id: 'n1' }],
  auto: 3,
  pending: 1,
  deletions: [{ id: 'n9', title: 'Section 9' }],
  token: 'sha-of-the-project-json',
  truncated: null,
};

await test('merge3 posts exactly {dir, incoming}', async () => {
  const fetchStub = stubFetch(MERGE_OK);
  await api.merge3(DIR, INCOMING);
  assert.equal(fetchStub.calls.length, 1);
  const call = fetchStub.calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.pathname, '/api/merge3');
  assert.deepEqual(Object.keys(call.body).sort(), ['dir', 'incoming']);
  assert.equal(call.body.dir, DIR);
  assert.deepEqual(call.body.incoming, INCOMING);
});

await test('merge3 sends allowBulkDelete only when the caller asked for it', async () => {
  const fetchStub = stubFetch(MERGE_OK);
  await api.merge3(DIR, INCOMING);
  assert.equal('allowBulkDelete' in fetchStub.calls[0].body, false);
  await api.merge3(DIR, INCOMING, { allowBulkDelete: true });
  const call = fetchStub.calls[1];
  assert.deepEqual(Object.keys(call.body).sort(), ['allowBulkDelete', 'dir', 'incoming']);
  assert.equal(call.body.allowBulkDelete, true);
});

await test('merge3 carries merged, token and deletions through to the caller', async () => {
  stubFetch(MERGE_OK);
  const result = await api.merge3(DIR, INCOMING);
  // The view has to hand `merged` back untouched -- it carries the conflict
  // markers the apply resolves against -- so the client must not prune it.
  assert.deepEqual(result.merged, MERGE_OK.merged);
  assert.equal(result.token, 'sha-of-the-project-json');
  assert.deepEqual(result.deletions, MERGE_OK.deletions);
  assert.equal(result.auto, 3);
  assert.equal(result.pending, 1);
});

await test('merge3 normalises a bare answer instead of handing out undefined', async () => {
  stubFetch({});
  const result = await api.merge3(DIR, INCOMING);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.deletions, []);
  assert.equal(result.token, '');
  assert.equal(result.merged, null);
});

/* ------------------------------------------------------------------ *
 * 2. merge3-apply -- the request body, and the local refusal
 * ------------------------------------------------------------------ */

section('POST /api/merge3-apply');

const CHOICES = [{ id: 'n1', take: 'mine' }];

await test('merge3Apply posts the merged report it was given', async () => {
  const fetchStub = stubFetch({ ok: true, applied: 4, snapshot: 's1.json' });
  await api.merge3Apply(DIR, { merged: MERGE_OK.merged, choices: CHOICES, token: 'tok' });
  const call = fetchStub.calls[0];
  assert.equal(call.pathname, '/api/merge3-apply');
  // Not a rebuild, not a subset: the same document, markers and all.
  assert.deepEqual(call.body.merged, MERGE_OK.merged);
}, { pin: true });

await test('merge3Apply posts the token the merge was computed from', async () => {
  const fetchStub = stubFetch({ ok: true, applied: 1 });
  await api.merge3Apply(DIR, { merged: MERGE_OK.merged, choices: CHOICES, token: 'tok' });
  assert.equal(fetchStub.calls[0].body.token, 'tok');
}, { pin: true });

await test('merge3Apply posts exactly {dir, merged, choices, token}', async () => {
  const fetchStub = stubFetch({ ok: true, applied: 1 });
  await api.merge3Apply(DIR, {
    merged: MERGE_OK.merged,
    choices: CHOICES,
    token: 'tok',
    // Transport options belong to the caller, not to the server: they must not
    // leak into the body.
    timeout: 1000,
  });
  const call = fetchStub.calls[0];
  assert.deepEqual(Object.keys(call.body).sort(), ['choices', 'dir', 'merged', 'token']);
  assert.equal(call.body.dir, DIR);
  assert.deepEqual(call.body.choices, CHOICES);
}, { pin: true });

await test('merge3Apply refuses a missing token locally, without a request', async () => {
  const fetchStub = stubFetch({ ok: true });
  const err = await rejects(() => api.merge3Apply(DIR, { merged: MERGE_OK.merged, choices: [] }));
  assert.ok(err instanceof MergeTokenMissingError, 'expected MergeTokenMissingError, got ' + err.name);
  assert.ok(err instanceof ApiError, 'the typed errors must stay catchable as ApiError');
  // An apply that can only be refused is not sent. This is the assertion that
  // separates "the client knows the rule" from "the server enforces the rule".
  assert.equal(fetchStub.calls.length, 0, 'no request may leave the client');
}, { pin: true });

await test('merge3Apply defaults choices to an empty list rather than omitting the key', async () => {
  const fetchStub = stubFetch({ ok: true });
  await api.merge3Apply(DIR, { merged: {}, token: 'tok' });
  assert.deepEqual(fetchStub.calls[0].body.choices, []);
});

await test('merge3Apply normalises the answer', async () => {
  stubFetch({ ok: true, applied: 7, snapshot: 'snapshot-2026.json' });
  const result = await api.merge3Apply(DIR, { merged: {}, token: 'tok' });
  assert.deepEqual(result, { ok: true, applied: 7, snapshot: 'snapshot-2026.json' });
});

/* ------------------------------------------------------------------ *
 * 3. the three typed failures
 * ------------------------------------------------------------------ */

section('Typed failures');

const TRUNCATED = { kind: 'sections', missing: 12, total: 14, detail: 'the tail is missing' };

await test('409 truncated becomes TruncatedPackageError carrying .truncated and .override', async () => {
  stubFetch(reply(409, { error: 'truncated', truncated: TRUNCATED }));
  const err = await rejects(() => api.merge3(DIR, INCOMING));
  assert.ok(err instanceof TruncatedPackageError, 'got ' + err.name);
  assert.ok(err instanceof ApiError);
  assert.deepEqual(err.truncated, TRUNCATED);
  // The view offers the override by name, so the name is part of the contract.
  assert.equal(err.override, 'allowBulkDelete');
  assert.equal(err.status, 409);
});

await test('409 stale_merge becomes StaleMergeError carrying .expected and .actual', async () => {
  stubFetch(reply(409, { error: 'stale_merge', expected: 'tok-a', actual: 'tok-b' }));
  const err = await rejects(() => api.merge3Apply(DIR, { merged: {}, token: 'tok-a' }));
  assert.ok(err instanceof StaleMergeError, 'got ' + err.name);
  assert.ok(err instanceof ApiError);
  assert.equal(err.expected, 'tok-a');
  assert.equal(err.actual, 'tok-b');
});

await test('400 merge_token_missing from the server becomes MergeTokenMissingError', async () => {
  stubFetch(reply(400, { error: 'merge_token_missing' }));
  // A token the client considers present, refused by the server anyway: the
  // typed error must come from the answer, not only from the local guard.
  const err = await rejects(() => api.merge3Apply(DIR, { merged: {}, token: 'stale-but-present' }));
  assert.ok(err instanceof MergeTokenMissingError, 'got ' + err.name);
  assert.equal(err.status, 400);
});

await test('an unrelated failure stays a plain ApiError', async () => {
  stubFetch(reply(500, { error: 'internal' }));
  const err = await rejects(() => api.merge3(DIR, INCOMING));
  assert.equal(err.constructor, ApiError);
  assert.equal(err.message, 'internal');
  assert.equal(err.status, 500);
});

await test('a 200 answer carrying an error field is still a failure', async () => {
  stubFetch({ error: 'no baseline recorded' });
  const err = await rejects(() => api.copyDiff(DIR, {}));
  assert.ok(err instanceof ApiError);
  assert.equal(err.message, 'no baseline recorded');
});

/* ------------------------------------------------------------------ *
 * 4. dir is a query parameter or a body field -- never a path segment
 * ------------------------------------------------------------------ */

section('dir addressing');

// Every function that takes a report dir, with the argument list that reaches
// the server, and where the contract says the dir travels.
const DIR_CALLS = [
  ['getConfig', () => api.getConfig(DIR), 'query'],
  ['getProject', () => api.getProject(DIR), 'query'],
  ['saveProject', () => api.saveProject(DIR, { outline: [] }, { savedAt: 12 }), 'query'],
  ['previewSection', () => api.previewSection(DIR, 'n1'), 'body'],
  ['merge3', () => api.merge3(DIR, INCOMING), 'body'],
  ['merge3Apply', () => api.merge3Apply(DIR, { merged: {}, token: 't' }), 'body'],
  ['pasteImport', () => api.pasteImport(DIR, '{}'), 'query'],
  ['copyDiff', () => api.copyDiff(DIR, {}), 'query'],
  ['applyUpdate', () => api.applyUpdate(DIR, { name: 'package.zip', zip_b64: '' }), 'body'],
  ['rollback', () => api.rollback(DIR), 'body'],
  ['getAutosaves', () => api.getAutosaves(DIR), 'query'],
  ['autosaveRestore', () => api.autosaveRestore(DIR, 'snapshot-1.json'), 'body'],
  ['projectDelete', () => api.projectDelete(DIR), 'body'],
  ['projectRename', () => api.projectRename(DIR, 'CDR', 'Title'), 'body'],
  ['projectCopy', () => api.projectCopy(DIR, 'CDR copy'), 'body'],
  ['getAssets', () => api.getAssets(DIR), 'query'],
  ['assetTag', () => api.assetTag(DIR, 'images/a.png', ['tag']), 'body'],
  ['assetRename', () => api.assetRename(DIR, 'images/a.png', 'images/b.png'), 'body'],
  ['putImage', () => api.putImage(DIR, 'n1', 'a.png', 'AAAA'), 'query'],
  ['exportXlsx', () => api.exportXlsx(DIR, { type: 'table' }), 'body'],
  ['validateCompliance', () => api.validateCompliance(DIR, { data: {} }), 'body'],
  ['exportPlain', () => api.exportPlain(DIR), 'query'],
];

// The complete set of paths these calls are allowed to build. A dir that leaked
// into the path would produce something outside this set.
const ALLOWED_PATHS = new Set([
  '/api/config', '/api/project', '/api/preview-section', '/api/merge3', '/api/merge3-apply',
  '/api/paste-import', '/api/copy-diff', '/api/apply-update', '/api/rollback',
  '/api/autosaves', '/api/autosave-restore', '/api/project-delete', '/api/project-rename',
  '/api/project-copy', '/api/assets', '/api/asset-tag', '/api/asset-rename', '/api/image',
  '/api/export-xlsx', '/api/validate-compliance', '/api/export',
]);

for (const entry of DIR_CALLS) {
  const name = entry[0];
  const call = entry[1];
  const where = entry[2];
  await test(name + ' passes dir as a ' + where + ' value, never in the path', async () => {
    const fetchStub = stubFetch({ ok: true });
    await call();
    assert.equal(fetchStub.calls.length, 1, name + ' made ' + fetchStub.calls.length + ' calls');
    const sent = fetchStub.calls[0];
    assert.ok(ALLOWED_PATHS.has(sent.pathname), name + ' built the path ' + sent.pathname);
    assert.equal(sent.pathname.split('/').length, 3, name + ' added path segments: ' + sent.pathname);
    const found = where === 'query' ? sent.query.get('dir') : (sent.body && sent.body.dir);
    assert.equal(found, DIR, name + ' did not carry dir in the ' + where);
  });
}

await test('the dir-free endpoints send no dir at all', async () => {
  const fetchStub = stubFetch({ projects: [] });
  await api.getTree();
  await api.getProjects();
  await api.getTemplates();
  await api.getVersion();
  await api.health();
  for (const call of fetchStub.calls) {
    assert.equal(call.query.get('dir'), null, call.pathname + ' sent a dir');
  }
});

await test('an empty query value is dropped rather than sent blank', async () => {
  const fetchStub = stubFetch({});
  await api.getConfig(DIR); // template is undefined
  assert.equal(fetchStub.calls[0].query.has('template'), false);
  assert.equal(fetchStub.calls[0].url, '/api/config?dir=' + encodeURIComponent(DIR));
});

/* ------------------------------------------------------------------ *
 * 5. imgUrl
 * ------------------------------------------------------------------ */

section('imgUrl');

await test('imgUrl builds /images/<file>?dir=<dir> with both halves encoded', () => {
  const url = api.imgUrl(DIR, 'images/a b&c.png');
  assert.equal(url, '/images/a%20b%26c.png?dir=1108%2FCLKDIV_5G%2FCDR');
  const parsed = new URL(url, 'http://127.0.0.1');
  assert.equal(parsed.pathname, '/images/a%20b%26c.png');
  assert.equal(parsed.searchParams.get('dir'), DIR);
});

await test('imgUrl tolerates a file stored with or without the images/ prefix', () => {
  assert.equal(api.imgUrl(DIR, 'plot.png'), api.imgUrl(DIR, 'images/plot.png'));
  assert.equal(api.imgUrl(DIR, 'IMAGES/plot.png'), api.imgUrl(DIR, 'plot.png'));
  assert.equal(api.imgUrl(DIR, '\\images\\plot.png'), api.imgUrl(DIR, 'plot.png'));
});

await test('imgUrl keeps a subfolder separator but escapes everything else', () => {
  const parsed = new URL(api.imgUrl(DIR, 'images/sub dir/p#1.png'), 'http://127.0.0.1');
  assert.equal(parsed.pathname, '/images/sub%20dir/p%231.png');
});

await test('imgUrl adds the cache-busting version only when one is given', () => {
  assert.equal(api.imgUrl(DIR, 'p.png').includes('v='), false);
  assert.equal(new URL(api.imgUrl(DIR, 'p.png', 7), 'http://127.0.0.1').searchParams.get('v'), '7');
});

/* ------------------------------------------------------------------ *
 * 6. exportStream -- NDJSON, line by line, with a fallback
 * ------------------------------------------------------------------ */

section('exportStream');

const DONE_RESULT = { docx: 'out/report.docx', pdf: 'out/report.pdf', pages: 12 };

await test('exportStream parses NDJSON events split across chunk boundaries', async () => {
  stubFetch(streamed([
    '{"type":"phase","phase":"collect"}\n{"type":"progr',
    'ess","done":3,"total":9}\n',
    '{"type":"progress","done":9,"total":9}\n{"type":"done","result":',
    JSON.stringify(DONE_RESULT) + '}\n',
  ]));
  const seen = [];
  const result = await api.exportStream(DIR, (event) => seen.push(event));
  assert.deepEqual(seen.map((e) => e.type), ['phase', 'progress', 'progress', 'done']);
  assert.equal(seen[1].done, 3);
  assert.deepEqual(result, DONE_RESULT);
});

await test('exportStream reads a final line that arrives without a newline', async () => {
  stubFetch(streamed(['{"type":"done","result":' + JSON.stringify(DONE_RESULT) + '}']));
  const result = await api.exportStream(DIR, () => {});
  assert.deepEqual(result, DONE_RESULT);
});

await test('exportStream skips a blank or non-JSON line instead of failing', async () => {
  stubFetch(streamed(['\n', 'not json\n', '{"type":"done","result":{"pages":1}}\n']));
  const seen = [];
  const result = await api.exportStream(DIR, (e) => seen.push(e));
  assert.deepEqual(seen.map((e) => e.type), ['done']);
  assert.deepEqual(result, { pages: 1 });
});

await test('exportStream passes dir and fmt as query parameters', async () => {
  const fetchStub = stubFetch(streamed(['{"type":"done","result":{}}\n']));
  await api.exportStream(DIR, () => {}, { fmt: 'docx', saveFirst: true });
  const call = fetchStub.calls[0];
  assert.equal(call.pathname, '/api/export-stream');
  assert.equal(call.query.get('dir'), DIR);
  assert.equal(call.query.get('fmt'), 'docx');
  assert.deepEqual(call.body, { save_first: true });
});

await test('exportStream falls back to the plain export when the stream is unavailable', async () => {
  // First call: a server too old for the streaming endpoint. Second: the plain one.
  const fetchStub = stubFetch([reply(404, { error: 'not found' }), { ok: true, pages: 12 }]);
  const seen = [];
  const result = await api.exportStream(DIR, (e) => seen.push(e));
  assert.equal(fetchStub.calls.length, 2);
  assert.equal(fetchStub.calls[1].pathname, '/api/export');
  assert.equal(fetchStub.calls[1].query.get('dir'), DIR);
  // The caller's progress UI must behave identically either way: one
  // indeterminate progress event, then the real done event.
  assert.deepEqual(seen.map((e) => e.type), ['progress', 'done']);
  assert.equal(seen[0].indeterminate, true);
  assert.equal(seen[0].fallback, true);
  assert.equal(seen[1].fallback, true);
  assert.deepEqual(result, { ok: true, pages: 12 });
});

await test('exportStream falls back when fetch itself throws', async () => {
  const fetchStub = stubFetch([throwing('network down'), { ok: true, pages: 3 }]);
  const seen = [];
  const result = await api.exportStream(DIR, (e) => seen.push(e));
  assert.equal(fetchStub.calls.length, 2);
  assert.equal(fetchStub.calls[1].pathname, '/api/export');
  assert.deepEqual(seen.map((e) => e.type), ['progress', 'done']);
  assert.deepEqual(result, { ok: true, pages: 3 });
});

await test('exportStream raises a stream-borne error rather than reporting a silent success', async () => {
  stubFetch(streamed(['{"type":"error","error":"the converter did not start"}\n']));
  const err = await rejects(() => api.exportStream(DIR, () => {}));
  assert.ok(err instanceof ApiError);
  assert.equal(err.message, 'the converter did not start');
});

await test('a listener that throws never breaks the transfer', async () => {
  stubFetch(streamed(['{"type":"progress","done":1,"total":2}\n{"type":"done","result":{"pages":2}}\n']));
  const result = await api.exportStream(DIR, () => {
    throw new Error('a view rendered badly');
  });
  assert.deepEqual(result, { pages: 2 });
});

/* ------------------------------------------------------------------ *
 * 7. store.js -- dirty tracking, and saving while the user keeps typing
 * ------------------------------------------------------------------ *
 *
 * THE DEFECT THESE PIN
 * --------------------
 * store.js used to decide "did anything change while the PUT was in flight?"
 * by comparing object identity: `state.project === theProjectWeSent`. The
 * document is edited IN PLACE -- that is the whole point of a large outline
 * every view holds by reference -- so that comparison was always true, `dirty`
 * was cleared, the queued save bailed on `!snapshot.dirty`, and the keystrokes
 * typed during a slow save were gone while the header read `Saved HH:MM`.
 *
 * Both assertions below fail against that store and are tagged PIN.
 * ------------------------------------------------------------------ */

section('store.js -- an edit typed during a save');

const STORE_PATH = path.resolve(HERE, '..', 'web', 'assets', 'v2', 'js', 'store.js');
const { store } = await import(pathToFileURL(STORE_PATH).href);

// A recorder for PUT /api/project that can hold one request open, so an edit
// can be made at the exact moment the defect needed: after the bytes were
// serialised, before the answer came back.
function saveRecorder() {
  const puts = [];
  let gate = null;
  globalThis.fetch = async (url, init) => {
    const options = init || {};
    if (String(url).indexOf('/api/project') === 0 && options.method === 'PUT') {
      puts.push(String(options.body));
      if (gate) {
        const waiting = gate;
        gate = null;
        await waiting;
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ mtime: puts.length }) };
    }
    return { ok: true, status: 200, text: async () => '{}' };
  };
  return {
    puts: puts,
    // Hold the NEXT PUT open until the returned function is called.
    hold() {
      let release;
      gate = new Promise((resolve) => { release = resolve; });
      return release;
    },
  };
}

// A minimal report, and the ONLY way this fixture is ever edited: in place,
// exactly as the prose card and the cover form edit it.
function openReport() {
  return {
    meta: { title: 'Sample Report' },
    outline: [{
      id: 'n1',
      title: 'Section 1',
      blocks: [{ id: 'b1', type: 'para', cardStart: true, runs: [{ t: 'base' }] }],
      children: [],
    }],
  };
}

// Opening a report is what gives the store a DESTINATION: the document and the
// report it was read from arrive together, and every save of it is addressed to
// that report and to no other. `store.set({project})` alone installs a document
// that belongs nowhere, which is not a state any screen can produce.
const openInto = (dir, project) => {
  store.set({ route: { view: 'editor', dir: dir, node: null } });
  store.setProject(project, { dir: dir });
  return project;
};

const typeInto = (project, text) => { project.outline[0].blocks[0].runs[0].t = text; };
const napMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return true;
    if (Date.now() > deadline) return false;
    await napMs(20);
  }
}

await test('an IN-PLACE edit made during a save keeps the report dirty and reaches the next PUT', async () => {
  store.reset();
  const recorder = saveRecorder();
  const release = recorder.hold();
  const project = openReport();
  openInto(DIR, project);

  typeInto(project, 'base FIRSTEDIT');
  store.markDirty();
  assert.ok(await until(() => recorder.puts.length === 1, 4000), 'the first save never started');
  assert.equal(recorder.puts[0].indexOf('SECONDEDIT'), -1, 'the fixture serialised too late to be a test');

  // The second keystroke, while the first PUT is still on the wire. Nothing
  // above the outline changes identity -- this is the mutation the old check
  // could not see.
  typeInto(project, 'base FIRSTEDIT SECONDEDIT');
  store.markDirty();
  assert.equal(store.get().project, project, 'the fixture must not replace the project reference');

  release();
  assert.ok(await until(() => store.get().saveState === 'saved', 4000), 'the save never finished');
  assert.equal(store.get().dirty, true,
    'the store called itself saved while an edit was still only in memory');

  assert.ok(await until(() => recorder.puts.length === 2, 4000),
    'no second save was ever scheduled: the edit typed during the first one is lost');
  assert.ok(recorder.puts[1].indexOf('SECONDEDIT') >= 0, 'the second PUT did not carry the edit');
  assert.ok(await until(() => store.get().dirty === false, 4000), 'the report never came clean');
  store.reset();
}, { pin: true });

await test('saveNow() resolves only once the in-flight save AND the pending edit are on disk', async () => {
  store.reset();
  const recorder = saveRecorder();
  const release = recorder.hold();
  const project = openReport();
  openInto(DIR, project);

  typeInto(project, 'base FIRSTEDIT');
  store.markDirty();
  assert.ok(await until(() => recorder.puts.length === 1, 4000), 'the first save never started');

  typeInto(project, 'base FIRSTEDIT SECONDEDIT');
  store.markDirty();

  let settled = false;
  const flushed = store.saveNow().then(() => { settled = true; });
  await napMs(120);
  // Three other views await this before a server-side file operation. Resolving
  // here would hand the server the document WITHOUT the pending edit.
  assert.equal(settled, false, 'saveNow resolved while a save was still in flight');

  release();
  await flushed;
  assert.equal(settled, true);
  assert.equal(recorder.puts.length, 2, 'saveNow did not write the edit made during the save');
  assert.ok(recorder.puts[1].indexOf('SECONDEDIT') >= 0, 'saveNow wrote the stale document');
  assert.equal(store.get().dirty, false, 'saveNow resolved with the report still dirty');
  store.reset();
}, { pin: true });

await test('saveNow() on a clean report resolves without touching the server', async () => {
  store.reset();
  const recorder = saveRecorder();
  openInto(DIR, openReport());
  await store.saveNow();
  assert.equal(recorder.puts.length, 0);
  store.reset();
});

/* ------------------------------------------------------------------ *
 * 7b. store.js -- a save carries its own destination, and says what it did
 *
 * Four defects, all of them able to destroy a report without a word on screen:
 *
 *   * runSave() read the destination from the LIVE route when the PUT went out,
 *     so a save scheduled after a report switch carried report A's document to
 *     report B's file. Watched in Edge: PDR/project.json afterwards held CDR's
 *     title and CDR's text.
 *   * the retry answered a 409 by dropping the optimistic token and re-sending
 *     the same bytes, which is what turned that caught mistake into the write
 *     that landed.
 *   * saveNow() resolved while the document was still dirty, so the six callers
 *     that use it as a barrier before something irreversible went ahead against
 *     a stale file and reported success.
 *   * every failed attempt pushed another banner, without bound.
 *
 * All five assertions below fail against that store and are tagged PIN.
 * ------------------------------------------------------------------ */

section('store.js -- a save carries its own destination');

const { SaveFailedError } = await import(pathToFileURL(STORE_PATH).href);

const DIR_B = '1108/CLKDIV_5G/PDR';

// A PUT recorder that answers with the status the test asks for and records what
// the client actually addressed: the destination, the token, the bytes, and the
// route AT THE MOMENT the request went out -- the last of those is how "the
// document went where the user was looking" is told apart from "the document
// went where it belongs".
function putRecorder(options) {
  const opt = options || {};
  const puts = [];
  let gate = null;
  let seq = 0;
  globalThis.fetch = async (url, init) => {
    const request = init || {};
    const parsed = new URL(String(url), 'http://127.0.0.1');
    if (parsed.pathname === '/api/project' && request.method === 'PUT') {
      seq += 1;
      const mine = seq;
      const route = store.get().route || {};
      const entry = {
        dir: parsed.searchParams.get('dir'),
        savedAt: parsed.searchParams.has('saved_at') ? parsed.searchParams.get('saved_at') : null,
        body: String(request.body || ''),
        routeAtPut: route.dir || null,
      };
      puts.push(entry);
      if (gate) {
        const waiting = gate;
        gate = null;
        await waiting;
      }
      const status = typeof opt.status === 'function' ? opt.status(mine) : (opt.status || 200);
      entry.status = status;
      if (status >= 400) {
        return { ok: false, status: status, text: async () => JSON.stringify({ error: 'refused' }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ saved_at: 1000 + mine }) };
    }
    return { ok: true, status: 200, text: async () => '{}' };
  };
  return {
    puts: puts,
    hold() {
      let release;
      gate = new Promise((resolve) => { release = resolve; });
      return release;
    },
  };
}

// Open a report with a known optimistic token, so a test can assert the token
// a PUT carried.
function loadInto(dir, project, mtime) {
  store.set({ route: { view: 'editor', dir: dir, node: null } });
  store.setProject(project, { dir: dir, mtime: mtime == null ? 100 : mtime });
  return project;
}

await test('a save in flight never follows the route to another report', async () => {
  store.reset();
  const recorder = putRecorder();
  const release = recorder.hold();
  const project = loadInto(DIR, openReport());

  typeInto(project, 'base EDITONE');
  store.markDirty();
  assert.ok(await until(() => recorder.puts.length === 1, 4000), 'the first save never started');

  // A second keystroke while the first PUT is held, and then the switch to
  // another report -- the route moves the instant the address changes, the
  // document only once its replacement has been fetched.
  typeInto(project, 'base EDITONE EDITTWO');
  store.markDirty();
  store.set({ route: { view: 'editor', dir: DIR_B, node: null } });

  release();
  assert.ok(await until(() => recorder.puts.length === 2, 4000),
    'the edit made during the save was never written anywhere');

  const strays = recorder.puts.filter((put) => put.dir !== DIR);
  assert.deepEqual(strays, [],
    'a document belonging to ' + DIR + ' was addressed at another report');
  assert.ok(recorder.puts[1].body.indexOf('EDITTWO') >= 0);
  assert.equal(recorder.puts[1].routeAtPut, DIR_B,
    'the fixture is not exercising the defect: the route had not moved yet');
  store.reset();
}, { pin: true });

await test('a 409 is never retried by dropping the token', async () => {
  store.reset();
  const recorder = putRecorder({ status: 409 });
  const project = loadInto(DIR, openReport(), 100);

  typeInto(project, 'base EDITONE');
  store.markDirty();
  assert.ok(await until(() => recorder.puts.length === 1, 4000), 'the save never started');
  // Long enough for the old retry (1500ms) to have gone out.
  await napMs(2600);

  const untokened = recorder.puts.filter((put) => put.savedAt === null);
  assert.deepEqual(untokened, [],
    'the token was dropped and the write forced through on top of the change that caused the 409');
  assert.equal(recorder.puts.length, 1, 'a refused write was repeated');
  assert.equal(recorder.puts[0].savedAt, '100');
  assert.equal(store.get().dirty, true, 'nothing was written, so the document is still dirty');
  assert.equal(store.get().saveState, 'blocked',
    'the indicator promises a retry that is never going to come');
  store.reset();
}, { pin: true });

await test('saveNow() rejects rather than resolving with the document still dirty', async () => {
  store.reset();
  const recorder = putRecorder({ status: 500 });
  const project = loadInto(DIR, openReport());

  typeInto(project, 'base EDITONE');
  store.markDirty();

  const err = await rejects(() => store.saveNow());
  assert.ok(err instanceof SaveFailedError, 'saveNow rejected with the wrong kind of error');
  assert.equal(err.code, 'save-failed');
  assert.equal(err.alreadyReported, true);
  assert.equal(store.get().dirty, true);
  assert.ok(recorder.puts.length >= 1, 'saveNow did not even try');
  store.reset();
}, { pin: true });

await test('saveNow() resolves with the destination it wrote to', async () => {
  store.reset();
  putRecorder();
  const project = loadInto(DIR, openReport());
  typeInto(project, 'base EDITONE');
  store.markDirty();
  const answer = await store.saveNow();
  assert.equal(answer.ok, true);
  assert.equal(answer.dir, DIR);
  assert.equal(store.get().dirty, false);
  store.reset();
});

await test('repeated save failures produce ONE banner, not a stack', async () => {
  store.reset();
  const recorder = putRecorder({ status: 500 });
  const project = loadInto(DIR, openReport());

  typeInto(project, 'base EDITONE');
  store.markDirty();
  // Two full rounds: each is an attempt, a retry 1500ms later, and a fresh pass
  // scheduled 800ms after that.
  assert.ok(await until(() => recorder.puts.length >= 4, 12000),
    'the save loop stopped trying, so there is nothing to count banners for');
  await napMs(200);

  const raised = store.get().banners.filter((b) => b.code === 'save-failed');
  assert.equal(raised.length, 1,
    'the failing save stacked ' + raised.length + ' banners');
  assert.ok(raised[0].count >= 2, 'the one banner does not say how many attempts it stands for');
  store.reset();
}, { pin: true });

/* ------------------------------------------------------------------ *
 * 8. blocks.js -- moveCardBySpan: moving a card moves a CARD
 * ------------------------------------------------------------------ */

section('blocks.js -- moveCardBySpan');

// blocks.js reads the vendor UMD globals when it loads. It is a browser module;
// these three stubs are only enough for the module body to evaluate, because
// the function under test is pure and touches none of them.
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

const V2_JS = path.resolve(HERE, '..', 'web', 'assets', 'v2', 'js');
const blocksMod = await import(pathToFileURL(path.join(V2_JS, 'views', 'blocks.js')).href);
const { groupBlocks } = await import(pathToFileURL(path.join(V2_JS, 'util.js')).href);
const { moveCardBySpan } = blocksMod;

// A two-paragraph prose card followed by a figure -- the smallest shape in
// which a single-block offset does the wrong thing.
const paragraph = (text, cardStart) => {
  const block = { type: 'para', runs: [{ t: text }] };
  if (cardStart) block.cardStart = true;
  return block;
};
const cardFixture = () => [
  paragraph('P1', true),
  paragraph('P2'),
  { type: 'image', id: 'fig', file: 'images/a.png', caption: '' },
];
const shape = (list) => list.map((b) => (b.type === 'para' ? b.runs[0].t : b.type));
const proseCards = (list) => groupBlocks(list).filter((card) => card.kind === 'prose');

await test('blocks.js exports moveCardBySpan', () => {
  assert.equal(typeof moveCardBySpan, 'function');
}, { pin: true });

await test('moving the figure up jumps the WHOLE prose card, and does not split it', () => {
  const before = cardFixture();
  const after = moveCardBySpan(before, 2, 1, -1);
  assert.notEqual(after, before, 'the move must return a new array');
  assert.deepEqual(shape(before), ['P1', 'P2', 'image'], 'the input array was mutated');
  assert.deepEqual(shape(after), ['image', 'P1', 'P2']);
  // The paragraphs are still ONE card: two blocks, the first carrying cardStart.
  assert.equal(proseCards(after).length, 1, 'the prose card was split in two');
  assert.equal(proseCards(after)[0].blocks.length, 2);
  assert.equal(after[1].cardStart, true);
  assert.equal(after[2].cardStart, undefined);
}, { pin: true });

await test('a single-block offset -- the behaviour this replaces -- splits the card', () => {
  // Not a test of the code under test: a demonstration that the assertion above
  // has teeth. `startIndex - 1` lands the figure BETWEEN the two paragraphs,
  // and the split is permanent -- it saves, and nothing undoes it later.
  const naive = cardFixture();
  const cut = naive.splice(2, 1);
  naive.splice(1, 0, cut[0]);
  assert.deepEqual(shape(naive), ['P1', 'image', 'P2']);
  assert.equal(proseCards(naive).length, 2, 'the naive move was expected to split the card');
});

await test('moving the prose card down jumps past the whole figure card', () => {
  const after = moveCardBySpan(cardFixture(), 0, 2, 1);
  assert.deepEqual(shape(after), ['image', 'P1', 'P2']);
  assert.equal(proseCards(after).length, 1);
});

await test('a move at either end is a no-op that returns the same array', () => {
  const list = cardFixture();
  assert.equal(moveCardBySpan(list, 0, 2, -1), list, 'the first card cannot move up');
  assert.equal(moveCardBySpan(list, 2, 1, 1), list, 'the last card cannot move down');
  assert.equal(moveCardBySpan(list, 1, 1, -1), list, 'index 1 is not a card boundary');
  assert.equal(moveCardBySpan([], 0, 1, -1).length, 0);
});

await test('the card span comes from the document, not from the caller count', () => {
  // A caller working from a stale render passes count 1 for a two-paragraph
  // card. The card is the unit, so the move must still carry both paragraphs.
  const after = moveCardBySpan(cardFixture(), 0, 1, 1);
  assert.deepEqual(shape(after), ['image', 'P1', 'P2']);
  assert.equal(proseCards(after).length, 1);
});

/* ------------------------------------------------------------------ *
 * 9. boot.js -- leaving a report does not strand the edit
 *
 * `if (leavingReport) store.saveNow();` was fired and forgotten, with
 * `store.set({route: next})` on the very next line. flushSaves() suspends on the
 * save in flight, so by the time it resumed the route had already moved -- to
 * the shelf, where there was no report at all. Watched in Edge: the store ended
 * {dirty:true, rev:2, saveState:'saved', dir:null}, the disk held the first edit
 * only, and the second edit was gone with nothing on screen saying so.
 *
 * This section drives the real module: a fake window whose `location.hash` fires
 * hashchange the way a browser does, so navigation goes through boot.js's own
 * router. Both assertions fail against the fire-and-forget version.
 * ------------------------------------------------------------------ */

section('boot.js -- leaving a report');

let fakeBrowserListeners = new Map();

function fakeBrowser(initialHash) {
  const listeners = new Map();
  fakeBrowserListeners = listeners;
  let hash = initialHash;
  const fire = (type) => {
    for (const fn of (listeners.get(type) || []).slice()) fn({ type: type });
  };
  const element = () => ({
    id: '', className: '', textContent: '',
    appendChild() {}, setAttribute() {},
  });
  const host = element();
  globalThis.document = {
    visibilityState: 'visible',
    getElementById: () => host,
    createElement: () => element(),
    body: { appendChild() {} },
  };
  globalThis.window = {
    addEventListener(type, fn) {
      const list = listeners.get(type) || [];
      list.push(fn);
      listeners.set(type, list);
    },
    removeEventListener() {},
    preact: { h: () => null, Fragment: {}, render: () => {} },
    preactHooks: globalThis.preactHooks,
    htm: { bind: () => () => null },
    location: {
      get hash() { return hash; },
      set hash(value) {
        if (value === hash) return;
        hash = value;
        queueMicrotask(() => fire('hashchange'));
      },
    },
  };
  return { listeners: listeners, fire: fire };
}

await test('leaving a report flushes the pending edit BEFORE the route changes', async () => {
  store.reset();
  const recorder = putRecorder();
  const release = recorder.hold();
  const browser = fakeBrowser('#/r/' + DIR);
  const BOOT_PATH = path.resolve(HERE, '..', 'web', 'assets', 'v2', 'js', 'boot.js');
  await import(pathToFileURL(BOOT_PATH).href);

  // boot.js reads the report the address names; replace what it loaded with the
  // fixture, exactly as a fetched document arrives: with its destination.
  assert.ok(await until(() => store.get().route.dir === DIR, 4000), 'boot never routed to the report');
  const project = openReport();
  store.setProject(project, { dir: DIR, mtime: 100 });

  typeInto(project, 'base EDITONE');
  store.markDirty();
  assert.ok(await until(() => recorder.puts.length === 1, 4000), 'the first save never started');

  // A second keystroke while that PUT is held, and then the user leaves for the
  // shelf. This is the case that stranded the edit: no report, no destination.
  typeInto(project, 'base EDITONE EDITTWO');
  store.markDirty();
  globalThis.window.location.hash = '#/';
  await napMs(50);
  release();

  assert.ok(await until(() => store.get().route.view === 'home', 6000), 'the route never reached the shelf');
  // Read the moment the route moved, not some point after it: the contract is
  // that the flush FINISHES first, and a fire-and-forget flush is caught here
  // even when the save loop would have got there eventually on its own.
  assert.equal(recorder.puts.length, 2, 'the route moved before the pending edit was flushed');
  assert.ok(recorder.puts[1].body.indexOf('EDITTWO') >= 0, 'the second write did not carry the edit');
  assert.equal(recorder.puts[1].routeAtPut, DIR,
    'the flush happened AFTER the route had already left the report');
  assert.equal(store.get().dirty, false, 'the edit was stranded: dirty with nowhere left to write it');
  assert.equal(recorder.puts[1].dir, DIR);
}, { pin: true });

// The unload guard FLUSHES an edit inside the debounce and asks nothing: the
// write is on the wire before the page goes, and lands (measured in a real
// browser by test_v2_save_conflict.js). The browser's prompt is kept for the
// one case the flush cannot cover -- a write already in flight, which a second
// edit typed during it has no request of its own for yet.
await test('the page unloading inside the debounce is flushed, without a prompt', async () => {
  const recorder = putRecorder();
  const project = openReport();
  store.set({ route: { view: 'editor', dir: DIR, node: null } });
  store.setProject(project, { dir: DIR, mtime: 100 });
  typeInto(project, 'base UNLOADEDIT');
  store.markDirty();
  // Inside the 800ms debounce: nothing has gone out yet.
  assert.equal(recorder.puts.length, 0);

  const handlers = (name) => (fakeBrowserListeners.get(name) || []);
  const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, returnValue: null };
  for (const fn of handlers('beforeunload')) fn(event);

  assert.ok(await until(() => recorder.puts.length === 1, 4000),
    'the guard did not even try to write the edit out');
  assert.ok(recorder.puts[0].body.indexOf('UNLOADEDIT') >= 0);
  assert.equal(event.defaultPrevented, false, 'the prompt fired for an edit the flush covers');
  await until(() => store.get().dirty === false, 4000);
  store.reset();
}, { pin: true });

await test('the page unloading with a write IN FLIGHT is asked about', async () => {
  const recorder = putRecorder();
  const release = recorder.hold();
  const project = openReport();
  store.set({ route: { view: 'editor', dir: DIR, node: null } });
  store.setProject(project, { dir: DIR, mtime: 100 });
  typeInto(project, 'base INFLIGHT');
  store.markDirty();
  assert.ok(await until(() => recorder.puts.length === 1, 4000), 'the save never started');
  assert.equal(store.get().saveState, 'saving');
  // A second keystroke during the held PUT: nothing on the wire carries it.
  typeInto(project, 'base INFLIGHT SECOND');
  store.markDirty();

  const handlers = (name) => (fakeBrowserListeners.get(name) || []);
  const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, returnValue: null };
  for (const fn of handlers('beforeunload')) fn(event);
  assert.equal(event.defaultPrevented, true, 'nothing asked with an edit that no request carries');

  release();
  await until(() => store.get().dirty === false, 6000);
  store.reset();
}, { pin: true });

/* ------------------------------------------------------------------ *
 * report
 * ------------------------------------------------------------------ */

console.log('');
if (failures.length) {
  console.log(failures.length + ' of ' + count + ' checks FAILED:');
  for (const name of failures) console.log('  - ' + name);
  process.exit(1);
}
console.log('all ' + count + ' checks passed');
