/*
 * Menu - a popup menu anchored at a point, used for the context menus in the
 * outline, the report shelf and the block cards.
 *
 * It is measured after mount and flipped when it would run off the window:
 * past the right edge it opens to the left of the anchor point, past the
 * bottom edge it opens above it, and it is clamped to an 8px margin either
 * way. Arrow keys, Home / End, Enter, Space and Esc all work; the first
 * enabled item takes focus on open, and focus returns to the opener on close.
 * Focus is not trapped - clicking or tabbing away closes the menu.
 *
 * THE ANCHOR. A menu belongs to the thing it was opened on, not to the page.
 * On open it takes the element under its point - a grid cell, a row, a button -
 * and from then on it FOLLOWS that element: a scroll that moves the anchor
 * moves the menu with it, a scroll of some other pane is ignored, and the menu
 * closes only once the anchor is genuinely out of sight (or gone from the
 * document). Closing on every scroll anywhere was wrong in a way that cost real
 * work: the compliance grid is wider than the pane that shows it, half the cell
 * menu acts on the column under the cursor, and bringing that column into view
 * to check it was the right one dismissed the menu about to act on it.
 *
 * CSS classes owned by css/app.css:
 *   .rw-menu
 *   .rw-menu--measuring       hidden while the first measurement happens
 *   .rw-menu__item
 *   .rw-menu__item--danger
 *   .rw-menu__item--disabled
 *   .rw-menu__glyph
 *   .rw-menu__label
 *   .rw-menu__key             right-aligned shortcut hint, --fg-faint
 *   .rw-menu__sep
 *
 * Props
 *   items    [{label, glyph, key, danger, disabled, separatorBefore, onClick}]
 *            `key` is the shortcut hint text, e.g. 'Ctrl+D'
 *   x, y     viewport coordinates of the anchor point
 *   onClose  (reason) => void
 *   width    px, default 210
 *   ariaLabel accessible name of the menu
 */

import { html, cx, useRef, useState, useEffect, useLayoutEffect } from './base.js';

const EDGE = 8;

/* The element the menu hangs off: the topmost thing under its point that is not
 * the menu itself. Asked of the document rather than guessed from a list of tag
 * names, so it is whatever the user really pointed at - a bare <td> as readily
 * as an input. */
function anchorAt(x, y, box) {
  const doc = typeof document === 'undefined' ? null : document;
  if (!doc) return null;
  const stack = typeof doc.elementsFromPoint === 'function'
    ? doc.elementsFromPoint(x, y)
    : [doc.elementFromPoint ? doc.elementFromPoint(x, y) : null];
  for (let i = 0; i < stack.length; i++) {
    const el = stack[i];
    if (!el || el === doc.documentElement || el === doc.body) continue;
    if (box && (el === box || box.contains(el))) continue;
    return el;
  }
  return null;
}

/* The ancestors that cut a hole for the anchor to be seen through: every one
 * that clips its overflow. Collected once, when the menu opens, because the
 * chain cannot change while it is open and reading styles on every scroll event
 * would be a lot of style resolution for nothing. */
function clippersOf(el) {
  const list = [];
  let node = el.parentElement;
  while (node && node !== document.body && node !== document.documentElement) {
    let style = null;
    try { style = window.getComputedStyle(node); } catch (err) { style = null; }
    if (style && (style.overflowX !== 'visible' || style.overflowY !== 'visible')) list.push(node);
    node = node.parentElement;
  }
  return list;
}

/* How much of an element a viewer can actually see: its own box, cut down by
 * each of those clippers and finally by the window. An empty result means it
 * has been scrolled out of sight. */
