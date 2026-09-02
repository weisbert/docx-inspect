/*
 * home.js -- the report shelf.
 *
 * One job: find a report and open it. Creating, renaming, duplicating,
 * deleting and importing are secondary and all live in dialogs launched here.
 *
 * Three things bring a report into existence and all three are on the top bar,
 * at the same level, because they are the same kind of act: `New report`,
 * `Import Word report`, and `Apply an external update`. The third one is here
 * rather than inside a report because a package is addressed to the reports
 * ROOT -- /api/apply-update writes every member it names, so one package can
 * create reports that do not exist yet, and those belong to nothing already on
 * the shelf. The dialog it opens is sync.js's ImportDialog, mounted here; the
 * editor's exchange pill keeps the outbound half, which really is per-report.
 *
 * Shape (widths are fixed; this is a desktop window, there are no breakpoints):
 *
 *   52px top bar
 *   300px navigation rail   the tree is a FILTER over the table on the right,
 *                           never the list itself: clicking a node scopes the
 *                           table, it does not open a report
 *   detail                  header / stage filter strip / grouped report table
 *
 * Everything on screen comes from GET /api/tree, which carries the per-report
 * over-spec count computed by the same code the checklist uses, so the shelf
 * and the checklist can never disagree.
 *
 * Rules this file follows:
 *   * every user-facing string is in T below, copied verbatim from the frozen
 *     string list -- nothing is assembled from fragments at the call site;
 *   * the project document is never fetched or written here; opening a report
 *     is a route change and boot.js loads it;
 *   * a `dir` is a path ('PROJECT/MODULE/STAGE', or a bare folder for a legacy
 *     flat report) and is passed through untouched, never parsed into an id.
 */

import { store, useStore } from '../store.js';
import * as api from '../api.js';
import { relativeTime, classNames } from '../util.js';
import { ImportDialog, packageFromText, PACKAGE_ACCEPT } from './sync.js';
import {
  Button, IconButton, Field, Chips, Dialog, Menu, EmptyState, Pill, Toast,
  html, Fragment, useState, useEffect, useMemo, useRef, useCallback,
} from '../components/index.js';

/* ------------------------------------------------------------------ *
 * Frozen strings
 * ------------------------------------------------------------------ */

const T = {
  // application chrome
  appName: 'Report Workbench',
  // The one line that tells the reader WHERE they are, so it has to be read off
  // the address bar rather than typed in here: the service takes --port, and a
  // second copy running beside the first was being told the first one's number.
  service: (host) => 'Local service ' + host + ' · runs offline',
  more: 'More',
  update: (n) => 'A newer version of the tool is available (' + n + ' fixes) · Pull and restart',

  // home
  reports: 'Reports',
  search: 'Search projects, modules and reports',
  allActive: 'All active',
  newProjectOrModule: 'New project or module',
  templates: 'Templates',
  trash: 'Trash',
  designSystem: 'Design system',
  newReport: 'New report',
  importWord: 'Import Word report',
  // The ONE name receiving a package has. The same words are the shelf button
  // and the dialog's own title, so the product never calls it two things.
  applyUpdate: 'Apply an external update',
  settings: 'Settings',

  colReport: 'Report',
  colProjectModule: 'Project / Module',
  colSpecCheck: 'Spec check',
  colExchange: 'Text exchange',
  colLastChange: 'Last change',
  colActions: 'Actions',

  countSorted: (n) => n + ' reports · sorted by last change',
  newReportHere: 'New report in this module',
  open: 'Open',
  rename: 'Rename',
  duplicate: 'Duplicate',
  remove: 'Delete',
  exportIt: 'Export',
  nothingHere: 'Nothing here yet — create a report or import a Word file',
  restore: 'Restore',
  deletedWhen: (when) => 'Deleted ' + when,
  restored: (name) => 'Restored ' + name,
  notRestored: (dir) => 'Not restored — something is already at ' + dir,
  notRestoredBody:
    'Nothing was moved. A report now occupies the path this one was deleted from, so ' +
    'putting it back would overwrite it. Rename or move what is there, then restore ' +
    'this again.',
  originUnknown: (name) =>
    'The original path was not recorded — this goes back to the top level as ' + name,
  nothingInTrash: 'Nothing here yet',
  overSpec: (n) => n + ' over spec',
  noSpecProblems: 'No spec problems',
  neverExchanged: 'Never exchanged',
  exchanged: (when) => 'Exchanged ' + when,
  sectionsSince: (n) => n + ' sections changed since',
  // A report whose project.json the server could not parse. Said on the shelf,
  // before it is opened, so the failure is not the first anyone hears of it.
  unreadable: 'Unreadable',
  unreadableWhy: 'project.json is not valid JSON',

  // create / rename / duplicate / delete
  newTitle: 'New',
  project: 'Project',
  module: 'Module',
  report: 'Report',
  name: 'Name',
  stage: 'Stage',
  template: 'Template',
  startFrom: 'Start from',
  inherit: 'Inherit from an existing report',
  blank: 'Blank, from a template',
  importFile: 'Import a Word file',
  description: 'Description',
  sourceReport: 'Source report',
  replace: 'Replace',
  createProject: 'Create project',
  createModule: 'Create module',
  createReport: 'Create report',
  inheritNote:
    'Section structure, fixed text and table layout are copied. Simulation values, ' +
    'figures and conclusions start empty.',
  docxLoses:
    'Word does not record limit direction, merged spans or the document version — ' +
    'check those after importing',

  renameReport: 'Rename report',
  renameModule: 'Rename module',
  renameProject: 'Rename project',
  newName: 'New name',

  duplicateReport: 'Duplicate report',
  duplicateNote: 'The copy starts as a full copy, including values and figures',

  deleteReport: 'Delete report',
  deleteModule: 'Delete module',
  deleteProject: 'Delete project',
  // The confirmation names WHERE the restore is, and there is exactly one
  // such place: the shelf's own Trash. It used to say History, which is a
  // per-report drawer reached from inside a report -- the one door a
  // deleted report no longer opens.
  movesToTrash: (name) =>
    'This moves ' + name + ' to the trash. You can restore it from Trash.',
  moduleHolds: (n) => 'This module holds ' + n + ' reports. All of them go to the trash together.',
  typeToConfirm: (name) => 'Type ' + name + ' to confirm',
  moveToTrash: 'Move to trash',
  cancel: 'Cancel',

  created: (name) => 'Created ' + name,
  renamedTo: (name) => 'Renamed to ' + name,
  duplicatedAs: (name) => 'Duplicated as ' + name,
  movedToTrash: (name) => 'Moved ' + name + ' to the trash',
  undo: 'Undo',

  // export, run from the row menu
  exporting: 'Exporting Word and PDF',
  openFolder: 'Open folder',

  // errors and placeholders
  all: 'All',
  wentWrong: 'Something went wrong',
  notAvailable: 'This screen is not available yet',
  close: 'Close',
  noResults: 'No results',
};

const STAGES = ['XDR', 'PDR', 'CDR', 'FDR'];

// The synthetic bucket the server files a flat legacy report under. It is not a
// folder, so it can never be renamed, deleted, or used as a create target.
const UNFILED_ID = 'unfiled';

/* ------------------------------------------------------------------ *
 * Where this page is being served from
 * ------------------------------------------------------------------ */

// host:port as the address bar has it. The service binds 127.0.0.1 on whatever
// --port it was given, so the number is only knowable at runtime; a page loaded
// from a file (or a test harness with no location) says the loopback address
// alone rather than a port that would be a guess.
export function serviceHost(loc) {
  const here = loc || (typeof window !== 'undefined' ? window.location : null);
  const host = here && here.host ? String(here.host) : '';
  return host || '127.0.0.1';
}

/* ------------------------------------------------------------------ *
 * Expansion state -- persisted under its own key
 * ------------------------------------------------------------------ */

const EXPANDED_KEY = 'rw.home.expanded';

