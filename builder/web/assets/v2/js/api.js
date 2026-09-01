// api.js -- one thin async function per server endpoint.
//
// Rules for this file:
//   * no user-facing strings live here (they belong to the views, sourced from
//     the frozen string list);
//   * `dir` -- the report folder, a path such as '1108/CLKDIV_5G/CDR' -- is
//     ALWAYS passed as the query parameter `dir`, never interpolated into a URL
//     path, so a folder name can never change which endpoint is hit;
//   * every function is async and throws ApiError when the call does not
//     succeed. Callers decide what to show.
//
// The server (builder/web/server.py) answers JSON everywhere and reports
// failures either as a non-2xx status with {"error": "..."} or, for a few
// endpoints, as 200 with an "error" field. Both raise ApiError here.
//
// The text-exchange endpoints are the one place where "the call failed" is not
// a good enough answer: a package that looks cut off, a merge that went stale
// while the user was deciding, and a merge posted without its token are three
// different conversations with the user, and two of them must NOT read as a
// bug. Those three get their own ApiError subclasses so a view can branch on
// the type instead of matching on message text.

import * as diag from './diag.js';

const DEFAULT_TIMEOUT_MS = 15000;

export class ApiError extends Error {
  constructor(message, info) {
    super(message);
    this.name = 'ApiError';
    const meta = info || {};
    this.status = meta.status == null ? 0 : meta.status;
    this.payload = meta.payload == null ? null : meta.payload;
    this.url = meta.url || '';
    this.timeout = !!meta.timeout;
  }
}

// merge3: the returned package is missing so much of the common ancestor that
// it looks cut off mid-copy. `truncated` is the server's description of what
// looks missing -- {kind, missing, total, detail} -- and is what the view needs
// to name the damage. Recoverable: merge3(..., {allowBulkDelete: true}) says
// "those deletions are real, merge them anyway".
export class TruncatedPackageError extends ApiError {
  constructor(message, info) {
    super(message, info);
    this.name = 'TruncatedPackageError';
    const meta = info || {};
    this.truncated = meta.truncated == null ? null : meta.truncated;
    this.override = 'allowBulkDelete';
  }
}

// merge3-apply: project.json moved between computing the merge and applying it,
// so writing the merged report would erase whatever landed in between. The
// refusal is the correct outcome, not a failure -- recompute the merge against
// the current report. Nothing was written.
export class StaleMergeError extends ApiError {
  constructor(message, info) {
    super(message, info);
    this.name = 'StaleMergeError';
    const meta = info || {};
    this.expected = meta.expected == null ? null : meta.expected;   // token the merge was computed from
    this.actual = meta.actual == null ? null : meta.actual;         // fingerprint of the report right now
  }
}

// merge3-apply without the token merge3 handed out. Same recovery as a stale
// merge -- recompute -- but a different cause, so it stays a distinct type.
export class MergeTokenMissingError extends ApiError {
  constructor(message, info) {
    super(message, info);
    this.name = 'MergeTokenMissingError';
  }
}

/* ------------------------------------------------------------------ *
 * internals
 * ------------------------------------------------------------------ */

function buildUrl(path, query) {
  const params = new URLSearchParams();
  const q = query || {};
  const keys = Object.keys(q);
  for (let i = 0; i < keys.length; i++) {
    const value = q[keys[i]];
    if (value === undefined || value === null || value === '') continue;
    params.set(keys[i], String(value));
  }
  const qs = params.toString();
  return qs ? path + '?' + qs : path;
}

// Merge an optional caller signal with our own timeout signal. AbortSignal.any
// is not available everywhere, so this is done by hand.
function withTimeout(signal, ms) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ms);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort);
  }
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    done: () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    },
  };
}

function errorMessage(payload, response, url) {
  if (payload && typeof payload === 'object' && payload.error) return String(payload.error);
  if (typeof payload === 'string' && payload.trim()) return payload.trim().slice(0, 400);
  return 'HTTP ' + response.status + ' ' + url;
}

