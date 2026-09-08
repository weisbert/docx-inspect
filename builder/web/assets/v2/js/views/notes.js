/*
 * Report Workbench v2 - the notes channel.
 *
 * A note is a remark ABOUT the report that never becomes part of it: an
 * instruction left for whoever fills the section in, a question about a number,
 * a reply. It rides inside project.json on the thing it is about --
 *
 *     owner.notes = [{ by:'user'|'claude', at:'YYYY-MM-DD',
 *                      status:'open'|'done', text:'...' }]
 *
 * -- where an owner is the report (project.meta), a section (an outline node)
 * or a CARD (the block that starts it, which is what the canvas draws as one
 * card). The shape is the one the previous single-file UI wrote, so notes left
 * before the rewrite come back into view here rather than sitting unread in the
 * file.
 *
 * Notes travel with Copy whole report and with Copy changes, so the round trip
 * carries them both ways. They never reach the Word body: core/engine.py
 * renders known block types and known fields, and `notes` is neither.
 *
 * A section ALSO has the plain-string `node.note` this UI has been writing
 * since the rewrite. Both are shown here -- the string in the section bar and
 * in the list below, the array wherever it is found -- because a report that
 * has been through both hands carries both, and a note nobody can see is worse
 * than a note in the wrong shape.
 *
 * What this file owns: the per-owner panel (js/views/editor.js hangs one under
 * every card), the whole-report list (the right panel's Notes tab, drawn by
 * js/views/preview.js), and the counting the top bar's pill reports. It draws
 * no canvas, no card and no section bar.
 *
 * Persistence, from the front-end contract: a view never PUTs project.json. It
 * mutates store.project in place and calls store.markDirty() on the same tick;
 * the store debounces the save and the header's save indicator is what says
 * whether it landed.
 *
 * CSS: .rw-notes* in css/app.css.
 */

import { store, useStore } from '../store.js';
import { groupBlocks } from '../util.js';
import { Button, IconButton, Pill } from '../components/index.js';

const preact = globalThis.preact;
const preactHooks = globalThis.preactHooks;
const html = globalThis.htm.bind(preact.h);
const { useState, useMemo } = preactHooks;

function cx() {
  const out = [];
  for (let i = 0; i < arguments.length; i++) {
    const value = arguments[i];
    if (value) out.push(value);
  }
  return out.join(' ');
}

/* ------------------------------------------------------------------ *
 * Frozen strings
 * ------------------------------------------------------------------ */

const S = {
  notes: 'Notes',
  addNote: 'Add a note',
  add: 'Add',
  placeholder: 'Write a note or an instruction…',
  byYou: 'You',
  byClaude: 'Claude',
  open: 'Open',
  done: 'Done',
  markDone: 'Mark this note done',
  reopen: 'Reopen this note',
  deleteNote: 'Delete this note',
  hide: 'Hide the notes',
  show: 'Show the notes',
  neverPrinted: 'Notes travel with the report and never appear in the exported file',
  nothingYet: 'No notes yet. Add one under any card, on a section, or on the report.',
  reportNotes: 'Report (cover)',
  sectionNote: 'Section note',
  openCount: (n) => n + (n === 1 ? ' open note' : ' open notes'),
  allDone: 'All notes done',
  countOn: (n) => (n === 1 ? '1 note' : n + ' notes'),
  jumpThere: 'Go to it',
  cardKind: {
    para: 'Text',
    image: 'Figure',
    imagegrid: 'Figure grid',
    table: 'Table',
    datatable: 'Compliance table',
  },
};

/* ------------------------------------------------------------------ *
 * the data
 * ------------------------------------------------------------------ */

const SELF = 'user';        // a note written in this UI is the user's

