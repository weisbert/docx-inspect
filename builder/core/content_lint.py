# -*- coding: utf-8 -*-
"""content_lint.py -- pre-render content checks for a project.json.

Pure functions with NO python-docx dependency, so a project can be linted before
(or entirely without) an export -- e.g. by a fill script, by a pre-package step,
or by the workbench's standing Check tab.

Every finding carries both the legacy render-manifest keys and the machine keys
the Check tab reads:

    {"type": str,        # legacy alias of "code"
     "level": "error"|"warn"|"info",
     "detail": str,      # legacy alias of "message"
     "location": str,    # human path: section "Title" / block 2 (image)
     "code": str,        # stable rule id
     "message": str,     # plain English, from the MESSAGES table below
     "loc": str,         # section number path, e.g. "4.2"
     "nodeId": str|None, # outline node id
     "blockId": str|None}

  * error -- would crash the renderer or silently drop a whole block / table, so
             the visible output is wrong in a way the user cannot see (must be
             zero before exporting / shipping a package).
  * warn  -- renders, but the content is probably wrong or incomplete: a
             compliance table with no setting rows, a result row that can never
             be marked over spec, a figure with no caption, ...
  * info  -- legitimate-but-worth-noting, shown as "Notes": an image whose file
             was cleared for the next stage, a result row with an empty unit.

The only verdict this module knows about is "over spec". It never implies a
pass / fail / unknown state for a row.

Return shape of ``lint_project``: a ``LintReport``. It IS a dict with the three
Check-tab groups::

    {"errors": [...], "warnings": [...], "notes": [...]}

so it serialises straight to JSON for the Check tab, AND it iterates as the flat
list of findings in document order, which is what the export path does when it
merges these findings into the render manifest. ``report.flat`` is that list
explicitly; ``report.counts`` is the per-level tally.

CLI:
    python builder/core/content_lint.py <project_dir> [--config <template.json>]
    python builder/core/content_lint.py <project_dir> --json      # flat list
    python builder/core/content_lint.py <project_dir> --grouped   # Check-tab dict

Exit status is 1 when any ``error``-level finding exists (0 otherwise), so it can
gate a fill / package workflow.
"""
import argparse
import json
import os
import sys


def _load_json_file(path):
    """Read a JSON file tolerating a leading UTF-8 BOM (a common artefact from
    Windows editors / Excel / Notepad). ``utf-8-sig`` strips the BOM if present
    and is otherwise identical to ``utf-8``, so this is a safe drop-in for every
    project.json / template config read. Raises ``ValueError`` (JSONDecodeError
    is one) or ``OSError`` on failure -- callers turn that into a clean message
    naming ``path`` instead of letting an uncaught traceback out."""
    with open(path, "r", encoding="utf-8-sig") as fh:
        return json.load(fh)

# Canonical level for every warning type -- engine render-manifest types AND the
# content_lint codes below. Anything not listed defaults to "warn" (classify).
LEVELS = {
    # engine render-manifest types
    "block_error": "error",
    "missing_image": "warn",
    "missing_logo": "warn",
    "no_caption": "warn",
    "row_clip_risk": "warn",
    # A cross-reference whose target is gone does not merely look odd: the
    # renderer writes a red "[ref: <id>]" marker into the sentence, so the
    # exported document says something the author never wrote. That is wrong
    # output the author cannot see from the editor -- an error.
    "dangling_ref": "error",
    "table_warning": "warn",
    # tables.py sim_span guard (same code the renderer emits)
    "sim_span_unmergeable": "error",
    # content_lint structural codes
    "datatable_no_data": "error",
    "table_no_rows": "error",
    "row_missing_key": "error",
    "image_path": "error",
    "free_table_bounds": "error",
    "no_setting_rows": "warn",
    "limit_no_flag": "warn",
    "empty_sim_result": "warn",
    "empty_section": "warn",
    "unknown_sim_key": "warn",
    "duplicate_id": "error",
    "image_placeholder": "info",
    "unit_empty": "info",
}

LEVEL_ORDER = {"error": 0, "warn": 1, "info": 2}

# Which Check-tab group a level lands in.
LEVEL_GROUP = {"error": "errors", "warn": "warnings", "info": "notes"}
GROUP_KEYS = ("errors", "warnings", "notes")

