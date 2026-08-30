#!/usr/bin/env python3
"""Create a new report from an existing one, and pull a reference column.

Two jobs, both driven by the v2 workbench:

``create_report(root, body)``
    Make the folder for a new project / module / report under the reports root.
    The interesting mode is ``inherit``: copy a finished report of the same
    module and strip it back to a skeleton the author can refill. What survives
    and what is emptied is spelled out above ``clear_report`` below.

``build_reference_column(root, body)``
    Pull one value column out of another report of the same module so two stages
    sit side by side in the same compliance table. Rows are paired by item name
    only; anything that does not pair is reported and left empty.

Layering: this module sits in ``core`` and imports nothing from the layers above
it (no ``store``, no ``sync``, no ``web``) and nothing outside the standard
library, so it stays importable from a plain CLI and from the server alike. It
reads the template library directly, with its own containment guard, rather than
reaching up into the store layer.

No policy belonging to one organisation lives here. Which chapters keep their
figures, which sections count as conclusions -- all of it arrives in the request
body as node ids, or falls back to a neutral default that keeps things.
"""

import copy
import difflib
import hashlib
import json
import os
import re


# ---------------------------------------------------------------------------
# Small shared helpers
# ---------------------------------------------------------------------------

_NAME_RE = re.compile(r"[^A-Za-z0-9_-]+")

#: Row kinds that mark a test condition rather than a simulated result. Mirrors
#: ``tables.render_datatable``'s default, so the rows this module refuses to
#: clear are exactly the rows the renderer paints with the setting fill.
DEFAULT_SETTING_KINDS = ("common_setting", "module_setting", "tb")

#: Words that mark a section as a conclusion when the caller supplies no
#: ``clearProseUnder`` list. Generic English only; a caller that needs anything
#: else passes node ids instead.
DEFAULT_CONCLUSION_WORDS = ("conclusion", "conclusions", "summary")

#: Similarity above which two differently spelled item names are treated as the
#: same measurement. Below it the row is reported as a non-match and left empty.
SIMILARITY_THRESHOLD = 0.88

_STAGE_RE = re.compile(r"(?:^|[^A-Z])(XDR|PDR|CDR|FDR)(?:[^A-Z]|$)")


def _sanitize(name):
    """Folder-safe segment (same character class as the server's sanitizer)."""
    return _NAME_RE.sub("_", str(name or "")).strip("_")[:64]


def _stage_of(text):
    """The stage code named by a title or a folder name, else ""."""
    m = _STAGE_RE.search(str(text or "").upper())
    return m.group(1) if m else ""


def _contained(child_abs, parent_abs):
    """True iff ``child_abs`` sits inside ``parent_abs`` (case/sep robust)."""
    try:
        common = os.path.commonpath([parent_abs, child_abs])
    except ValueError:
        return False            # different drives
    return os.path.normcase(common) == os.path.normcase(parent_abs)


def _under_root(root, rel, must_exist=False):
    """Resolve ``rel`` under the reports root, refusing anything that escapes."""
    if not root:
        raise ValueError("no reports root configured")
    root_abs = os.path.abspath(root)
    rel = str(rel or "").strip().replace("\\", "/")
    if not rel:
        raise ValueError("missing path")
    target = (os.path.abspath(rel) if os.path.isabs(rel)
              else os.path.abspath(os.path.join(root_abs, rel)))
    if not _contained(target, root_abs):
        raise ValueError("path escapes the reports root")
    if must_exist and not os.path.isdir(target):
        raise FileNotFoundError("no such folder: %s" % rel)
    return target


def _rel_dir(root, path):
    """A report folder as the slash-separated path the API speaks in."""
    rel = os.path.relpath(os.path.abspath(path), os.path.abspath(root))
    return rel.replace(os.sep, "/")


def _read_json(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _read_json_quiet(path):
    try:
        return _read_json(path)
    except Exception:
        return None


def _atomic_write_json(path, obj):
    """Write JSON via a temp file + os.replace (never a half-written report)."""
    data = json.dumps(obj, ensure_ascii=False, indent=1).encode("utf-8")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = "%s.tmp.%d" % (path, os.getpid())
    with open(tmp, "wb") as fh:
        fh.write(data)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def _canon(obj):
    """Canonical JSON bytes: key order and spacing fixed, so a hash over it only
    moves when the content itself moves."""
    return json.dumps(obj, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":")).encode("utf-8")


def _content_hash(obj):
    return hashlib.sha256(_canon(obj)).hexdigest()


def _walk_nodes(nodes, parent=None):
    """Depth-first ``(node, parent)`` over an outline tree."""
    for node in nodes or []:
        if not isinstance(node, dict):
            continue
        yield node, parent
        for pair in _walk_nodes(node.get("children") or [], node):
            yield pair


