/*
 * Button - the four button levels from 01_TOKENS.md.
 *
 * CSS classes owned by css/app.css:
 *   .rw-btn
 *   .rw-btn--primary  .rw-btn--secondary  .rw-btn--tertiary  .rw-btn--danger
 *   .rw-btn--block            full-width variant, used inside dialogs
 *   .rw-btn__glyph            leading glyph span
 *   .rw-btn[disabled]         disabled treatment
 *
 * Props
 *   level     'secondary' (default) | 'primary' | 'tertiary' | 'danger'
 *   glyph     optional leading glyph character
 *   disabled  boolean
 *   block     boolean, stretch to the container width
 *   type      native button type, defaults to 'button' so it never submits by accident
 *   title     tooltip / accessible name when the label alone is not enough
 *   onClick   (event) => void
 *   children  the label - always supplied by the caller, never hardcoded here
 */

import { html, cx } from './base.js';

const LEVELS = { primary: 1, secondary: 1, tertiary: 1, danger: 1 };

export function Button(props) {
  const {
    level = 'secondary', glyph, disabled = false, block = false,
    type = 'button', title, onClick, className, children, ...rest
  } = props || {};
  const lv = LEVELS[level] ? level : 'secondary';

  return html`
    <button
      type=${type}
      class=${cx('rw-btn', 'rw-btn--' + lv, block && 'rw-btn--block', className)}
      disabled=${disabled || null}
      aria-disabled=${disabled ? 'true' : null}
      title=${title || null}
      onClick=${disabled ? null : onClick}
      ...${rest}
    >
      ${glyph ? html`<span class="rw-btn__glyph" aria-hidden="true">${glyph}</span>` : null}
      ${children}
    </button>`;
}

export default Button;
