#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Three-way merge of one report, at SECTION granularity.

The work machine can only send plain text back. A returned package therefore
carries a whole report that was cut from a known common ancestor -- the
``_baseline.json`` stamped at the last exchange. Merging it must never lose an
edit made on either side, so this module answers exactly one question per
section:

    neither side changed it   -> keep it as it is
    only one side changed it  -> take that side
    both sides changed it     -> CONFLICT, and stop. Never pick a winner.

Nothing here writes to disk except :func:`apply_choices`, which is what the user
presses after deciding every conflict; it snapshots first, so the merge itself
stays undoable.

Section identity is the node ``id`` first, the ``title`` second, and how alike
the two sections read third -- update packages have always located sections by
title so they survive id drift, and the similarity pass keeps a report whose
sections were re-created AND retitled on the other side pairing up instead of
arriving as a pile of deletions and additions.

A returned package that looks cut off rather than edited is refused outright,
whether it stopped between sections or inside one, and every deletion the merge
does honour is recorded -- see the truncation guards below.

Change detection reuses ``apply_update``: ``_cmp_own`` is the normalized view of
a node's own fields (editor-internal ``_`` keys and the grid editor's cosmetic
per-block ids removed), so a section that differs only by editor bookkeeping
reads as UNCHANGED and never manufactures a conflict.

Public API
    merge3(base, mine, theirs) -> {"merged": <project>, "conflicts": [...]}
    apply_choices(project_dir, merged, choices)
        -> {"ok": True, "applied": n, "snapshot": <path>}
"""
# A merge is computed from one state of project.json and written back some time
# later, after the user has decided every conflict -- a whole report round-trips
# through the browser in between. Anything that lands on disk in that window (the
# editor's own autosave, a fill script, a second tab) would be overwritten
# wholesale by the write, so merge3 stamps the fingerprint of the state it read
# into the merged object and apply_choices refuses when the file no longer
# matches it. Refusing is the point: silently discarding an edit is exactly what
# this module exists to prevent.
import copy
import difflib
import json
import os

import apply_update as A   # same layer; reuse node matching + normalization

# Marker left on a merged node that could not be resolved automatically. It is
# ``_``-prefixed on purpose: the codebase already treats a leading underscore as
# editor-internal, so it is stripped from the upstream diff channel and ignored
# by the renderer even if one ever leaked. apply_choices removes every marker
# before writing, so a resolved project.json carries none.
CONFLICT_KEY = "_conflict"
CHILD_CONFLICT_KEY = "_conflict_children"

# Same holder for top-level (meta / checklist) conflicts, which have no section
# to hang off.
TOP_CONFLICT_KEY = "_conflict_top"

# Optimistic-concurrency token: the fingerprint of the project.json the merge was
# computed from, carried on the merged object so it survives the round trip
# through the browser. ``_``-prefixed like the conflict markers, for the same
# reasons -- the diff channel strips it and apply_choices removes it before the
# write, so no stored report ever carries one.
BASE_SHA_KEY = "_merge_base_sha"

CHOICES = ("mine", "theirs", "both")

# Truncation guards. The upstream channel is a person pasting text, so a package
# that stops halfway still parses and still has an outline. It can stop in two
# places, and counting only the first shape loses content silently:
#
#   between sections -> whole sections are absent, and every one of them reads
#       as a deletion
#   inside a section -> every section is still there and the BLOCKS under them
#       are short. A section count cannot see this at all: the outline is intact
#       and each short section reads as an ordinary one-sided edit, so the merge
#       takes it and every passage past the cut is gone with no conflict, no
#       deletion record and no warning.
#
# So the guard measures both. A returned report missing more than a QUARTER of
# the ancestor's sections, and more than TWO of them, is treated as truncated
# rather than as a bulk deletion. The fraction catches the cut; the floor keeps
# small reports (where deleting one of four sections is 25%) usable. A genuine
# bulk deletion passes ``allow_bulk_delete=True``.
TRUNCATION_FRACTION = 0.25
TRUNCATION_MIN = 3

# The same reading one level down: how much of what the ancestor SAYS came back,
# counted in blocks over the whole report -- the blocks missing from sections that
# paired up, plus every block of a section that did not come back at all. It is
# the second guard because the first one names the damage better when whole
# sections are gone; it is not redundant with it, because the two measure
# different things. A cut that drops the last few chapters of a report whose
# chapters are uneven can be a quarter of the sections and most of the words (the
# section guard, which counts sections and not size, then just misses it), and a
# cut inside the sections is invisible to it entirely. The fraction is the same
# quarter of the ancestor; the floor is higher because a block is the unit an
# ordinary editing pass deletes. Pruning eight passages across a whole report is
# plausible editing; losing eight AND a quarter of everything the report says is
# a cut, not an edit.
BLOCK_TRUNCATION_FRACTION = 0.25
BLOCK_TRUNCATION_MIN = 8

# One section, one side. The returned version of a section nobody touched here is
# normally just taken, which is safe only while it is an EDIT of that section.
# When it drops most of the section it is indistinguishable from a paste that
# stopped inside it, so it becomes a decision for the user instead of a silent
# take -- at minimum pending, never automatic. Half the section and at least
# three blocks: below that it is ordinary pruning, and asking would fill the
# merge screen with noise nobody reads.
SECTION_BLOCK_LOSS_FRACTION = 0.5
SECTION_BLOCK_LOSS_MIN = 3

# Last-resort section pairing (see _pair_indices): how alike two sections must
# read before position alone is allowed to pair them.
PAIR_SIMILARITY_MIN = 0.6


# ---------------------------------------------------------------------------
# Identity + change detection.
# ---------------------------------------------------------------------------


def _nodes(x):
    return [n for n in (x or []) if isinstance(n, dict)]


def _own(n):
    """A node's own fields (everything but ``children``), or None."""
    return A._node_own(n) if isinstance(n, dict) else None