def _blocks_of(node):
    return [b for b in (node.get("blocks") or []) if isinstance(b, dict)]


def _datatables(outline):
    """``(node, block)`` for every compliance table in the tree, in order."""
    out = []
    for node, _parent in _walk_nodes(outline):
        for block in _blocks_of(node):
            if block.get("type") == "datatable":
                out.append((node, block))
    return out


def _image_files(project):
    """Every image file the report still points at, first-seen order."""
    out, seen = [], set()
    for node, _p in _walk_nodes((project or {}).get("outline") or []):
        for block in _blocks_of(node):
            files = []
            if block.get("type") == "image":
                files = [block.get("file")]
            elif block.get("type") == "imagegrid":
                files = [it.get("file") for it in (block.get("items") or [])
                         if isinstance(it, dict)]
            for f in files:
                if f and f not in seen:
                    seen.add(f)
                    out.append(f)
    return out


# ---------------------------------------------------------------------------
# Clearing an inherited report
# ---------------------------------------------------------------------------
#
# KEPT, because it is the stage-independent skeleton the author should not have
# to retype:
#   * the whole section tree -- ids, titles, levels, order, fixed_body
#   * prose, except in the sections the caller marks as conclusions
#   * table STRUCTURE: columns, simulation groups, category / item / unit /
#     limit / kind per row, and the VALUES of setting rows -- those are test
#     conditions, not results
#   * captions, cross-reference targets, image blocks and their numbering
#   * cover metadata apart from the date and the version
#
# CLEARED:
#   * every simulated value on a RESULT row of a compliance table
#   * conclusion prose
#   * the figures the caller names -- and only those
#
# Clearing a figure blanks its ``file`` and keeps the block, its caption and its
# position, so the figure number never moves and the author only re-pastes the
# picture. An empty ``file`` is the placeholder that both the linter and the
# renderer already understand.


def _selector_matches(node, selector):
    """A clearPolicy entry addresses a node by id, or by exact title.

    Ids are the documented form. Title matching is a convenience for callers that
    build a policy from an outline dump, and mirrors the way patch bundles locate
    nodes; it is case-insensitive and must be exact.
    """
    sel = str(selector or "").strip()
    if not sel:
        return False
    if str(node.get("id") or "") == sel:
        return True
    return str(node.get("title") or "").strip().lower() == sel.lower()


def _in_any(node, selectors):
    return any(_selector_matches(node, s) for s in selectors or [])


def _blank_axis_list(values, counter):
    """Blank a MIN/TYP/MAX list, counting the values actually removed."""
    out = []
    for v in list(values or []):
        if v not in (None, ""):
            counter[0] += 1
        out.append(None)
    while len(out) < 3:
        out.append(None)
    return out


def _clear_result_row(row, counter):
    """Blank every simulated value on one result row; keep everything else."""
    before = counter[0]
    if "sim_mtm" in row or "sim_ntwc" in row:
        row["sim_mtm"] = _blank_axis_list(row.get("sim_mtm"), counter)
        if row.get("sim_ntwc") not in (None, ""):
            counter[0] += 1
        row["sim_ntwc"] = None
    sims = row.get("sims")
    if isinstance(sims, dict):
        for key in list(sims.keys()):
            entry = sims.get(key)
            if not isinstance(entry, dict):
                sims[key] = {"mtm": [None, None, None], "ntwc": None}
                continue
            entry["mtm"] = _blank_axis_list(entry.get("mtm"), counter)
            if entry.get("ntwc") not in (None, ""):
                counter[0] += 1
            entry["ntwc"] = None
    return counter[0] - before


