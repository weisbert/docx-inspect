/*
 * Banner - the three level banner from 01_TOKENS.md: a 3px left bar, a tinted
 * body and a glyph. There are exactly three levels and no others.
 *
 *   error  ✕  blocking
 *   warn   !  attention
 *   done   ✓  finished
 *
 * CSS classes owned by css/app.css:
 *   .rw-banner
 *   .rw-banner--error  .rw-banner--warn  .rw-banner--done
 *   .rw-banner__glyph
 *   .rw-banner__body
 *   .rw-banner__title
 *   .rw-banner__action
 *
 * Props
 *   level     'error' (default) | 'warn' | 'done'
 *   title     optional bold first line
 *   action    nodes placed at the right edge, usually a Button
 *   children  the message text
 */

import { html, cx } from './base.js';

const GLYPH = { error: '✕', warn: '!', done: '✓' };
const ROLE = { error: 'alert', warn: 'status', done: 'status' };

export function Banner(props) {
  const { level = 'error', title, action, className, children } = props || {};
  const lv = GLYPH[level] ? level : 'error';

  return html`
    <div class=${cx('rw-banner', 'rw-banner--' + lv, className)} role=${ROLE[lv]}>
      <span class="rw-banner__glyph" aria-hidden="true">${GLYPH[lv]}</span>
      <div class="rw-banner__body">
        ${title ? html`<div class="rw-banner__title">${title}</div>` : null}
        ${children}
      </div>
      ${action ? html`<div class="rw-banner__action">${action}</div>` : null}
    </div>`;
}

export default Banner;
