// util.js -- pure helpers shared by every v2 view.
//
// Nothing in this file touches the DOM, the store or the network. Everything is
// a plain function so it can be unit-tested straight from node.
//
// Owner: boot/store/api/util agent. See the v2 spec index for ownership.

/* ------------------------------------------------------------------ *
 * Caption numbering
 * ------------------------------------------------------------------ */

// !!! THIS RULE NOW LIVES IN THREE PLACES AND THEY MUST CHANGE TOGETHER !!!
//
//   1. builder/core/engine.py            -> _collect_ref_targets()  (the authority:
//      it is what the exported Word file actually numbers)
//   2. builder/web/app.html              -> computeCaptionNumbers() (legacy UI)
//   3. builder/web/assets/v2/js/util.js  -> this function           (v2 UI)
//
// If you change one, change all three, then re-run
//   node builder/tests/test_app_logic.js
//   python builder/tests/test_render_golden.py
//
// The rule, copied from _collect_ref_targets:
//   * chapter number = 1-based index of the TOP-LEVEL section; it increments for
//     every top-level node, including one carrying fixed_body;
//   * a figure block ('image' / 'imagegrid') ALWAYS consumes a figure number,
//     even with an empty caption -- the render bookmarks it either way, so it
//     stays a valid cross-reference target;
//   * a table block ('table' / 'datatable') consumes a table number ONLY when it
//     carries a non-empty caption;
//   * Figure and Table have SEPARATE counters and BOTH reset at each top-level
//     section (the Word "\s 1" SEQ switch);
//   * a section with a truthy `fixed_body` contributes none of its own blocks,
//     but its children are still walked -- fixed bodies carry no captioned media
//     of their own, their subsections may;
//   * only a block with a non-empty `id` becomes an entry in the map.
//
// Returns: Map<blockId, {kind:'Figure'|'Table', chapter:number, seq:number,
//                        label:string}>  where label is `${kind} ${chapter}-${seq}`.
export function computeCaptionNumbers(outline) {
  const map = new Map();
  const state = { chapter: 0, img: Object.create(null), tbl: Object.create(null) };

  const walk = (node, depth) => {
    if (!node || typeof node !== 'object') return;
    if (depth === 0) {
      state.chapter += 1;
      state.img[state.chapter] = 0;
      state.tbl[state.chapter] = 0;
    }
    const chapter = state.chapter;
    if (!node.fixed_body) {
      const blocks = node.blocks || [];
      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        if (!block || typeof block !== 'object') continue;
        const type = block.type;
        const id = block.id;
        if (type === 'image' || type === 'imagegrid') {
          state.img[chapter] += 1;
          if (id) {
            map.set(id, {
              kind: 'Figure',
              chapter: chapter,
              seq: state.img[chapter],
              label: 'Figure ' + chapter + '-' + state.img[chapter],
            });
          }
        } else if (type === 'table' || type === 'datatable') {
          const caption = String(block.caption == null ? '' : block.caption).trim();
          if (caption) {
            state.tbl[chapter] += 1;
            if (id) {
              map.set(id, {
                kind: 'Table',
                chapter: chapter,
                seq: state.tbl[chapter],
                label: 'Table ' + chapter + '-' + state.tbl[chapter],
              });
            }
          }
        }
      }
    }
    const children = node.children || [];
    for (let i = 0; i < children.length; i++) walk(children[i], depth + 1);
  };

  const roots = outline || [];
  for (let i = 0; i < roots.length; i++) walk(roots[i], 0);
  return map;
}

/* ------------------------------------------------------------------ *
 * Block grouping (prose cards)
 * ------------------------------------------------------------------ */