function visibleBox(el, clippers) {
  const r = el.getBoundingClientRect();
  let left = r.left;
  let top = r.top;
  let right = r.right;
  let bottom = r.bottom;
  for (let i = 0; i < clippers.length; i++) {
    const c = clippers[i].getBoundingClientRect();
    if (c.left > left) left = c.left;
    if (c.top > top) top = c.top;
    if (c.right < right) right = c.right;
    if (c.bottom < bottom) bottom = c.bottom;
  }
  if (left < 0) left = 0;
  if (top < 0) top = 0;
  if (right > window.innerWidth) right = window.innerWidth;
  if (bottom > window.innerHeight) bottom = window.innerHeight;
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

const clamp = (v, lo, hi) => (v < lo ? lo : (v > hi ? hi : v));

export function Menu(props) {
  const { items = [], x = 0, y = 0, onClose, width = 210, ariaLabel, className } = props || {};

  const boxRef = useRef(null);
  const openerRef = useRef(null);
  const anchorRef = useRef(null);
  // Where the point sits inside the anchor's own box, so the menu keeps the
  // same relationship to it while it travels.
  const gripRef = useRef({ dx: 0, dy: 0 });
  const clipsRef = useRef([]);
  const [point, setPoint] = useState({ px: x, py: y });
  const [pos, setPos] = useState({ left: x, top: y, ready: false });

  const enabledCount = items.filter((it) => !it.disabled).length;

  // FIRST, so the anchor is read before anything below can move the box: take
  // the element under the opening point and remember where in it the point fell.
  useLayoutEffect(() => {
    const el = anchorAt(x, y, boxRef.current);
    anchorRef.current = el;
    const r = el ? el.getBoundingClientRect() : null;
    gripRef.current = r ? { dx: x - r.left, dy: y - r.top } : { dx: 0, dy: 0 };
    clipsRef.current = el ? clippersOf(el) : [];
    setPoint({ px: x, py: y });
  }, [x, y]);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const w = box.offsetWidth;
    const h = box.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = point.px;
    let top = point.py;
    if (left + w > vw - EDGE) left = point.px - w;
    if (left < EDGE) left = EDGE;
    if (top + h > vh - EDGE) top = point.py - h;
    if (top < EDGE) top = EDGE;
    setPos({ left, top, ready: true });
  }, [point.px, point.py, items.length]);

  useEffect(() => {
    openerRef.current = document.activeElement;
    const box = boxRef.current;
    if (box) {
      const first = box.querySelector('.rw-menu__item:not([disabled])');
      (first || box).focus();
    }
    const close = (reason) => { if (onClose) onClose(reason); };
    const onDocDown = (ev) => {
      const b = boxRef.current;
      if (b && b.contains(ev.target)) return;
      close('outside');
    };
    const onResize = () => close('resize');

    const onScroll = (ev) => {
      const el = anchorRef.current;
      const t = ev && ev.target;
      // The page itself scrolling carries this absolutely positioned box along
      // with it, so there is nothing to follow and nothing to recompute; with
      // no anchor at all there is nothing to be sure of either. Close, as
      // before. Everything else is a pane, and only a pane the anchor lives in
      // is any of the menu's business.
      const pageScroll = !t || t === document || t === document.documentElement || t === document.body;
      if (pageScroll || !el) return close('scroll');
      if (typeof t.contains === 'function' && !t.contains(el)) return;
      if (!el.isConnected) return close('anchor-gone');
      const seen = visibleBox(el, clipsRef.current);
      if (seen.width <= 0 || seen.height <= 0) return close('anchor-hidden');
      const r = el.getBoundingClientRect();
      setPoint({
        px: clamp(r.left + gripRef.current.dx, seen.left, seen.right),
        py: clamp(r.top + gripRef.current.dy, seen.top, seen.bottom),
      });
    };

    document.addEventListener('mousedown', onDocDown, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDocDown, true);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true);
      const opener = openerRef.current;
      if (opener && opener.focus) {
        try { opener.focus(); } catch (err) { /* the node may be gone */ }
      }
    };
  }, []);

  const focusItem = (index) => {
    const box = boxRef.current;
    if (!box) return;
    const nodes = box.querySelectorAll('.rw-menu__item:not([disabled])');
    if (!nodes.length) return;
    const n = ((index % nodes.length) + nodes.length) % nodes.length;
    nodes[n].focus();
  };

  const currentIndex = () => {
    const box = boxRef.current;
    if (!box) return 0;
    const nodes = Array.prototype.slice.call(box.querySelectorAll('.rw-menu__item:not([disabled])'));
    const i = nodes.indexOf(document.activeElement);
    return i === -1 ? 0 : i;
  };

  const onKeyDown = (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      if (onClose) onClose('escape');
      return;
    }
    if (ev.key === 'ArrowDown') { ev.preventDefault(); focusItem(currentIndex() + 1); return; }
    if (ev.key === 'ArrowUp') { ev.preventDefault(); focusItem(currentIndex() - 1); return; }
    if (ev.key === 'Home') { ev.preventDefault(); focusItem(0); return; }
    if (ev.key === 'End') { ev.preventDefault(); focusItem(enabledCount - 1); return; }
    if (ev.key === 'Tab') {
      ev.preventDefault();
      if (onClose) onClose('tab');
    }
  };

  const run = (item) => {
    if (item.disabled) return;
    if (onClose) onClose('item');
    if (item.onClick) item.onClick(item);
  };

  return html`
    <div
      ref=${boxRef}
      class=${cx('rw-menu', !pos.ready && 'rw-menu--measuring', className)}
      role="menu"
      aria-label=${ariaLabel || null}
      tabIndex="-1"
      style=${{ left: pos.left + 'px', top: pos.top + 'px', minWidth: width + 'px' }}
      onKeyDown=${onKeyDown}
    >
      ${items.map((item, i) => html`
        <${MenuRow} key=${item.id || item.label || i} item=${item} onRun=${run} />`)}
    </div>`;
}

function MenuRow({ item, onRun }) {
  return html`
    ${item.separatorBefore ? html`<div class="rw-menu__sep" role="separator"></div>` : null}
    <button
      type="button"
      class=${cx('rw-menu__item', item.danger && 'rw-menu__item--danger',
                 item.disabled && 'rw-menu__item--disabled')}
      role="menuitem"
      tabIndex="-1"
      disabled=${item.disabled || null}
      onClick=${() => onRun(item)}
    >
      ${item.glyph !== undefined && item.glyph !== null
        ? html`<span class="rw-menu__glyph" aria-hidden="true">${item.glyph}</span>` : null}
      <span class="rw-menu__label">${item.label}</span>
      ${item.key ? html`<span class="rw-menu__key">${item.key}</span>` : null}
    </button>`;
}

export default Menu;
