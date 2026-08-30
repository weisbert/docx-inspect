/*
 * Report Workbench v2 - shared widget set.
 *
 * Views import from here and nowhere else inside components/:
 *   import { Button, Dialog, Pill } from '../components/index.js';
 *
 * Every widget in this directory is presentational. None of them reads the
 * store, none of them calls the server, and none of them contains a
 * user-facing string of its own - all text arrives by prop and comes from
 * 02_GLOSSARY_EN.md. The accessible names that do have defaults
 * ('Close' and 'Clear the search') are glossary entries too, and can
 * be overridden per call site.
 *
 *
 * CSS class manifest - the complete set this directory emits, for css/app.css:
 *
 *   Button           .rw-btn .rw-btn--primary .rw-btn--secondary .rw-btn--tertiary
 *                    .rw-btn--danger .rw-btn--block .rw-btn__glyph
 *   IconButton       .rw-iconbtn .rw-iconbtn--on .rw-iconbtn--danger
 *                    .rw-iconbtn--small .rw-iconbtn__glyph
 *   Field            .rw-field .rw-field--invalid .rw-field--inline .rw-field__label
 *                    .rw-field__req .rw-field__control .rw-field__hint .rw-field__hint--bad
 *   Select           .rw-select .rw-select--invalid .rw-select--small
 *                    .rw-select__el .rw-select__caret
 *   Chips            .rw-chips .rw-chips--wrap .rw-chip .rw-chip--on
 *                    .rw-chip--disabled .rw-chip__count
 *   SegmentedControl .rw-seg .rw-seg--stretch .rw-seg__opt .rw-seg__opt--on .rw-seg__glyph
 *   SearchInput      .rw-search .rw-search--small .rw-search__glyph
 *                    .rw-search__input .rw-search__clear
 *   Dialog           .rw-scrim .rw-dialog .rw-dialog__head .rw-dialog__titles
 *                    .rw-dialog__title .rw-dialog__subtitle .rw-dialog__close
 *                    .rw-dialog__body .rw-dialog__foot .rw-dialog__foot-left
 *                    body.rw-modal-open
 *   Drawer           .rw-scrim.rw-scrim--soft .rw-drawer .rw-drawer__head
 *                    .rw-drawer__titles .rw-drawer__title .rw-drawer__subtitle
 *                    .rw-drawer__close .rw-drawer__body .rw-drawer__foot
 *   Menu             .rw-menu .rw-menu--measuring .rw-menu__item .rw-menu__item--danger
 *                    .rw-menu__item--disabled .rw-menu__glyph .rw-menu__label
 *                    .rw-menu__key .rw-menu__sep
 *   Banner           .rw-banner .rw-banner--error .rw-banner--warn .rw-banner--done
 *                    .rw-banner__glyph .rw-banner__body .rw-banner__title .rw-banner__action
 *   EmptyState       .rw-empty .rw-empty--over .rw-empty--compact .rw-empty__glyph
 *                    .rw-empty__title .rw-empty__body .rw-empty__actions
 *   Pill             .rw-pill .rw-pill--neutral .rw-pill--bad .rw-pill--warn
 *                    .rw-pill--good .rw-pill--accent .rw-pill--note
 *                    .rw-pill--button .rw-pill__glyph
 *   Spinner          .rw-spinner .rw-spinner--inline  (sized via --rw-spinner-size)
 *   Toast            .rw-toast .rw-toast__dot .rw-toast__text
 *                    .rw-toast__action .rw-toast__close
 *
 * .rw-scrim and .rw-menu are position:fixed, so a widget works wherever it is
 * mounted; the vendored preact build has no portal.
 */

export { Button } from './Button.js';
export { IconButton } from './IconButton.js';
export { Field } from './Field.js';
export { Select } from './Select.js';
export { Chips } from './Chips.js';
export { SegmentedControl } from './SegmentedControl.js';
export { SearchInput } from './SearchInput.js';
export { Dialog } from './Dialog.js';
export { Drawer } from './Drawer.js';
export { Menu } from './Menu.js';
export { Banner } from './Banner.js';
export { EmptyState } from './EmptyState.js';
export { Pill } from './Pill.js';
export { Spinner } from './Spinner.js';
export { Toast } from './Toast.js';

/* Re-exported so a view can build its own markup with the same bindings the
 * widgets use, instead of reaching for the vendor globals directly. */
export { h, Fragment, render, html, cx } from './base.js';
export {
  useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useId,
} from './base.js';