// Mirrors groupBlocks() in builder/web/app.html.
//
// A prose card is a contiguous run of 'para' blocks whose FIRST block carries
// cardStart. A non-para block always breaks the run and becomes a card of its
// own. A para WITHOUT cardStart continues the current card (Enter inside the
// flowing editor adds a paragraph to the same card); a para WITH cardStart
// begins a new card, so separately created text blocks never merge just because
// they ended up adjacent. Legacy content that carries no cardStart anywhere
// therefore groups purely by adjacency, exactly as it always did.
//
// Returns: [ {kind:'prose', start:<index of first block>, blocks:[...]} |
//            {kind:'block', idx:<index>, block:<block>} ]
export function groupBlocks(blocks) {
  const cards = [];
  let current = null;
  const list = blocks || [];
  for (let i = 0; i < list.length; i++) {
    const block = list[i];
    if (block && block.type === 'para') {
      if (!current || block.cardStart) {
        current = { kind: 'prose', start: i, blocks: [] };
        cards.push(current);
      }
      current.blocks.push(block);
    } else {
      current = null;
      cards.push({ kind: 'block', idx: i, block: block });
    }
  }
  return cards;
}

/* ------------------------------------------------------------------ *
 * Numeric values -- the one over-spec parser
 * ------------------------------------------------------------------ */

