/*
 * Report Workbench v2 - shared preact bindings for the component set.
 *
 * The vendor libraries are plain UMD scripts loaded by index.html before any
 * module runs, so they arrive as globals rather than as ES modules. Every
 * component file imports h / html / hooks from here instead of reaching for
 * window itself, so there is exactly one place to change if the vendor drop
 * ever ships real modules.
 *
 * This file renders nothing and owns no CSS class.
 */

const preact = globalThis.preact;
const preactHooks = globalThis.preactHooks;
const htm = globalThis.htm;

if (!preact || !preactHooks || !htm) {
  throw new Error('vendor globals missing: load preact.umd.js, hooks.umd.js and htm.umd.js first');
}

export const h = preact.h;
export const Fragment = preact.Fragment;
export const render = preact.render;
export const html = htm.bind(h);

export const useState = preactHooks.useState;
export const useEffect = preactHooks.useEffect;
export const useLayoutEffect = preactHooks.useLayoutEffect;
export const useRef = preactHooks.useRef;
export const useMemo = preactHooks.useMemo;
export const useCallback = preactHooks.useCallback;
export const useId = preactHooks.useId;

/* Join truthy class names. Kept local so components never depend on util.js. */
export function cx(...parts) {
  const out = [];
  for (const p of parts) {
    if (!p) continue;
    if (typeof p === 'string') { out.push(p); continue; }
    if (Array.isArray(p)) { const s = cx(...p); if (s) out.push(s); continue; }
    if (typeof p === 'object') {
      for (const k of Object.keys(p)) if (p[k]) out.push(k);
    }
  }
  return out.join(' ');
}

/* Elements inside `root` that can take focus, in document order. */
export const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])', '[contenteditable="true"]',
].join(',');

export function focusables(root) {
  if (!root) return [];
  return Array.prototype.filter.call(
    root.querySelectorAll(FOCUSABLE),
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}
