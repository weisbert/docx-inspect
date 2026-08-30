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

export function Menu(props) {
  const { items = [], x = 0, y = 0, onClose, width = 210, ariaLabel, className } = props || {};

  const boxRef = useRef(null);
  const openerRef = useRef(null);
  const [pos, setPos] = useState({ left: x, top: y, ready: false });

  const enabledCount = items.filter((it) => !it.disabled).length;

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const w = box.offsetWidth;
    const h = box.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = x;
    let top = y;
    if (left + w > vw - EDGE) left = x - w;
    if (left < EDGE) left = EDGE;
    if (top + h > vh - EDGE) top = y - h;
    if (top < EDGE) top = EDGE;
    setPos({ left, top, ready: true });
  }, [x, y, items.length]);

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
    const onScroll = () => close('scroll');
    document.addEventListener('mousedown', onDocDown, true);
    window.addEventListener('resize', onScroll);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDocDown, true);
      window.removeEventListener('resize', onScroll);
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