def _norm(n):
    """Own fields normalized for change detection only."""
    return A._cmp_own(n) if isinstance(n, dict) else None


def _subtree(n):
    """Normalized (own, children...) shape -- 'did anything under here move'."""
    if not isinstance(n, dict):
        return None
    return (json.dumps(_norm(n), sort_keys=True, ensure_ascii=False),
            tuple(_subtree(c) for c in _nodes(n.get("children"))))


def _subtree_changed(a, b):
    return _subtree(a) != _subtree(b)


def _index(nodes):
    """(by_id, by_title) index of a child list, both mapping to list position."""
    by_id, by_title = {}, {}
    for i, n in enumerate(nodes):
        nid = n.get("id")
        if nid and nid not in by_id:
            by_id[nid] = i
        by_title.setdefault(n.get("title", ""), []).append(i)
    return by_id, by_title


def _blocks(n):
    b = (n or {}).get("blocks")
    return b if isinstance(b, list) else []


def _block_sig(b):
    """One block as a comparable string, normalized the way ``_cmp_own``
    normalizes blocks (the grid editor's cosmetic per-block id and every editor
    ``_`` key dropped), so content that came back through the text channel still
    reads as the same content."""
    if isinstance(b, dict):
        b = {k: A._strip_ui(v) for k, v in b.items()
             if k != "id" and not str(k).startswith("_")}
    else:
        b = A._strip_ui(b)
    return json.dumps(b, sort_keys=True, ensure_ascii=False, default=str)


def _content_sig(node, out=None):
    """Every block under a section, its subsections included, as strings."""
    out = [] if out is None else out
    for b in _blocks(node):
        out.append(_block_sig(b))
    for c in _nodes((node or {}).get("children")):
        _content_sig(c, out)
    return out


def _ratio(a, b):
    return difflib.SequenceMatcher(None, a, b, autojunk=False).ratio()


def _similarity_of(sig_a, sig_b):
    """How alike two sections read, 0..1, from their prepared (content, title)
    signatures. Content first; two sections that carry no content at all fall
    back to their titles, so empty placeholders pair by name rather than by being
    equally empty."""
    body_a, title_a = sig_a
    body_b, title_b = sig_b
    if not body_a and not body_b:
        return _ratio(title_a, title_b)
    return _ratio(body_a, body_b)


def _sig(node):
    """(content signature, title) -- prepared once per node, because pairing
    compares every leftover section with every other one."""
    return (_content_sig(node), str((node or {}).get("title", "")))


def _similarity(a, b):
    """How alike two sections read, 0..1."""
    return _similarity_of(_sig(a), _sig(b))


