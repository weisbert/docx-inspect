/*
 * Drawer - the right-hand panel over --scrim-soft.
 *
 * Esc closes and a click on the scrim closes. Focus moves into the drawer on
 * open and returns to the opener on close, but focus is NOT trapped: the
 * drawer sits beside the document and the user may tab back out to it.
 *
 * CSS classes owned by css/app.css:
 *   .rw-scrim.rw-scrim--soft
 *   .rw-drawer
 *   .rw-drawer__head
 *   .rw-drawer__titles
 *   .rw-drawer__title
 *   .rw-drawer__subtitle
 *   .rw-drawer__close
 *   .rw-drawer__body
 *   .rw-drawer__foot
 *
 * Props
 *   title       noun phrase (from 02_GLOSSARY_EN.md)
 *   subtitle    optional second line
 *   width       px, default 494
 *   onClose     () => void
 *   footer      optional footer nodes
 *   closeLabel  accessible name of the close button, default 'Close'
 *   children    the body
 */

import { html, cx, useRef, useEffect, useId, focusables } from './base.js';

export function Drawer(props) {
  const {
    title, subtitle, width = 494, onClose, footer,
    closeLabel = 'Close', className, children,
  } = props || {};

  const panelRef = useRef(null);
  const uid = useId();
  const titleId = 'rw-drw-' + uid;
  const subId = subtitle ? titleId + '-sub' : null;

  useEffect(() => {
    const previous = document.activeElement;
    const panel = panelRef.current;
    if (panel) {
      const first = focusables(panel)[0];
      (first || panel).focus();
    }
    return () => {
      if (previous && previous.focus) {
        try { previous.focus(); } catch (err) { /* the node may be gone */ }
      }
    };
  }, []);

  const onKeyDown = (ev) => {
    if (ev.key !== 'Escape') return;
    ev.stopPropagation();
    ev.preventDefault();
    if (onClose) onClose('escape');
  };

  const onScrimMouseDown = (ev) => {
    if (ev.target !== ev.currentTarget) return;
    if (onClose) onClose('scrim');
  };

  return html`
    <div class="rw-scrim rw-scrim--soft" onMouseDown=${onScrimMouseDown}>
      <aside
        ref=${panelRef}
        class=${cx('rw-drawer', className)}
        role="dialog"
        aria-labelledby=${title ? titleId : null}
        aria-describedby=${subId}
        tabIndex="-1"
        style=${{ width: width + 'px', maxWidth: 'calc(100vw - 30px)' }}
        onKeyDown=${onKeyDown}
      >
        <div class="rw-drawer__head">
          <div class="rw-drawer__titles">
            ${title ? html`<div class="rw-drawer__title" id=${titleId}>${title}</div>` : null}
            ${subtitle ? html`<div class="rw-drawer__subtitle" id=${subId}>${subtitle}</div>` : null}
          </div>
          ${onClose ? html`
            <button type="button" class="rw-drawer__close" title=${closeLabel}
                    aria-label=${closeLabel} onClick=${() => onClose('button')}>✕</button>` : null}
        </div>
        <div class="rw-drawer__body">${children}</div>
        ${footer ? html`<div class="rw-drawer__foot">${footer}</div>` : null}
      </aside>
    </div>`;
}

export default Drawer;
