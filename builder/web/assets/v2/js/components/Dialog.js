/*
 * Dialog - a centred modal over --scrim.
 *
 * Behaviour required by the specs:
 *   - Esc closes.
 *   - Focus is trapped inside while it is open, and returns to whatever was
 *     focused before when it closes. Dialog is the only component in this set
 *     that traps focus.
 *   - Clicking the scrim closes it only when there is nothing to lose. Views
 *     that hold typed input pass scrimCloses=false, and then only the close
 *     button, the footer buttons and Esc get out.
 *
 * There is no portal in the vendored preact build, so the markup is position:
 * fixed and works wherever it is mounted in the tree.
 *
 * CSS classes owned by css/app.css:
 *   .rw-scrim                 fixed full-screen scrim, --scrim
 *   .rw-dialog
 *   .rw-dialog__head
 *   .rw-dialog__titles
 *   .rw-dialog__title
 *   .rw-dialog__subtitle
 *   .rw-dialog__close
 *   .rw-dialog__body
 *   .rw-dialog__foot
 *   .rw-dialog__foot-left      slot for a left-aligned action next to the footer
 *   body.rw-modal-open         set while at least one Dialog is mounted
 *
 * Props
 *   title        noun phrase (from 02_GLOSSARY_EN.md)
 *   subtitle     optional second line
 *   width        px, default 520
 *   onClose      () => void
 *   footer       nodes for the footer row; omitted footer renders no footer
 *   footerLeft   nodes pinned to the left of the footer
 *   closeLabel   accessible name of the close button, default 'Close'
 *   scrimCloses  boolean, default true
 *   children     the body
 */

import { html, cx, useRef, useEffect, useId, focusables } from './base.js';

export function Dialog(props) {
  const {
    title, subtitle, width = 520, onClose, footer, footerLeft,
    closeLabel = 'Close', scrimCloses = true, className, children,
  } = props || {};

  const panelRef = useRef(null);
  const uid = useId();
  const titleId = 'rw-dlg-' + uid;
  const subId = subtitle ? titleId + '-sub' : null;

  useEffect(() => {
    const previous = document.activeElement;
    const panel = panelRef.current;
    if (panel) {
      const first = focusables(panel)[0];
      (first || panel).focus();
    }
    document.body.classList.add('rw-modal-open');
    return () => {
      document.body.classList.remove('rw-modal-open');
      if (previous && previous.focus) {
        try { previous.focus(); } catch (err) { /* the node may be gone */ }
      }
    };
  }, []);

  const onKeyDown = (ev) => {
    if (ev.key === 'Escape') {
      ev.stopPropagation();
      ev.preventDefault();
      if (onClose) onClose('escape');
      return;
    }
    if (ev.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;
    const list = focusables(panel);
    if (!list.length) { ev.preventDefault(); return; }
    const first = list[0];
    const last = list[list.length - 1];
    const active = document.activeElement;
    if (ev.shiftKey && (active === first || !panel.contains(active))) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && active === last) {
      ev.preventDefault();
      first.focus();
    }
  };

  const onScrimMouseDown = (ev) => {
    if (!scrimCloses) return;
    if (ev.target !== ev.currentTarget) return;
    if (onClose) onClose('scrim');
  };

  return html`
    <div class="rw-scrim" onMouseDown=${onScrimMouseDown}>
      <div
        ref=${panelRef}
        class=${cx('rw-dialog', className)}
        role="dialog"
        aria-modal="true"
        aria-labelledby=${title ? titleId : null}
        aria-describedby=${subId}
        tabIndex="-1"
        style=${{ width: width + 'px', maxWidth: 'calc(100vw - 44px)' }}
        onKeyDown=${onKeyDown}
      >
        <div class="rw-dialog__head">
          <div class="rw-dialog__titles">
            ${title ? html`<div class="rw-dialog__title" id=${titleId}>${title}</div>` : null}
            ${subtitle ? html`<div class="rw-dialog__subtitle" id=${subId}>${subtitle}</div>` : null}
          </div>
          ${onClose ? html`
            <button type="button" class="rw-dialog__close" title=${closeLabel}
                    aria-label=${closeLabel} onClick=${() => onClose('button')}>✕</button>` : null}
        </div>
        <div class="rw-dialog__body">${children}</div>
        ${footer || footerLeft ? html`
          <div class="rw-dialog__foot">
            <div class="rw-dialog__foot-left">${footerLeft}</div>
            ${footer}
          </div>` : null}
      </div>
    </div>`;
}

export default Dialog;