def _pair_indices(src, dst, dst_skip=()):
    """Pair each section of ``src`` with its counterpart in ``dst``: by id, then
    by title, then by content similarity with position breaking the ties.

    The third pass is what keeps a COMPLETE report from reading as a truncated
    one. Sections re-created on the other side come back with fresh ids, and one
    that was also retitled then matches neither id nor title -- with two passes
    it looks deleted, and an honest whole report gets refused as a cut.
    Similarity is measured over the blocks of the section and everything under
    it, so a section pairs with the section that says the same thing; position
    only decides between equally good candidates.

    Ids are resolved for the whole level before any title match is allowed, so a
    section that still carries its id can never have its counterpart taken by an
    earlier same-titled sibling.

    Returns {src index: dst index}; a src index that is absent has no
    counterpart. ``dst_skip`` holds dst positions already claimed elsewhere.
    """
    used = set(dst_skip)
    out = {}
    by_id, by_title = _index(dst)
    for i, n in enumerate(src):
        nid = n.get("id")
        j = by_id.get(nid) if nid else None
        if j is not None and j not in used:
            out[i] = j
            used.add(j)
    for i, n in enumerate(src):
        if i in out:
            continue
        for j in by_title.get(n.get("title", ""), []):
            if j not in used:
                out[i] = j
                used.add(j)
                break
    rest_src = [i for i in range(len(src)) if i not in out]
    rest_dst = [j for j in range(len(dst)) if j not in used]
    if not rest_src or not rest_dst:
        return out
    sig_src = dict((i, _sig(src[i])) for i in rest_src)
    sig_dst = dict((j, _sig(dst[j])) for j in rest_dst)
    scored = []
    for i in rest_src:
        for j in rest_dst:
            ratio = _similarity_of(sig_src[i], sig_dst[j])
            if ratio >= PAIR_SIMILARITY_MIN:
                scored.append((-ratio, abs(i - j), i, j))
    for _ratio, _dist, i, j in sorted(scored):
        if i in out or j in used:
            continue
        out[i] = j
        used.add(j)
    return out


def _key_of(node):
    return node.get("id") or ("title:" + str(node.get("title", "")))


def _child_keys(n):
    return [_key_of(c) for c in _nodes((n or {}).get("children"))]


def _changed_fields(a, b):
    """Field names whose normalized values differ between two nodes."""
    na, nb = _norm(a) or {}, _norm(b) or {}
    return sorted(k for k in set(na) | set(nb) if na.get(k) != nb.get(k))


# ---------------------------------------------------------------------------
# Conflict records.
# ---------------------------------------------------------------------------


def _conflict_id(node, loc, kind):
    """Stable key the caller sends back in ``choices``. A section id when it has
    one (survives renumbering), the location otherwise; the kind is appended so
    one section can raise a content conflict and a child-order conflict without
    the two sharing a key."""
    stem = (node or {}).get("id") or ("sec-" + (loc or "0"))
    return "%s:%s" % (stem, kind)


def _record(conflicts, node, loc, kind, base, mine, theirs, **extra):
    entry = {"id": _conflict_id(node, loc, kind),
             "node_id": (node or {}).get("id"),
             "title": (node or {}).get("title", ""),
             "loc": loc, "kind": kind,
             "base": _own(base), "mine": _own(mine), "theirs": _own(theirs)}
    entry.update(extra)
    conflicts.append(entry)
    return entry


def _kind_of(fields):
    """Name what changed, most visible first: the passage text, then its
    heading, then anything else a section carries."""
    if "blocks" in fields:
        return "blocks"
    if "title" in fields:
        return "title"
    return "fields"


# ---------------------------------------------------------------------------
# The merge.
# ---------------------------------------------------------------------------


def _take_own(node, own):
    """Replace a node's own fields wholesale, leaving children and markers."""
    for k in list(node):
        if k != "children" and not k.startswith("_conflict"):
            node.pop(k, None)
    for k, v in (own or {}).items():
        if k != "children":
            node[k] = copy.deepcopy(v)


def _collapsed(before, lost):
    """True when a one-sided shrink is too big to read as ordinary editing --
    see SECTION_BLOCK_LOSS_FRACTION."""
    return (lost >= SECTION_BLOCK_LOSS_MIN
            and lost > before * SECTION_BLOCK_LOSS_FRACTION)


