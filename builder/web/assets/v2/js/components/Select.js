/*
 * Select - a native <select>, styled. Native is deliberate: it is keyboard
 * reachable, type-ahead works, and it does not need a portal.
 *
 * CSS classes owned by css/app.css:
 *   .rw-select
 *   .rw-select--invalid  .rw-select--small
 *   .rw-select__el
 *   .rw-select__caret
 *
 * Props
 *   value       current value
 *   options     [{value, label, disabled}] - a bare string is treated as both
 *   onChange    (value, event) => void
 *   placeholder label of a leading empty option; omit for no empty option
 *   disabled    boolean
 *   invalid     boolean
 *   small       boolean, toolbar height instead of form height
 *   id, title, ariaLabel
 */

import { html, cx } from './base.js';

function normalise(o) {
  if (o === null || o === undefined) return { value: '', label: '' };
  if (typeof o === 'string' || typeof o === 'number') return { value: o, label: String(o) };
  return { value: o.value, label: o.label === undefined ? String(o.value) : o.label, disabled: !!o.disabled };
}

export function Select(props) {
  const {
    value, options = [], onChange, placeholder, disabled = false,
    invalid = false, small = false, id, title, ariaLabel, className, ...rest
  } = props || {};

  const items = options.map(normalise);
  const current = value === undefined || value === null ? '' : String(value);

  return html`
    <span class=${cx('rw-select', invalid && 'rw-select--invalid', small && 'rw-select--small', className)}>
      <select
        class="rw-select__el"
        id=${id || null}
        title=${title || null}
        aria-label=${ariaLabel || null}
        aria-invalid=${invalid ? 'true' : null}
        disabled=${disabled || null}
        value=${current}
        onChange=${(ev) => onChange && onChange(ev.currentTarget.value, ev)}
        ...${rest}
      >
        ${placeholder !== undefined ? html`<option value="">${placeholder}</option>` : null}
        ${items.map((o) => html`
          <option value=${String(o.value)} disabled=${o.disabled || null}>${o.label}</option>`)}
      </select>
      <span class="rw-select__caret" aria-hidden="true">⌄</span>
    </span>`;
}

export default Select;
