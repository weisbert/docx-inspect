/*
 * Lightbox - one picture, as large as the screen allows, for LOOKING at.
 *
 * A figure in the canvas is drawn at the width it will have on the printed
 * page, which for a screenshot of a plot is a few hundred pixels: the axis
 * labels, the legend and the cursor readouts that are the whole reason the
 * picture is in the report are unreadable there. This is where they are read.
 *
 * Behaviour
 *   - opens at FIT: the whole picture, scaled down to the viewport, never up;
 *   - 1:1 shows it at its own pixel size, which is what a screenshot was
 *     captured at and therefore the size its text was drawn to be read at;
 *   - the wheel zooms about the pointer, so what is under the cursor stays
 *     under it, and a drag pans once the picture is bigger than the frame;
 *   - double-click toggles fit and 1:1, the way every image viewer does;
 *   - Esc, the ✕ and a press on the backdrop all close it; + - and 0 are the
 *     keyboard's zoom, fit is 0.
 *
 * It does NOT edit anything. Nothing here writes to the document, and the
 * caller keeps ownership of the picture.
 *
 * There is no portal in the vendored preact build, so this is position:fixed
 * and works wherever it is mounted.
 *
 * CSS classes owned by css/app.css: .rw-lightbox*
 *
 * Props
 *   src       the image URL, already resolved by the caller
 *   alt       accessible name; the caption, when there is one
 *   title     the line shown top-left, e.g. 'Figure 1-2'
 *   subtitle  the second line, e.g. the file name and pixel size
 *   onClose   () => void
 */

import { html, cx, useState, useRef, useEffect, useCallback } from './base.js';

const MIN_SCALE = 0.05;
const MAX_SCALE = 16;
const STEP = 1.25;

const S = {
  close: 'Close',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  fit: 'Fit',
  actual: '1:1',
  hint: 'Scroll to zoom · drag to pan · double-click for 1:1 · Esc closes',
};

function clamp(value) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

