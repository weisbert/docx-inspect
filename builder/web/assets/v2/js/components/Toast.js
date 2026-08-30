/*
 * Toast - bottom centre, one line, a dot on the left and an optional action on
 * the right when what just happened is reversible. It dismisses itself after
 * 6 seconds; hovering or focusing it pauses the timer and leaving resumes with
 * the time that was left, so a slow reader never loses the Undo.
 *
 * CSS classes owned by css/app.css:
 *   .rw-toast
 *   .rw-toast__dot
 *   .rw-toast__text
 *   .rw-toast__action
 *   .rw-toast__close
 *
 * Props
 *   text         the message (from 02_GLOSSARY_EN.md)
 *   action       label of the action button, e.g. 'Undo'; omit for no action
 *   onAction     () => void
 *   onDismiss    () => void, called by the timer, by the close button and by Esc
 *   dismissLabel accessible name of the close button, default 'Close'
 *   duration     ms, default 6000; pass 0 to keep it until dismissed
 */

import { html, cx, useRef, useEffect } from './base.js';

const DEFAULT_MS = 6000;

export function Toast(props) {
  const {
    text, action, onAction, onDismiss, dismissLabel = 'Close',
    duration = DEFAULT_MS, className,
  } = props || {};

  const timerRef = useRef(null);
  const leftRef = useRef(duration);
  const startedRef = useRef(0);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  const stop = () => {
    if (timerRef.current === null) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
    leftRef.current = Math.max(0, leftRef.current - (Date.now() - startedRef.current));
  };

  const start = () => {
    if (!duration) return;
    if (timerRef.current !== null) return;
    if (leftRef.current <= 0) return;
    startedRef.current = Date.now();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (dismissRef.current) dismissRef.current('timeout');
    }, leftRef.current);
  };

  useEffect(() => {
    leftRef.current = duration;
    start();
    return stop;
  }, [text, action, duration]);

  const onKeyDown = (ev) => {
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    if (onDismiss) onDismiss('escape');
  };

  return html`
    <div
      class=${cx('rw-toast', className)}
      role="status"
      aria-live="polite"
      onMouseEnter=${stop}
      onMouseLeave=${start}
      onFocusIn=${stop}
      onFocusOut=${start}
      onKeyDown=${onKeyDown}
    >
      <span class="rw-toast__dot" aria-hidden="true"></span>
      <span class="rw-toast__text">${text}</span>
      ${action ? html`
        <button type="button" class="rw-toast__action"
                onClick=${() => { stop(); if (onAction) onAction(); }}>${action}</button>` : null}
      ${onDismiss ? html`
        <button type="button" class="rw-toast__close" title=${dismissLabel}
                aria-label=${dismissLabel} onClick=${() => onDismiss('button')}>✕</button>` : null}
    </div>`;
}

export default Toast;
