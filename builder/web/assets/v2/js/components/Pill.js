/*
 * Pill - a small status pill. Tone carries meaning, never decoration, so the
 * default is neutral grey and a coloured tone must be earned:
 *
 *   neutral  chrome, counts
 *   bad      over spec, blocking
 *   warn     attention
 *   good     finished
 *   accent   the current selection
 *   note     a note carried alongside the document
 *
 * A Pill with onClick becomes a real button so it stays keyboard reachable;
 * without one it is a plain span and is skipped by Tab.
 *
 * CSS classes owned by css/app.css:
 *   .rw-pill
 *   .rw-pill--neutral  .rw-pill--bad  .rw-pill--warn
 *   .rw-pill--good     .rw-pill--accent  .rw-pill--note
 *   .rw-pill--button          interactive variant
 *   .rw-pill__glyph
 *
 * Props
 *   tone      'neutral' (default) | 'bad' | 'warn' | 'good' | 'accent' | 'note'
 *   glyph     optional leading glyph
 *   title     tooltip
 *   onClick   makes the pill a button
 *   children  the label
 */

import { html, cx } from './base.js';

const TONES = { neutral: 1, bad: 1, warn: 1, good: 1, accent: 1, note: 1 };

export function Pill(props) {
  const { tone = 'neutral', glyph, title, onClick, className, children, ...rest } = props || {};
  const t = TONES[tone] ? tone : 'neutral';
  const cls = cx('rw-pill', 'rw-pill--' + t, onClick && 'rw-pill--button', className);
  const inner = html`
    ${glyph ? html`<span class="rw-pill__glyph" aria-hidden="true">${glyph}</span>` : null}
    ${children}`;

  if (onClick) {
    return html`
      <button type="button" class=${cls} title=${title || null} onClick=${onClick} ...${rest}>
        ${inner}
      </button>`;
  }
  return html`<span class=${cls} title=${title || null} ...${rest}>${inner}</span>`;
}

export default Pill;