// The one place that talks to fetch(). JSON in, JSON out.
//
// options: {query, body, signal, timeout, method, rawBody, headers}
//   body     -- serialised with JSON.stringify
//   rawBody  -- sent verbatim (used by paste-import / copy-diff, whose bodies
//               are a bare document rather than a wrapper object)
export async function request(method, path, options) {
  // Every call is traced for diag.js: what left, what came back, what never
  // came back. The trace holds the METHOD and the PATH -- never the query, the
  // body or the answer -- so a pasted diagnostic carries no report content.
  const trace = diag.started(method + ' ' + path);
  try {
    const value = await requestOnce(method, path, options);
    diag.finished(trace, null);
    return value;
  } catch (err) {
    const status = err && err.status ? ' (HTTP ' + err.status + ')' : '';
    diag.finished(trace, String((err && err.message) || err) + status);
    throw err;
  }
}

async function requestOnce(method, path, options) {
  const opt = options || {};
  const url = buildUrl(path, opt.query);
  const guard = withTimeout(opt.signal, opt.timeout || DEFAULT_TIMEOUT_MS);
  const init = { method: method, signal: guard.signal, headers: {} };
  if (opt.headers) Object.assign(init.headers, opt.headers);
  if (opt.rawBody !== undefined && opt.rawBody !== null) {
    init.body = opt.rawBody;
    if (!init.headers['Content-Type']) init.headers['Content-Type'] = 'text/plain; charset=utf-8';
  } else if (opt.body !== undefined) {
    init.body = JSON.stringify(opt.body);
    init.headers['Content-Type'] = 'application/json; charset=utf-8';
  }

  let response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    const timedOut = guard.didTimeout();
    throw new ApiError(timedOut ? 'request timed out: ' + url : String(err && err.message ? err.message : err), {
      status: 0,
      url: url,
      timeout: timedOut,
    });
  } finally {
    guard.done();
  }

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (err) {
      payload = text;
    }
  }
  if (!response.ok) {
    throw new ApiError(errorMessage(payload, response, url), {
      status: response.status,
      payload: payload,
      url: url,
    });
  }
  // A handful of endpoints answer 200 with {"error": ...}; treat that as a failure
  // too, so callers only ever need one error path.
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && payload.error) {
    throw new ApiError(String(payload.error), {
      status: response.status,
      payload: payload,
      url: url,
    });
  }
  return payload;
}

const get = (path, query, options) => request('GET', path, Object.assign({ query: query }, options || {}));
const post = (path, query, body, options) =>
  request('POST', path, Object.assign({ query: query, body: body }, options || {}));

/* ------------------------------------------------------------------ *
 * config / project
 * ------------------------------------------------------------------ */

// The frontend-facing slice of the template config: skeleton, cover fields,
// compliance defaults, table presets. `template` is optional and only needed
// when asking for a specific library template rather than the report's own.
export function getConfig(dir, template) {
  return get('/api/config', { dir: dir, template: template });
}

// -> {project, meta_info:{exists, mtime}}. The mtime is the optimistic-concurrency
// token: hand it back to saveProject so a second tab cannot clobber this one.
export function getProject(dir) {
  return get('/api/project', { dir: dir });
}

// options: {savedAt} -- the mtime this client last saw. The server answers 409
// when the file changed underneath, which surfaces as ApiError.status === 409.
export function saveProject(dir, project, options) {
  const opt = options || {};
  return request('PUT', '/api/project', {
    query: { dir: dir, saved_at: opt.savedAt },
    body: project,
    signal: opt.signal,
  });
}

// Flat list of report folders under the reports root -- the pre-three-level
// listing. getTree() is the shaped replacement; this stays as a fallback.
export function getProjects() {
  return get('/api/projects');
}

// -> {projects:[{id,name,modules:[{id,name,reports:[{dir,stage,name,mtime,
//     overSpec,exchange:{last,sectionsSince}}]}]}]}
export function getTree() {
  return get('/api/tree');
}

export function getTemplates() {
  return get('/api/templates');
}

export function getTemplate(name) {
  return get('/api/template', { id: name });
}

// body: {project, module, stage, from, mode:'inherit'|'template'|'docx', clearValues}
export function reportNew(body) {
  return post('/api/report-new', null, body, { timeout: 60000 });
}