# ---------------------------------------------------------------------------
# Frozen message table. Every user-visible sentence this module can produce is
# here, in plain English -- nothing is assembled ad hoc at a call site. Keep the
# wording aligned with the workbench glossary; do not invent a second phrase for
# a rule that already has one.
# ---------------------------------------------------------------------------
MESSAGES = {
    "image_path.absolute":
        'Image file is an absolute path: "%(file)s". Store the file under images/ '
        'and reference it as images/<name>',
    "image_path.escapes":
        'Image file points outside the report with "..": "%(file)s"',
    "image_path.outside":
        'Image file is not under images/: "%(file)s"',
    "image_placeholder.blank":
        "Image has no file yet - it is an empty frame waiting for a picture",
    "missing_image.not_found":
        'Image file "%(file)s" is missing from the report folder',
    "no_caption.image":
        "Image has no caption",
    "no_caption.imagegrid":
        "Image grid has no caption",
    "table_no_rows.missing":
        "Table has no rows",
    "table_no_rows.not_list":
        "Table rows are not a list of rows",
    "free_table_bounds.merge":
        "Merged cell at row %(r)s column %(c)s spanning %(rs)s x %(cs)s reaches "
        "outside this %(nrows)d x %(ncols)d table",
    "free_table_bounds.fill":
        "Row shading is set for row %(idx)s, but this table has only %(nrows)d rows",
    "datatable_no_data.block":
        "Compliance table has no data",
    "datatable_no_data.rows":
        "Compliance table data has no rows",
    "row_missing_key.not_object":
        "Row %(i)d is not a row object",
    "row_missing_key.missing":
        'Row %(i)d ("%(item)s") is missing: %(keys)s',
    "no_setting_rows.none":
        "Compliance table has no setting rows - add the test conditions at the "
        "top of the table",
    "limit_no_flag.blank":
        'Result row "%(item)s" has a spec but no limit set - this row is never '
        'marked over spec',
    "empty_sim_result.blank":
        'Result row "%(item)s" has no simulation values yet',
    "unit_empty.blank":
        'Result row "%(item)s" has an empty unit',
    "unknown_sim_key.undeclared":
        'Row %(i)d uses simulation column "%(key)s", which this table does not '
        'declare',
    "sim_span_unmergeable.thin":
        "A row spans the simulation columns, but simulation group(s) %(keys)s have "
        "fewer than two columns - there is nothing to merge",
    "empty_section.none":
        "Section is empty - no text, no figures, no tables",
    "dangling_ref.missing":
        "A cross-reference in this paragraph points at a figure or table that no "
        "longer exists - the export prints a red marker there",
    "duplicate_id.block":
        'Block id "%(id)s" is also used by another block at %(other)s - captions '
        'and cross-references cannot tell them apart',
    "duplicate_id.section":
        'Section id "%(id)s" is also used by another section at %(other)s',
}

_REQUIRED_ROW_KEYS = ("cat", "item", "kind", "unit")
_DEFAULT_AXES = ["MIN", "TYP", "MAX", "NTWC"]
_DEFAULT_SETTING_KINDS = ["common_setting", "module_setting", "tb"]


def classify(wtype, default="warn"):
    return LEVELS.get(wtype, default)


def stamp_levels(warnings):
    """Ensure every warning dict carries a ``level`` (idempotent). Returns it."""
    for w in warnings or []:
        if isinstance(w, dict) and "level" not in w:
            w["level"] = classify(w.get("type"))
    return warnings


def message(mid, **kw):
    """Render a frozen message. An unknown id falls back to the id itself rather
    than raising, so a typo degrades to an ugly string instead of killing a lint
    that exists to be a safety net."""
    tpl = MESSAGES.get(mid)
    if tpl is None:
        return mid
    try:
        return tpl % kw if kw else tpl
    except (KeyError, TypeError, ValueError):
        return tpl