def _merge_node(base, mine, theirs, loc, forced, conflicts, deletions,
                allow_bulk_delete=False):
    """Merge one matched section. ``mine`` / ``theirs`` is None when only one
    side still has the section; ``forced`` names that case."""
    node = copy.deepcopy(mine if mine is not None else theirs)

    if forced in ("removed", "deleted"):
        # An edit on one side and a deletion on the other. The surviving version
        # is kept provisionally -- dropping content is never the automatic
        # answer -- and the user decides.
        node[CONFLICT_KEY] = _record(conflicts, node, loc, forced,
                                     base, mine, theirs)
        return node

    if mine is None or theirs is None:
        return node                     # added on one side only -> keep it

    nb, nm, nt = _norm(base), _norm(mine), _norm(theirs)
    mine_changed, theirs_changed = nb != nm, nb != nt
    if theirs_changed and not mine_changed:
        lost = len(_blocks(mine)) - len(_blocks(theirs))
        if lost > 0 and _collapsed(len(_blocks(mine)), lost) \
                and not allow_bulk_delete:
            # The returned section is not an edit of this one, it is a much
            # shorter version of it -- which is exactly what a paste that stopped
            # inside the section looks like from here. Taking it silently is the
            # one-level-down form of swallowing a truncated package, so the local
            # version is kept provisionally and the user decides.
            node[CONFLICT_KEY] = _record(conflicts, node, loc, "blocks",
                                         base, mine, theirs, fields=["blocks"],
                                         reason="blocks_removed",
                                         removed_blocks=lost)
        else:
            if lost > 0:
                _record_block_deletion(deletions, mine, loc, lost, "theirs")
            _take_own(node, _own(theirs))
    elif mine_changed and theirs_changed and nm != nt:
        fields = _changed_fields(mine, theirs)
        node[CONFLICT_KEY] = _record(conflicts, node, loc, _kind_of(fields),
                                     base, mine, theirs, fields=fields)
    # neither side changed, only mine changed, or both made the SAME edit:
    # the local version already is the answer.

    kb, km, kt = _child_keys(base), _child_keys(mine), _child_keys(theirs)
    node["children"] = _merge_level(_nodes((base or {}).get("children")),
                                    _nodes(mine.get("children")),
                                    _nodes(theirs.get("children")),
                                    loc + ".", conflicts, deletions,
                                    allow_bulk_delete)
    if km != kb and kt != kb and km != kt:
        # Both sides reshaped this level. The children were still merged
        # content-wise; what stays undecided is their order.
        node[CHILD_CONFLICT_KEY] = _record(
            conflicts, node, loc, "children", base, mine, theirs,
            base_order=kb, mine_order=km, theirs_order=kt)
    return node


def _record_deletion(deletions, base_node, prefix, pos, side):
    """Note a whole section the merge dropped without asking. Honouring it is
    right -- one side dropped the section and the other never touched it -- but it
    must still leave a trace, so the caller can show what went away instead of
    letting sections disappear silently."""
    kids = _nodes((base_node or {}).get("children"))
    sections = 1 + _count_sections(kids)
    blocks = len(_blocks(base_node)) + _count_blocks(kids)
    deletions.append({"kind": "section",
                      "node_id": (base_node or {}).get("id"),
                      "title": (base_node or {}).get("title", ""),
                      "loc": "%s%d" % (prefix, pos),
                      "side": side,
                      "sections": sections,
                      "blocks": blocks,
                      "detail": "section removed, with %d block(s) under it"
                                % blocks})


def _record_block_deletion(deletions, node, loc, lost, side):
    """Note blocks the merge dropped from a surviving section without asking:
    nobody touched the section here and the returned version of it is shorter.
    Under the collapse threshold that is ordinary editing and taking it is right,
    but the same rule applies as to a section -- nothing disappears without a
    trace, so the caller can name it."""
    deletions.append({"kind": "blocks",
                      "node_id": (node or {}).get("id"),
                      "title": (node or {}).get("title", ""),
                      "loc": loc,
                      "side": side,
                      "sections": 0,
                      "blocks": lost,
                      "detail": "%d block(s) removed from this section" % lost})