// body: {dir, srcReport, targetBlock} -> matched rows + MIN/TYP/MAX values +
// the provenance stamp for a reference column.
export function refcol(body) {
  return post('/api/refcol', null, body, { timeout: 60000 });
}

/* ------------------------------------------------------------------ *
 * preview
 * ------------------------------------------------------------------ */

// One section rendered by Word -> {pages:[{png_b64,w,h}], ms}. Word is kept
// resident server-side; a cold start costs a few seconds, hence the long timeout.
export function previewSection(dir, node, options) {
  const opt = options || {};
  return post('/api/preview-section', null, { dir: dir, node: node }, {
    timeout: opt.timeout || 60000,
    signal: opt.signal,
  });
}

/* ------------------------------------------------------------------ *
 * text exchange
 * ------------------------------------------------------------------ */

// Three-way merge of a returned report against the recorded baseline.
//
// POST /api/merge3  {dir, incoming, allowBulkDelete?}
//   200 {merged, conflicts:[...], auto, pending, deletions:[...], token, truncated:null}
//   409 {error:"truncated", truncated:{kind, missing, total, detail}}
//
// Computes only; nothing is written until merge3Apply. Three fields of that
// answer are not optional decoration:
//   * `merged`    -- hand this SAME object back to merge3Apply. It carries the
//                    conflict markers the apply resolves against.
//   * `token`     -- the fingerprint of the project.json the merge was computed
//                    from; merge3Apply refuses without it.
//   * `deletions` -- every section dropped without asking, because one side
//                    deleted it and the other never touched it. A deletion the
//                    user is not shown is indistinguishable from lost work, so
//                    the view must list these before Apply.
//
// options: {allowBulkDelete, signal, timeout}. `allowBulkDelete` is the override
// for TruncatedPackageError: only send it after the user has seen what looks
// missing and said the deletions are real.
export async function merge3(dir, incoming, options) {
  const opt = options || {};
  const body = { dir: dir, incoming: incoming };
  if (opt.allowBulkDelete) body.allowBulkDelete = true;
  let payload;
  try {
    payload = await post('/api/merge3', null, body, {
      timeout: opt.timeout || 60000,
      signal: opt.signal,
    });
  } catch (err) {
    throw classifyMergeError(err);
  }
  const out = payload && typeof payload === 'object' ? payload : {};
  return {
    merged: out.merged == null ? null : out.merged,
    conflicts: Array.isArray(out.conflicts) ? out.conflicts : [],
    auto: Number(out.auto) || 0,
    pending: Number(out.pending) || 0,
    deletions: Array.isArray(out.deletions) ? out.deletions : [],
    token: out.token == null ? '' : String(out.token),
    truncated: out.truncated == null ? null : out.truncated,
  };
}

// Write the outcome of a merge.
//
// POST /api/merge3-apply  {dir, merged, choices, token}
//   200 {ok:true, applied, snapshot}
//   400 {error:"merge_token_missing"}
//   409 {error:"stale_merge", expected, actual}
//
// `merged` and `token` come straight from the merge3 answer; `choices` are the
// user's per-conflict decisions. A refused apply writes nothing at all -- no
// snapshot, no project.json, no baseline -- so a stale merge costs the user only
// the decisions, and those are recomputed by re-running merge3.
export async function merge3Apply(dir, result) {
  const res = result || {};
  const token = res.token == null ? '' : String(res.token);
  // Posting an apply with no token can only ever be refused, and an apply is the
  // one call that replaces the whole report -- so stop here rather than ask the
  // server to say no.
  if (!token) {
    throw new MergeTokenMissingError('merge_token_missing', {
      status: 0,
      url: '/api/merge3-apply',
    });
  }
  const body = { dir: dir, merged: res.merged, choices: res.choices || [], token: token };
  let payload;
  try {
    payload = await post('/api/merge3-apply', null, body, {
      timeout: res.timeout || 60000,
      signal: res.signal,
    });
  } catch (err) {
    throw classifyMergeError(err);
  }
  const out = payload && typeof payload === 'object' ? payload : {};
  return {
    ok: out.ok !== false,
    applied: Number(out.applied) || 0,
    snapshot: out.snapshot == null ? '' : String(out.snapshot),
  };
}

