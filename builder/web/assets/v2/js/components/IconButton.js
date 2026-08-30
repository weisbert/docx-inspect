/*
 * IconButton - a square, glyph-only button. The glyph is decorative; the
 * accessible name comes from `title`, so callers must always pass one.
 *
 * CSS classes owned by css/app.css:
 *   .rw-iconbtn
 *   .rw-iconbtn--on           pressed / active state
 *   .rw-iconbtn--danger
 *   .rw-iconbtn--small
 *   .rw-iconbtn__glyph
 *
 * Props
 *   glyph     the character to draw
 *   title     accessible name and tooltip (from 02_GLOSSARY_EN.md)
 *   pressed   boolean, renders aria-pressed and the --on class
 *   danger    boolean
 *   small     boolean
 *   disabled  boolean
 *   onClick   (event) => void
 */

import { html, cx } from './base.js';

export function IconButton(props) {
  const {
    glyph, title, pressed, danger = false, small = false,
    disabled = false, onClick, className, ...rest
  } = props || {};

  return html`
    <button
      type="button"
      class=${cx('rw-iconbtn', pressed && 'rw-iconbtn--on', danger && 'rw-iconbtn--danger',
                 small && 'rw-iconbtn--small', className)}
      title=${title || null}
      aria-label=${title || null}
      aria-pressed=${pressed === undefined ? null : String(!!pressed)}
      disabled=${disabled || null}
      onClick=${disabled ? null : onClick}
      ...${rest}
    ><span class="rw-iconbtn__glyph" aria-hidden="true">${glyph}</span></button>`;
}

export default IconButton;
