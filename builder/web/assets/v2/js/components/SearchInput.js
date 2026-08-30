/*
 * SearchInput - a search box with a leading glyph and a clear button that only
 * appears once there is something to clear. Esc inside the box clears it.
 *
 * CSS classes owned by css/app.css:
 *   .rw-search
 *   .rw-search--small
 *   .rw-search__glyph
 *   .rw-search__input
 *   .rw-search__clear
 *
 * Props
 *   value        current text
 *   placeholder  string (from 02_GLOSSARY_EN.md)
 *   onInput      (text, event) => void
 *   onClear      () => void; when absent the clear button reports an empty string
 *   clearLabel   accessible name of the clear button, default 'Clear the search'
 *   onKeyDown    passed through, so a view can drive a result list from the box
 *   small        boolean, toolbar height
 *   autoFocus, id, ariaLabel, disabled
 */

import { html, cx, useRef } from './base.js';

export function SearchInput(props) {
  const {
    value = '', placeholder, onInput, onClear, clearLabel = 'Clear the search',
    onKeyDown, small = false, autoFocus = false, id, ariaLabel, disabled = false, className,
  } = props || {};

  const inputRef = useRef(null);

  const clear = () => {
    if (onClear) onClear();
    else if (onInput) onInput('', null);
    if (inputRef.current) inputRef.current.focus();
  };

  const keyDown = (ev) => {
    if (ev.key === 'Escape' && value) {
      ev.preventDefault();
      ev.stopPropagation();
      clear();
      return;
    }
    if (onKeyDown) onKeyDown(ev);
  };

  return html`
    <div class=${cx('rw-search', small && 'rw-search--small', className)}>
      <span class="rw-search__glyph" aria-hidden="true">⌕</span>
      <input
        ref=${inputRef}
        class="rw-search__input"
        type="text"
        id=${id || null}
        value=${value}
        placeholder=${placeholder || ''}
        aria-label=${ariaLabel || placeholder || null}
        autoFocus=${autoFocus || null}
        disabled=${disabled || null}
        onInput=${(ev) => onInput && onInput(ev.currentTarget.value, ev)}
        onKeyDown=${keyDown}
      />
      ${value ? html`
        <button type="button" class="rw-search__clear" title=${clearLabel}
                aria-label=${clearLabel} onClick=${clear}>✕</button>` : null}
    </div>`;
}

export default SearchInput;
