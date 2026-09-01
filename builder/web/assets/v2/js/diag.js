/*
 * diag.js -- what to paste when something goes wrong.
 *
 * The workbench runs on a machine with no way to send a log anywhere: the only
 * channel out is text the user copies and pastes by hand. So the price of a bug
 * report is whatever the user can be bothered to type, and "it froze" is what
 * that price buys. This file lowers the price to one click.
 *
 * It keeps a small ring of things that happened -- route changes, requests that
 * failed, requests still in flight, uncaught errors -- and formats them, with
 * the version and the browser, as plain text. Nothing leaves the machine on its
 * own; `copyReport()` puts the text on the clipboard and the user decides where
 * it goes.
 *
 * Rules:
 *   * it must never throw. A diagnostics helper that breaks the app it is
 *     diagnosing is worse than no diagnostics at all: every entry point here is
 *     wrapped, and a failure inside is swallowed;
 *   * it holds no report CONTENT -- paths, endpoints, statuses and messages
 *     only. What the user is writing about is their business and their
 *     employer's, and this text is meant to be pasted into a chat window;
 *   * it is imported by api.js and boot.js, so it may not import either of
 *     them. It depends on nothing.
 */

const MAX_EVENTS = 60;
const BOOTED = Date.now();

const events = [];          // {t, kind, text}
const pending = new Map();  // id -> {t, what}

let seq = 0;
let toolVersion = null;     // filled in by boot.js once /api/version answers
let routeNow = '';

function push(kind, text) {
  try {
    events.push({ t: Date.now(), kind: String(kind), text: String(text).slice(0, 300) });
    while (events.length > MAX_EVENTS) events.shift();
  } catch (err) { /* diagnostics never break the app */ }
}

/* -- what the rest of the app calls -------------------------------- */

// A plain note: 'open', 'view', 'export', anything worth a line.
export function note(kind, text) {
  push(kind, text);
}

// The route the user is looking at, kept out of the ring so it is always
// current even after 60 events have scrolled past.
export function setRoute(text) {
  routeNow = String(text || '');
  push('route', routeNow);
}

export function setVersion(info) {
  toolVersion = info || null;
}

// A request has left. Returns the id to hand back to `finished`.
export function started(what) {
  seq += 1;
  const id = seq;
  try { pending.set(id, { t: Date.now(), what: String(what).slice(0, 200) }); } catch (err) { /* ignore */ }
  return id;
}

// A request has come back. `failure` is the message when it did not succeed;
// a slow success is recorded too, because "it took 40 seconds" is a symptom.
export function finished(id, failure, ms) {
  let entry = null;
  try {
    entry = pending.get(id) || null;
    pending.delete(id);
  } catch (err) { /* ignore */ }
  const what = entry ? entry.what : '(unknown request)';
  const took = ms == null && entry ? Date.now() - entry.t : ms;
  const timing = took == null ? '' : ' [' + Math.round(took) + 'ms]';
  if (failure) push('api-fail', what + timing + ' -- ' + failure);
  else if (took != null && took >= 2000) push('api-slow', what + timing);
}

/* -- the report ---------------------------------------------------- */

function stamp(t) {
  const rel = (t - BOOTED) / 1000;
  return '+' + rel.toFixed(1) + 's';
}

function pad(text, width) {
  const s = String(text);
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

// Plain text, ready to paste. Never throws: on an internal failure it returns
// the failure, which is itself a useful thing to paste.
export function report(extra) {
  try {
    const now = Date.now();
    const lines = [];
    lines.push('Report Workbench diagnostics');
    lines.push('when     ' + new Date(now).toISOString() + '  (local ' + new Date(now).toLocaleString() + ')');
    lines.push('running  ' + Math.round((now - BOOTED) / 1000) + 's since this page loaded');
    if (toolVersion) {
      lines.push('tool     ' + (toolVersion.local || '?')
        + (toolVersion.available && toolVersion.available !== toolVersion.local
          ? '  (available ' + toolVersion.available + ')' : ''));
    }
    lines.push('page     ' + String(window.location.href).slice(0, 300));
    if (routeNow) lines.push('route    ' + routeNow);
    lines.push('window   ' + window.innerWidth + 'x' + window.innerHeight
      + '  dpr ' + (window.devicePixelRatio || 1));
    lines.push('browser  ' + String(navigator.userAgent).slice(0, 200));

    const extras = extra && typeof extra === 'object' ? Object.keys(extra) : [];
    for (let i = 0; i < extras.length; i++) {
      lines.push(pad(extras[i], 8) + ' ' + String(extra[extras[i]]).slice(0, 300));
    }

    if (pending.size) {
      lines.push('');
      lines.push('--- still waiting for an answer ---');
      pending.forEach((v) => {
        lines.push('  ' + v.what + '  -- sent ' + Math.round((now - v.t) / 1000) + 's ago, no reply yet');
      });
    }

    lines.push('');
    lines.push('--- what happened (oldest first) ---');
    if (!events.length) lines.push('  (nothing recorded)');
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      lines.push('  ' + pad(stamp(e.t), 9) + pad(e.kind, 10) + e.text);
    }
    return lines.join('\n');
  } catch (err) {
    return 'Report Workbench diagnostics could not be assembled: '
      + String(err && err.message ? err.message : err);
  }
}

// Put `text` on the clipboard. 127.0.0.1 is a secure origin, so the async API is
// there; the textarea path is the fallback for a browser that refuses it while
// the window is not focused. Returns a promise for true / false.
export function copyText(text) {
  const body = String(text == null ? '' : text);
  const fallback = () => {
    try {
      const box = document.createElement('textarea');
      box.value = body;
      box.setAttribute('readonly', 'readonly');
      box.style.position = 'fixed';
      box.style.top = '-1000px';
      document.body.appendChild(box);
      box.select();
      const ok = document.execCommand && document.execCommand('copy');
      document.body.removeChild(box);
      return !!ok;
    } catch (err) {
      return false;
    }
  };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(body).then(() => true, () => fallback());
    }
  } catch (err) { /* fall through */ }
  return Promise.resolve(fallback());
}

export function copyReport(extra) {
  return copyText(report(extra));
}

export default { note, setRoute, setVersion, started, finished, report, copyReport, copyText };