def _merge_level(b_list, m_list, t_list, prefix, conflicts, deletions,
                 allow_bulk_delete=False):
    """Merge one level of sections. Order follows MINE; sections only the
    returned report has are appended after, never interleaved by guesswork.

    Pairing is _pair_indices in both directions, so the merge and the truncation
    guard read the same report the same way -- a section re-created upstream with
    a fresh id and a new title pairs with its local counterpart here instead of
    arriving as one deletion plus one addition."""
    to_base = _pair_indices(m_list, b_list)          # mine -> ancestor
    to_theirs = _pair_indices(m_list, t_list)        # mine -> returned
    used_b, used_t = set(to_base.values()), set(to_theirs.values())
    slots = []
    for i, m in enumerate(m_list):
        bi, ti = to_base.get(i), to_theirs.get(i)
        b = b_list[bi] if bi is not None else None
        t = t_list[ti] if ti is not None else None
        if b is not None and t is None:
            # the returned report dropped a section the ancestor had
            if _subtree_changed(b, m):
                slots.append((b, m, None, "removed"))
            else:
                # untouched locally -> the deletion is the only change, honour
                # it, but report it rather than letting it vanish unremarked
                _record_deletion(deletions, b, prefix, bi + 1, "theirs")
            continue
        slots.append((b, m, t, None))
    extra = [j for j in range(len(t_list)) if j not in used_t]
    # what is left over there pairs against what is left of the ancestor: a
    # section only the returned report still has was either added over there or
    # deleted here.
    extra_to_base = _pair_indices([t_list[j] for j in extra], b_list,
                                  dst_skip=used_b)
    for k, j in enumerate(extra):
        t = t_list[j]
        bi = extra_to_base.get(k)
        if bi is None:
            slots.append((None, None, t, None))      # added in the returned one
            continue
        if _subtree_changed(b_list[bi], t):
            slots.append((b_list[bi], None, t, "deleted"))
        else:
            # deleted locally and untouched over there -> honour the deletion
            _record_deletion(deletions, b_list[bi], prefix, bi + 1, "mine")
    return [_merge_node(b, m, t, "%s%d" % (prefix, i), forced, conflicts,
                        deletions, allow_bulk_delete)
            for i, (b, m, t, forced) in enumerate(slots, 1)]


def _merge_top(base, mine, theirs, conflicts):
    """The same three-way rule for everything that is not the outline: meta, the
    checklist, the template id. Small values, so they travel whole."""
    out, markers = {}, {}
    keys = (set(base) | set(mine) | set(theirs)) - {"outline"}
    for k in sorted(keys):
        if str(k).startswith("_"):
            continue                    # editor bookkeeping never merges
        b, m, t = base.get(k), mine.get(k), theirs.get(k)
        nb, nm, nt = A._strip_ui(b), A._strip_ui(m), A._strip_ui(t)
        mine_changed, theirs_changed = nb != nm, nb != nt
        if theirs_changed and not mine_changed:
            if k in theirs:
                out[k] = copy.deepcopy(t)
            continue                    # absent over there -> drop it here too
        if mine_changed and theirs_changed and nm != nt:
            entry = {"id": "top:%s" % k, "node_id": None, "title": k,
                     "loc": "", "kind": "meta",
                     "base": b, "mine": m, "theirs": t}
            conflicts.append(entry)
            markers[k] = entry
        if k in mine:
            out[k] = copy.deepcopy(m)
    return out, markers


def _count_sections(nodes):
    return sum(1 + _count_sections(_nodes(n.get("children"))) for n in nodes)


def _count_blocks(nodes):
    return sum(len(_blocks(n)) + _count_blocks(_nodes(n.get("children")))
               for n in nodes)


def _absent_from(b_list, t_list):
    """How many of the ancestor's sections have no counterpart in the returned
    report, an absent section's whole subtree counted with it. Pairing is the
    same _pair_indices the merge itself uses, so this measures exactly the
    sections the merge would read as deleted -- a section re-created on the other
    side under a fresh id and a new title is NOT one of them."""
    pairs = _pair_indices(b_list, t_list)
    n = 0
    for i, b in enumerate(b_list):
        j = pairs.get(i)
        if j is None:
            n += 1 + _count_sections(_nodes(b.get("children")))
            continue
        n += _absent_from(_nodes(b.get("children")),
                          _nodes(t_list[j].get("children")))
    return n


