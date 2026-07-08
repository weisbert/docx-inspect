# -*- coding: utf-8 -*-
"""content_lint.py -- pre-render content checks for a project.json.

Pure functions with NO python-docx dependency, so a project can be linted before
(or entirely without) an export -- e.g. by a fill script or a pre-push step.

Findings share the render manifest's warning shape and add a ``level``:
    {"type": str, "level": "error"|"warn"|"info", "detail": str, "location": str}

  * error -- would crash the renderer or silently drop a whole block / table, so
             the visible output is wrong in a way the user cannot see (must be
             zero before exporting / shipping a bundle).
  * warn  -- renders, but the content is probably wrong or incomplete: a
             compliance table with no condition rows, a result row that can
             never red-flag, a figure with no caption, ...
  * info  -- legitimate-but-worth-noting (e.g. a result row with an empty unit,
             which the demo proves is valid). Default off in the GUI.

CLI:
    python builder/content_lint.py <project_dir> [--config <template.json>]
    python builder/content_lint.py <project_dir> --json      # machine-readable

Exit status is 1 when any ``error``-level finding exists (0 otherwise), so it can
gate a fill / bundle workflow.
"""
import argparse
import json
import os
import sys

# Canonical level for every warning type -- engine render-manifest types AND the
# content_lint types below. Anything not listed defaults to "warn" (classify).
LEVELS = {
    # engine render-manifest types (existing)
    "block_error": "error",
    "missing_image": "warn",
    "missing_logo": "warn",
    "no_caption": "warn",
    "row_clip_risk": "warn",
    "dangling_ref": "warn",
    "table_warning": "warn",
    # tables.py sim_span guards (new, WS3)
    "sim_span_unmergeable": "error",
    "sim_span_partial": "warn",
    # content_lint structural types (new, WS3)
    "datatable_no_data": "error",
    "table_no_rows": "error",
    "row_missing_key": "error",
    "sim_span_axes": "error",
    "image_path": "error",
    "free_table_bounds": "error",
    "no_setting_rows": "warn",
    "limit_no_flag": "warn",
    "empty_sim_result": "warn",
    "sim_span_multi": "warn",
    "empty_section": "warn",
    "unknown_sim_key": "warn",
    "unit_empty": "info",
}

LEVEL_ORDER = {"error": 0, "warn": 1, "info": 2}

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


def _row_sim_values(row):
    """Flat list of a row's simulated axis values (multi-sim or flat schema)."""
    vals = []
    sims = row.get("sims")
    if isinstance(sims, dict) and sims:
        for sv in sims.values():
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
# Block-level linters.
# ---------------------------------------------------------------------------


def _lint_image_file(fname, loc, add):
    """A5: an image file must be project-relative under images/ (never absolute
    or ..-escaping). An empty file is a legitimate not-yet-pasted placeholder."""
    if not fname:
        return
    f = str(fname).replace("\\", "/")
    if f.startswith("/") or (len(f) >= 2 and f[1] == ":"):
        add("image_path", 'image file is an absolute path: "%s"' % fname, loc)
    elif ".." in f.split("/"):
        add("image_path", 'image file escapes with "..": "%s"' % fname, loc)
    elif not f.startswith("images/"):
        add("image_path", 'image file is not under images/: "%s"' % fname, loc)


def _lint_free_table(block, rows, loc, add):
    if not isinstance(rows, list):
        add("table_no_rows", "table 'rows' is not a list", loc)
        return
    nrows = len(rows)
    ncols = max((len(r) for r in rows if isinstance(r, (list, tuple))), default=0)
    for m in (block.get("merges") or []):
        if not isinstance(m, dict):
            continue
        r, c = m.get("r", 0), m.get("c", 0)
        rs, cs = m.get("rs", 1), m.get("cs", 1)
        if r < 0 or c < 0 or r + rs > nrows or c + cs > ncols:
            add("free_table_bounds",
                "merge {r:%s,c:%s,rs:%s,cs:%s} is out of the %dx%d grid"
                % (r, c, rs, cs, nrows, ncols), loc)
    rf = block.get("row_fills")
    if isinstance(rf, dict):
        for k in rf:
            try:
                ki = int(k)
            except (TypeError, ValueError):
                continue
            if ki < 0 or ki >= nrows:
                add("free_table_bounds",
                    "row_fills index %s is outside the %d rows" % (k, nrows), loc)


