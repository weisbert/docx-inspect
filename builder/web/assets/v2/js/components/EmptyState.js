/*
 * EmptyState - a drop target, not an illustration: dashed border, sunken fill,
 * centred, and the whole block accepts paste and drop. It says what is
 * required and how to supply it.
 *
 * Drag and paste handling stays with the view that owns the data, so the
 * handlers are passed in. When onDrop is supplied the component tracks the
 * drag-over state and adds .rw-empty--over for you.
 *
 * CSS classes owned by css/app.css:
 *   .rw-empty
 *   .rw-empty--over           a file is hovering over the target
 *   .rw-empty--compact
 *   .rw-empty__glyph
 *   .rw-empty__title
 *   .rw-empty__body
 *   .rw-empty__actions
 *
 * Props
 *   title     noun phrase (from 02_GLOSSARY_EN.md)
 *   body      one sentence saying how to supply what is missing
 *   glyph     optional large glyph
 *   compact   boolean, the inline version used inside a card
 *   onDrop    (event) => void; enables drag tracking
 *   onPaste   (event) => void; the block is focusable when this is set
 *   onClick   (event) => void
 *   children  action buttons
 */

import { html, cx, useState } from './base.js';

export function EmptyState(props) {
  const {
    title, body, glyph, compact = false, onDrop, onPaste, onClick,
    className, children,
  } = props || {};

  const [over, setOver] = useState(false);

  const dragProps = onDrop ? {
    onDragOver: (ev) => { ev.preventDefault(); if (!over) setOver(true); },
    onDragLeave: (ev) => { if (ev.currentTarget === ev.target) setOver(false); },
    onDrop: (ev) => { ev.preventDefault(); setOver(false); onDrop(ev); },
  } : {};

  const keyProps = (onPaste || onClick) ? {
    tabIndex: 0,
    onKeyDown: (ev) => {
      if (!onClick) return;
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onClick(ev); }
    },
  } : {};

  return html`
    <div
      class=${cx('rw-empty', over && 'rw-empty--over', compact && 'rw-empty--compact', className)}
      onPaste=${onPaste || null}
      onClick=${onClick || null}
      ...${dragProps}
      ...${keyProps}
    >
      ${glyph ? html`<div class="rw-empty__glyph" aria-hidden="true">${glyph}</div>` : null}
      ${title ? html`<div class="rw-empty__title">${title}</div>` : null}
      ${body ? html`<div class="rw-empty__body">${body}</div>` : null}
      ${children ? html`<div class="rw-empty__actions">${children}</div>` : null}
    </div>`;
}

export default EmptyState;