def _blocks_absent_from(b_list, t_list):
    """(missing, total) blocks: how much of what the ancestor says has no
    counterpart in the returned report, over the whole report. A section that did
    not come back at all counts with every block under it -- from the reader's
    side a passage is equally gone whether its section went with it."""
    pairs = _pair_indices(b_list, t_list)
    missing = total = 0
    for i, b in enumerate(b_list):
        j = pairs.get(i)
        if j is None:
            gone = len(_blocks(b)) + _count_blocks(_nodes(b.get("children")))
            missing += gone
            total += gone
            continue
        t = t_list[j]
        had = len(_blocks(b))
        total += had
        missing += max(0, had - len(_blocks(t)))
        sub_missing, sub_total = _blocks_absent_from(
            _nodes(b.get("children")), _nodes(t.get("children")))
        missing += sub_missing
        total += sub_total
    return missing, total


def _looks_truncated(base, theirs):
    """What looks cut off about the returned report, or None when nothing does.

    Sections first, then how much of what the report says did not come back at
    all -- a paste can stop between sections or inside one, and the second shape
    is invisible to a section count. Returns {kind, missing, total, detail}:
    ``kind`` names which guard fired, so the caller can say what is missing
    rather than just that something is."""
    b_list = _nodes(base.get("outline"))
    t_list = _nodes(theirs.get("outline"))
    total = _count_sections(b_list)
    missing = _absent_from(b_list, t_list)
    if missing >= TRUNCATION_MIN and missing > total * TRUNCATION_FRACTION:
        return {"kind": "sections", "missing": missing, "total": total,
                "detail": "%d of the %d sections this package was cut from are "
                          "missing" % (missing, total)}
    missing, total = _blocks_absent_from(b_list, t_list)
    if (missing >= BLOCK_TRUNCATION_MIN
            and missing > total * BLOCK_TRUNCATION_FRACTION):
        return {"kind": "blocks", "missing": missing, "total": total,
                "detail": "%d of the %d blocks this package was cut from have no "
                          "counterpart in it" % (missing, total)}
    return None


def merge3(base, mine, theirs, allow_bulk_delete=False, **wire):
    """Three-way merge of a whole report.

    ``base`` is the common ancestor (``_baseline.json``; ``{}`` when the report
    has never been exchanged -- then every difference counts as a change on both
    sides, which is the safe reading), ``mine`` is this machine's project.json,
    ``theirs`` is the returned one.

    Returns ``{"merged": <project>, "conflicts": [...], "auto": n, "pending": n,
    "deletions": [...], "token": <sha>, "truncated": None}``, and a refusal
    replaces the token with ``error`` plus a filled-in ``truncated``.
    ``merged`` already holds every
    automatically resolved section; an unresolved one keeps the local version
    provisionally and carries a ``_conflict`` marker that :func:`apply_choices`
    needs, so hand the SAME object back rather than rebuilding it -- it also
    carries the concurrency token apply_choices checks.

    ``deletions`` lists every deletion honoured without asking -- a whole section
    (``kind: "section"``) or blocks dropped from a section that stays
    (``kind: "blocks"``) -- so the caller can show them. Nothing goes away
    unrecorded.

    ``theirs`` must be a COMPLETE report, not a partial package -- a section
    missing from it reads as deleted. A package missing so much of the ancestor
    that it looks cut off, in sections or in blocks, is REFUSED (see
    TRUNCATION_FRACTION and BLOCK_TRUNCATION_FRACTION) with
    ``error: "truncated"`` and a ``truncated`` description of what looks missing.

    ``allow_bulk_delete`` is that refusal's override: it says the deletions are
    real, merge them anyway. The wire spells it ``allowBulkDelete`` (the
    /api/merge3 request field) and this function answers to both spellings, so a
    caller can forward the request field unchanged -- while the only spelling was
    the Python one, a caller that passed the body through could not reach the
    override at all and a report the guard misread was a dead end.
    """
    unknown = set(wire) - {"allowBulkDelete"}
    if unknown:
        raise TypeError("merge3() got an unexpected keyword argument %r"
                        % sorted(unknown)[0])
    allow_bulk_delete = bool(allow_bulk_delete or wire.get("allowBulkDelete"))
    base = base if isinstance(base, dict) else {}
    mine = mine if isinstance(mine, dict) else {}
    theirs = theirs if isinstance(theirs, dict) else {}
    refused = {"merged": copy.deepcopy(mine), "conflicts": [], "auto": 0,
               "pending": 0, "deletions": [], "token": None, "truncated": None}
    if "outline" not in theirs:
        # Not a whole report: refuse to read every absent section as a deletion.
        refused["error"] = "incoming report has no outline"
        return refused
    truncated = _looks_truncated(base, theirs)
    if truncated and not allow_bulk_delete:
        refused["error"] = "truncated"
        refused["detail"] = "this package appears truncated: " \
                            + truncated["detail"]
        # The override travels with the refusal under its WIRE name, so the view
        # can offer it without knowing this module.
        refused["truncated"] = dict(truncated, override="allowBulkDelete")
        return refused
    conflicts, deletions = [], []
    merged, markers = _merge_top(base, mine, theirs, conflicts)
    merged["outline"] = _merge_level(_nodes(base.get("outline")),
                                     _nodes(mine.get("outline")),
                                     _nodes(theirs.get("outline")),
                                     "", conflicts, deletions,
                                     allow_bulk_delete)
    if markers:
        merged[TOP_CONFLICT_KEY] = markers
    merged[BASE_SHA_KEY] = _project_token(mine)
    touched = {c.get("node_id") or c.get("loc") for c in conflicts}
    return {"merged": merged, "conflicts": conflicts,
            "auto": max(_count_sections(merged["outline"]) - len(touched), 0),
            "pending": len(conflicts), "deletions": deletions,
            "truncated": None,
            # "token" is the wire name for the concurrency fingerprint;
            # "base_sha" is the same value under the name this module used
            # before the endpoint was written, kept so nothing that reads it
            # breaks.
            "token": merged[BASE_SHA_KEY],
            "base_sha": merged[BASE_SHA_KEY]}


