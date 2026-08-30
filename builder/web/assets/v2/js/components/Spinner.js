/*
 * Spinner - an indeterminate ring. Used where a step genuinely has no
 * progress to report; anything with a known step count gets a real progress
 * readout instead.
 *
 * CSS classes owned by css/app.css:
 *   .rw-spinner               animated ring, sized from --rw-spinner-size
 *   .rw-spinner--inline       sits on the text baseline next to a label
 *
 * The size prop is passed through as the CSS custom property
 * --rw-spinner-size so app.css keeps control of stroke width and colour.
 *
 * Props
 *   size    px, default 16
 *   inline  boolean
 *   label   accessible name; without one the spinner is aria-hidden
 */

import { html, cx } from './base.js';

export function Spinner(props) {
  const { size = 16, inline = false, label, className } = props || {};
  return html`
    <span
      class=${cx('rw-spinner', inline && 'rw-spinner--inline', className)}
      style=${{ '--rw-spinner-size': size + 'px', width: size + 'px', height: size + 'px' }}
      role=${label ? 'status' : null}
      aria-label=${label || null}
      aria-hidden=${label ? null : 'true'}
    ></span>`;
}

export default Spinner;