def clear_report(project, policy=None, setting_kinds=None):
    """Strip an inherited report back to its skeleton, in place.

    ``policy`` -- the request's ``clearPolicy`` -- is entirely optional::

        {"clearImagesUnder":  [node id or title, ...],
         "keepImagesUnder":   [node id or title, ...],
         "clearProseUnder":   [node id or title, ...],
         "keepValuesUnder":   [node id or title, ...],
         "settingKinds":      [row kind, ...],
         "conclusionWords":   [word, ...],
         "clearProse":        bool}

    Both image lists nest: the deepest listed ancestor-or-self decides, and a
    node named in both lists keeps its figures (the safe answer). With neither
    list present every figure is kept -- this module never guesses which chapter
    holds results.

    Returns the manifest documented on ``create_report``, plus ``keptFiles``
    (the image files still referenced), which ``create_report`` consumes and
    drops before answering.
    """
    policy = policy if isinstance(policy, dict) else {}
    kinds = set(setting_kinds or policy.get("settingKinds")
                or DEFAULT_SETTING_KINDS)
    clear_imgs = policy.get("clearImagesUnder") or []
    keep_imgs = policy.get("keepImagesUnder") or []
    clear_prose = policy.get("clearProseUnder") or []
    keep_values = policy.get("keepValuesUnder") or []
    prose_enabled = policy.get("clearProse", True)
    words = policy.get("conclusionWords")
    concl_words = (tuple(str(w).lower() for w in words) if words
                   else DEFAULT_CONCLUSION_WORDS)

    counts = {"tables": 0, "resultRows": 0, "values": 0,
              "images": 0, "imagesKept": 0, "gridImages": 0,
              "prose": 0, "proseSections": 0, "items": [], "keptFiles": []}
    kept_files = []

    def visit(nodes, img_clear, keep_vals, in_conclusion):
        for node in nodes or []:
            if not isinstance(node, dict):
                continue
            # deepest mention wins; at the same node, keep beats clear
            node_img = img_clear
            if _in_any(node, keep_imgs):
                node_img = False
            elif _in_any(node, clear_imgs):
                node_img = True
            node_keep_vals = keep_vals or _in_any(node, keep_values)
            node_concl = in_conclusion or _in_any(node, clear_prose)
            if prose_enabled and not node_concl:
                title = str(node.get("title") or "").lower()
                node_concl = any(w in title for w in concl_words)

            nid = str(node.get("id") or "")
            ntitle = str(node.get("title") or "")
            prose_here = 0

            for block in _blocks_of(node):
                btype = block.get("type")

                if btype == "datatable" and not node_keep_vals:
                    data = block.get("data")
                    if not isinstance(data, dict):
                        continue
                    counter = [0]
                    rows_hit = 0
                    for row in data.get("rows") or []:
                        if not isinstance(row, dict):
                            continue
                        if row.get("kind") in kinds:
                            continue        # a test condition, never a result
                        if _clear_result_row(row, counter):
                            rows_hit += 1
                    if counter[0]:
                        counts["tables"] += 1
                        counts["resultRows"] += rows_hit
                        counts["values"] += counter[0]
                        counts["items"].append({
                            "node": nid, "title": ntitle,
                            "block": block.get("id"), "type": "datatable",
                            "action": "cleared", "rows": rows_hit,
                            "values": counter[0],
                            "caption": block.get("caption") or "",
                        })

                elif btype == "image":
                    fname = block.get("file") or ""
                    if node_img and fname:
                        block["file"] = ""
                        counts["images"] += 1
                        action = "cleared"
                    else:
                        if fname:
                            kept_files.append(fname)
                            counts["imagesKept"] += 1
                        action = "kept"
                    counts["items"].append({
                        "node": nid, "title": ntitle, "block": block.get("id"),
                        "type": "image", "action": action, "file": fname,
                        "caption": block.get("caption") or "",
                    })

                elif btype == "imagegrid":
                    items = [it for it in (block.get("items") or [])
                             if isinstance(it, dict)]
                    files = [it.get("file") or "" for it in items]
                    if node_img:
                        hit = 0
                        for it in items:
                            if it.get("file"):
                                it["file"] = ""
                                hit += 1
                        counts["gridImages"] += hit
                        action = "cleared" if hit else "kept"
                    else:
                        present = [f for f in files if f]
                        kept_files.extend(present)
                        counts["imagesKept"] += len(present)
                        action = "kept"
                    counts["items"].append({
                        "node": nid, "title": ntitle, "block": block.get("id"),
                        "type": "imagegrid", "action": action, "files": files,
                        "caption": block.get("caption") or "",
                    })

                elif btype == "para" and node_concl:
                    if block.get("runs"):
                        block["runs"] = []
                        prose_here += 1

            if prose_here:
                counts["prose"] += prose_here
                counts["proseSections"] += 1
                counts["items"].append({
                    "node": nid, "title": ntitle, "block": None,
                    "type": "prose", "action": "cleared",
                    "paragraphs": prose_here,
                })

            visit(node.get("children") or [], node_img, node_keep_vals,
                  node_concl)

    visit((project or {}).get("outline") or [], False, False, False)
    seen = set()
    for f in kept_files:            # one file can back several blocks
        if f not in seen:
            seen.add(f)
            counts["keptFiles"].append(f)
    return counts


# ---------------------------------------------------------------------------
# Cover metadata for the new stage
# ---------------------------------------------------------------------------

_NUM_TAIL_RE = re.compile(r"(\d+)(\D*)$")