def _lint_datatable(data, loc, add, default_axes, setting_kinds):
    rows = data.get("rows")
    if not isinstance(rows, list):
        add("datatable_no_data", "datatable data has no 'rows' list", loc)
        return
    sims = data.get("sims") or []
    sim_keys = {s.get("key") for s in sims if isinstance(s, dict) and s.get("key")}
    first_sim_axes = None
    for s in sims:
        if isinstance(s, dict):
            first_sim_axes = _axis_count(s, default_axes)
            break
    if first_sim_axes is None:
        first_sim_axes = len(default_axes)   # implicit single sim group
    n_sim_groups = max(1, len(sims))

    has_setting = False
    any_sim_span = False
    for ri, row in enumerate(rows):
        if not isinstance(row, dict):
            add("row_missing_key", "row %d is not an object" % ri, loc)
            continue
        missing = [k for k in _REQUIRED_ROW_KEYS if k not in row]
        if missing:
            add("row_missing_key",
                "row %d ('%s') is missing key(s): %s"
                % (ri, row.get("item", ""), ", ".join(missing)), loc)
        kind = row.get("kind")
        is_setting = kind in setting_kinds
        if is_setting:
            has_setting = True
        if not is_setting:
            # B1: a result row with a spec but no limit direction never red-flags.
            if _is_empty(row.get("limit")) and _row_has_spec(row):
                add("limit_no_flag",
                    "result row '%s' has a spec but limit is empty -> it can never "
                    "red-flag" % row.get("item", ""), loc)
            # all-empty sim values -> an unfilled placeholder row.
            if all(_is_empty(v) for v in _row_sim_values(row)):
                add("empty_sim_result",
                    "result row '%s' has all-empty sim values (unfilled?)"
                    % row.get("item", ""), loc)
            # info: empty unit string (legitimate, e.g. a ratio -- default off).
            if "unit" in row and row.get("unit", "") == "":
                add("unit_empty",
                    "result row '%s' has an empty unit" % row.get("item", ""), loc)
        rsims = row.get("sims")
        if isinstance(rsims, dict) and sim_keys:
            for k in rsims:
                if k not in sim_keys:
                    add("unknown_sim_key",
                        "row %d references undeclared sim key '%s'" % (ri, k), loc)
        if row.get("sim_span"):
            any_sim_span = True

    # The recurring pain point: a compliance table with NO condition/setting row.
    if rows and not has_setting:
        add("no_setting_rows",
            "compliance table has no condition/setting rows -- add them (use a "
            "table preset so the condition rows are never forgotten)", loc)
    # A sim_span value now merges across ALL sim groups' axis columns (the whole
    # sim area), so multiple sim groups are fine. The only genuinely unmergeable
    # case is a sim area with fewer than 2 axis columns total.
    if any_sim_span:
        total_sim_axes = sum(_axis_count(s, default_axes)
                             for s in sims if isinstance(s, dict)) or first_sim_axes
        if total_sim_axes < 2:
            add("sim_span_unmergeable",
                "sim_span row(s) but the sim area has %d axis column(s) (<2) -- "
                "nothing to merge" % total_sim_axes, loc)


def _lint_block(block, loc, add, default_axes, setting_kinds):
    bt = block.get("type")
    if bt == "image":
        _lint_image_file(block.get("file"), loc, add)
        if not (block.get("caption") or "").strip():
            add("no_caption", "image has no caption", loc)
    elif bt == "imagegrid":
        for it in (block.get("items") or []):
            if isinstance(it, dict):
                _lint_image_file(it.get("file"), loc, add)
        if not (block.get("caption") or "").strip():
            add("no_caption", "image grid has no caption", loc)
    elif bt == "table":
        rows = block.get("rows")
        if rows is None:
            add("table_no_rows", "table block has no 'rows' key", loc)
        else:
            _lint_free_table(block, rows, loc, add)
    elif bt == "datatable":
        data = block.get("data")
        if not isinstance(data, dict):
            add("datatable_no_data", "datatable block has no 'data' dict", loc)
        else:
            _lint_datatable(data, loc, add, default_axes, setting_kinds)


# ---------------------------------------------------------------------------
# Public: lint a whole project.
# ---------------------------------------------------------------------------


def lint_project(project, cfg=None):
    """Return a list of findings for ``project`` (a parsed project.json dict).

    ``cfg`` (optional) is the template config; its ``compliance.axis_labels`` /
    ``compliance.setting_kinds`` calibrate the axis-count and condition-row rules.
    """
    findings = []
    cfg = cfg if isinstance(cfg, dict) else {}
    comp = cfg.get("compliance", {}) if isinstance(cfg.get("compliance"), dict) else {}
    default_axes = comp.get("axis_labels", _DEFAULT_AXES)
    setting_kinds = set(comp.get("setting_kinds", _DEFAULT_SETTING_KINDS))

    def add(t, detail, location):
        findings.append({"type": t, "level": classify(t),
                         "detail": detail, "location": location})

    def walk(node):
        if not isinstance(node, dict):
            return
        title = node.get("title", "")
        loc0 = 'section "%s"' % title
        blocks = node.get("blocks") or []
        children = node.get("children") or []
        has_fixed = bool(node.get("fixed_body"))
        if not blocks and not children and not has_fixed:
            add("empty_section",
                "section has no blocks, no fixed body, and no sub-sections", loc0)
        for idx, block in enumerate(blocks):
            if not isinstance(block, dict):
                continue
            loc = '%s / block %d (%s)' % (loc0, idx, block.get("type", "?"))
            _lint_block(block, loc, add, default_axes, setting_kinds)
        for c in children:
            walk(c)

    for node in (project.get("outline") or []):
        walk(node)
    return findings


def summarize(findings):
    """{'error': n, 'warn': n, 'info': n} for a findings list."""
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
    ap.add_argument("--info", action="store_true", help="include info-level findings in text output")
    a = ap.parse_args(argv)

    proj_path = os.path.join(a.project_dir, "project.json")
    if not os.path.isfile(proj_path):
        sys.stderr.write("error: %s not found\n" % proj_path)
        return 2
    with open(proj_path, encoding="utf-8") as fh:
        project = json.load(fh)
    cfg = {}
    if a.config:
        with open(a.config, encoding="utf-8") as fh:
            cfg = json.load(fh)

    findings = lint_project(project, cfg)
    findings.sort(key=lambda f: LEVEL_ORDER.get(f.get("level"), 1))

    if a.json:
        print(json.dumps(findings, ensure_ascii=False, indent=2))
        return 1 if any(f["level"] == "error" for f in findings) else 0

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
