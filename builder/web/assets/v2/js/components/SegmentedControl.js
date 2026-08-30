/*
 * SegmentedControl - the two or three way toggle that sits on --bg-rail.
 *
 * Implemented as a radio group with roving tabindex: Tab enters the control
 * once, then Left / Right / Home / End move between segments.
 *
 * CSS classes owned by css/app.css:
 *   .rw-seg
 *   .rw-seg--stretch          segments share the width evenly
 *   .rw-seg__opt
 *   .rw-seg__opt--on
 *   .rw-seg__glyph
 *
 * Props
 *   value     the selected value
 *   options   [{value, label, glyph, title, disabled}] - a bare string is both value and label
 *   onChange  (value) => void
 *   stretch   boolean
 *   ariaLabel accessible name of the group
 */

import { html, cx, useRef } from './base.js';

function normalise(o) {
  if (typeof o === 'string' || typeof o === 'number') return { value: o, label: String(o) };
  return {
    value: o.value,
    label: o.label === undefined ? String(o.value) : o.label,
    glyph: o.glyph,
    title: o.title,
    disabled: !!o.disabled,
  };
}

export function SegmentedControl(props) {
  const { value, options = [], onChange, stretch = false, ariaLabel, className } = props || {};
  const items = options.map(normalise);
  const boxRef = useRef(null);

  const move = (from, step) => {
    const usable = items.filter((o) => !o.disabled);
    if (!usable.length) return;
    let i = usable.findIndex((o) => o.value === items[from].value);
    if (i === -1) i = 0;
    let next;
    if (step === 'first') next = usable[0];
    else if (step === 'last') next = usable[usable.length - 1];
    else next = usable[(i + step + usable.length) % usable.length];
    if (onChange) onChange(next.value);
    const box = boxRef.current;
    if (box) {
      const btn = box.querySelector('[data-seg="' + String(next.value) + '"]');
      if (btn) btn.focus();
    }
  };

  const onKeyDown = (ev, index) => {
    let step = null;
    if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') step = -1;
    else if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') step = 1;
    else if (ev.key === 'Home') step = 'first';
    else if (ev.key === 'End') step = 'last';
    if (step === null) return;
    ev.preventDefault();
    move(index, step);
  };

  let activeIndex = items.findIndex((o) => o.value === value);
  if (activeIndex < 0) activeIndex = 0;

  return html`
    <div ref=${boxRef} class=${cx('rw-seg', stretch && 'rw-seg--stretch', className)}
         role="radiogroup" aria-label=${ariaLabel || null}>
      ${items.map((o, i) => {
        const on = o.value === value;
        return html`
          <button
            type="button"
            key=${String(o.value)}
            data-seg=${String(o.value)}
            class=${cx('rw-seg__opt', on && 'rw-seg__opt--on')}
            role="radio"
            aria-checked=${String(on)}
            tabIndex=${i === activeIndex ? 0 : -1}
            title=${o.title || null}
            disabled=${o.disabled || null}
            onKeyDown=${(ev) => onKeyDown(ev, i)}
            onClick=${() => !o.disabled && onChange && onChange(o.value)}
          >
            ${o.glyph ? html`<span class="rw-seg__glyph" aria-hidden="true">${o.glyph}</span>` : null}
            ${o.label}
          </button>`;
      })}
    </div>`;
}

export default SegmentedControl;