function readExpanded() {
  try {
    const raw = window.localStorage.getItem(EXPANDED_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    return {};
  }
}

function writeExpanded(map) {
  try {
    window.localStorage.setItem(EXPANDED_KEY, JSON.stringify(map || {}));
  } catch (err) {
    /* storage is a convenience, never a requirement */
  }
}

/* ------------------------------------------------------------------ *
 * Pure helpers over the tree
 * ------------------------------------------------------------------ */

function projectsOf(tree) {
  return tree && Array.isArray(tree.projects) ? tree.projects : [];
}

function reportLabel(report) {
  return String((report && (report.title || report.name || report.stage || report.dir)) || '');
}

// A module's folder path. The 'unfiled' bucket holds legacy reports that sit
// straight under the reports root, so ITS modules are the top level.
function moduleDir(project, module) {
  if (!project || !module) return '';
  return project.id === UNFILED_ID ? String(module.id) : project.id + '/' + module.id;
}

function projectModulePath(project, module) {
  return String(project.name || project.id) + ' / ' + String(module.name || module.id);
}

function matches(text, needle) {
  return String(text || '').toLowerCase().indexOf(needle) !== -1;
}

// Search filters the tree and, through it, the table. A project that matches
// keeps everything under it; otherwise only matching modules and reports stay.
function filterProjects(projects, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return projects;
  const out = [];
  for (let i = 0; i < projects.length; i++) {
    const p = projects[i];
    const pHit = matches(p.name, q) || matches(p.id, q);
    const modules = [];
    const mods = p.modules || [];
    for (let j = 0; j < mods.length; j++) {
      const m = mods[j];
      const mHit = pHit || matches(m.name, q) || matches(m.id, q);
      const reports = (m.reports || []).filter(
        (r) => mHit || matches(reportLabel(r), q) || matches(r.stage, q) || matches(r.dir, q)
      );
      if (mHit || reports.length) {
        modules.push(Object.assign({}, m, { reports: mHit ? m.reports || [] : reports }));
      }
    }
    if (pHit || modules.length) out.push(Object.assign({}, p, { modules: modules }));
  }
  return out;
}

// The table is grouped by module; which modules appear is the rail's decision.
function groupsFor(projects, sel) {
  const out = [];
  for (let i = 0; i < projects.length; i++) {
    const p = projects[i];
    if (sel.kind === 'project' && sel.project !== p.id) continue;
    const mods = p.modules || [];
    for (let j = 0; j < mods.length; j++) {
      const m = mods[j];
      if (sel.kind === 'module' && !(sel.project === p.id && sel.module === m.id)) continue;
      if (sel.kind === 'report' && !(m.reports || []).some((r) => r.dir === sel.dir)) continue;
      out.push({ project: p, module: m, reports: (m.reports || []).slice() });
    }
  }
  return out;
}

function applyStage(groups, stage) {
  if (!stage) return groups;
  return groups
    .map((g) => Object.assign({}, g, { reports: g.reports.filter((r) => r.stage === stage) }))
    .filter((g) => g.reports.length);
}

function countReports(groups) {
  let n = 0;
  for (let i = 0; i < groups.length; i++) n += groups[i].reports.length;
  return n;
}

function countOverSpec(groups) {
  let n = 0;
  for (let i = 0; i < groups.length; i++) {
    const rs = groups[i].reports;
    for (let j = 0; j < rs.length; j++) n += Number(rs[j].overSpec) || 0;
  }
  return n;
}

function stagesIn(groups) {
  const seen = {};
  for (let i = 0; i < groups.length; i++) {
    const rs = groups[i].reports;
    for (let j = 0; j < rs.length; j++) if (rs[j].stage) seen[rs[j].stage] = true;
  }
  const known = STAGES.filter((s) => seen[s]);
  const extra = Object.keys(seen).filter((s) => STAGES.indexOf(s) === -1).sort();
  return known.concat(extra);
}

// The first stage this module has no report for: a useful default, never a
// decision the author cannot change.
function suggestStage(module) {
  const used = {};
  const rs = (module && module.reports) || [];
  for (let i = 0; i < rs.length; i++) used[rs[i].stage] = true;
  for (let i = 0; i < STAGES.length; i++) if (!used[STAGES[i]]) return STAGES[i];
  return STAGES[0];
}

/* ------------------------------------------------------------------ *
 * Browser plumbing
 * ------------------------------------------------------------------ */

// A file picker with no markup: the input never enters the document, so a
// cancelled pick leaves nothing behind. Resolves null when nothing was chosen.
function chooseFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', () =>
      resolve(input.files && input.files[0] ? input.files[0] : null));
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(String(reader.error || 'read failed')));
    reader.onload = () => {
      const text = String(reader.result || '');
      const comma = text.indexOf(',');
      resolve(comma >= 0 ? text.slice(comma + 1) : text);
    };
    reader.readAsDataURL(file);
  });
}

function isDocx(file) {
  return !!file && /\.docx$/i.test(file.name || '');
}

function isZip(file) {
  return !!file && /\.zip$/i.test(file.name || '');
}

// The other shape a returned package comes in: the assistant hands back a whole
// report or an op-diff as text, and the exchange drawer inside a report has
// always taken those. The shelf's own door used to accept .zip alone, so a user
// handed a .md by the assistant found the file chooser would not even show it.
// One rule for what a returned package may be -- sync.js's PACKAGE_ACCEPT is
// that rule, and the chooser below is filtered by it.
function isTextPackage(file) {
  return !!file && /\.(md|json|txt)$/i.test(file.name || '');
}

// Whether a drag is carrying a FILE. The shelf claims those and leaves every
// other drag alone -- text dragged into the search box still lands there.
function dragHasFile(ev) {
  const types = ev && ev.dataTransfer ? ev.dataTransfer.types : null;
  return !!types && Array.prototype.indexOf.call(types, 'Files') >= 0;
}

/* ------------------------------------------------------------------ *
 * An update package, read on the shelf
 *
 * What the dialog is handed is built here; the dialog itself is sync.js's, and
 * there is only one of it. A package read HERE is always a root-level bundle:
 * the shelf has no report to merge a returned document into, and the archive
 * may name reports that do not exist yet. sync.js's own reader answers the
 * other question -- "is there a returned document for THIS report inside" --
 * which is the editor's path and stays there.
 *
 * Nothing is decompressed to draw the manifest: the central directory alone
 * carries every member's name and size. update.json is the one entry inflated,
 * because a package's declared ancestor and its note live in it, and a dialog
 * that said "this package does not name the state it was cut from" without
 * looking would be stating something it had not checked.
 * ------------------------------------------------------------------ */

function zipDirectory(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const decoder = new TextDecoder('utf-8');
  let eocd = -1;
  const floor = Math.max(0, bytes.length - 66000);
  for (let i = bytes.length - 22; i >= floor; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip archive');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50) break;
    const nameLen = view.getUint16(p + 28, true);
    const entry = {
      method: view.getUint16(p + 10, true),
      csize: view.getUint32(p + 20, true),
      size: view.getUint32(p + 24, true),
      offset: view.getUint32(p + 42, true),
      name: decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen)),
    };
    if (!entry.name.endsWith('/')) entries.push(entry);
    p += 46 + nameLen + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
  }
  return { bytes: bytes, view: view, entries: entries };
}

async function zipEntryText(zip, entry) {
  const at = entry.offset;
  if (zip.view.getUint32(at, true) !== 0x04034b50) throw new Error('damaged zip entry');
  const start = at + 30 + zip.view.getUint16(at + 26, true) + zip.view.getUint16(at + 28, true);
  const raw = zip.bytes.subarray(start, start + entry.csize);
  if (entry.method === 0) return new TextDecoder('utf-8').decode(raw);
  if (entry.method === 8 && typeof DecompressionStream === 'function') {
    const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return await new Response(stream).text();
  }
  throw new Error('unsupported zip compression');
}

// -> the descriptor ImportDialog takes: the package's facts, every member it
// carries, the state it says it was cut from, and its note.
async function readRootPackage(file) {
  const buffer = await file.arrayBuffer();
  const zip = zipDirectory(buffer);
  let manifest = null;
  const declared = zip.entries.filter((e) => e.name === 'update.json')[0];
  if (declared) {
    try {
      manifest = JSON.parse(await zipEntryText(zip, declared));
    } catch (err) {
      manifest = null;         // an unreadable manifest is not a read one
    }
  }
  return {
    kind: 'bundle',
    name: baseName(file.name),
    size: buffer.byteLength,
    created: file.lastModified ? file.lastModified / 1000 : Date.now() / 1000,
    entries: zip.entries,
    zipB64: await fileToBase64(file),
    note: String((manifest && manifest.note) || ''),
    declaredBase: (manifest && manifest.base_sha) ? String(manifest.base_sha) : null,
  };
}

function baseName(path) {
  const parts = String(path || '').replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || String(path || '');
}

function stripExt(name) {
  return String(name || '').replace(/\.[^.]+$/, '');
}

function errorText(err) {
  if (!err) return T.wentWrong;
  return String(err.message || err);
}