def bump_version(version):
    """Increment the last number of a version string.

    ``V1.0`` -> ``V1.1``, ``2`` -> ``3``, empty -> ``V1.0``. A caller that wants
    a different scheme passes ``version`` in the request body instead.
    """
    text = str(version or "").strip()
    if not text:
        return "V1.0"
    m = _NUM_TAIL_RE.search(text)
    if not m:
        return text
    return "%s%d%s" % (text[:m.start(1)], int(m.group(1)) + 1, m.group(2))


def _retitle(title, old_stage, new_stage):
    """Swap the stage code inside a document title, leaving the rest alone."""
    if not title or not new_stage or not old_stage or old_stage == new_stage:
        return title
    return re.sub(r"\b%s\b" % re.escape(old_stage), new_stage, title,
                  flags=re.IGNORECASE)


def _restage_meta(meta, stage, body):
    """Cover metadata for a report that starts a new stage."""
    meta = dict(meta or {})
    old_stage = _stage_of(meta.get("title")) or _stage_of(body.get("from"))
    version = body.get("version") or bump_version(meta.get("version"))
    meta["version"] = version
    if stage:
        meta["stage"] = stage
        meta["title"] = _retitle(meta.get("title") or "", old_stage, stage)
    if body.get("title"):
        meta["title"] = body["title"]
    meta["date"] = ""
    # a fresh revision history: this document has not been issued yet
    meta["revisions"] = [{"ver": version, "date": "",
                          "author": meta.get("author") or "", "note": ""}]
    return meta


# ---------------------------------------------------------------------------
# Template library (read-only, guarded -- core cannot import the store layer)
# ---------------------------------------------------------------------------


def _template_files(root, tid):
    """``(config, skeleton)`` for a template id."""
    troot = os.path.abspath(os.path.join(os.path.abspath(root), "templates"))
    tdir = os.path.abspath(os.path.join(troot, str(tid or "")))
    if (not tid or not _contained(tdir, troot)
            or os.path.normcase(tdir) == os.path.normcase(troot)):
        raise ValueError("bad template id")
    cfg = _read_json_quiet(os.path.join(tdir, "config.json"))
    if cfg is None:
        raise FileNotFoundError("template not found: %s" % tid)
    skel = _read_json_quiet(os.path.join(tdir, "skeleton.json"))
    return cfg, (skel if isinstance(skel, list) else [])


def _instantiate_skeleton(skeleton):
    """Clone a template skeleton into an outline (fixed nodes keep their blocks)."""
    out = []
    for node in skeleton or []:
        if not isinstance(node, dict):
            continue
        out.append({
            "title": node.get("title", ""),
            "level": node.get("level", 1),
            "blocks": (copy.deepcopy(node.get("blocks", []))
                       if node.get("fixed") else []),
            "children": _instantiate_skeleton(node.get("children", [])),
        })
    return out


def _empty_meta():
    return {"title": "", "secrecy": "", "doc_no": "", "page_count": "",
            "author": "", "reviewers": [], "approver": "", "revisions": []}


# ---------------------------------------------------------------------------
# create_report
# ---------------------------------------------------------------------------


def _kind_of(body):
    """Which shell the request asks for: a report, a module, or a project."""
    kind = str(body.get("kind") or "").strip().lower()
    if kind in ("report", "module", "project"):
        return kind
    if body.get("stage") or body.get("mode") or body.get("from"):
        return "report"
    if body.get("project") and (body.get("module") or body.get("name")):
        return "module"
    return "project"


def _make_shell(root, kind, body):
    """Create a project or module folder plus its optional name / description."""
    if kind == "project":
        seg = _sanitize(body.get("project") or body.get("name"))
        if not seg:
            raise ValueError("missing project name")
        parts = [seg]
    else:
        proj = _sanitize(body.get("project"))
        mod = _sanitize(body.get("module") or body.get("name"))
        if not proj:
            raise ValueError("missing project name")
        if not mod:
            raise ValueError("missing module name")
        parts = [proj, mod]
    target = _under_root(root, "/".join(parts))
    existed = os.path.isdir(target)
    os.makedirs(target, exist_ok=True)
    meta_path = os.path.join(target, "project_meta.json")
    if not os.path.isfile(meta_path):
        _atomic_write_json(meta_path, {
            "name": str(body.get("displayName") or body.get("name")
                        or parts[-1]),
            "description": str(body.get("description") or ""),
        })
    return {"dir": _rel_dir(root, target), "kind": kind, "existed": existed,
            "cleared": {}, "warnings": []}


