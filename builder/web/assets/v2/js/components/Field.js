/*
 * Field - the label / control / hint wrapper used by every form in v2.
 *
 * It labels whatever control the caller nests inside it. If the child control
 * carries its own id, pass that id as `htmlFor`; otherwise Field generates one
 * and exposes it to the child through the `controlId` render argument, i.e.
 *   ${Field({ label, children: (id) => html`<input id=${id} />` })}
 * A plain element child works too - the label then points at the field body
 * and clicking it moves focus to the first focusable control inside.
 *
 * CSS classes owned by css/app.css:
 *   .rw-field
 *   .rw-field--invalid  .rw-field--inline
 *   .rw-field__label
 *   .rw-field__req            the required marker
 *   .rw-field__control
 *   .rw-field__hint
 *   .rw-field__hint--bad
 *
 * Props
 *   label         string (from 02_GLOSSARY_EN.md)
 *   required      boolean
 *   requiredLabel accessible name of the required marker, default 'Required'
 *   invalid       boolean
 *   hint          string shown under the control; styled as an error when invalid
 *   inline        boolean, label and control on one row
 *   htmlFor       id of the control, when the caller already has one
 *   children      element, or a function receiving the generated control id
 */

import { html, cx, useId } from './base.js';

export function Field(props) {
  const {
    label, required = false, requiredLabel = 'Required', invalid = false,
    hint, inline = false, htmlFor, children, className,
  } = props || {};

  const auto = useId();
  const controlId = htmlFor || ('rw-f-' + auto);
  const hintId = hint ? controlId + '-hint' : null;
  const body = typeof children === 'function' ? children(controlId, hintId) : children;

  const onLabelClick = htmlFor ? null : (ev) => {
    const box = ev.currentTarget.parentNode.querySelector('.rw-field__control');
    const el = box && box.querySelector('input,select,textarea,button,[contenteditable="true"]');
    if (el && el.focus) el.focus();
  };

  return html`
    <div class=${cx('rw-field', invalid && 'rw-field--invalid', inline && 'rw-field--inline', className)}>
      ${label ? html`
        <label class="rw-field__label" for=${htmlFor || null} onClick=${onLabelClick}>
          ${label}
          ${required ? html`<span class="rw-field__req" title=${requiredLabel}
                                  aria-label=${requiredLabel}>*</span>` : null}
        </label>` : null}
      <div class="rw-field__control">${body}</div>
      ${hint ? html`
        <div id=${hintId} class=${cx('rw-field__hint', invalid && 'rw-field__hint--bad')}
             role=${invalid ? 'alert' : null}>${hint}</div>` : null}
    </div>`;
}

export default Field;