class LintReport(dict):
    """The Check tab's three groups, which also iterates as a flat findings list.

    ``dict(report)`` / ``json.dumps(report)`` give
    ``{"errors": [...], "warnings": [...], "notes": [...]}``;
    ``list(report)`` / ``for f in report`` give the flat findings in document
    order (the shape the export manifest merge wants). ``len(report)`` is the
    dict's 3 -- use ``len(report.flat)`` for the finding count.
    """

    def __init__(self, findings=None):
        flat = list(findings or [])
        groups = {k: [] for k in GROUP_KEYS}
        for f in flat:
            groups[LEVEL_GROUP.get(f.get("level"), "warnings")].append(f)
        dict.__init__(self, groups)
        self.flat = flat

    def __iter__(self):
        return iter(self.flat)

    @property
    def counts(self):
        return summarize(self.flat)

    @property
    def has_errors(self):
        return bool(self["errors"])


# ---------------------------------------------------------------------------
# Small data-model helpers (mirror tables.py's reading, without importing it).
# ---------------------------------------------------------------------------


def _axis_count(sim, default_axes):
    ax = sim.get("axes") if isinstance(sim, dict) else None
    return len(ax) if isinstance(ax, list) else len(default_axes)


def _as_list(v):
    """A list/tuple as a list, else [] -- so a malformed scalar mtm (e.g.
    sim_mtm: 5 in a hand-edited project.json) is tolerated instead of crashing
    the whole lint on list(5)."""
    return list(v) if isinstance(v, (list, tuple)) else []


def _reference_group_keys(data):
    """Keys of the value groups that hold ANOTHER report's numbers.

    A reference column is a snapshot pulled from an earlier stage of the same
    module. ``report_new.build_reference_column`` stamps it ``role="reference"``
    and ``readOnly``; the table view treats either mark as read-only, so both are
    honoured here. Such a column is not work done for this stage, so it never
    answers "has this row been filled in".
    """
    keys = set()
    for s in (data.get("sims") or []):
        if not isinstance(s, dict):
            continue
        if s.get("role") == "reference" or s.get("readOnly"):
            k = s.get("key")
            if k is not None:
                keys.add(k)
    return keys


def _row_sim_values(row, ref_keys=()):
    """Flat list of a row's OWN simulated axis values (multi-sim or flat schema).

    Groups named in ``ref_keys`` are left out: an inherited row carries the
    previous stage's numbers beside empty cells of its own, and counting those
    would report the row as done. When a row's ONLY group is a reference one, the
    flat schema is read instead -- the same fallback ``tables.py`` makes when a
    group has no per-row entry -- so a freshly inherited row reads as empty,
    which is what it is.
    """
    vals = []
    sims = row.get("sims")
    own = {}
    if isinstance(sims, dict):
        own = dict((k, v) for k, v in sims.items() if k not in ref_keys)
    if own:
        for sv in own.values():
            if isinstance(sv, dict):
                vals += _as_list(sv.get("mtm"))
                vals.append(sv.get("ntwc"))
    else:
        vals += _as_list(row.get("sim_mtm"))
        vals.append(row.get("sim_ntwc"))
    return vals


def _row_has_spec(row):
    if row.get("spec") not in (None, ""):
        return True
    for v in _as_list(row.get("spec_mtm")):
        if v not in (None, ""):
            return True
    return row.get("spec_ntwc") not in (None, "")


def _is_empty(v):
    return v is None or v == ""


# ---------------------------------------------------------------------------
# Block-level linters. ``add(code, message_id, **fields)`` is bound per block by
# lint_project, so a rule never has to know about locations or node ids.
# ---------------------------------------------------------------------------


def _lint_image_file(fname, add, project_dir=None):
    """An image file must be project-relative under images/ (never absolute or
    ..-escaping). A BLANK file is the legitimate "cleared for the next stage"
    placeholder: a note, never a warning -- a freshly inherited report is full of
    them by design."""
    if not fname:
        add("image_placeholder", "image_placeholder.blank")
        return
    f = str(fname).replace("\\", "/")
    if f.startswith("/") or (len(f) >= 2 and f[1] == ":"):
        add("image_path", "image_path.absolute", file=fname)
    elif ".." in f.split("/"):
        add("image_path", "image_path.escapes", file=fname)
    elif not f.startswith("images/"):
        add("image_path", "image_path.outside", file=fname)
    elif project_dir:
        # Only when a folder is supplied: the standing Check tab can then report a
        # missing picture without waiting for an export. The export path does NOT
        # pass one, because the renderer already emits missing_image itself.
        if not os.path.isfile(os.path.join(project_dir, *f.split("/"))):
            add("missing_image", "missing_image.not_found", file=fname)