# ---------------------------------------------------------------------------
# Applying the user's decisions.
# ---------------------------------------------------------------------------


def _normalize_choices(choices):
    """Accept {id: choice} or [{"id":.., "choice":..}] -- the caller posts JSON
    and both shapes are natural there."""
    out = {}
    if isinstance(choices, dict):
        items = choices.items()
    elif isinstance(choices, list):
        items = [(it.get("id"), it.get("choice") or it.get("pick"))
                 for it in choices if isinstance(it, dict)]
    else:
        return out
    for cid, pick in items:
        if isinstance(pick, dict):
            pick = pick.get("choice") or pick.get("pick")
        if cid and pick in CHOICES:
            out[str(cid)] = pick
    return out


def _blocks_of(own):
    b = (own or {}).get("blocks")
    return copy.deepcopy(b) if isinstance(b, list) else []


def _apply_content_choice(node, entry, pick):
    """mine / theirs / both for one section. ``both`` concatenates the two
    versions as separate blocks, mine first, so nothing is thrown away and the
    user deletes the half they do not want in the editor."""
    if pick == "theirs":
        _take_own(node, entry.get("theirs"))
    elif pick == "both":
        mine_own = entry.get("mine") or {}
        joined = _blocks_of(mine_own) + _blocks_of(entry.get("theirs"))
        _take_own(node, mine_own)
        node["blocks"] = joined
    # "mine": the node already carries the local version


def _apply_children_choice(node, entry, pick):
    """Only the ORDER of an already content-merged level is in question here, so
    a choice reorders and can never drop a child. ``both`` keeps the local order
    with the other side's additions after it, which is what the merge built."""
    if pick != "theirs":
        return
    order = entry.get("theirs_order") or []
    rank = {k: i for i, k in enumerate(order)}
    kids = _nodes(node.get("children"))
    node["children"] = [n for _r, _i, n in
                        sorted((rank.get(_key_of(n), len(order)), i, n)
                               for i, n in enumerate(kids))]


def _resolve(nodes, picks, stats):
    """Walk the merged outline, apply each decision, strip every marker."""
    keep = []
    for node in nodes:
        drop = False
        for key in (CONFLICT_KEY, CHILD_CONFLICT_KEY):
            entry = node.pop(key, None)
            if not isinstance(entry, dict):
                continue
            pick = picks.get(str(entry.get("id"))) or "mine"
            stats["seen"] += 1
            kind = entry.get("kind")
            if kind == "removed":       # mine edited it, the package deleted it
                drop = drop or (pick == "theirs")
            elif kind == "deleted":     # the package edited it, mine deleted it
                drop = drop or (pick == "mine")
            elif kind == "children":
                _apply_children_choice(node, entry, pick)
            else:
                _apply_content_choice(node, entry, pick)
            if pick != "mine" or kind in ("removed", "deleted"):
                stats["applied"] += 1
        if drop:
            continue
        node["children"] = _resolve(_nodes(node.get("children")), picks, stats)
        keep.append(node)
    return keep