function cssEscape(value) {
  const text = String(value == null ? '' : value);
  if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(text);
  return text.replace(/["\\]/g, '\\$&');
}

/* ------------------------------------------------------------------ *
 * The screen
 * ------------------------------------------------------------------ */

export function Home() {
  const tree = useStore((s) => s.tree);
  const version = useStore((s) => s.version);

  const [query, setQuery] = useState('');
  const [sel, setSel] = useState({ kind: 'all' });
  const [stage, setStage] = useState('');
  const [expanded, setExpanded] = useState(readExpanded);
  const [templates, setTemplates] = useState([]);
  const [dialog, setDialog] = useState(null);
  const [menu, setMenu] = useState(null);
  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pkg, setPkg] = useState(null);
  const [trash, setTrash] = useState([]);
  const listRef = useRef(null);
  const packageInputRef = useRef(null);

  useEffect(() => {
    let live = true;
    api.getTemplates().then(
      (payload) => {
        if (live) setTemplates((payload && payload.templates) || []);
      },
      () => {}
    );
    return () => {
      live = false;
    };
  }, []);

  // What is in the trash is read here rather than inside the dialog, because
  // the rail carries its count whether the dialog is open or not, and a delete
  // has to change that count on the spot.
  const refreshTrash = useCallback(async () => {
    try {
      const payload = await api.request('GET', '/api/trash');
      const items = (payload && payload.items) || [];
      setTrash(items);
      return items;
    } catch (err) {
      setTrash([]);
      return [];
    }
  }, []);

  useEffect(() => {
    refreshTrash();
  }, [refreshTrash]);

  const refresh = useCallback(async () => {
    try {
      const next = await api.getTree();
      store.set({ tree: next });
      return next;
    } catch (err) {
      store.pushBanner({ level: 'error', code: 'tree', message: errorText(err) });
      return null;
    }
  }, []);

  const all = projectsOf(tree);
  const filtered = useMemo(() => filterProjects(all, query), [all, query]);

  // A search can filter away the very node the table is scoped to. When that
  // happens the scope stops applying rather than showing an empty table for a
  // node the rail no longer offers -- the selection itself is left alone, so
  // clearing the search puts it back.
  const scope = useMemo(() => {
    const scoped = groupsFor(filtered, sel);
    if (scoped.length || sel.kind === 'all') return { sel: sel, groups: scoped };
    return { sel: { kind: 'all' }, groups: groupsFor(filtered, { kind: 'all' }) };
  }, [filtered, sel]);
  const groups = scope.groups;
  const stages = useMemo(() => stagesIn(groups), [groups]);
  const shown = useMemo(() => applyStage(groups, stage), [groups, stage]);

  // A stage that is no longer in the scope must not silently empty the table.
  useEffect(() => {
    if (stage && stages.indexOf(stage) === -1) setStage('');
  }, [stage, stages]);

  // Selecting a report in the rail scrolls the table to it and highlights it.
  useEffect(() => {
    if (sel.kind !== 'report' || !listRef.current) return;
    const row = listRef.current.querySelector('[data-dir="' + cssEscape(sel.dir) + '"]');
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
  }, [sel, shown]);

  const toggle = useCallback(
    (key) => {
      const next = Object.assign({}, expanded);
      if (next[key]) delete next[key];
      else next[key] = true;
      writeExpanded(next);
      store.setUi({ homeExpanded: next });
      setExpanded(next);
    },
    [expanded]
  );

  const expand = useCallback(
    (keys) => {
      const next = Object.assign({}, expanded);
      for (let i = 0; i < keys.length; i++) next[keys[i]] = true;
      writeExpanded(next);
      store.setUi({ homeExpanded: next });
      setExpanded(next);
    },
    [expanded]
  );

  const openReport = useCallback((dir) => {
    store.navigate({ view: 'editor', dir: dir, node: store.lastNodeFor(dir) });
  }, []);

  const showToast = useCallback((text, action, onAction) => {
    setToast({ text: text, action: action || null, onAction: onAction || null });
  }, []);

  /* ---- current scope, used to prefill the create dialog ---- */

  const scopeProject = () => {
    if (sel.kind === 'project' || sel.kind === 'module') return sel.project;
    if (sel.kind === 'report') return groups[0] ? groups[0].project.id : '';
    return '';
  };

  const scopeModule = () => {
    if (sel.kind === 'module') return sel.module;
    if (sel.kind === 'report') return groups[0] ? groups[0].module.id : '';
    return '';
  };

  const openCreate = (patch) => {
    const pid = (patch && patch.project) || scopeProject();
    const mid = (patch && patch.module) || scopeModule();
    setDialog(
      Object.assign(
        {
          kind: 'create',
          what: 'report',
          project: pid === UNFILED_ID ? '' : pid,
          module: pid === UNFILED_ID ? '' : mid,
        },
        patch || {}
      )
    );
  };

  /* ---- Word import ---- */

  // Parsed once here so the un-recoverable fields and any parser warnings are on
  // screen BEFORE the author commits to a project and a stage. The staging
  // folder is '_'-prefixed, so it never appears on the shelf; the file is parsed
  // again into the real report folder on Create, which is what puts its figures
  // beside the document.
  const startImport = async (file) => {
    if (!isDocx(file)) return;
    setBusy(true);
    try {
      const b64 = await fileToBase64(file);
      const staging = '_import/' + Date.now();
      const payload = await api.importDocx({ docx_b64: b64, mode: 'report', dir: staging });
      const seed = (payload && payload.project) || null;
      const title = (seed && seed.meta && seed.meta.title) || stripExt(baseName(file.name));
      openCreate({
        what: 'report',
        from: 'docx',
        docx: {
          fileName: baseName(file.name),
          b64: b64,
          warnings: (payload && payload.warnings) || [],
          template: (payload && payload.template_id) || '',
        },
        name: title,
        nameTouched: true,
      });
    } catch (err) {
      store.pushBanner({ level: 'error', code: 'import-docx', message: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  const pickAndImport = async () => {
    const file = await chooseFile('.docx');
    if (file) startImport(file);
  };

  /* ---- receiving an update package ---- */

  // The package is read here only far enough to describe it; nothing is written
  // until the dialog's own button is pressed, and the dialog says so.
  const takePackage = async (file) => {
    if (!isZip(file) && !isTextPackage(file)) return;
    setBusy(true);
    try {
      setPkg(isZip(file)
        ? await readRootPackage(file)
        : packageFromText(baseName(file.name), await file.text(),
                          file.lastModified ? file.lastModified / 1000 : Date.now() / 1000));
    } catch (err) {
      store.pushBanner({ level: 'error', code: 'apply-update', message: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  // A real input in the document rather than the detached one the Word import
  // uses, so the shelf's file picker is a thing the page owns and a test can
  // drive.
  const pickPackage = () => {
    if (packageInputRef.current) packageInputRef.current.click();
  };

  // One answer to a dropped file, used by the empty state and by the whole
  // shelf behind it, so where the pointer happens to be does not change what a
  // drop means.
  const takeDropped = (ev) => {
    const files = ev && ev.dataTransfer ? ev.dataTransfer.files : null;
    const file = files && files[0];
    if (isZip(file) || isTextPackage(file)) {
      takePackage(file);
      return;
    }
    if (isDocx(file)) startImport(file);
  };

  /* ---- the four operations ---- */

  const runCreate = async (form) => {
    const body = { kind: form.what };
    if (form.what === 'project') {
      body.project = form.name;
      body.name = form.name;
      body.description = form.description || '';
    } else if (form.what === 'module') {
      body.project = form.project;
      body.module = form.name;
      body.name = form.name;
      body.description = form.description || '';
      if (form.template) body.template = form.template;
    } else {
      body.project = form.project;
      body.module = form.module;
      body.stage = form.stage;
      body.name = form.name;
      body.title = form.name;
      if (form.from === 'inherit') {
        body.mode = 'inherit';
        body.from = form.source;
        body.clearValues = true;
      } else if (form.from === 'template') {
        body.mode = 'template';
        body.template = form.template;
      } else {
        body.mode = 'docx';
        const dir = form.project + '/' + form.module + '/' + form.stage;
        const imported = await api.importDocx({
          docx_b64: form.docx.b64,
          mode: 'report',
          dir: dir,
          template: form.docx.template || undefined,
        });
        const seed = imported && imported.project;
        // An imported document keeps its own cover metadata, so the name typed
        // in the dialog has to be written into the seed or it would be lost.
        if (seed && form.name) {
          seed.meta = Object.assign({}, seed.meta, { title: form.name });
        }
        body.seed = seed;
        if (imported && imported.template_id) body.template = imported.template_id;
      }
    }
    const result = await api.reportNew(body);
    await refresh();
    showToast(T.created(form.name));
    if (form.what === 'report') {
      if (result && result.dir) openReport(result.dir);
      return;
    }
    // Whatever was just made has to be visible in the rail, not only scoped in
    // the table, so the branch holding it is opened.
    const dir = (result && result.dir) || '';
    if (form.what === 'module') {
      const mid = baseName(dir) || form.name;
      expand(['p:' + form.project, 'm:' + form.project + '/' + mid]);
      setSel({ kind: 'module', project: form.project, module: mid });
    } else {
      const pid = dir || form.name;
      expand(['p:' + pid]);
      setSel({ kind: 'project', project: pid });
    }
  };

  // Renaming a REPORT changes its title and nothing else. Its folder is the
  // address: `dir` is the only thing an update package or an op-diff carries,
  // and the stage leaf of PROJECT/MODULE/STAGE is where the shelf reads the
  // stage from -- so moving it would orphan every package already cut for the
  // old path and invent a fifth stage. The server enforces that too; this is
  // the shelf asking for the right thing in the first place.
  //
  // A module or a project is a container, so renaming one still moves a folder.
  const renameReportTitle = (dir, title) =>
    api.request('POST', '/api/project-rename', { body: { dir: dir, title: title } });

  const runRename = async (target, newName) => {
    const isReport = target.what === 'report';
    const result = isReport
      ? await renameReportTitle(target.dir, newName)
      : await api.projectRename(target.dir, newName);
    const dir = (result && result.dir) || target.dir;
    await refresh();
    setSel({ kind: 'all' });
    showToast(T.renamedTo(newName), T.undo, async () => {
      setToast(null);
      try {
        if (isReport) await renameReportTitle(dir, target.label);
        else await api.projectRename(dir, target.prevLeaf);
        await refresh();
      } catch (err) {
        store.pushBanner({ level: 'error', code: 'rename', message: errorText(err) });
      }
    });
  };

  const runDuplicate = async (target, newName) => {
    const result = await api.projectCopy(target.dir, newName);
    const dir = (result && result.dir) || '';
    await refresh();
    showToast(T.duplicatedAs(newName), T.undo, async () => {
      setToast(null);
      try {
        if (dir) await api.projectDelete(dir);
        await refresh();
      } catch (err) {
        store.pushBanner({ level: 'error', code: 'duplicate', message: errorText(err) });
      }
    });
  };

  // Every delete moves the folder to the trash -- the server never hard-deletes,
  // which is why all three confirmations can promise it is recoverable. The
  // trash is re-read straight away: the promise the confirmation just made is
  // only true if the entry is on the shelf's Trash list a moment later.
  const runDelete = async (target) => {
    await api.projectDelete(target.dir);
    await refresh();
    await refreshTrash();
    setSel({ kind: 'all' });
    showToast(T.movedToTrash(target.label));
  };

  // The other half of that promise. The server refuses rather than overwrites
  // when something occupies the original path, so the failure is thrown on to
  // the dialog, which keeps the entry listed and says what did not happen.
  const runRestore = async (entry) => {
    const result = await api.request('POST', '/api/trash-restore', {
      body: { id: entry.id },
    });
    await refresh();
    await refreshTrash();
    setSel({ kind: 'all' });
    showToast(T.restored(entry.name));
    return result;
  };

  const runExport = async (report) => {
    showToast(T.exporting);
    try {
      const result = await api.exportStream(report.dir, null, { fmt: 'pdf' });
      const out = (result && (result.out || result.abs)) || '';
      setToast({
        text: baseName(out),
        action: T.openFolder,
        onAction: () => {
          setToast(null);
          api
            .request('POST', '/api/open-path', {
              body: { dir: report.dir, file: 'out', folder: true },
            })
            .catch((err) =>
              store.pushBanner({ level: 'error', code: 'open', message: errorText(err) }));
        },
      });
    } catch (err) {
      setToast(null);
      store.pushBanner({ level: 'error', code: 'export', message: errorText(err) });
    }
  };

  /* ---- context menus ---- */

  const anchor = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const box = ev.currentTarget.getBoundingClientRect();
    return { x: box.right, y: box.bottom + 2 };
  };

  const openRowMenu = (ev, project, module, report) => {
    const at = anchor(ev);
    setMenu({
      x: at.x,
      y: at.y,
      items: [
        { label: T.open, onClick: () => openReport(report.dir) },
        {
          label: T.rename,
          onClick: () =>
            setDialog({
              kind: 'rename',
              what: 'report',
              dir: report.dir,
              value: reportLabel(report),
              label: reportLabel(report),
              prevLeaf: baseName(report.dir),
            }),
        },
        {
          label: T.duplicate,
          onClick: () =>
            setDialog({
              kind: 'duplicate',
              dir: report.dir,
              value: baseName(report.dir) + '_copy',
              label: reportLabel(report),
            }),
        },
        { label: T.exportIt, onClick: () => runExport(report) },
        {
          label: T.remove,
          danger: true,
          separatorBefore: true,
          onClick: () =>
            setDialog({ kind: 'delete', what: 'report', dir: report.dir, label: reportLabel(report) }),
        },
      ],
    });
  };

  // WHERE AN ACT BELONGS IS WHERE IT ACTS.
  //
  // `Apply an external update` and `Settings` are addressed to the whole
  // machine -- a package names its own destinations and can create reports
  // under any project -- so they live on the top bar and nowhere else.
  // `New report` is addressed to whatever the breadcrumb has selected, so it
  // lives beside the breadcrumb, once.
  //
  // The caret is a shortcut into the create dialog's own `Start from` choice,
  // not a second set of rules: each entry opens the same dialog with that
  // choice already made. `Import Word report` used to be a top-level button
  // for one of these three, listed twice, in two different orders.
  const openNewMenu = (ev) => {
    const at = anchor(ev);
    setMenu({
      x: at.x,
      y: at.y,
      items: [
        { label: T.blank, onClick: () => openCreate({ from: 'template' }) },
        { label: T.importFile, onClick: () => pickAndImport() },
        { label: T.inherit, onClick: () => openCreate({ from: 'inherit' }) },
      ],
    });
  };

  const openModuleMenu = (ev, project, module) => {
    const at = anchor(ev);
    const dir = moduleDir(project, module);
    const reports = module.reports || [];
    setMenu({
      x: at.x,
      y: at.y,
      items: [
        {
          label: T.newReportHere,
          disabled: project.id === UNFILED_ID,
          onClick: () => openCreate({ what: 'report', project: project.id, module: module.id }),
        },
        {
          label: T.rename,
          onClick: () =>
            setDialog({
              kind: 'rename',
              what: 'module',
              dir: dir,
              value: module.id,
              label: String(module.name || module.id),
              prevLeaf: module.id,
            }),
        },
        {
          label: T.remove,
          danger: true,
          separatorBefore: true,
          onClick: () =>
            setDialog({
              kind: 'delete',
              what: 'module',
              dir: dir,
              label: String(module.name || module.id),
              count: reports.length,
              reports: reports.map(reportLabel),
            }),
        },
      ],
    });
  };

  const openProjectMenu = (ev, project) => {
    const at = anchor(ev);
    // A project delete names every report it takes with it, the same way the
    // module weight does -- there is no "and 9 others" here.
    const carried = [];
    (project.modules || []).forEach((m) => {
      (m.reports || []).forEach((r) => carried.push(reportLabel(r)));
    });
    const synthetic = project.id === UNFILED_ID;
    setMenu({
      x: at.x,
      y: at.y,
      items: [
        {
          label: T.newReportHere,
          disabled: synthetic,
          onClick: () => openCreate({ what: 'report', project: project.id, module: '' }),
        },
        {
          label: T.rename,
          disabled: synthetic,
          onClick: () =>
            setDialog({
              kind: 'rename',
              what: 'project',
              dir: project.id,
              value: project.id,
              label: String(project.name || project.id),
              prevLeaf: project.id,
            }),
        },
        {
          label: T.remove,
          danger: true,
          separatorBefore: true,
          disabled: synthetic,
          onClick: () =>
            setDialog({
              kind: 'delete',
              what: 'project',
              dir: project.id,
              label: String(project.name || project.id),
              count: carried.length,
              reports: carried,
            }),
        },
      ],
    });
  };

  /* ---- header ---- */

  let crumb = [T.reports];
  let title = T.reports;
  let description = '';
  if (scope.sel.kind !== 'all' && groups[0]) {
    const g = groups[0];
    crumb = [T.reports, String(g.project.name || g.project.id)];
    title = String(g.project.name || g.project.id);
    description = g.project.description || '';
    if (scope.sel.kind !== 'project') {
      crumb.push(String(g.module.name || g.module.id));
      title = String(g.module.name || g.module.id);
      description = g.module.description || '';
    }
  }

  const over = countOverSpec(shown);
  const total = countReports(shown);
  const updateReady = version && version.available && version.available !== version.local;
  const stageOptions = [{ value: '', label: T.all }].concat(
    stages.map((s) => ({ value: s, label: s })));

  return html`
    <div
      class="rw-app"
      onDragOver=${(ev) => {
        if (!dialog && !pkg && dragHasFile(ev)) ev.preventDefault();
      }}
      onDrop=${(ev) => {
        // The empty state is its own drop target and answers first, preventing
        // the default before the event reaches here -- so one dropped file is
        // never read twice. A dialog on screen owns the pointer entirely.
        if (ev.defaultPrevented || dialog || pkg) return;
        ev.preventDefault();
        takeDropped(ev);
      }}
    >
      <div class="rw-topbar">
        <span class="rw-topbar__mark" aria-hidden="true">R</span>
        <span class="rw-topbar__name">${T.appName}</span>
        <span class="rw-topbar__rule"></span>
        <span class="rw-topbar__sub">${T.service(serviceHost())}</span>
        <span class="rw-spacer"></span>
        <div class="rw-topbar__actions">
          ${updateReady
            ? html`<${Pill} tone="accent">${T.update(version.fixes == null ? 0 : version.fixes)}<//>`
            : null}
          <${Button} onClick=${pickPackage} disabled=${busy}>${T.applyUpdate}<//>
          <${IconButton} glyph="⚙" title=${T.settings}
                         onClick=${() => setDialog({ kind: 'stub', label: T.settings })} />
        </div>
      </div>

      <div class="rw-shell">
        <${Rail}
          projects=${filtered}
          sel=${sel}
          onSelect=${setSel}
          query=${query}
          onQuery=${setQuery}
          expanded=${expanded}
          onToggle=${toggle}
          templates=${templates}
          trash=${trash}
          onNew=${() => openCreate({ what: all.length ? 'module' : 'project' })}
          onProjectMenu=${openProjectMenu}
          onModuleMenu=${openModuleMenu}
          onTrash=${() => {
            refreshTrash();
            setDialog({ kind: 'trash' });
          }}
          onStub=${(label) => setDialog({ kind: 'stub', label: label })}
        />

        <div class="rw-home__detail">
          <div class="rw-home__header">
            <div class="rw-home__crumb">
              ${crumb.map((part, i) => html`
                <${Fragment} key=${i}>
                  ${i ? html`<span aria-hidden="true">›</span>` : null}<span>${part}</span>
                <//>`)}
              <span class="rw-spacer"></span>
              <div class="rw-split">
                <${Button} level="primary" className="rw-split__main"
                           onClick=${() => openCreate({})}>${T.newReport}<//>
                <${IconButton} glyph="▾" title=${T.startFrom}
                               className="rw-split__more" disabled=${busy}
                               onClick=${openNewMenu} />
              </div>
            </div>
            <div class="rw-home__titleline">
              <span class="rw-screen-title">${title}</span>
              ${description ? html`<span class="rw-home__desc">${description}</span>` : null}
              <span class=${classNames('rw-specsum', !over && 'rw-specsum--clear')}>
                ${over ? '✕ ' + T.overSpec(over) : T.noSpecProblems}
              </span>
            </div>
          </div>

          <div class="rw-home__filters">
            <${Chips} value=${stage} onChange=${setStage} ariaLabel=${T.stage}
                      options=${stageOptions} />
            <span class="rw-home__filtermeta">${T.countSorted(total)}</span>
          </div>

          <div class="rw-home__list" ref=${listRef}>
            ${total === 0
              ? html`
                <div class="rw-rows__tail">
                  <${EmptyState}
                    title=${query || stage ? T.noResults : T.nothingHere}
                    onDrop=${takeDropped}
                  >
                    <${Button} level="primary" onClick=${() => openCreate({})}>${T.newReport}<//>
                    <${Button} onClick=${pickAndImport}>${T.importWord}<//>
                    <${Button} onClick=${pickPackage}>${T.applyUpdate}<//>
                  <//>
                </div>`
              : html`
                <div class="rw-rows">
                  <div class="rw-rows__head">
                    <span>${T.colReport}</span>
                    <span>${T.colProjectModule}</span>
                    <span>${T.colSpecCheck}</span>
                    <span>${T.colExchange}</span>
                    <span>${T.colLastChange}</span>
                    <span>${T.colActions}</span>
                  </div>
                  ${shown.map((g) => html`
                    <${Group}
                      key=${g.project.id + '/' + g.module.id}
                      group=${g}
                      sel=${sel}
                      onOpen=${openReport}
                      onRowMenu=${openRowMenu}
                      onNewHere=${() =>
                        openCreate({ what: 'report', project: g.project.id, module: g.module.id })}
                    />`)}
                  <div class="rw-rows__tail">
                    <button type="button" class="rw-dashrow" onClick=${() => openCreate({})}>
                      <span aria-hidden="true">+</span>${T.newReport}
                    </button>
                  </div>
                </div>`}
          </div>
        </div>
      </div>

      ${menu
        ? html`<${Menu} x=${menu.x} y=${menu.y} items=${menu.items}
                        onClose=${() => setMenu(null)} />`
        : null}

      ${dialog
        ? html`
          <${Dialogs}
            dialog=${dialog}
            projects=${all}
            templates=${templates}
            trash=${trash}
            onClose=${() => setDialog(null)}
            onCreate=${runCreate}
            onRename=${runRename}
            onDuplicate=${runDuplicate}
            onDelete=${runDelete}
            onRestore=${runRestore}
          />`
        : null}

      ${toast
        ? html`
          <${Toast}
            text=${toast.text}
            action=${toast.action}
            onAction=${toast.onAction}
            onDismiss=${() => setToast(null)}
          />`
        : null}

      <input
        ref=${packageInputRef}
        type="file"
        class="rw-hidden"
        accept=${PACKAGE_ACCEPT}
        onChange=${(ev) => {
          const file = ev.target.files && ev.target.files[0];
          ev.target.value = '';
          takePackage(file);
        }}
      />

      ${pkg
        ? html`
          <${ImportDialog}
            dir=""
            pkg=${pkg}
            baseline=${{ none: false, sha: '' }}
            onClose=${() => setPkg(null)}
            onDone=${async () => {
              setPkg(null);
              // The package may have CREATED reports, so the shelf is re-read
              // rather than patched: what changed is not knowable from here.
              await refresh();
            }}
          />`
        : null}
    </div>`;
}

/* ------------------------------------------------------------------ *
 * Left rail -- a filter over the table, never the list itself
 * ------------------------------------------------------------------ */

function Rail(props) {
  const {
    projects, sel, onSelect, query, onQuery, expanded, onToggle,
    templates, trash, onNew, onProjectMenu, onModuleMenu, onTrash, onStub,
  } = props;

  return html`
    <div class="rw-home__rail">
      <div class="rw-home__railtop">
        <div class="rw-search">
          <span class="rw-search__glyph" aria-hidden="true">⌕</span>
          <input
            class="rw-input"
            type="text"
            value=${query}
            placeholder=${T.search}
            aria-label=${T.search}
            onInput=${(ev) => onQuery(ev.currentTarget.value)}
            onKeyDown=${(ev) => {
              if (ev.key === 'Escape' && query) {
                ev.preventDefault();
                onQuery('');
              }
            }}
          />
          ${query
            ? html`<${IconButton} className="rw-search__clear" small glyph="✕"
                                  title=${T.close} onClick=${() => onQuery('')} />`
            : null}
        </div>
      </div>

      <div class="rw-home__railbody">
        <div class="rw-tree" role="tree" aria-label=${T.reports}>
          <div
            class=${classNames('rw-tree__row', sel.kind === 'all' && 'rw-tree__row--on')}
            role="treeitem"
            tabIndex="0"
            aria-selected=${sel.kind === 'all' ? 'true' : 'false'}
            onClick=${() => onSelect({ kind: 'all' })}
            onKeyDown=${(ev) => {
              if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                onSelect({ kind: 'all' });
              }
            }}
          >
            <span class="rw-tree__twisty" aria-hidden="true">◆</span>
            <span class="rw-tree__label">${T.allActive}</span>
          </div>

          ${projects.map((p) => html`
            <${ProjectBranch}
              key=${p.id}
              project=${p}
              sel=${sel}
              onSelect=${onSelect}
              expanded=${expanded}
              onToggle=${onToggle}
              onProjectMenu=${onProjectMenu}
              onModuleMenu=${onModuleMenu}
            />`)}

          <div class="rw-tree__group">
            <button type="button" class="rw-dashrow" onClick=${onNew}>
              <span aria-hidden="true">+</span>${T.newProjectOrModule}
            </button>
          </div>
        </div>
      </div>

      <div class="rw-home__railfoot">
        <div class="rw-tree">
          <${FootRow} label=${T.templates} count=${templates.length}
                      onClick=${() => onStub(T.templates)} />
          <${FootRow} label=${T.trash} count=${(trash || []).length}
                      onClick=${onTrash} />
          <${FootRow} label=${T.designSystem} glyph="›"
                      onClick=${() => onStub(T.designSystem)} />
        </div>
      </div>
    </div>`;
}

function FootRow({ label, count, glyph, onClick }) {
  return html`
    <button type="button" class="rw-tree__row" onClick=${onClick}>
      <span class="rw-tree__label">${label}</span>
      ${count === undefined || count === null ? null : html`<span class="rw-tree__count">${count}</span>`}
      ${glyph ? html`<span class="rw-tree__count" aria-hidden="true">${glyph}</span>` : null}
    </button>`;
}

function ProjectBranch(props) {
  const { project, sel, onSelect, expanded, onToggle, onProjectMenu, onModuleMenu } = props;
  const key = 'p:' + project.id;
  const open = !!expanded[key];
  const modules = project.modules || [];

  let count = 0;
  let over = 0;
  modules.forEach((m) => {
    (m.reports || []).forEach((r) => {
      count += 1;
      over += Number(r.overSpec) || 0;
    });
  });

  const on = sel.kind === 'project' && sel.project === project.id;
  const select = () => onSelect({ kind: 'project', project: project.id });

  return html`
    <${Fragment}>
      <div
        class=${classNames('rw-tree__row', on && 'rw-tree__row--on')}
        role="treeitem"
        tabIndex="0"
        aria-expanded=${open ? 'true' : 'false'}
        aria-selected=${on ? 'true' : 'false'}
        onClick=${select}
        onKeyDown=${(ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            select();
          } else if (ev.key === 'ArrowRight' && !open) onToggle(key);
          else if (ev.key === 'ArrowLeft' && open) onToggle(key);
        }}
      >
        <span
          class="rw-tree__twisty"
          role="presentation"
          onClick=${(ev) => {
            ev.stopPropagation();
            onToggle(key);
          }}
        >${open ? '▾' : '▸'}</span>
        <span class="rw-tree__label">${project.name || project.id}</span>
        ${over ? html`<span class="rw-bad" aria-hidden="true">⚠</span>` : null}
        <span class="rw-tree__count">${count}</span>
        <${IconButton} small glyph="⋯" title=${T.more}
                       onClick=${(ev) => onProjectMenu(ev, project)} />
      </div>

      ${open
        ? modules.map((m) => html`
          <${ModuleBranch}
            key=${m.id}
            project=${project}
            module=${m}
            sel=${sel}
            onSelect=${onSelect}
            expanded=${expanded}
            onToggle=${onToggle}
            onModuleMenu=${onModuleMenu}
          />`)
        : null}
    <//>`;
}

function ModuleBranch(props) {
  const { project, module, sel, onSelect, expanded, onToggle, onModuleMenu } = props;
  const key = 'm:' + project.id + '/' + module.id;
  const open = !!expanded[key];
  const reports = module.reports || [];
  const on = sel.kind === 'module' && sel.project === project.id && sel.module === module.id;
  const select = () => onSelect({ kind: 'module', project: project.id, module: module.id });

  return html`
    <${Fragment}>
      <div
        class=${classNames('rw-tree__row', 'rw-tree__row--l2', on && 'rw-tree__row--on')}
        role="treeitem"
        tabIndex="0"
        aria-expanded=${open ? 'true' : 'false'}
        aria-selected=${on ? 'true' : 'false'}
        onClick=${select}
        onKeyDown=${(ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            select();
          } else if (ev.key === 'ArrowRight' && !open) onToggle(key);
          else if (ev.key === 'ArrowLeft' && open) onToggle(key);
        }}
      >
        <span
          class="rw-square"
          role="presentation"
          onClick=${(ev) => {
            ev.stopPropagation();
            onToggle(key);
          }}
        ></span>
        <span class="rw-tree__label">${module.name || module.id}</span>
        <span class="rw-tree__count">${reports.length}</span>
        <${IconButton} small glyph="⋯" title=${T.more}
                       onClick=${(ev) => onModuleMenu(ev, project, module)} />
      </div>

      ${open
        ? reports.map((r) => {
            const rOn = sel.kind === 'report' && sel.dir === r.dir;
            return html`
              <div
                key=${r.dir}
                class=${classNames('rw-tree__row', 'rw-tree__row--l3', rOn && 'rw-tree__row--on')}
                role="treeitem"
                tabIndex="0"
                aria-selected=${rOn ? 'true' : 'false'}
                onClick=${() => onSelect({ kind: 'report', dir: r.dir })}
                onKeyDown=${(ev) => {
                  if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    onSelect({ kind: 'report', dir: r.dir });
                  }
                }}
              >
                <span class="rw-tree__label">${reportLabel(r)}</span>
                ${r.overSpec ? html`<span class="rw-bad" aria-hidden="true">⚠</span>` : null}
              </div>`;
          })
        : null}
    <//>`;
}

/* ------------------------------------------------------------------ *
 * The report table
 * ------------------------------------------------------------------ */

function Group({ group, sel, onOpen, onRowMenu, onNewHere }) {
  const { project, module, reports } = group;
  return html`
    <${Fragment}>
      <div class="rw-rows__group">
        <span class="rw-square"></span>
        <span class="rw-strong">${module.name || module.id}</span>
        <span class="rw-dim">${project.name || project.id}</span>
        ${module.description
          ? html`<span class="rw-dim rw-truncate">${module.description}</span>`
          : null}
        <span class="rw-rows__groupaction">
          <${Button} level="tertiary" onClick=${onNewHere}>${T.newReportHere}<//>
        </span>
      </div>
      ${reports.map((r) => html`
        <${Row}
          key=${r.dir}
          project=${project}
          module=${module}
          report=${r}
          selected=${sel.kind === 'report' && sel.dir === r.dir}
          onOpen=${onOpen}
          onRowMenu=${onRowMenu}
        />`)}
    <//>`;
}

function Row({ project, module, report, selected, onOpen, onRowMenu }) {
  const exchange = report.exchange || {};
  const since = Number(exchange.sectionsSince) || 0;
  const last = exchange.last;
  const unreadable = !!report.unreadable;

  return html`
    <div
      class=${classNames('rw-row', selected && 'rw-row--on', unreadable && 'rw-row--unreadable')}
      data-dir=${report.dir}
      role="button"
      tabIndex="0"
      onClick=${() => onOpen(report.dir)}
      onKeyDown=${(ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          onOpen(report.dir);
        }
      }}
    >
      <span class="rw-row__name">
        ${report.stage ? html`<span class="rw-stage">${report.stage}</span>` : null}
        <span class="rw-row__title">${reportLabel(report)}</span>
        ${unreadable ? html`
          <span class="rw-row__unreadable" role="img"
                title=${T.unreadableWhy + (report.error ? ' — ' + report.error : '')}
                aria-label=${T.unreadable + ' — ' + T.unreadableWhy}>
            ${T.unreadable}
          </span>` : null}
      </span>
      <span class="rw-row__path rw-truncate">${projectModulePath(project, module)}</span>
      <span class="rw-row__spec">
        ${unreadable ? html`<span class="rw-dim">${T.unreadableWhy}</span>`
          : report.overSpec ? '✕ ' + T.overSpec(report.overSpec) : ''}
      </span>
      <span class=${classNames('rw-row__exchange', !last && 'rw-row__exchange--never')}>
        ${last ? T.exchanged(relativeTime(last)) : T.neverExchanged}
        ${since ? html`<span class="rw-row__since"> · ${T.sectionsSince(since)}</span>` : null}
      </span>
      <span class="rw-row__when">${relativeTime(report.mtime)}</span>
      <span class="rw-row__actions" onClick=${(ev) => ev.stopPropagation()}>
        <${Button} level="tertiary" onClick=${() => onOpen(report.dir)}>${T.open}<//>
        <${IconButton} glyph="⋯" title=${T.more}
                       onClick=${(ev) => onRowMenu(ev, project, module, report)} />
      </span>
    </div>`;
}

/* ------------------------------------------------------------------ *
 * Dialogs
 * ------------------------------------------------------------------ */

function Dialogs(props) {
  const { dialog } = props;
  if (dialog.kind === 'create') return html`<${CreateDialog} ...${props} />`;
  if (dialog.kind === 'rename') return html`<${RenameDialog} ...${props} />`;
  if (dialog.kind === 'duplicate') return html`<${DuplicateDialog} ...${props} />`;
  if (dialog.kind === 'delete') return html`<${DeleteDialog} ...${props} />`;
  if (dialog.kind === 'trash') return html`<${TrashDialog} ...${props} />`;
  return html`<${StubDialog} ...${props} />`;
}

function StubDialog({ dialog, onClose }) {
  return html`
    <${Dialog}
      title=${dialog.label}
      width=${420}
      onClose=${onClose}
      footer=${html`<${Button} onClick=${onClose}>${T.close}<//>`}
    >
      <div class="rw-dim">${T.notAvailable}</div>
    <//>`;
}

// One failure banner for every dialog here. `title` names the operation that did
// not happen when there is a better word for it than "something went wrong" --
// a refused restore is not a fault, it is an answer.
function DialogError({ title, message }) {
  if (!message) return null;
  return html`
    <div class="rw-banner rw-banner--blocking rw-dialog__alert" role="alert">
      <span class="rw-banner__glyph" aria-hidden="true">✕</span>
      <div class="rw-banner__body">
        <div class="rw-banner__title">${title || T.wentWrong}</div>
        <div>${message}</div>
      </div>
    </div>`;
}

// One dialog, three field sets. The segmented control at the top swaps the set
// and nothing else about the dialog changes -- which is why it is one dialog.
function CreateDialog({ dialog, projects, templates, onClose, onCreate }) {
  const realProjects = projects.filter((p) => p.id !== UNFILED_ID);

  // Every field that has a sensible default is DERIVED from the choice above
  // it, not copied into state by an effect: the project decides the module, the
  // module decides which stage is free and whether there is anything to inherit
  // from, and each of those answers changes while the dialog is open. An empty
  // choice means "still following the default".
  const [what, setWhat] = useState(dialog.what || 'report');
  const [projectChoice, setProject] = useState(dialog.project || '');
  const [moduleChoice, setModule] = useState(dialog.module || '');
  const [stageChoice, setStage] = useState(dialog.stage || '');
  const [fromChoice, setFrom] = useState(dialog.from || '');
  const [sourceChoice, setSource] = useState('');
  const [templateChoice, setTemplate] = useState(dialog.template || '');
  const [typedName, setTypedName] = useState(dialog.name || '');
  const [nameTouched, setNameTouched] = useState(!!dialog.nameTouched);
  const [description, setDescription] = useState('');
  const [docx, setDocx] = useState(dialog.docx || null);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);

  const project = projectChoice || (realProjects[0] ? realProjects[0].id : '');
  const projectObj = realProjects.filter((p) => p.id === project)[0] || null;
  const modules = (projectObj && projectObj.modules) || [];
  const module = moduleChoice || (modules[0] ? modules[0].id : '');
  const moduleObj = modules.filter((m) => m.id === module)[0] || null;
  const siblings = ((moduleObj && moduleObj.reports) || []).slice();
  const stage = stageChoice || suggestStage(moduleObj);
  const from = fromChoice || (siblings.length ? 'inherit' : 'template');
  const source = sourceChoice || (siblings[0] ? siblings[0].dir : '');
  const template = templateChoice || (templates[0] ? templates[0].id : '');

  // The name tracks {MODULE} {STAGE} until the author types something.
  const autoName = what === 'report' && moduleObj
    ? [String(moduleObj.name || moduleObj.id), stage].filter(Boolean).join(' ')
    : '';
  const name = nameTouched ? typedName : autoName;

  const typeName = (value) => {
    setTypedName(value);
    setNameTouched(true);
  };

  const pickDocx = async () => {
    const file = await chooseFile('.docx');
    if (!isDocx(file)) return;
    try {
      const b64 = await fileToBase64(file);
      setDocx({ fileName: baseName(file.name), b64: b64, warnings: [], template: '' });
      if (!nameTouched) typeName(stripExt(baseName(file.name)));
    } catch (err) {
      setError(errorText(err));
    }
  };

  let ready = !!name.trim() && !working;
  if (what === 'module') ready = ready && !!project;
  if (what === 'report') {
    ready = ready && !!project && !!module && !!stage;
    if (from === 'inherit') ready = ready && !!source;
    if (from === 'template') ready = ready && !!template;
    if (from === 'docx') ready = ready && !!docx;
  }

  const submit = async () => {
    setError('');
    setWorking(true);
    try {
      await onCreate({
        what: what,
        project: project,
        module: module,
        stage: stage,
        from: from,
        source: source,
        template: template,
        name: name.trim(),
        description: description,
        docx: docx,
      });
      onClose();
    } catch (err) {
      setError(errorText(err));
      setWorking(false);
    }
  };

  const createLabel =
    what === 'project' ? T.createProject : what === 'module' ? T.createModule : T.createReport;

  const projectPicker = (onPick) => html`
    <select class="rw-input" value=${project} onChange=${(ev) => onPick(ev.currentTarget.value)}>
      ${realProjects.map((p) => html`<option key=${p.id} value=${p.id}>${p.name || p.id}</option>`)}
    </select>`;

  const templatePicker = html`
    <select class="rw-input" value=${template}
            onChange=${(ev) => setTemplate(ev.currentTarget.value)}>
      ${templates.map((t) => html`<option key=${t.id} value=${t.id}>${t.name || t.id}</option>`)}
    </select>`;

  return html`
    <${Dialog}
      title=${T.newTitle}
      width=${600}
      scrimCloses=${false}
      onClose=${onClose}
      footerLeft=${what === 'report' && from === 'inherit' ? T.inheritNote : null}
      footer=${html`
        <${Button} onClick=${onClose}>${T.cancel}<//>
        <${Button} level="primary" disabled=${!ready} onClick=${submit}>${createLabel}<//>`}
    >
      <div class="rw-seg rw-dialog__switch" role="radiogroup" aria-label=${T.newTitle}>
        ${[['project', T.project], ['module', T.module], ['report', T.report]].map((opt) => html`
          <button
            key=${opt[0]}
            type="button"
            role="radio"
            aria-checked=${what === opt[0] ? 'true' : 'false'}
            class=${classNames('rw-seg__item', what === opt[0] && 'rw-seg__item--on')}
            onClick=${() => setWhat(opt[0])}
          >${opt[1]}</button>`)}
      </div>

      <${DialogError} message=${error} />

      ${what === 'project'
        ? html`
          <div class="rw-formgrid rw-formgrid--full">
            <${Field} label=${T.name}>
              <input class="rw-input" value=${name}
                     onInput=${(ev) => typeName(ev.currentTarget.value)} />
            <//>
            <${Field} label=${T.description}>
              <textarea class="rw-textarea" value=${description}
                        onInput=${(ev) => setDescription(ev.currentTarget.value)}></textarea>
            <//>
          </div>`
        : null}

      ${what === 'module'
        ? html`
          <div class="rw-formgrid">
            <${Field} label=${T.project}>
              ${projectPicker((value) => {
                setProject(value);
                setModule('');
              })}
            <//>
            <${Field} label=${T.name}>
              <input class="rw-input" value=${name}
                     onInput=${(ev) => typeName(ev.currentTarget.value)} />
            <//>
            <${Field} label=${T.template}>${templatePicker}<//>
            <div class="rw-formgrid__wide">
              <${Field} label=${T.description}>
                <textarea class="rw-textarea" value=${description}
                          onInput=${(ev) => setDescription(ev.currentTarget.value)}></textarea>
              <//>
            </div>
          </div>`
        : null}

      ${what === 'report'
        ? html`
          <div class="rw-formgrid">
            <${Field} label=${T.project}>
              ${projectPicker((value) => {
                setProject(value);
                setModule('');
                setSource('');
              })}
            <//>
            <${Field} label=${T.module}>
              <select class="rw-input" value=${module}
                      onChange=${(ev) => {
                        setModule(ev.currentTarget.value);
                        setSource('');
                      }}>
                ${modules.map((m) => html`
                  <option key=${m.id} value=${m.id}>${m.name || m.id}</option>`)}
              </select>
            <//>

            <div class="rw-formgrid__wide">
              <${Field} label=${T.stage}>
                <${Chips} value=${stage} onChange=${setStage} ariaLabel=${T.stage}
                          options=${STAGES.map((s) => ({ value: s, label: s }))} />
              <//>
            </div>

            <div class="rw-formgrid__wide">
              <${Field} label=${T.startFrom}>
                <${Chips}
                  value=${from}
                  onChange=${setFrom}
                  wrap
                  ariaLabel=${T.startFrom}
                  options=${[
                    { value: 'inherit', label: T.inherit, disabled: !siblings.length },
                    { value: 'template', label: T.blank },
                    { value: 'docx', label: T.importFile },
                  ]}
                />
              <//>
            </div>

            ${from === 'inherit'
              ? html`
                <div class="rw-formgrid__wide">
                  <${Field} label=${T.sourceReport}>
                    <select class="rw-input" value=${source}
                            onChange=${(ev) => setSource(ev.currentTarget.value)}>
                      ${siblings.map((r) => html`
                        <option key=${r.dir} value=${r.dir}>${reportLabel(r)}</option>`)}
                    </select>
                  <//>
                </div>`
              : null}

            ${from === 'template'
              ? html`
                <div class="rw-formgrid__wide">
                  <${Field} label=${T.template}>${templatePicker}<//>
                </div>`
              : null}

            ${from === 'docx'
              ? html`
                <div class="rw-formgrid__wide">
                  <${Field} label=${T.importFile}>
                    <div class="rw-btnrow">
                      ${docx ? html`<span class="rw-strong">${docx.fileName}</span>` : null}
                      <${Button} onClick=${pickDocx}>${docx ? T.replace : T.importWord}<//>
                    </div>
                  <//>
                  <div class="rw-banner rw-banner--attention rw-dialog__alert" role="status">
                    <span class="rw-banner__glyph" aria-hidden="true">!</span>
                    <div class="rw-banner__body">
                      <div>${T.docxLoses}</div>
                      ${(docx && docx.warnings && docx.warnings.length)
                        ? html`
                          <div class="rw-dialog__warnlist">
                            ${docx.warnings.map((w, i) => html`
                              <div key=${i} class="rw-meta">${w}</div>`)}
                          </div>`
                        : null}
                    </div>
                  </div>
                </div>`
              : null}

            <div class="rw-formgrid__wide">
              <${Field} label=${T.name}>
                <input class="rw-input" value=${name}
                       onInput=${(ev) => typeName(ev.currentTarget.value)} />
              <//>
            </div>
          </div>`
        : null}
    <//>`;
}

function RenameDialog({ dialog, onClose, onRename }) {
  const [value, setValue] = useState(dialog.value || '');
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);

  const title =
    dialog.what === 'module' ? T.renameModule
      : dialog.what === 'project' ? T.renameProject
        : T.renameReport;

  const submit = async () => {
    if (!value.trim() || working) return;
    setError('');
    setWorking(true);
    try {
      await onRename(dialog, value.trim());
      onClose();
    } catch (err) {
      setError(errorText(err));
      setWorking(false);
    }
  };

  return html`
    <${Dialog}
      title=${title}
      width=${440}
      scrimCloses=${false}
      onClose=${onClose}
      footer=${html`
        <${Button} onClick=${onClose}>${T.cancel}<//>
        <${Button} level="primary" disabled=${!value.trim() || working}
                   onClick=${submit}>${T.rename}<//>`}
    >
      <${DialogError} message=${error} />
      <${Field} label=${T.newName}>
        <input class="rw-input" value=${value} autoFocus
               onInput=${(ev) => setValue(ev.currentTarget.value)}
               onKeyDown=${(ev) => {
                 if (ev.key === 'Enter') submit();
               }} />
      <//>
    <//>`;
}

function DuplicateDialog({ dialog, onClose, onDuplicate }) {
  const [value, setValue] = useState(dialog.value || '');
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);

  const submit = async () => {
    if (!value.trim() || working) return;
    setError('');
    setWorking(true);
    try {
      await onDuplicate(dialog, value.trim());
      onClose();
    } catch (err) {
      setError(errorText(err));
      setWorking(false);
    }
  };

  return html`
    <${Dialog}
      title=${T.duplicateReport}
      width=${440}
      scrimCloses=${false}
      onClose=${onClose}
      footer=${html`
        <${Button} onClick=${onClose}>${T.cancel}<//>
        <${Button} level="primary" disabled=${!value.trim() || working}
                   onClick=${submit}>${T.duplicate}<//>`}
    >
      <${DialogError} message=${error} />
      <div class="rw-dialog__note rw-dialog__lead">${T.duplicateNote}</div>
      <${Field} label=${T.newName}>
        <input class="rw-input" value=${value} autoFocus
               onInput=${(ev) => setValue(ev.currentTarget.value)}
               onKeyDown=${(ev) => {
                 if (ev.key === 'Enter') submit();
               }} />
      <//>
    <//>`;
}

// The other end of every delete confirmation on this screen. Nothing here
// hard-deletes and nothing here ever did -- the folders have been sitting in
// the trash all along -- so the only thing this dialog adds is the door.
//
// One row per entry: what it was called, the path it came from, when it went,
// and the button that puts it back. The path matters as much as the name: two
// reports in different modules are both called `CDR`, and the row has to say
// which one is about to come back.
//
// A refused restore is an ANSWER, not a fault. The server refuses rather than
// overwrites when something already occupies the original path, and when it
// does the entry stays listed, nothing on disk moves, and the banner says what
// did not happen and what would make it possible.
function TrashDialog({ trash, onClose, onRestore }) {
  const [failure, setFailure] = useState(null);
  const [working, setWorking] = useState('');
  const items = trash || [];

  const restore = async (entry) => {
    if (working) return;
    setFailure(null);
    setWorking(entry.id);
    try {
      await onRestore(entry);
    } catch (err) {
      const payload = (err && err.payload) || null;
      const occupied = payload && payload.code === 'occupied';
      setFailure({
        title: occupied ? T.notRestored(String(payload.dir || entry.dir)) : null,
        message: occupied ? T.notRestoredBody : errorText(err),
      });
    } finally {
      setWorking('');
    }
  };

  return html`
    <${Dialog}
      title=${T.trash}
      width=${640}
      onClose=${onClose}
      footer=${html`<${Button} onClick=${onClose}>${T.close}<//>`}
    >
      <${DialogError} title=${failure && failure.title}
                      message=${failure && failure.message} />
      ${items.length
        ? html`
          <div class="rw-timeline">
            ${items.map((entry) => html`
              <div class="rw-timeline__item" key=${entry.id}>
                <div class="rw-timeline__body">
                  <div class="rw-timeline__title">${entry.name}</div>
                  <div class="rw-meta">
                    ${entry.dir} · ${T.deletedWhen(relativeTime(entry.deleted))}
                  </div>
                  ${entry.knownOrigin === false
                    ? html`<div class="rw-meta">${T.originUnknown(entry.dir)}</div>`
                    : null}
                </div>
                <${Button} level="tertiary" disabled=${!!working}
                           onClick=${() => restore(entry)}>${T.restore}<//>
              </div>`)}
          </div>`
        : html`<${EmptyState} title=${T.nothingInTrash} />`}
    <//>`;
}

// Three weights, all of them a move to the trash: a report is one danger click,
// a module lists the reports it takes with it, a project also wants its name
// typed. None of the three hard-deletes anything.
function DeleteDialog({ dialog, onClose, onDelete }) {
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);

  const title =
    dialog.what === 'module' ? T.deleteModule
      : dialog.what === 'project' ? T.deleteProject
        : T.deleteReport;
  const needsTyping = dialog.what === 'project';
  const ready = !working && (!needsTyping || typed.trim() === dialog.label);

  const submit = async () => {
    if (!ready) return;
    setError('');
    setWorking(true);
    try {
      await onDelete(dialog);
      onClose();
    } catch (err) {
      setError(errorText(err));
      setWorking(false);
    }
  };

  return html`
    <${Dialog}
      title=${title}
      width=${520}
      scrimCloses=${false}
      onClose=${onClose}
      footer=${html`
        <${Button} onClick=${onClose}>${T.cancel}<//>
        <${Button} level="danger" disabled=${!ready} onClick=${submit}>${T.moveToTrash}<//>`}
    >
      <${DialogError} message=${error} />
      <div>${T.movesToTrash(dialog.label)}</div>
      ${dialog.what === 'module'
        ? html`<div class="rw-dialog__note rw-dialog__gap">${T.moduleHolds(dialog.count || 0)}</div>`
        : null}
      ${dialog.reports && dialog.reports.length
        ? html`
          <ul class="rw-meta rw-dialog__list">
            ${dialog.reports.map((r, i) => html`<li key=${i}>${r}</li>`)}
          </ul>`
        : null}
      ${needsTyping
        ? html`
          <div class="rw-dialog__gap">
            <${Field} label=${T.typeToConfirm(dialog.label)}>
              <input class="rw-input" value=${typed} autoFocus
                     onInput=${(ev) => setTyped(ev.currentTarget.value)} />
            <//>
          </div>`
        : null}
    <//>`;
}

export default Home;