def _ref_targets(outline):
    """The block ids a cross-reference can resolve to.

    Mirrors ``engine._collect_ref_targets``: an image / image grid is a target
    whether or not it carries a caption (the render bookmarks it either way), a
    table only once it has one, a block with no id never is, and a section with a
    ``fixed_body`` contributes none of its own blocks. A reference to anything
    else is what the renderer calls dangling."""
    ids = set()

    def walk(node):
        if not isinstance(node, dict):
            return
        if not node.get("fixed_body"):
            for block in node.get("blocks") or []:
                if not isinstance(block, dict):
                    continue
                bid = block.get("id")
                if not bid:
                    continue
                btype = block.get("type")
                if btype in ("image", "imagegrid"):
                    ids.add(bid)
                elif btype in ("table", "datatable") and block.get("caption"):
                    ids.add(bid)
        for child in node.get("children") or []:
            walk(child)

    for node in outline or []:
        walk(node)
    return ids


def _lint_para_refs(block, add, targets):
    """A run carrying ``ref`` must point at a live target -- see _ref_targets."""
    if targets is None:
        return
    for run in block.get("runs") or []:
        if not isinstance(run, dict):
            continue
        ref = run.get("ref")
        if ref and ref not in targets:
            add("dangling_ref", "dangling_ref.missing")


def _lint_free_table(block, rows, add):
    if not isinstance(rows, list):
        add("table_no_rows", "table_no_rows.not_list")
        return
    nrows = len(rows)
    ncols = max((len(r) for r in rows if isinstance(r, (list, tuple))), default=0)
    for m in (block.get("merges") or []):
        if not isinstance(m, dict):
            continue
        r, c = m.get("r", 0), m.get("c", 0)
        rs, cs = m.get("rs", 1), m.get("cs", 1)
        if r < 0 or c < 0 or r + rs > nrows or c + cs > ncols:
            add("free_table_bounds", "free_table_bounds.merge",
                r=r, c=c, rs=rs, cs=cs, nrows=nrows, ncols=ncols)
    rf = block.get("row_fills")
    if isinstance(rf, dict):
        for k in rf:
            try:
                ki = int(k)
            except (TypeError, ValueError):
                continue
            if ki < 0 or ki >= nrows:
                add("free_table_bounds", "free_table_bounds.fill",
                    idx=k, nrows=nrows)


def _lint_datatable(data, add, default_axes, setting_kinds):
    rows = data.get("rows")
    if not isinstance(rows, list):
        add("datatable_no_data", "datatable_no_data.rows")
        return
    sims = [s for s in (data.get("sims") or []) if isinstance(s, dict)]
    sim_keys = {s.get("key") for s in sims if s.get("key")}
    ref_keys = _reference_group_keys(data)

    has_setting = False
    any_sim_span = False
    for ri, row in enumerate(rows):
        if not isinstance(row, dict):
            add("row_missing_key", "row_missing_key.not_object", i=ri)
            continue
        missing = [k for k in _REQUIRED_ROW_KEYS if k not in row]
        if missing:
            add("row_missing_key", "row_missing_key.missing",
                i=ri, item=row.get("item", ""), keys=", ".join(missing))
        kind = row.get("kind")
        is_setting = kind in setting_kinds
        if is_setting:
            has_setting = True
        else:
            # A result row with a spec but no limit direction can never be marked
            # over spec -- the one verdict this tool has. A warning, not an error.
            if _is_empty(row.get("limit")) and _row_has_spec(row):
                add("limit_no_flag", "limit_no_flag.blank", item=row.get("item", ""))
            # all-empty sim values of this stage's OWN groups -> an unfilled
            # placeholder row. A reference column beside it is somebody else's
            # work and never counts as filled in.
            if all(_is_empty(v) for v in _row_sim_values(row, ref_keys)):
                add("empty_sim_result", "empty_sim_result.blank",
                    item=row.get("item", ""))
            # note: empty unit string (legitimate, e.g. a ratio).
            if "unit" in row and row.get("unit", "") == "":
                add("unit_empty", "unit_empty.blank", item=row.get("item", ""))
        rsims = row.get("sims")
        if isinstance(rsims, dict) and sim_keys:
            for k in rsims:
                if k not in sim_keys:
                    add("unknown_sim_key", "unknown_sim_key.undeclared", i=ri, key=k)
        if row.get("sim_span"):
            any_sim_span = True

    # The recurring real-world mistake: a compliance table with NO setting rows.
    if rows and not has_setting:
        add("no_setting_rows", "no_setting_rows.none")
    # sim_span merges each simulation group's own axis columns INDEPENDENTLY
    # (tables.py merges cc[0]..cc[-1] per group), so several groups are fine and a
    # group of two axes merges cleanly. The only unmergeable case -- and the exact
    # condition the renderer warns about -- is a group with fewer than 2 axis
    # columns. Mirrored here so the mistake is caught before the export.
    if any_sim_span:
        if sims:
            thin = [s.get("key") or "(unnamed)" for s in sims
                    if _axis_count(s, default_axes) < 2]
        else:
            # implicit single group taking the template's axis labels
            thin = ["(default)"] if len(default_axes) < 2 else []
        if thin:
            add("sim_span_unmergeable", "sim_span_unmergeable.thin",
                keys=", ".join(thin))