def _copy_images(src_dir, dest_dir, files, warnings):
    """Copy only the image files the surviving blocks still point at."""
    copied = 0
    for rel in files or []:
        rel = str(rel or "").replace("\\", "/")
        if not rel or rel.startswith("/") or ".." in rel.split("/"):
            continue
        src = os.path.join(src_dir, rel.replace("/", os.sep))
        if not os.path.isfile(src):
            warnings.append("source image is missing: %s" % rel)
            continue
        dest = os.path.join(dest_dir, rel.replace("/", os.sep))
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(src, "rb") as fh_in, open(dest, "wb") as fh_out:
            fh_out.write(fh_in.read())
        copied += 1
    return copied


def create_report(root, body):
    """Create a report -- or a project / module shell -- under the reports root.

    Body::

        {project, module, stage, name, mode: 'inherit'|'template'|'docx',
         from, template, clearValues: true, clearPolicy: {...}}

    ``mode``:

    ``inherit``   copy the report at ``from`` and clear it (see ``clear_report``)
    ``template``  instantiate ``template``'s skeleton into an empty report
    ``docx``      write the parsed report handed over in ``seed`` -- the
                  ``project`` object ``/api/import-docx`` returns -- or, when the
                  import already staged a folder, the report at ``from``

    A report folder is ``<project>/<module>/<stage>``; ``dirName`` overrides the
    leaf when a module needs two reports at one stage. Creating over an existing
    report needs ``overwrite``.

    Returns ``{"dir", "kind", "mode", "cleared": {...}, "warnings": [...]}``
    where ``cleared`` carries counts and a per-item manifest the caller can print
    line by line::

        {"tables", "resultRows", "values", "images", "imagesKept", "gridImages",
         "prose", "proseSections", "imagesCopied",
         "items": [{"node", "title", "block", "type", "action", ...}, ...]}
    """
    if not isinstance(body, dict):
        raise ValueError("body must be a JSON object")
    kind = _kind_of(body)
    if kind != "report":
        return _make_shell(root, kind, body)

    warnings = []
    stage = str(body.get("stage") or "").strip().upper()
    leaf = _sanitize(body.get("dirName") or stage or body.get("name"))
    if not leaf:
        raise ValueError("missing stage")
    parts = [p for p in (_sanitize(body.get("project")),
                         _sanitize(body.get("module")), leaf) if p]
    if len(parts) < 2:
        raise ValueError("a report needs a project and a module")
    target = _under_root(root, "/".join(parts))
    project_json = os.path.join(target, "project.json")
    if os.path.isfile(project_json) and not body.get("overwrite"):
        raise ValueError("a report already exists at %s" % "/".join(parts))

    mode = str(body.get("mode") or "inherit").strip().lower()
    clear_values = body.get("clearValues", True)
    src_dir = None

    if mode == "inherit":
        if not body.get("from"):
            raise ValueError("inherit needs a source report in 'from'")
        src_dir = _under_root(root, body["from"], must_exist=True)
        src_json = os.path.join(src_dir, "project.json")
        if not os.path.isfile(src_json):
            raise FileNotFoundError("no project.json in %s" % body["from"])
        project = copy.deepcopy(_read_json(src_json))
        if clear_values:
            cleared = clear_report(project, body.get("clearPolicy"))
        else:
            cleared = {"items": [], "keptFiles": _image_files(project)}
        project["meta"] = _restage_meta(project.get("meta"), stage, body)

    elif mode == "template":
        _cfg, skeleton = _template_files(root, body.get("template"))
        project = {"schema_version": 1, "template": body.get("template"),
                   "meta": _empty_meta(),
                   "outline": _instantiate_skeleton(skeleton)}
        project["meta"]["title"] = body.get("title") or body.get("name") or ""
        if stage:
            project["meta"]["stage"] = stage
        cleared = {"items": []}
        if not skeleton:
            warnings.append("template '%s' has an empty skeleton"
                            % body.get("template"))

    elif mode == "docx":
        seed = body.get("seed") or body.get("projectJson")
        if isinstance(seed, dict) and seed.get("outline") is not None:
            project = copy.deepcopy(seed)
        elif body.get("from"):
            src_dir = _under_root(root, body["from"], must_exist=True)
            project = copy.deepcopy(
                _read_json(os.path.join(src_dir, "project.json")))
        else:
            raise ValueError("docx mode needs the imported report in 'seed'")
        if clear_values and body.get("clearPolicy") is not None:
            cleared = clear_report(project, body.get("clearPolicy"))
        else:
            cleared = {"items": [], "keptFiles": _image_files(project)}
        if stage:
            project.setdefault("meta", _empty_meta())["stage"] = stage
        warnings.append("Word does not record limit direction, merged spans or "
                        "the document version -- check those after importing")
    else:
        raise ValueError("unknown mode: %r" % mode)

    if body.get("template") and not project.get("template"):
        project["template"] = body["template"]
    project.setdefault("schema_version", 1)

    os.makedirs(os.path.join(target, "images"), exist_ok=True)
    copied = 0
    if src_dir:
        copied = _copy_images(src_dir, target, cleared.get("keptFiles"),
                              warnings)
    _atomic_write_json(project_json, project)

    cleared.pop("keptFiles", None)
    cleared["imagesCopied"] = copied
    return {"dir": _rel_dir(root, target), "kind": "report", "mode": mode,
            "cleared": cleared, "warnings": warnings}