// Turn the documented merge failures into the three typed errors above and
// leave everything else as the ApiError it already is. Both the status and the
// payload are inspected, because the server reports some of these as a non-2xx
// status and request() also raises on a 200 carrying an "error" field.
function classifyMergeError(err) {
  if (!(err instanceof ApiError)) return err;
  const payload = err.payload && typeof err.payload === 'object' ? err.payload : {};
  const code = payload.error == null ? '' : String(payload.error);
  const info = { status: err.status, payload: err.payload, url: err.url };
  if (code === 'truncated' || payload.truncated) {
    return new TruncatedPackageError(code || 'truncated',
      Object.assign({ truncated: payload.truncated == null ? null : payload.truncated }, info));
  }
  if (code === 'stale_merge') {
    return new StaleMergeError(code, Object.assign({
      expected: payload.expected == null ? null : payload.expected,
      actual: payload.actual == null ? null : payload.actual,
    }, info));
  }
  if (code === 'merge_token_missing') return new MergeTokenMissingError(code, info);
  return err;
}

// The pasted-text upstream channel: the body is the raw project JSON text, byte
// for byte, so it never passes through anything that could rewrite it.
export function pasteImport(dir, text) {
  return request('POST', '/api/paste-import', {
    query: { dir: dir },
    rawBody: text,
    timeout: 60000,
  });
}

// The incremental upstream channel: post the in-memory project, get back a
// compact op-diff against the recorded baseline.
// -> {ok, no_baseline, empty, diff_text, summary, diff_chars, full_chars}
export function copyDiff(dir, project) {
  return request('POST', '/api/copy-diff', {
    query: { dir: dir },
    rawBody: JSON.stringify(project),
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    timeout: 60000,
  });
}

// Apply a returned update package. body: {name, zip_b64}.
export function applyUpdate(dir, body) {
  const payload = Object.assign({ dir: dir }, body || {});
  return post('/api/apply-update', null, payload, { timeout: 120000 });
}

// Undo the most recent apply / paste import by restoring the newest backup.
export function rollback(dir) {
  return post('/api/rollback', null, { dir: dir }, { timeout: 60000 });
}

/* ------------------------------------------------------------------ *
 * snapshots, report management
 * ------------------------------------------------------------------ */

export function getAutosaves(dir) {
  return get('/api/autosaves', { dir: dir });
}

// `id` is the snapshot's file name as listed by getAutosaves.
export function autosaveRestore(dir, id) {
  return post('/api/autosave-restore', null, { dir: dir, name: id });
}

// Moves the report to _trash/ -- recoverable, never a hard delete.
export function projectDelete(dir) {
  return post('/api/project-delete', null, { dir: dir });
}

export function projectRename(dir, name, title) {
  return post('/api/project-rename', null, { dir: dir, new_name: name, title: title });
}

export function projectCopy(dir, name) {
  return post('/api/project-copy', null, { dir: dir, new_name: name }, { timeout: 60000 });
}

/* ------------------------------------------------------------------ *
 * assets
 * ------------------------------------------------------------------ */

export function getAssets(dir) {
  return get('/api/assets', { dir: dir });
}

export function assetTag(dir, file, tags) {
  return post('/api/asset-tag', null, { dir: dir, file: file, tags: tags });
}

export function assetRename(dir, from, to) {
  return post('/api/asset-rename', null, { dir: dir, from: from, to: to });
}

// Store a pasted or dropped image. `png` is either raw bytes/Blob or a base64
// string; `name` is optional and the server makes it unique.
export function putImage(dir, section, name, png) {
  if (typeof png === 'string') {
    return post('/api/image', { dir: dir }, { section: section, name: name, png_b64: png }, { timeout: 60000 });
  }
  return request('POST', '/api/image', {
    query: { dir: dir, section: section, name: name },
    rawBody: png,
    headers: { 'Content-Type': 'image/png' },
    timeout: 60000,
  });
}