def _lint_block(block, add, default_axes, setting_kinds, project_dir=None, targets=None):
    bt = block.get("type")
    if bt == "para":
        _lint_para_refs(block, add, targets)
    elif bt == "image":
        _lint_image_file(block.get("file"), add, project_dir)
        if not (block.get("caption") or "").strip():
            add("no_caption", "no_caption.image")
    elif bt == "imagegrid":
        for it in (block.get("items") or []):
            if isinstance(it, dict):
                _lint_image_file(it.get("file"), add, project_dir)
        if not (block.get("caption") or "").strip():
            add("no_caption", "no_caption.imagegrid")
    elif bt == "table":
        rows = block.get("rows")
        if rows is None:
            add("table_no_rows", "table_no_rows.missing")
        else:
            _lint_free_table(block, rows, add)
    elif bt == "datatable":
        data = block.get("data")
        if not isinstance(data, dict):
            add("datatable_no_data", "datatable_no_data.block")
        else:
            _lint_datatable(data, add, default_axes, setting_kinds)


# ---------------------------------------------------------------------------
# Public: lint a whole project.
# ---------------------------------------------------------------------------


def lint_project(project, cfg=None, project_dir=None):
    """Lint ``project`` (a parsed project.json dict) and return a ``LintReport``.

    ``cfg`` (optional) is the template config; its ``compliance.axis_labels`` /
    ``compliance.setting_kinds`` calibrate the axis-count and setting-row rules.
    ``project_dir`` (optional) is the report folder: pass it to also report
    pictures whose file is missing from disk, which lets the Check tab stand on
    its own without an export. The export path leaves it out, because the
    renderer reports missing pictures itself.

    The report is a dict of the Check tab's ``errors`` / ``warnings`` / ``notes``
    groups AND iterates as the flat findings list -- see ``LintReport``.
    """
    findings = []
    cfg = cfg if isinstance(cfg, dict) else {}
    comp = cfg.get("compliance", {}) if isinstance(cfg.get("compliance"), dict) else {}
    default_axes = comp.get("axis_labels", _DEFAULT_AXES)
    setting_kinds = set(comp.get("setting_kinds", _DEFAULT_SETTING_KINDS))
    # Whole-document, so a reference that points FORWARD (or into another
    # section) is not reported as broken -- collected once, before the walk.
    targets = _ref_targets(project.get("outline") or [])

    def emit(code, mid, location, loc, node_id, block_id, kw):
        text = message(mid, **kw)
        findings.append({
            "type": code, "level": classify(code),
            "detail": text, "location": location,
            "code": code, "message": text, "loc": loc,
            "nodeId": node_id, "blockId": block_id,
        })

    # Block ids and section (node) ids are each other's own namespace, shared
    # across the WHOLE project (not reset per section): the engine numbers
    # captions and resolves cross-references off a single project-wide
    # id -> target map (_collect_ref_targets), so two blocks (or two sections)
    # that happen to share an id collide there too -- the second one silently
    # overwrites the first, and a caption number / REF field can point at the
    # wrong one. First-seen location wins; every later occurrence is flagged.
    seen_block_ids = {}
    seen_node_ids = {}

    def walk(node, path):
        if not isinstance(node, dict):
            return
        title = node.get("title", "")
        node_id = node.get("id")
        loc0 = 'section "%s"' % title
        blocks = node.get("blocks") or []
        children = node.get("children") or []
        has_fixed = bool(node.get("fixed_body"))
        if not blocks and not children and not has_fixed:
            emit("empty_section", "empty_section.none", loc0, path, node_id, None, {})
        if node_id:
            if node_id in seen_node_ids:
                emit("duplicate_id", "duplicate_id.section", loc0, path, node_id, None,
                     {"id": node_id, "other": seen_node_ids[node_id]})
            else:
                seen_node_ids[node_id] = loc0
        for idx, block in enumerate(blocks):
            if not isinstance(block, dict):
                continue
            location = '%s / block %d (%s)' % (loc0, idx, block.get("type", "?"))
            block_id = block.get("id")
            if block_id:
                if block_id in seen_block_ids:
                    emit("duplicate_id", "duplicate_id.block", location, path,
                         node_id, block_id,
                         {"id": block_id, "other": seen_block_ids[block_id]})
                else:
                    seen_block_ids[block_id] = location

            def add(code, mid, _location=location, _bid=block_id, **kw):
                emit(code, mid, _location, path, node_id, _bid, kw)

            _lint_block(block, add, default_axes, setting_kinds, project_dir, targets)
        for ci, c in enumerate(children):
            walk(c, "%s.%d" % (path, ci + 1))

    for ni, node in enumerate(project.get("outline") or []):
        walk(node, "%d" % (ni + 1))
    return LintReport(findings)