# ---------------------------------------------------------------------------
# Reference column
# ---------------------------------------------------------------------------
#
# One column of another report's numbers pinned next to this report's own, so a
# reader sees both stages at once. It is a SNAPSHOT: values are copied at
# insertion time and stamped with where they came from, including a hash of the
# source table so a later change to the source can be detected. Nothing here
# ever refreshes on its own.

_PUNCT_RE = re.compile(r"[^0-9a-z]+")


def normalise_item(text):
    """An item name reduced to what a reader would call the same measurement.

    Case, spacing and punctuation only -- no synonym table, no unit stripping,
    nothing that could quietly pair two different measurements.
    """
    return _PUNCT_RE.sub(" ", str(text or "").strip().lower()).strip()


def _similarity(a, b):
    if not a or not b:
        return 0.0
    return difflib.SequenceMatcher(None, a, b).ratio()


def _numeric(v):
    """Numeric part of an axis value, tolerating the ``[value, "CORNER"]`` form."""
    if isinstance(v, (list, tuple)) and len(v) == 2:
        v = v[0]
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _axis_values(row, gkey):
    """``(mtm_triple, ntwc)`` for one group of one row -- the same per-group
    lookup the renderer does, so what lands in the column is what Word prints."""
    if gkey == "spec":
        mtm = list(row.get("spec_mtm") or [])
        ntwc = row.get("spec_ntwc")
    else:
        sims = row.get("sims")
        if isinstance(sims, dict) and gkey in sims:
            entry = sims.get(gkey) or {}
            mtm = list(entry.get("mtm") or [])
            ntwc = entry.get("ntwc")
        else:
            mtm = list(row.get("sim_mtm") or [])
            ntwc = row.get("sim_ntwc")
    while len(mtm) < 3:
        mtm.append(None)
    return mtm, ntwc


def delta_direction(limit, current, reference, spec_mtm=None, spec=None):
    """Which way a value moved relative to its own limit.

    ``"toward"``  closer to passing than the reference value
    ``"away"``    further from passing
    ``"none"``    no limit on this row, or nothing comparable to say

    Colour lives in the UI; this only ever names the direction.
    """
    cur, ref = _numeric(current), _numeric(reference)
    if not limit or cur is None or ref is None or cur == ref:
        return "none"
    if limit == "le":                       # lower is better
        return "toward" if cur < ref else "away"
    if limit == "ge":                       # higher is better
        return "toward" if cur > ref else "away"
    if limit == "range":                    # closer to inside the band is better
        sm = list(spec_mtm or [])
        while len(sm) < 3:
            sm.append(None)
        lo, hi = _numeric(sm[0]), _numeric(sm[2])
        if lo is None and hi is None:
            lo = hi = _numeric(spec)
        if lo is None and hi is None:
            return "none"

        def excess(v):
            out = 0.0
            if lo is not None and v < lo:
                out = max(out, lo - v)
            if hi is not None and v > hi:
                out = max(out, v - hi)
            return out

        moved = excess(cur) - excess(ref)
        if moved < 0:
            return "toward"
        if moved > 0:
            return "away"
    return "none"


def _find_block(outline, block_id):
    """The datatable addressed by ``targetBlock``: by block id, or by position
    among the report's compliance tables when the caller passes an index."""
    found = _datatables(outline)
    if block_id in (None, ""):
        if len(found) == 1:
            return found[0]
        raise ValueError("this report has %d compliance tables; name one in "
                         "'targetBlock'" % len(found))
    for node, block in found:
        if str(block.get("id") or "") == str(block_id):
            return node, block
    try:
        idx = int(block_id)
    except (TypeError, ValueError):
        idx = None
    if idx is not None and 0 <= idx < len(found):
        return found[idx]
    raise ValueError("no compliance table with id %r" % (block_id,))