// The only file route: a report's images/ subtree. `file` is stored as
// 'images/<name>', so a leading 'images/' is tolerated and normalised away.
export function imgUrl(dir, file, version) {
  let rel = String(file || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (rel.toLowerCase().startsWith('images/')) rel = rel.slice('images/'.length);
  const params = new URLSearchParams();
  params.set('dir', dir == null ? '' : String(dir));
  if (version) params.set('v', String(version));
  const path = rel.split('/').map(encodeURIComponent).join('/');
  return '/images/' + path + '?' + params.toString();
}

/* ------------------------------------------------------------------ *
 * import / export
 * ------------------------------------------------------------------ */

// body: {docx_b64, mode:'report'|'template', dir?, ...}
export function importDocx(body) {
  return post('/api/import-docx', null, body, { timeout: 180000 });
}

// body: {xlsx_b64, mode:'grid'|'compliance'}
export function importXlsx(body) {
  return post('/api/import-xlsx', null, body, { timeout: 120000 });
}

// One table/datatable block -> {ok, filename, xlsx_b64}
export function exportXlsx(dir, block) {
  return post('/api/export-xlsx', null, { dir: dir, block: block }, { timeout: 60000 });
}

// Compliance check for one block's data -> the over-spec positions.
export function validateCompliance(dir, block) {
  const data = block && block.data ? block.data : block;
  return post('/api/validate-compliance', null, { dir: dir, data: data }, { timeout: 60000 });
}

// The plain, non-streaming export. Used on its own and as exportStream's fallback.
export function exportPlain(dir, options) {
  const opt = options || {};
  return post('/api/export', { dir: dir, fmt: opt.fmt || 'pdf' }, { save_first: !!opt.saveFirst }, {
    timeout: opt.timeout || 600000,
    signal: opt.signal,
  });
}

// Streaming export. Reads the newline-delimited JSON feed and hands each event
// to onEvent({type:'phase'|'progress'|'done'|'error', ...}).
//
// If anything about the stream fails -- no ReadableStream, a proxy that buffers,
// a server too old to have the endpoint -- it falls back to POST /api/export and
// emits one synthetic indeterminate progress event followed by the real done
// event, so the caller's progress UI behaves identically either way.
export async function exportStream(dir, onEvent, options) {
  const opt = options || {};
  const emit = (event) => {
    if (typeof onEvent === 'function') {
      try {
        onEvent(event);
      } catch (err) {
        /* a listener must never break the transfer */
      }
    }
  };

  const fallback = async (reason) => {
    emit({ type: 'progress', done: 0, total: 0, indeterminate: true, fallback: true, reason: reason || '' });
    const result = await exportPlain(dir, opt);
    emit({ type: 'done', result: result, fallback: true });
    return result;
  };

  const url = buildUrl('/api/export-stream', { dir: dir, fmt: opt.fmt || 'pdf' });
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ save_first: !!opt.saveFirst }),
      signal: opt.signal,
    });
  } catch (err) {
    return fallback(String(err && err.message ? err.message : err));
  }
  if (!response.ok || !response.body || !response.body.getReader) {
    return fallback('stream unavailable');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let result = null;
  let sawEvent = false;
  let streamError = null;

  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch (err) {
      return; // a partial or non-JSON line is simply skipped
    }
    sawEvent = true;
    emit(event);
    if (event.type === 'done') result = event.result;
    if (event.type === 'error') streamError = event.error || 'export failed';
  };

  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        handleLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
      }
    }
    handleLine(buffer);
  } catch (err) {
    if (opt.signal && opt.signal.aborted) throw err;
    if (!sawEvent) return fallback(String(err && err.message ? err.message : err));
    streamError = streamError || String(err && err.message ? err.message : err);
  }

  if (streamError) throw new ApiError(String(streamError), { status: 0, url: url });
  if (!result) return fallback('stream ended without a result');
  return result;
}

/* ------------------------------------------------------------------ *
 * tool version
 * ------------------------------------------------------------------ */

// -> {local, available, fixes, needsRestart, changes:[...]}
export function getVersion() {
  return get('/api/version', null, { timeout: 5000 });
}

export function health() {
  return get('/api/health', null, { timeout: 5000 });
}