def summarize(findings):
    """{'error': n, 'warn': n, 'info': n} for a findings list (or a LintReport)."""
    out = {"error": 0, "warn": 0, "info": 0}
    for f in findings or []:
        lv = f.get("level", "warn")
        out[lv] = out.get(lv, 0) + 1
    return out


# ---------------------------------------------------------------------------
# CLI.
# ---------------------------------------------------------------------------


def main(argv=None):
    ap = argparse.ArgumentParser(description="Pre-render content lint for project.json")
    ap.add_argument("project_dir", help="folder containing project.json")
    ap.add_argument("--config", help="template config json (for setting_kinds/axes)")
    ap.add_argument("--json", action="store_true", help="machine-readable JSON output")
    ap.add_argument("--grouped", action="store_true",
                    help="JSON grouped into errors/warnings/notes (the Check tab shape)")
    ap.add_argument("--info", action="store_true",
                    help="include info-level findings in text output")
    ap.add_argument("--files", action="store_true",
                    help="also report pictures missing from the report folder")
    a = ap.parse_args(argv)

    proj_path = os.path.join(a.project_dir, "project.json")
    if not os.path.isfile(proj_path):
        sys.stderr.write("error: %s not found\n" % proj_path)
        return 2
    try:
        project = _load_json_file(proj_path)
    except Exception as exc:
        sys.stderr.write("error: could not parse %s: %s\n" % (proj_path, exc))
        return 2
    cfg = {}
    if a.config:
        try:
            cfg = _load_json_file(a.config)
        except Exception as exc:
            sys.stderr.write("error: could not parse %s: %s\n" % (a.config, exc))
            return 2

    report = lint_project(project, cfg, a.project_dir if a.files else None)
    findings = sorted(report.flat, key=lambda f: LEVEL_ORDER.get(f.get("level"), 1))

    if a.grouped:
        print(json.dumps(dict(report), ensure_ascii=False, indent=2))
        return 1 if report.has_errors else 0
    if a.json:
        print(json.dumps(findings, ensure_ascii=False, indent=2))
        return 1 if report.has_errors else 0

    counts = summarize(findings)
    for f in findings:
        if f["level"] == "info" and not a.info:
            continue
        print("[%-5s] %s: %s @ %s"
              % (f["level"].upper(), f["type"], f["detail"], f["location"]))
    print("\n%d error, %d warn, %d info%s"
          % (counts["error"], counts["warn"], counts["info"],
             "" if a.info else "  (info hidden; --info to show)"))
    return 1 if counts["error"] else 0


if __name__ == "__main__":
    sys.exit(main())