def _pick_source_block(outline, target_rows, want_id=None):
    """The source table to pull from: the one named, else the one whose item
    names overlap this table's the most. Deterministic, and it never silently
    picks an unrelated table -- zero overlap raises instead."""
    found = _datatables(outline)
    if not found:
        raise ValueError("the source report has no compliance table")
    if want_id:
        for _node, block in found:
            if str(block.get("id") or "") == str(want_id):
                return block
        raise ValueError("no compliance table with id %r in the source report"
                         % (want_id,))
    wanted = set(normalise_item(r.get("item")) for r in target_rows
                 if isinstance(r, dict) and r.get("item"))
    best, best_score = None, -1
    for _node, block in found:
        rows = (block.get("data") or {}).get("rows") or []
        have = set(normalise_item(r.get("item")) for r in rows
                   if isinstance(r, dict) and r.get("item"))
        score = len(wanted & have)
        if score > best_score:
            best, best_score = block, score
    if best_score <= 0:
        raise ValueError("no table in the source report shares an item name "
                         "with this one")
    return best


def _group_of(data, key):
    """The named simulation group of a source table, else its first one."""
    sims = [s for s in (data.get("sims") or []) if isinstance(s, dict)]
    if key:
        for s in sims:
            if str(s.get("key")) == str(key):
                return s
        if str(key) == "spec":
            return {"key": "spec", "title": data.get("spec_name") or "Spec",
                    "stage": None, "axes": ["MIN", "TYP", "MAX"]}
        raise ValueError("no group %r in the source table" % (key,))
    if not sims:
        raise ValueError("the source table declares no simulation group")
    return sims[0]


def _primary_group_key(data):
    """The group holding this report's own numbers -- the first declared sim."""
    for s in data.get("sims") or []:
        if isinstance(s, dict) and s.get("key"):
            return str(s["key"])
    return "sim"


def _axis_index(axes, axis_arg):
    """Resolve ``axis`` (a label such as ``MAX``, or an index) inside ``axes``."""
    if axis_arg in (None, ""):
        return 0
    if isinstance(axis_arg, bool):
        return 0
    if isinstance(axis_arg, int):
        return max(0, min(axis_arg, len(axes) - 1))
    text = str(axis_arg)
    if text.isdigit():
        return max(0, min(int(text), len(axes) - 1))
    upper = [a.upper() for a in axes]
    if text.upper() not in upper:
        raise ValueError("no axis %r in this group" % (axis_arg,))
    return upper.index(text.upper())


def _unique_key(existing, base):
    key = base or "ref"
    n = 2
    while key in existing:
        key = "%s_%d" % (base, n)
        n += 1
    return key