export function Lightbox(props) {
  const { src, alt, title, subtitle, onClose } = props || {};
  const frameRef = useRef(null);
  const imgRef = useRef(null);
  // natural: the picture's own pixel size. fit: the scale that shows all of it.
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const [fit, setFit] = useState(1);
  // scale === null means "follow fit", so a window resize keeps the picture
  // whole until the user has said otherwise.
  const [scale, setScale] = useState(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef(null);

  const shown = scale == null ? fit : scale;

  const measure = useCallback(() => {
    const frame = frameRef.current;
    const img = imgRef.current;
    if (!frame || !img || !img.naturalWidth) return;
    const box = frame.getBoundingClientRect();
    const next = Math.min(box.width / img.naturalWidth, box.height / img.naturalHeight, 1);
    if (next > 0) setFit(next);
  }, []);

  useEffect(() => {
    const onResize = () => measure();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [measure]);

  // The whole component is a modal: Esc closes it wherever the focus is, and
  // the keys that zoom work without hunting for the buttons.
  useEffect(() => {
    const onKey = (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        if (onClose) onClose();
        return;
      }
      if (ev.key === '+' || ev.key === '=') {
        ev.preventDefault();
        setScale((s) => clamp((s == null ? fit : s) * STEP));
      } else if (ev.key === '-' || ev.key === '_') {
        ev.preventDefault();
        setScale((s) => clamp((s == null ? fit : s) / STEP));
      } else if (ev.key === '0') {
        ev.preventDefault();
        setScale(null);
        setPan({ x: 0, y: 0 });
      } else if (ev.key === '1') {
        ev.preventDefault();
        setScale(1);
        setPan({ x: 0, y: 0 });
      }
    };
    document.addEventListener('keydown', onKey, true);
    document.body.classList.add('rw-modal-open');
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.classList.remove('rw-modal-open');
    };
  }, [onClose, fit]);

  // Zoom about the pointer: the point under the cursor is the one the reader is
  // looking at, and a zoom that moves it somewhere else has to be chased back.
  const onWheel = (ev) => {
    ev.preventDefault();
    const frame = frameRef.current;
    if (!frame) return;
    const box = frame.getBoundingClientRect();
    const cx0 = ev.clientX - box.left - box.width / 2 - pan.x;
    const cy0 = ev.clientY - box.top - box.height / 2 - pan.y;
    const factor = ev.deltaY < 0 ? STEP : 1 / STEP;
    const from = shown;
    const to = clamp(from * factor);
    if (to === from) return;
    const ratio = to / from;
    setScale(to);
    setPan({ x: pan.x - cx0 * (ratio - 1), y: pan.y - cy0 * (ratio - 1) });
  };

  const onPointerDown = (ev) => {
    if (ev.button !== 0) return;
    drag.current = { x: ev.clientX, y: ev.clientY, pan: pan };
    if (ev.currentTarget.setPointerCapture) {
      try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch (err) { /* not captured */ }
    }
  };

  const onPointerMove = (ev) => {
    const from = drag.current;
    if (!from) return;
    setPan({ x: from.pan.x + (ev.clientX - from.x), y: from.pan.y + (ev.clientY - from.y) });
  };

  const endDrag = () => { drag.current = null; };

  const percent = Math.round(shown * 100);
  const canPan = natural.w > 0;

  return html`
    <div class="rw-lightbox" role="dialog" aria-modal="true" aria-label=${alt || title || 'Picture'}
         onMouseDown=${(ev) => {
           // Only a press on the backdrop itself closes. A press that started on
           // the picture is a pan, and a pan that ends outside must not close
           // the thing it was moving.
           if (ev.target === ev.currentTarget && onClose) onClose();
         }}>
      <div class="rw-lightbox__bar">
        <div class="rw-lightbox__titles">
          ${title ? html`<div class="rw-lightbox__title">${title}</div>` : null}
          ${subtitle ? html`<div class="rw-lightbox__sub">${subtitle}</div>` : null}
        </div>
        <div class="rw-lightbox__tools">
          <button type="button" class="rw-lightbox__btn" title=${S.zoomOut} aria-label=${S.zoomOut}
                  onClick=${() => setScale(clamp(shown / STEP))}>−</button>
          <span class="rw-lightbox__pct" aria-live="polite">${percent + '%'}</span>
          <button type="button" class="rw-lightbox__btn" title=${S.zoomIn} aria-label=${S.zoomIn}
                  onClick=${() => setScale(clamp(shown * STEP))}>+</button>
          <button type="button"
                  class=${cx('rw-lightbox__btn', 'rw-lightbox__btn--text', scale == null && 'rw-lightbox__btn--on')}
                  onClick=${() => { setScale(null); setPan({ x: 0, y: 0 }); }}>${S.fit}</button>
          <button type="button"
                  class=${cx('rw-lightbox__btn', 'rw-lightbox__btn--text', scale === 1 && 'rw-lightbox__btn--on')}
                  onClick=${() => { setScale(1); setPan({ x: 0, y: 0 }); }}>${S.actual}</button>
          <button type="button" class="rw-lightbox__btn" title=${S.close} aria-label=${S.close}
                  onClick=${() => onClose && onClose()}>✕</button>
        </div>
      </div>
      ${/* The frame is stage AND backdrop: the picture sits in the middle of
            it and the space around the picture is the way out. Panning and the
            double-press belong to the PICTURE, so a press on that empty space
            is unambiguous -- it used to be the element under the pointer for
            most of the screen while only the strip above and below it closed,
            which is to say the backdrop did not close. */ ''}
      <div ref=${frameRef} class="rw-lightbox__frame"
           onWheel=${onWheel}
           onClick=${(ev) => {
             if (ev.target === ev.currentTarget && onClose) onClose();
           }}>
        <img ref=${imgRef} class="rw-lightbox__img" src=${src} alt=${alt || ''} draggable=${false}
             onPointerDown=${canPan ? onPointerDown : null}
             onPointerMove=${canPan ? onPointerMove : null}
             onPointerUp=${endDrag}
             onPointerCancel=${endDrag}
             onDblClick=${() => {
               setPan({ x: 0, y: 0 });
               setScale(scale === 1 ? null : 1);
             }}
             style=${{
               transform: 'translate(' + pan.x + 'px,' + pan.y + 'px) scale(' + shown + ')',
               width: natural.w ? natural.w + 'px' : 'auto',
               height: natural.h ? natural.h + 'px' : 'auto',
               cursor: drag.current ? 'grabbing' : 'grab',
             }}
             onLoad=${(ev) => {
               const node = ev.currentTarget;
               setNatural({ w: node.naturalWidth, h: node.naturalHeight });
               // Measured after the size is known, and on the next frame so the
               // frame has been laid out.
               window.requestAnimationFrame(measure);
             }} />
      </div>
      <div class="rw-lightbox__hint">${S.hint}</div>
    </div>`;
}

export default Lightbox;
