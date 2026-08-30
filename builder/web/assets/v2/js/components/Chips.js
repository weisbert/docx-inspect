/*
 * Chips - the chip row used for stage pickers and tag filters.
 *
 * Single mode behaves like a radio group (one value, clicking a chip selects
 * it). Multi mode behaves like a set of checkboxes (clicking toggles, the
 * value is an array). Every chip is a real button, so Tab reaches the row and
 * Space / Enter activate.
 *
 * CSS classes owned by css/app.css:
 *   .rw-chips
 *   .rw-chips--wrap
 *   .rw-chip
 *   .rw-chip--on
 *   .rw-chip--disabled
 *   .rw-chip__count           trailing count, when an option supplies one
 *
 * Props
 *   value     the selected value, or an array of values when multi
 *   options   [{value, label, count, disabled}] - a bare string is both value and label
 *   onChange  (next, changedValue) => void; next is a value or an array
 *   multi     boolean, default false
 *   wrap      boolean, allow the row to wrap onto several lines
 *   ariaLabel accessible name of the group
 */

import { html, cx } from './base.js';

function normalise(o) {
  if (typeof o === 'string' || typeof o === 'number') return { value: o, label: String(o) };
  return {
    value: o.value,
    label: o.label === undefined ? String(o.value) : o.label,
    count: o.count,
    disabled: !!o.disabled,
  };
}

export function Chips(props) {
  const {
    value, options = [], onChange, multi = false, wrap = false,
    ariaLabel, className,
  } = props || {};

  const items = options.map(normalise);
  const selected = multi ? (Array.isArray(value) ? value : (value ? [value] : [])) : [];
  const isOn = (v) => (multi ? selected.indexOf(v) !== -1 : v === value);

  const pick = (v) => {
    if (!onChange) return;
    if (!multi) { onChange(v, v); return; }
    const next = selected.indexOf(v) === -1
      ? selected.concat([v])
      : selected.filter((x) => x !== v);
    onChange(next, v);
  };

  return html`
    <div class=${cx('rw-chips', wrap && 'rw-chips--wrap', className)}
         role="group" aria-label=${ariaLabel || null}>
      ${items.map((o) => {
        const on = isOn(o.value);
        const count = (o.count === undefined || o.count === null)
          ? null
          : html`<span class="rw-chip__count">${o.count}</span>`;
        return html`
          <button
            type="button"
            key=${String(o.value)}
            class=${cx('rw-chip', on && 'rw-chip--on', o.disabled && 'rw-chip--disabled')}
            aria-pressed=${String(on)}
            disabled=${o.disabled || null}
            onClick=${() => !o.disabled && pick(o.value)}
          >${o.label}${count}</button>`;
      })}
    </div>`;
}

export default Chips;