def build_reference_column(root, body):
    """Pull one value column out of another report of the same module.

    Body ``{dir, srcReport, targetBlock, group, axis, title}``; ``srcBlock`` is
    optional and pins the source table when the source holds several.

    Returns::

        {"matches": [{"row", "item", "cat", "kind", "unit", "limit", "status",
                      "score", "srcRow", "srcItem", "values", "value",
                      "current", "delta", "direction"}, ...],
         "column":  {"key", "title", "stage", "axes", "axis", "role", "readOnly",
                     "rows": [{"mtm", "ntwc", "span"} | null, ...],
                     "source": {"report", "stage", "version", "date", "block",
                                "group", "hash"}},
         "summary": {"matched", "renamed", "nomatch", "total"}}

    ``status`` is ``matched`` (identical item name), ``renamed`` (same name up to
    case / spacing / punctuation, or above the similarity threshold) or
    ``nomatch``. A non-match keeps an empty cell -- ``column.rows`` holds
    ``null`` there. Nothing is ever guessed, and every unmatched row is listed so
    the author can see what was left out.

    ``values`` carries all three of MIN / TYP / MAX (plus the fourth axis when
    the group declares one) whichever axis the caller asked to look at;
    ``value`` is that axis alone. ``direction`` says whether this report's own
    value sits closer to its limit than the reference does -- the UI colours from
    it, and no colour is decided here.

    The column is a snapshot. ``column.source.hash`` fingerprints the source
    table so a later change can be noticed; it is never refreshed automatically.
    """
    if not isinstance(body, dict):
        raise ValueError("body must be a JSON object")
    if not body.get("dir"):
        raise ValueError("missing 'dir'")
    if not body.get("srcReport"):
        raise ValueError("missing 'srcReport'")

    tgt_dir = _under_root(root, body["dir"], must_exist=True)
    src_dir = _under_root(root, body["srcReport"], must_exist=True)
    target = _read_json(os.path.join(tgt_dir, "project.json"))
    source = _read_json(os.path.join(src_dir, "project.json"))

    _tnode, tblock = _find_block(target.get("outline") or [],
                                 body.get("targetBlock"))
    tdata = tblock.get("data") or {}
    trows = [r for r in (tdata.get("rows") or []) if isinstance(r, dict)]
    tkey = _primary_group_key(tdata)

    sblock = _pick_source_block(source.get("outline") or [], trows,
                                body.get("srcBlock"))
    sdata = sblock.get("data") or {}
    srows = [r for r in (sdata.get("rows") or []) if isinstance(r, dict)]
    group = _group_of(sdata, body.get("group"))
    gkey = str(group.get("key"))
    axes = [str(a) for a in (group.get("axes") or ["MIN", "TYP", "MAX"])]
    axis_i = _axis_index(axes, body.get("axis"))
    axis_label = axes[axis_i]

    # index the source rows by item name; each source row is spent once, so two
    # target rows can never quietly share one source value
    exact, normed = {}, {}
    for j, row in enumerate(srows):
        item = str(row.get("item") or "")
        if item:
            exact.setdefault(item, j)
            normed.setdefault(normalise_item(item), j)
    used = set()

    src_meta = source.get("meta") or {}
    src_stage = (str(src_meta.get("stage") or "")
                 or _stage_of(src_meta.get("title"))
                 or _stage_of(body["srcReport"]))

    matches, column_rows = [], []
    summary = {"matched": 0, "renamed": 0, "nomatch": 0, "total": len(trows)}

    for i, trow in enumerate(trows):
        item = str(trow.get("item") or "")
        key = normalise_item(item)
        j, status, score = None, "nomatch", 0.0

        if item and exact.get(item) is not None and exact[item] not in used:
            j, status, score = exact[item], "matched", 1.0
        elif key and normed.get(key) is not None and normed[key] not in used:
            j, status, score = normed[key], "renamed", 1.0
        elif key:
            best_j, best_score = None, 0.0
            for cand, srow in enumerate(srows):
                if cand in used:
                    continue
                s = _similarity(key, normalise_item(srow.get("item")))
                if s > best_score:
                    best_j, best_score = cand, s
            if best_j is not None and best_score >= SIMILARITY_THRESHOLD:
                j, status, score = best_j, "renamed", round(best_score, 4)

        entry = {"row": i, "item": item, "cat": trow.get("cat") or "",
                 "kind": trow.get("kind") or "", "unit": trow.get("unit") or "",
                 "limit": trow.get("limit"), "status": status, "score": score,
                 "srcRow": j, "srcItem": None, "values": {}, "value": None,
                 "current": None, "delta": None, "direction": "none"}

        if j is None:
            column_rows.append(None)         # left empty, never guessed
            summary["nomatch"] += 1
            matches.append(entry)
            continue

        used.add(j)
        srow = srows[j]
        mtm, ntwc = _axis_values(srow, gkey)
        entry["srcItem"] = str(srow.get("item") or "")
        values = {}
        for k in range(min(3, len(axes))):
            values[axes[k]] = mtm[k]
        if len(axes) > 3:
            values[axes[3]] = ntwc
        entry["values"] = values
        entry["value"] = ntwc if axis_i >= 3 else mtm[axis_i]

        cur_mtm, cur_ntwc = _axis_values(trow, tkey)
        entry["current"] = cur_ntwc if axis_i >= 3 else cur_mtm[axis_i]
        cur_n, ref_n = _numeric(entry["current"]), _numeric(entry["value"])
        if cur_n is not None and ref_n is not None:
            entry["delta"] = cur_n - ref_n
        entry["direction"] = delta_direction(
            trow.get("limit"), entry["current"], entry["value"],
            trow.get("spec_mtm"), trow.get("spec"))

        column_rows.append({"mtm": mtm[:3], "ntwc": ntwc,
                            "span": bool(srow.get("sim_span"))})
        summary[status] += 1
        matches.append(entry)

    existing = set(str(s.get("key")) for s in (tdata.get("sims") or [])
                   if isinstance(s, dict))
    base_key = _sanitize("ref_%s_%s" % (src_stage or "src", gkey)).lower()
    title = body.get("title") or " ".join(
        p for p in (src_stage, str(group.get("title") or gkey), axis_label) if p)

    column = {
        "key": _unique_key(existing, base_key or "ref"),
        "title": title,
        "stage": group.get("stage") or src_stage or None,
        "axes": axes[:],
        "axis": axis_label,
        "role": "reference",
        "readOnly": True,
        "rows": column_rows,
        "source": {
            "report": body["srcReport"],
            "stage": src_stage,
            "version": str(src_meta.get("version") or ""),
            "date": str(src_meta.get("date") or ""),
            "block": sblock.get("id"),
            "group": gkey,
            "hash": _content_hash(sdata),
        },
    }
    return {"matches": matches, "column": column, "summary": summary}