function stamp() {
  const d = new Date();
  const pad = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

export function noteList(owner) {
  return owner && Array.isArray(owner.notes) ? owner.notes : [];
}

export function openNotes(owner) {
  return noteList(owner).filter((n) => n && n.status !== 'done');
}

// The owner grows its array only when a note is really written, so a report
// that has never been annotated stays byte-identical to what it was -- which is
// what keeps Copy changes free of noise nobody typed.
export function addNote(owner, text) {
  const body = String(text || '').trim();
  if (!owner || !body) return null;
  if (!Array.isArray(owner.notes)) owner.notes = [];
  const note = { by: SELF, at: stamp(), status: 'open', text: body };
  owner.notes.push(note);
  return note;
}

function removeNote(owner, index) {
  const list = noteList(owner);
  if (index < 0 || index >= list.length) return;
  list.splice(index, 1);
  if (!list.length && owner) delete owner.notes;
}

function str(value) {
  return value == null ? '' : String(value);
}

/* Every open note in the report: the array notes on the cover, on every section
 * and on every card. The section's plain-string note is deliberately NOT
 * counted -- it is a standing remark about the section, not a task, and it
 * would keep the pill lit forever. */
export function countOpenNotes(project) {
  if (!project) return 0;
  let n = openNotes(project.meta || {}).length;
  const walk = (node) => {
    if (!node) return;
    n += openNotes(node).length;
    (node.blocks || []).forEach((b) => { if (b) n += openNotes(b).length; });
    (node.children || []).forEach(walk);
  };
  (project.outline || []).forEach(walk);
  return n;
}

// A card is a run of blocks in the canvas and its FIRST block owns the notes --
// the same block the canvas hands every card component, found the same way the
// canvas finds it, so a note can never belong to a card nobody draws. Only a
// card's first block is asked, so a paragraph in the middle of a text card
// cannot grow a note there is no room to show.
function cardStarts(blocks) {
  const list = Array.isArray(blocks) ? blocks : [];
  return groupBlocks(list).map((card) => {
    const index = card.kind === 'prose' ? card.start : card.idx;
    return { block: list[index], index: index };
  }).filter((card) => !!card.block);
}

/* Everything in the report that carries a note, in document order, with enough
 * about each one to say where it is and to go there. */
export function collectNotes(project) {
  const entries = [];
  if (!project) return entries;

  const meta = project.meta || {};
  entries.push({
    key: 'report',
    kind: 'report',
    where: S.reportNotes,
    owner: meta,
    nodeId: null,
    blockId: null,
    always: true,          // the cover's panel is offered even when empty
  });

  const walk = (node, trail) => {
    if (!node) return;
    const title = str(node.title) || '';
    const path = trail ? trail + ' › ' + title : title;
    if (noteList(node).length || str(node.note).trim()) {
      entries.push({
        key: 'n:' + str(node.id),
        kind: 'section',
        where: path,
        owner: node,
        node: node,
        nodeId: str(node.id) || null,
        blockId: null,
      });
    }
    cardStarts(node.blocks).forEach((card) => {
      if (!noteList(card.block).length) return;
      const kind = S.cardKind[card.block.type] || card.block.type;
      entries.push({
        key: 'b:' + str(node.id) + ':' + card.index,
        kind: 'card',
        where: path + ' › ' + kind,
        owner: card.block,
        nodeId: str(node.id) || null,
        blockId: str(card.block.id) || null,
      });
    });
    (node.children || []).forEach((child) => walk(child, path));
  };
  (project.outline || []).forEach((node) => walk(node, ''));
  return entries;
}

/* ------------------------------------------------------------------ *
 * committing
 * ------------------------------------------------------------------ */

// Mutate in place, then say so on the same tick. See js/views/blocks.js for
// why in-place is the rule and why silence is the one thing a caller must not
// do: the save loop tracks revisions, not object identity.
function commit() {
  store.markDirty();
}

function goTo(nodeId, blockId) {
  const dir = (store.get().route || {}).dir;
  if (nodeId && dir) store.navigate({ view: 'editor', dir: dir, node: nodeId });
  store.setUi({
    cursorNode: nodeId || null,
    cursorBlock: blockId || null,
    focusBlock: blockId || null,
    focusAt: Date.now(),
  });
}

/* ------------------------------------------------------------------ *
 * one owner's notes
 * ------------------------------------------------------------------ */

export function NotesPanel(props) {
  const owner = props.owner;
  const [draft, setDraft] = useState('');
  const list = noteList(owner);
  // A tick, so a status flip or a delete redraws: the list is mutated in place
  // and preact has no way to know the array it already holds is different.
  const [tick, setTick] = useState(0);
  const touch = () => { commit(); setTick(tick + 1); };

  const commitDraft = () => {
    const body = draft.trim();
    if (!body) return;
    addNote(owner, body);
    setDraft('');
    touch();
  };

  return html`
    <div class="rw-notes">
      ${list.map((note, i) => {
        const claude = note && note.by === 'claude';
        const done = note && note.status === 'done';
        return html`
          <div class=${cx('rw-note', done && 'rw-note--done')} key=${'n' + i}>
            <div class="rw-note__meta">
              <span class=${cx('rw-note__by', claude && 'rw-note__by--claude')}>
                ${claude ? S.byClaude : S.byYou}
              </span>
              ${note && note.at ? html`<span class="rw-note__at">${note.at}</span>` : null}
            </div>
            <div class="rw-note__main">
              ${/* Claude's own replies are read-only, so authorship stays
                    honest; the user still resolves and deletes them. */ ''}
              <textarea class="rw-textarea rw-note__text" rows="2"
                        readOnly=${claude || null}
                        aria-label=${S.notes}
                        value=${str(note && note.text)}
                        onInput=${claude ? null : (ev) => {
                          note.text = ev.currentTarget.value;
                          commit();
                        }}></textarea>
              <div class="rw-note__actions">
                <button type="button"
                        class=${cx('rw-note__status', done && 'rw-note__status--done')}
                        title=${done ? S.reopen : S.markDone}
                        onClick=${() => { note.status = done ? 'open' : 'done'; touch(); }}>
                  ${done ? '✓ ' + S.done : '○ ' + S.open}
                </button>
                <${IconButton} glyph="✕" small=${true} danger=${true} title=${S.deleteNote}
                               onClick=${() => { removeNote(owner, i); touch(); }} />
              </div>
            </div>
          </div>`;
      })}
      <div class="rw-note__add">
        <textarea class="rw-textarea" rows="2" aria-label=${S.addNote}
                  placeholder=${S.placeholder}
                  value=${draft}
                  onInput=${(ev) => setDraft(ev.currentTarget.value)}
                  onKeyDown=${(ev) => {
                    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
                      ev.preventDefault();
                      commitDraft();
                    }
                  }}
                  ${/* Leaving the box keeps what was typed: a note written and
                        then clicked away from used to vanish. */ ''}
                  onBlur=${commitDraft}></textarea>
        <${Button} level="tertiary" onClick=${commitDraft}>${'+ ' + S.add}<//>
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ *
 * the strip under a card
 * ------------------------------------------------------------------ */

export function CardNotes(props) {
  const block = props.block;
  const list = noteList(block);
  const open = openNotes(block).length;
  // A card that is carrying an open note shows it without being asked; one with
  // nothing on it is a single quiet line until it is clicked.
  const [shown, setShown] = useState(open > 0);

  if (!block) return null;
  return html`
    <div class=${cx('rw-cardnotes', shown && 'rw-cardnotes--on', open > 0 && 'rw-cardnotes--live')}>
      <button type="button" class="rw-cardnotes__toggle"
              aria-expanded=${String(shown)}
              title=${shown ? S.hide : S.show}
              onClick=${() => setShown(!shown)}>
        <span aria-hidden="true">📝</span>
        <span>${S.notes}</span>
        ${list.length
          ? html`<span class=${cx('rw-cardnotes__count', open > 0 && 'rw-cardnotes__count--live')}>
                   ${open > 0 ? String(open) : '✓'}
                 </span>`
          : null}
        <span class="rw-cardnotes__caret" aria-hidden="true">${shown ? '▴' : '▾'}</span>
      </button>
      ${shown ? html`<${NotesPanel} owner=${block} />` : null}
    </div>`;
}

/* ------------------------------------------------------------------ *
 * the whole report, in the right panel
 * ------------------------------------------------------------------ */

export function NotesTab() {
  const project = useStore((s) => s.project);
  const rev = useStore((s) => s.rev);
  const entries = useMemo(() => collectNotes(project), [project, rev]);
  const open = useMemo(() => countOpenNotes(project), [project, rev]);
  const real = entries.filter((e) => !e.always || noteList(e.owner).length);

  return html`
    <div class="rw-noteslist">
      <div class="rw-noteslist__head">
        <${Pill} tone=${open > 0 ? 'warn' : 'neutral'}>
          ${open > 0 ? S.openCount(open) : S.allDone}
        <//>
        <div class="rw-meta">${S.neverPrinted}</div>
      </div>
      ${real.length
        ? real.map((entry) => html`
          <div class="rw-notesgroup" key=${entry.key}>
            <div class="rw-notesgroup__head">
              <span class="rw-notesgroup__where" title=${entry.where}>${entry.where}</span>
              ${entry.kind === 'report' ? null : html`
                <${IconButton} glyph="↗" small=${true} title=${S.jumpThere}
                               onClick=${() => goTo(entry.nodeId, entry.blockId)} />`}
            </div>
            ${entry.kind === 'section' && str(entry.node && entry.node.note).trim()
              ? html`
                <div class="rw-notesgroup__plain">
                  <span class="rw-note__by">${S.sectionNote}</span>
                  <span>${str(entry.node.note)}</span>
                </div>`
              : null}
            ${noteList(entry.owner).length || entry.always
              ? html`<${NotesPanel} owner=${entry.owner} />`
              : null}
          </div>`)
        : html`<div class="rw-empty rw-empty--sm">${S.nothingYet}</div>`}
      ${/* The cover's panel is always reachable, even with nothing on it: it is
            where a remark about the whole report goes. */ ''}
      ${real.some((e) => e.kind === 'report') ? null : html`
        <div class="rw-notesgroup">
          <div class="rw-notesgroup__head">
            <span class="rw-notesgroup__where">${S.reportNotes}</span>
          </div>
          <${NotesPanel} owner=${(project && project.meta) || {}} />
        </div>`}
    </div>`;
}

export default NotesTab;