def _project_token(project):
    """Fingerprint of a report object, canonicalized exactly the way
    ``apply_update.project_sha`` fingerprints a project.json on disk, so the
    token a merge was computed from is directly comparable with the file."""
    try:
        return A._sha(A._canon(project))
    except Exception:
        return None


# One snapshot implementation for the whole sync layer: the rolling
# <report>/_autosave/ history that both an apply and a merge write into before
# they overwrite anything.
snapshot_project = A.snapshot_project


def apply_choices(project_dir, merged, choices, base_sha=None):
    """Write the outcome of a merge: resolve every marked conflict with the
    user's decision, strip the markers, snapshot, write, re-stamp the baseline.

    ``choices`` maps a conflict id to ``mine`` | ``theirs`` | ``both``; an
    undecided conflict falls back to ``mine``, so the local report is never
    silently replaced. Returns {ok, applied, snapshot, conflicts, path}.

    The write REPLACES project.json wholesale, so it is guarded by the
    concurrency token :func:`merge3` stamped into ``merged`` (or passed here
    explicitly): if the file no longer matches the state the merge was computed
    from, something else wrote in the meantime and this write would erase it, so
    the apply is refused with ``error: "stale_merge"`` and the caller recomputes
    the merge against the current report. Nothing is written on a refusal.

    The written state becomes the new baseline: this exchange is the common
    ancestor the next incremental diff is measured against.
    """
    if not isinstance(merged, dict) or "outline" not in merged:
        return {"ok": False, "error": "merged report missing or has no outline"}
    project_dir = os.path.abspath(project_dir)
    target = os.path.join(project_dir, "project.json")
    picks = _normalize_choices(choices)
    out = copy.deepcopy(merged)
    token = base_sha or out.pop(BASE_SHA_KEY, None)
    out.pop(BASE_SHA_KEY, None)     # never written to disk, whichever won above
    # A report with no project.json yet is the empty state, and a merge computed
    # from that same empty state may still create it -- only a file that exists
    # and has MOVED since the merge is a refusal.
    current = (A.project_sha(target) if os.path.isfile(target)
               else _project_token({}))
    # "expected" / "actual" are the wire names for the two fingerprints;
    # "mergeBase" / "localBase" are the same values under this module's older
    # names, kept so nothing that reads them breaks.
    if not token:
        return {"ok": False, "error": "merge_token_missing",
                "expected": None, "actual": current, "localBase": current,
                "message": "this merge carries no concurrency token; "
                           "recompute the merge and apply that result"}
    if token != current:
        return {"ok": False, "error": "stale_merge",
                "expected": token, "actual": current,
                "mergeBase": token, "localBase": current,
                "message": "the report changed while you were deciding; "
                           "recompute the merge against the current report"}
    stats = {"seen": 0, "applied": 0}

    top = out.pop(TOP_CONFLICT_KEY, None)
    if isinstance(top, dict):
        for key, entry in top.items():
            if not isinstance(entry, dict):
                continue
            pick = picks.get(str(entry.get("id"))) or "mine"
            stats["seen"] += 1
            if pick == "mine":
                continue
            stats["applied"] += 1
            mine_v, theirs_v = entry.get("mine"), entry.get("theirs")
            if pick == "theirs":
                out[key] = copy.deepcopy(theirs_v)
            elif isinstance(mine_v, list) and isinstance(theirs_v, list):
                out[key] = copy.deepcopy(mine_v) + copy.deepcopy(theirs_v)
            elif isinstance(mine_v, dict) and isinstance(theirs_v, dict):
                joined = copy.deepcopy(mine_v)
                joined.update(copy.deepcopy(theirs_v))
                out[key] = joined
            else:
                out[key] = copy.deepcopy(theirs_v)

    out["outline"] = _resolve(_nodes(out.get("outline")), picks, stats)

    snap = snapshot_project(project_dir, "premerge")
    data = json.dumps(out, ensure_ascii=False, indent=2).encode("utf-8")
    A._atomic_write(target, data)
    # project_dir doubles as the reports root here: _stamp_baseline resolves the
    # baseline as a sibling of the rel path, i.e. <report>/_baseline.json.
    A._stamp_baseline(project_dir, "project.json", data)
    return {"ok": True, "applied": stats["applied"], "snapshot": snap,
            "conflicts": stats["seen"], "path": target.replace("\\", "/")}