// THE SINGLE NUMERIC RULE FOR THE WHOLE INTERFACE.
//
// Every decision that colours a value red -- the compliance grid, the editor
// header's count, the preview paper -- routes through this function, because
// the red on screen has to be the red the exported document prints. There used
// to be three ports of this rule and all three disagreed with the engine.
//
// It mirrors builder/core/tables.py::_numv, which is:
//
//     if isinstance(v, (tuple, list)) and len(v) == 2: v = v[0]
//     try:    return float(v)
//     except (TypeError, ValueError): return None
//
// so the whole rule is "Python float(), returning null wherever it raises".
// Neither JS built-in is that function:
//
//   Number('')      -> 0        Python raises        (an empty cell is NOT zero)
//   Number('   ')   -> 0        Python raises
//   Number('0x10')  -> 16       Python raises
//   parseFloat('5%')    -> 5    Python raises        (a unit suffix is not a number)
//   parseFloat('12 dB') -> 12   Python raises
//   parseFloat('<3')    -> NaN  Python raises        (agrees, by luck)
//
// What Python DOES accept, and so do we: surrounding whitespace, a leading
// sign, a bare '.5' or '1.', an exponent, underscores between digits ('1_000'),
// and 'inf' / 'infinity' / 'nan' in any case. float('1e400') is inf, not an
// error, and float(True) is 1.0.
//
// Returning Infinity and NaN rather than null is deliberate: float('inf') is a
// value in Python, and an infinite simulated value IS over an upper limit,
// while every comparison against NaN is false in both languages. Collapsing
// them to null here would silently unflag one and change nothing for the other.
//
// One documented divergence: Python's float() also accepts non-ASCII decimal
// digits (Arabic-Indic and friends). This does not. No axis value in a report
// is typed in those digits, and supporting them would need a full Unicode
// digit-value table in a file that has no other dependencies.
//
// Returns: number | null.
const PY_FLOAT_RE =
  /^[+-]?(?:(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|inf(?:inity)?|nan)$/i;

// Python allows '_' only BETWEEN digits: '1_000.0_1' parses, '_1' / '1_' /
// '1__0' / '1e_3' do not. Collapsing digit-underscore-digit until nothing
// changes leaves any other underscore in place, where the pattern above
// rejects it. (A loop rather than a lookbehind: overlapping matches such as
// '1_0_0' need the second pass either way.)
function stripDigitUnderscores(text) {
  let s = text;
  let previous;
  do {
    previous = s;
    s = s.replace(/(\d)_(\d)/g, '$1$2');
  } while (s !== previous);
  return s;
}

export function numericValue(v) {
  let raw = v;
  // A [value, "CORNER"] pair carries its number first. Exactly two elements,
  // like the engine -- any other array is a value float() would refuse.
  if (Array.isArray(raw) && raw.length === 2) raw = raw[0];
  if (raw === null || raw === undefined) return null;   // float(None) raises
  if (typeof raw === 'boolean') return raw ? 1 : 0;     // float(True) is 1.0
  if (typeof raw === 'number') return raw;              // float(3) is 3.0
  if (typeof raw !== 'string') return null;             // dicts, lists, objects
  const trimmed = raw.trim();
  if (trimmed === '') return null;                      // float('') / float('  ')
  const s = stripDigitUnderscores(trimmed);
  if (!PY_FLOAT_RE.test(s)) return null;
  const lower = s.toLowerCase();
  const signed = lower.charAt(0) === '+' || lower.charAt(0) === '-';
  const body = signed ? lower.slice(1) : lower;
  if (body === 'nan') return NaN;
  // Number('inf') is NaN, so the two words Python spells out are spelled here.
  if (body === 'inf' || body === 'infinity') {
    return lower.charAt(0) === '-' ? -Infinity : Infinity;
  }
  return Number(s);
}

/* ------------------------------------------------------------------ *
 * The over-spec rule
 * ------------------------------------------------------------------ */

// THE SINGLE OVER-SPEC RULE FOR THE WHOLE INTERFACE.
//
// "A value that violates its spec is red" is the only verdict this tool has, so
// the grid, the header count, the paper preview and the exported document have
// to give one answer. There used to be three copies of the rule below -- one
// per view -- and they disagreed with the engine about which values a group
// even contributes.
//
// Mirrors, function for function:
//   core/tables.py::_violates       -> violates()
//   core/tables.py::_sim_axis_vals  -> simAxisValues()
//   core/tables.py::_axis_value     -> axisValue()
//   core/tables.py::_flags_from     -> flagsFrom()
// Change one of those and change its twin here in the same commit; the
// generated case table in builder/tests proves the two still agree.
//
// The subtlety that cost a wrong red cell: the per-group lookup is MEMBERSHIP,
// not truthiness. Python asks `gkey in sims`, so a row whose sims map holds the
// group key with a null value contributes NOTHING -- it does not fall back to
// the flat sim_mtm. A truthiness test fell back, and the grid then reddened a
// value the engine never looks at.

// True when `row.sims` is a mapping that holds `groupKey` -- the JS spelling of
// Python's `isinstance(sims, dict) and gkey in sims`. hasOwnProperty rather than
// `in`, because Python asks about the dict's own keys, not a prototype chain.
function hasSimGroup(row, groupKey) {
  const sims = row && row.sims;
  if (!sims || typeof sims !== 'object' || Array.isArray(sims)) return false;
  return Object.prototype.hasOwnProperty.call(sims, groupKey);
}

function mtmTriple(v) {
  return Array.isArray(v) ? v : [null, null, null];
}

// One simulation group's ({mtm triple}, ntwc): the per-group values when the
// row's sims map holds this key, otherwise the flat single-simulation fields.
// Returns {mtm, ntwc}.
export function simAxisValues(row, groupKey) {
  if (hasSimGroup(row, groupKey)) {
    const sv = row.sims[groupKey] || {};
    return { mtm: mtmTriple(sv.mtm), ntwc: sv.ntwc === undefined ? null : sv.ntwc };
  }
  const flat = row && row.sim_ntwc;
  return {
    mtm: mtmTriple(row && row.sim_mtm),
    ntwc: flat === undefined ? null : flat,
  };
}

// One cell of the rendered table: group `groupKey`, axis index `ai`
// (0..2 = MIN/TYP/MAX, 3 = NTWC). The spec group reads the row's spec fields.
export function axisValue(row, groupKey, ai) {
  let arr;
  if (groupKey === 'spec') {
    arr = mtmTriple(row && row.spec_mtm).concat([row ? row.spec_ntwc : null]);
  } else {
    const v = simAxisValues(row, groupKey);
    arr = v.mtm.concat([v.ntwc]);
  }
  return ai < arr.length ? arr[ai] : null;
}

// True when one simulated value is out of the row's limit. Directions:
// le (<= upper bound) / ge (>= target) / range (within [MIN, MAX]). Thresholds
// come from the row's own spec triple / scalar spec -- no number is hardcoded,
// and a row with no limit is never over spec.
export function violates(limit, nv, smin, smax, en, styp) {
  if (nv === null) return false;
  if (limit === 'le') {
    const thr = smax !== null ? smax : (en !== null ? en : styp);
    return thr !== null && nv > thr;
  }
  if (limit === 'ge') {
    const thr = smin !== null ? smin : (smax !== null ? smax : en);
    return thr !== null && nv < thr;
  }
  if (limit === 'range') {
    return (smin !== null && nv < smin) || (smax !== null && nv > smax);
  }
  return false;
}

// The axis indices of one group's [MIN, TYP, MAX(, NTWC)] that break the row's
// limit, judged against the values passed in -- so a comparison column is
// judged by its OWN numbers, never the primary simulation's. Index 3 is the
// NTWC corner, compared to spec_ntwc when the row carries one; a null NTWC is
// never flagged.
//
// Returns: Set<number>, in ascending axis order.
export function flagsFrom(row, mtm, ntwc) {
  const flags = new Set();
  const limit = row && row.limit;
  if (!limit) return flags;
  const sm = mtmTriple(row.spec_mtm);
  const smin = numericValue(sm[0]);
  const styp = numericValue(sm[1]);
  const smax = numericValue(sm[2]);
  const en = numericValue(row.spec);
  const list = Array.isArray(mtm) ? mtm : [];
  for (let i = 0; i < list.length; i++) {
    if (violates(limit, numericValue(list[i]), smin, smax, en, styp)) flags.add(i);
  }
  const nt = numericValue(ntwc);
  if (nt !== null) {
    const nspec = numericValue(row.spec_ntwc);
    const nmin = nspec !== null ? nspec : smin;
    const nmax = nspec !== null ? nspec : smax;
    const nen = nspec !== null ? nspec : en;
    if (violates(limit, nt, nmin, nmax, nen, styp)) flags.add(3);
  }
  return flags;
}

// flagsFrom for a named group, with the group's values looked up the way the
// engine looks them up. This is the entry point every view should call.
export function flagsForGroup(row, groupKey) {
  const v = simAxisValues(row, groupKey);
  return flagsFrom(row, v.mtm, v.ntwc);
}

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

// formatBytes(1234) -> '1.2 KB'. Bytes stay whole; anything larger keeps one
// decimal until it reaches three significant digits.
export function formatBytes(n) {
  const bytes = Number(n);
  if (!isFinite(bytes) || bytes <= 0) return '0 B';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return Math.round(value) + ' B';
  const text = value >= 100 ? String(Math.round(value)) : value.toFixed(1);
  return text.replace(/\.0$/, '') + ' ' + BYTE_UNITS[unit];
}

// relativeTime(epochSeconds) -> one of the frozen strings in
// the frozen string list, section "Time". Anything older than a week
// renders as an ISO-style YYYY-MM-DD date, which needs no translation.
export function relativeTime(epochSeconds, nowEpochSeconds) {
  const then = Number(epochSeconds);
  if (!isFinite(then) || then <= 0) return '';
  const now = isFinite(Number(nowEpochSeconds))
    ? Number(nowEpochSeconds)
    : Date.now() / 1000;
  const delta = now - then;
  if (delta < 45) return 'just now';
  if (delta < 90) return '1 minute ago';
  if (delta < 3600) return Math.round(delta / 60) + ' minutes ago';
  if (delta < 7200) return '1 hour ago';
  if (delta < 86400) return Math.round(delta / 3600) + ' hours ago';
  if (delta < 172800) return 'yesterday';
  if (delta < 604800) return Math.round(delta / 86400) + ' days ago';
  const d = new Date(then * 1000);
  const pad = (v) => (v < 10 ? '0' + v : String(v));
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

// HH:MM on the local clock, for the `Saved HH:MM` chrome string.
export function formatClock(epochSeconds) {
  const t = Number(epochSeconds);
  if (!isFinite(t) || t <= 0) return '';
  const d = new Date(t * 1000);
  const pad = (v) => (v < 10 ? '0' + v : String(v));
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}

export function clamp(n, lo, hi) {
  const v = Number(n);
  if (!isFinite(v)) return lo;
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

// classNames('a', cond && 'b', {c: true, d: false}, ['e']) -> 'a b c e'
export function classNames(...parts) {
  const out = [];
  const push = (part) => {
    if (!part) return;
    if (typeof part === 'string' || typeof part === 'number') {
      out.push(String(part));
      return;
    }
    if (Array.isArray(part)) {
      for (let i = 0; i < part.length; i++) push(part[i]);
      return;
    }
    if (typeof part === 'object') {
      const keys = Object.keys(part);
      for (let i = 0; i < keys.length; i++) if (part[keys[i]]) out.push(keys[i]);
    }
  };
  for (let i = 0; i < parts.length; i++) push(parts[i]);
  return out.join(' ');
}
