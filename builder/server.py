#!/usr/bin/env python3
"""Local HTTP server for the structured document builder.

Standard-library only (http.server / json / urllib / base64 / sqlite3).
Binds to 127.0.0.1 exclusively. Serves the single-page app and the JSON API
defined in CONTRACT.md. All domain-specific content (chapter skeleton, cover
fields, fixed body texts, style numbers, validation rules, UI strings, logo)
lives in an external template config file loaded at runtime; this module stays
neutral and domain-agnostic.

Run:
    python server.py --port 8765 --root <reports_root> --config <template.json>
"""

import argparse
import base64
import io
import json
import os
import re
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

HERE = os.path.dirname(os.path.abspath(__file__))

# ---------------------------------------------------------------------------
# Server configuration (populated in main()).
# ---------------------------------------------------------------------------


class Config:
    reports_root = None          # absolute path; project dirs must stay under it
    template_config_path = None  # path to the active template config JSON
    bind = "127.0.0.1"
    port = 8765
    _template_cache = None       # (path, mtime) -> parsed dict


CFG = Config()


# ---------------------------------------------------------------------------
# Helpers: template config loading.
# ---------------------------------------------------------------------------


def load_template_config(path=None):
    """Load and cache the template config JSON. Returns a dict or raises."""
    p = path or CFG.template_config_path
    if not p:
        raise FileNotFoundError("no template config path configured")
    p = os.path.abspath(p)
    if not os.path.isfile(p):
        raise FileNotFoundError("template config not found: %s" % p)
    mtime = os.path.getmtime(p)
    cache = CFG._template_cache
    if cache and cache[0] == p and cache[1] == mtime:
        return cache[2]
    with open(p, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    CFG._template_cache = (p, mtime, data)
    return data


def config_slice(template_query=None):
    """Frontend-facing slice of the template config (API #3).

    Returns only what the GUI needs; never leaks engine-only style numbers.
    """
    tc = load_template_config()
    return {
        "template": tc.get("id"),
        "skeleton": tc.get("skeleton", []),
        "ui_strings": tc.get("ui_strings", {}),
        "cover": tc.get("cover", {}),
        "compliance": _compliance_defaults(tc.get("compliance", {})),
    }


def _compliance_defaults(comp):
    """Expose only the compliance defaults the GUI needs for live preview."""
    return {
        "axis_labels": comp.get("axis_labels", ["MIN", "TYP", "MAX", "NTWC"]),
        "default_limit": comp.get("default_limit", {}),
        "flag_color": comp.get("flag_color", "FF0000"),
        "setting_kinds": comp.get(
            "setting_kinds", ["common_setting", "module_setting", "tb"]
        ),
    }


# ---------------------------------------------------------------------------
# Helpers: path safety.
# ---------------------------------------------------------------------------


def resolve_project_dir(dir_arg, create=False):
    """Resolve a project dir from the `dir` query param.

    `dir` may be absolute or relative to reports_root. The resolved path must
    stay under reports_root (if one is configured). Raises ValueError on any
    traversal outside the allowed root.
    """
    if not dir_arg:
        raise ValueError("missing 'dir' parameter")
    root = CFG.reports_root
    if os.path.isabs(dir_arg):
        target = os.path.abspath(dir_arg)
    elif root:
        target = os.path.abspath(os.path.join(root, dir_arg))
    else:
        target = os.path.abspath(dir_arg)

    if root:
        root_abs = os.path.abspath(root)
        # containment check that is robust to case/sep on Windows
        try:
            common = os.path.commonpath([root_abs, target])
        except ValueError:
            # different drives
            raise ValueError("path escapes reports_root")
        if os.path.normcase(common) != os.path.normcase(root_abs):
            raise ValueError("path escapes reports_root")

    if create:
        os.makedirs(target, exist_ok=True)
        os.makedirs(os.path.join(target, "images"), exist_ok=True)
    return target


def atomic_write(path, data_bytes):
    """Write bytes to path atomically (temp file + os.replace)."""
    d = os.path.dirname(path)
    os.makedirs(d, exist_ok=True)
    tmp = path + ".tmp.%d" % os.getpid()
    with open(tmp, "wb") as fh:
        fh.write(data_bytes)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


# ---------------------------------------------------------------------------
# Helpers: image saving.
# ---------------------------------------------------------------------------

_NAME_RE = re.compile(r"[^A-Za-z0-9_-]+")


def _sanitize_name(name):
    name = _NAME_RE.sub("_", name).strip("_")
    return name[:64] if name else ""


def next_image_path(project_dir, section, name=None):
    """Compute images/<section>_<seq>.png (or images/<section>-<seq>_<name>.png).

    <seq> is the next free sequence for that section. Returns (rel, abs).
    """
    section = _sanitize_name(str(section)) or "0"
    name = _sanitize_name(name) if name else ""
    images_dir = os.path.join(project_dir, "images")
    os.makedirs(images_dir, exist_ok=True)

    # find existing seqs for this section in either naming form
    seqs = []
    pat = re.compile(
        r"^%s[-_](\d+)(?:_.*)?\.png$" % re.escape(section), re.IGNORECASE
    )
    for fn in os.listdir(images_dir):
        m = pat.match(fn)
        if m:
            try:
                seqs.append(int(m.group(1)))
            except ValueError:
                pass
    seq = (max(seqs) + 1) if seqs else 1

    if name:
        rel = "images/%s-%d_%s.png" % (section, seq, name)
    else:
        rel = "images/%s_%d.png" % (section, seq)
    return rel, os.path.join(project_dir, rel)


# ---------------------------------------------------------------------------
# Helpers: xlsx parsing (free-table grid + compliance data).
# ---------------------------------------------------------------------------


def parse_xlsx_grid(xlsx_bytes):
    """Parse an xlsx into a free-table grid: {rows:[[..]], merges:[..]}.

    Reads the first worksheet's used range. Cell values are stringified;
    None -> "". Merged ranges are reported as {r,c,rs,cs} (0-based, top-left).
    """
    import openpyxl

    wb = openpyxl.load_workbook(io.BytesIO(xlsx_bytes), data_only=True)
    ws = wb.active
    max_r = ws.max_row or 0
    max_c = ws.max_column or 0

    rows = []
    for r in range(1, max_r + 1):
        row = []
        for c in range(1, max_c + 1):
            v = ws.cell(row=r, column=c).value
            row.append("" if v is None else str(v))
        rows.append(row)

    merges = []
    for rng in ws.merged_cells.ranges:
        merges.append(
            {
                "r": rng.min_row - 1,
                "c": rng.min_col - 1,
                "rs": rng.max_row - rng.min_row + 1,
                "cs": rng.max_col - rng.min_col + 1,
            }
        )
    return {"rows": rows, "merges": merges}


def _to_num_or_str(v):
    """Coerce a cell value: numbers stay numeric, blanks -> None, else str."""
    if v is None or v == "":
        return None
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return v
    s = str(v).strip()
    if s == "":
        return None
    try:
        f = float(s)
        return int(f) if f.is_integer() else f
    except ValueError:
        return s


def parse_xlsx_compliance(xlsx_bytes):
    """Best-effort parse of an xlsx into the compliance DATA model.

    The layout mirrors the renderer's output: a yellow 3-row header band, then
    Category / Item / [Spec] / <group axis columns> / Unit. This is a seed for
    the GUI editor, not a strict importer; the GUI lets the user fix anything.

    Returns {data: {spec_name, sims, rows}}.
    """
    import openpyxl

    wb = openpyxl.load_workbook(io.BytesIO(xlsx_bytes), data_only=True)
    ws = wb.active

    grid = []
    for row in ws.iter_rows(values_only=True):
        grid.append(list(row))
    if not grid:
        return {"data": {"spec_name": "", "sims": [], "rows": []}}

    ncols = max(len(r) for r in grid)
    for r in grid:
        r.extend([None] * (ncols - len(r)))

    # Locate header band: the first row containing an axis label cell.
    AX = {"MIN", "TYP", "MAX", "NTWC", "NT WC", "NT-WC"}
    header_axis_row = None
    for ri, r in enumerate(grid[:10]):
        if any(isinstance(c, str) and c.strip().upper() in AX for c in r):
            header_axis_row = ri
            break
    if header_axis_row is None:
        # Fall back: treat as plain grid, no compliance structure recognized.
        return {"data": {"spec_name": "", "sims": [], "rows": []}}

    # Map header columns.
    axis_cols = []  # list of (col_index, axis_label)
    cat_col = item_col = spec_col = unit_col = None
    band = grid[header_axis_row]
    for ci, c in enumerate(band):
        if not isinstance(c, str):
            continue
        cu = c.strip().upper()
        if cu in AX:
            axis_cols.append((ci, "NTWC" if cu.replace(" ", "").replace("-", "") == "NTWC" else cu))

    # Category/Item/Unit/Spec live in the merged label columns above the axes:
    # scan rows 0..header_axis_row for the literal labels.
    for ri in range(0, header_axis_row + 1):
        for ci, c in enumerate(grid[ri]):
            if not isinstance(c, str):
                continue
            cl = c.strip().lower()
            if cl == "category" and cat_col is None:
                cat_col = ci
            elif cl == "item" and item_col is None:
                item_col = ci
            elif cl == "spec" and spec_col is None:
                spec_col = ci
            elif cl == "unit" and unit_col is None:
                unit_col = ci

    # Group axis columns into runs of 3-4 consecutive axis columns.
    spec_name = ""
    sims = []
    spec_axis_cols = None
    groups = []  # (title, stage, [cols])
    if axis_cols:
        # Split into groups. A new group starts when columns are non-adjacent
        # (a spacer between groups) OR when an axis label repeats within the
        # current run (e.g. ...MAX, NTWC, MIN... => the second MIN begins a new
        # group even with no spacer column).
        runs = []
        cur = [axis_cols[0]]
        seen = {axis_cols[0][1]}
        for prev, nxt in zip(axis_cols, axis_cols[1:]):
            adjacent = (nxt[0] - prev[0] == 1)
            repeats = nxt[1] in seen
            if adjacent and not repeats:
                cur.append(nxt)
                seen.add(nxt[1])
            else:
                runs.append(cur)
                cur = [nxt]
                seen = {nxt[1]}
        runs.append(cur)

        # Group titles sit in the row above header_axis_row (the merged band top).
        title_row = grid[header_axis_row - 2] if header_axis_row >= 2 else grid[0]
        stage_row = grid[header_axis_row - 1] if header_axis_row >= 1 else grid[0]
        for gi, run in enumerate(runs):
            c0 = run[0][0]
            title = _first_str(title_row, run) or ""
            stage = _first_str(stage_row, run)
            cols = [rc[0] for rc in run]
            if gi == 0 and "spec" in (title or "").lower():
                spec_name = title
                spec_axis_cols = cols
            elif gi == 0 and stage is None and "spec" in (title or "").lower():
                spec_name = title
                spec_axis_cols = cols
            else:
                groups.append((title, stage, cols))
        # If first run wasn't recognized as spec by name, assume it is spec.
        if spec_axis_cols is None and runs:
            spec_axis_cols = [rc[0] for rc in runs[0]]
            spec_name = _first_str(title_row, runs[0]) or spec_name
            groups = []
            for gi, run in enumerate(runs[1:]):
                title = _first_str(title_row, run) or "Sim%d" % (gi + 1)
                stage = _first_str(stage_row, run)
                groups.append((title, stage, [rc[0] for rc in run]))

    for gi, (title, stage, cols) in enumerate(groups):
        sims.append(
            {
                "key": _sanitize_name(title).lower() or ("sim%d" % (gi + 1)),
                "title": title or ("Sim%d" % (gi + 1)),
                "stage": stage,
            }
        )

    # Data rows start after the header band.
    rows = []
    last_cat = ""
    for ri in range(header_axis_row + 1, len(grid)):
        r = grid[ri]
        item = _to_num_or_str(r[item_col]) if item_col is not None else None
        cat = _to_num_or_str(r[cat_col]) if cat_col is not None else None
        if cat:
            last_cat = str(cat)
        if item is None or item == "":
            continue  # skip separator / blank rows
        unit = _to_num_or_str(r[unit_col]) if unit_col is not None else None
        spec = _to_num_or_str(r[spec_col]) if spec_col is not None else None

        spec_mtm = [None, None, None]
        spec_ntwc = None
        if spec_axis_cols:
            for ai, ci in enumerate(spec_axis_cols[:4]):
                val = _to_num_or_str(r[ci]) if ci < len(r) else None
                if ai < 3:
                    spec_mtm[ai] = val
                else:
                    spec_ntwc = val

        sim_mtm = [None, None, None]
        sim_ntwc = None
        if groups:
            first_cols = groups[0][2]
            for ai, ci in enumerate(first_cols[:4]):
                val = _to_num_or_str(r[ci]) if ci < len(r) else None
                if ai < 3:
                    sim_mtm[ai] = val
                else:
                    sim_ntwc = val

        rows.append(
            {
                "cat": last_cat,
                "item": str(item),
                "unit": "" if unit is None else str(unit),
                "kind": "result",
                "spec": spec,
                "spec_mtm": spec_mtm,
                "sim_mtm": sim_mtm,
                "spec_ntwc": spec_ntwc,
                "sim_ntwc": sim_ntwc,
                "limit": None,
                "sim_span": False,
            }
        )

    return {"data": {"spec_name": spec_name, "sims": sims, "rows": rows}}


def _first_str(row, run):
    """Return the first non-empty string within the given run's columns."""
    for ci, _ in run:
        if ci < len(row) and isinstance(row[ci], str) and row[ci].strip():
            return row[ci].strip()
    return None


# ---------------------------------------------------------------------------
# Helpers: compliance validation (reuses engine flag logic; never duplicated).
# ---------------------------------------------------------------------------


def _import_flag_positions():
    """Lazily import the engine's flag_positions. Raises on unavailability."""
    if HERE not in sys.path:
        sys.path.insert(0, HERE)
    try:
        from tables import flag_positions  # type: ignore
        return flag_positions
    except Exception:
        # engine module may expose it directly
        from engine import flag_positions  # type: ignore
        return flag_positions


def validate_compliance(data):
    """Run engine flag logic over compliance rows.

    Returns {"flags": {"<rowIndex>": [axisIndex,...]}, "color": flag_color}.
    Axis indices are positions within the sim group's [MIN, TYP, MAX] axes.
    """
    flag_positions = _import_flag_positions()
    rows = (data or {}).get("rows", [])
    flags = {}
    for i, row in enumerate(rows):
        positions = flag_positions(row)
        if positions:
            flags[str(i)] = sorted(int(p) for p in positions)
    try:
        tc = load_template_config()
        color = tc.get("compliance", {}).get("flag_color", "FF0000")
    except Exception:
        color = "FF0000"
    return {"flags": flags, "color": color}


# ---------------------------------------------------------------------------
# Helpers: export (delegates to the engine).
# ---------------------------------------------------------------------------


def _import_engine():
    if HERE not in sys.path:
        sys.path.insert(0, HERE)
    import engine  # type: ignore
    return engine


def run_export(project_dir, fmt, save_first=False):
    """Render the project via the engine. fmt in {docx, pdf}.

    Returns {out, abs, fmt}. For pdf: render docx then COM-export (Export then
    Close, never a method call after Close). Output lands in <dir>/out/.
    """
    engine = _import_engine()
    out_dir = os.path.join(project_dir, "out")
    os.makedirs(out_dir, exist_ok=True)

    # Load the project document.
    with open(os.path.join(project_dir, "project.json"), "r", encoding="utf-8") as fh:
        project = json.load(fh)

    # Resolve and load the template config (engine resolves the logo path).
    config_path = engine._resolve_config_path(
        project, project_dir, CFG.template_config_path
    )
    cfg = engine._load_config(config_path)

    name = os.path.basename(project_dir.rstrip(os.sep)) or "report"
    docx_out = os.path.join(out_dir, "%s.docx" % name)
    docx_abs = os.path.abspath(engine.render_report(project, cfg, project_dir, docx_out))

    if fmt == "docx":
        rel = os.path.relpath(docx_abs, project_dir).replace("\\", "/")
        return {"out": rel, "abs": docx_abs.replace("\\", "/"), "fmt": "docx"}

    if fmt == "pdf":
        pdf_abs = os.path.splitext(docx_abs)[0] + ".pdf"
        _word_export_pdf(docx_abs, pdf_abs)
        rel = os.path.relpath(pdf_abs, project_dir).replace("\\", "/")
        return {"out": rel, "abs": pdf_abs.replace("\\", "/"), "fmt": "pdf"}

    raise ValueError("unknown fmt: %s" % fmt)


def _word_export_pdf(docx_abs, pdf_abs):
    """Word COM: Open -> ExportAsFixedFormat(17) -> Close. Export then Close."""
    import win32com.client  # type: ignore  # pywin32, present on the work machine

    word = win32com.client.DispatchEx("Word.Application")
    word.Visible = False
    doc = None
    try:
        doc = word.Documents.Open(os.path.abspath(docx_abs))
        # Update all fields (e.g. a Table of Contents) so the PDF reflects what
        # the user sees in Word after a field refresh; otherwise TOC/PAGEREF
        # fields render as their unpopulated placeholder and pagination differs.
        try:
            for story in doc.StoryRanges:
                story.Fields.Update()
            for toc in doc.TablesOfContents:
                toc.Update()
        except Exception:
            pass  # field update is best-effort; never block the export
        # 17 = wdExportFormatPDF
        doc.ExportAsFixedFormat(os.path.abspath(pdf_abs), 17)
    finally:
        if doc is not None:
            doc.Close(False)  # never call a method on doc after this
        word.Quit()


# ---------------------------------------------------------------------------
# HTTP handler.
# ---------------------------------------------------------------------------


class Handler(BaseHTTPRequestHandler):
    server_version = "DocBuilder/1.0"
    protocol_version = "HTTP/1.1"

    # --- low-level response helpers ---

    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_error_json(self, msg, status=400):
        self._send_json({"error": str(msg)}, status=status)

    def _send_bytes(self, body, content_type, status=200):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return b""
        return self.rfile.read(length)

    def _read_json(self):
        raw = self._read_body()
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    def log_message(self, fmt, *args):  # quieter logging
        sys.stderr.write("[server] %s - %s\n" % (self.address_string(), fmt % args))

    # --- routing ---

    def do_GET(self):
        try:
            parsed = urlparse(self.path)
            path = parsed.path
            qs = parse_qs(parsed.query)

            if path == "/" or path == "/app.html":
                return self._serve_app_html()
            if path.startswith("/assets/"):
                return self._serve_asset(path)
            if path.startswith("/images/") or path.startswith("images/"):
                return self._serve_project_file(path, qs)
            if path == "/api/config":
                template = (qs.get("template") or [None])[0]
                return self._send_json(config_slice(template))
            if path == "/api/project":
                return self._api_project_get(qs)
            if path == "/api/health":
                return self._send_json({"ok": True})

            return self._send_error_json("not found: %s" % path, status=404)
        except Exception as exc:
            self._handle_exc(exc)

    def do_PUT(self):
        try:
            parsed = urlparse(self.path)
            path = parsed.path
            qs = parse_qs(parsed.query)
            if path == "/api/project":
                return self._api_project_put(qs)
            return self._send_error_json("not found: %s" % path, status=404)
        except Exception as exc:
            self._handle_exc(exc)

    def do_POST(self):
        try:
            parsed = urlparse(self.path)
            path = parsed.path
            qs = parse_qs(parsed.query)

            if path == "/api/image":
                return self._api_image(qs)
            if path == "/api/import-xlsx":
                return self._api_import_xlsx()
            if path == "/api/validate-compliance":
                return self._api_validate_compliance()
            if path == "/api/export":
                return self._api_export(qs)

            return self._send_error_json("not found: %s" % path, status=404)
        except Exception as exc:
            self._handle_exc(exc)

    def _handle_exc(self, exc):
        # Never crash the serve loop; always return a JSON error.
        if isinstance(exc, ValueError):
            status = 400
        elif isinstance(exc, FileNotFoundError):
            status = 404
        elif isinstance(exc, json.JSONDecodeError):
            status = 400
            exc = "invalid JSON body: %s" % exc
        else:
            status = 500
            sys.stderr.write(traceback.format_exc())
        try:
            self._send_error_json(exc, status=status)
        except Exception:
            pass

    # --- endpoint implementations ---

    def _serve_app_html(self):
        path = os.path.join(HERE, "app.html")
        if not os.path.isfile(path):
            # app.html is produced by the frontend agent; until then, a stub.
            stub = (
                b"<!doctype html><meta charset=utf-8>"
                b"<title>Document Builder</title>"
                b"<h1>Document Builder</h1>"
                b"<p>app.html is not present yet.</p>"
            )
            return self._send_bytes(stub, "text/html; charset=utf-8")
        with open(path, "rb") as fh:
            body = fh.read()
        return self._send_bytes(body, "text/html; charset=utf-8")

    def _serve_asset(self, path):
        rel = path[len("/assets/"):]
        rel = rel.replace("\\", "/")
        if ".." in rel.split("/"):
            return self._send_error_json("forbidden", status=403)
        full = os.path.join(HERE, "assets", *rel.split("/"))
        if not os.path.isfile(full):
            return self._send_error_json("not found", status=404)
        ctype = _guess_content_type(full)
        with open(full, "rb") as fh:
            body = fh.read()
        return self._send_bytes(body, ctype)

    def _serve_project_file(self, path, qs):
        """Serve a project-relative file (e.g. images/<name>.png) from the
        project folder identified by the `dir` query param.

        The frontend requests image thumbnails as `images/<file>?dir=<project>`.
        Only the project's `images/` subtree is served; traversal is rejected.
        """
        dir_arg = (qs.get("dir") or [None])[0]
        rel = path.lstrip("/")  # e.g. "images/1-1_checklist.png"
        rel = rel.replace("\\", "/")
        parts = rel.split("/")
        if parts[0] != "images" or ".." in parts:
            return self._send_error_json("forbidden", status=403)
        try:
            project_dir = resolve_project_dir(dir_arg, create=False)
        except ValueError as exc:
            return self._send_error_json(exc, status=400)
        full = os.path.join(project_dir, *parts)
        # Containment guard: resolved file must stay under the project dir.
        full_abs = os.path.abspath(full)
        pdir_abs = os.path.abspath(project_dir)
        if os.path.normcase(os.path.commonpath([full_abs, pdir_abs])) != os.path.normcase(pdir_abs):
            return self._send_error_json("forbidden", status=403)
        if not os.path.isfile(full_abs):
            return self._send_error_json("not found", status=404)
        ctype = _guess_content_type(full_abs)
        with open(full_abs, "rb") as fh:
            body = fh.read()
        return self._send_bytes(body, ctype)

    def _api_project_get(self, qs):
        dir_arg = (qs.get("dir") or [None])[0]
        project_dir = resolve_project_dir(dir_arg, create=False)
        pj = os.path.join(project_dir, "project.json")
        if not os.path.isfile(pj):
            return self._send_json(
                {"project": None, "meta_info": {"exists": False, "mtime": None}}
            )
        with open(pj, "r", encoding="utf-8") as fh:
            project = json.load(fh)
        mtime = os.path.getmtime(pj)
        return self._send_json(
            {"project": project, "meta_info": {"exists": True, "mtime": mtime}}
        )

    def _api_project_put(self, qs):
        dir_arg = (qs.get("dir") or [None])[0]
        project_dir = resolve_project_dir(dir_arg, create=True)
        project = self._read_json()
        if not isinstance(project, dict):
            return self._send_error_json("body must be a JSON object")
        sv = project.get("schema_version")
        if sv is not None and sv != 1:
            return self._send_error_json("unsupported schema_version: %r" % sv)
        pj = os.path.join(project_dir, "project.json")
        body = json.dumps(project, ensure_ascii=False, indent=2).encode("utf-8")
        atomic_write(pj, body)
        return self._send_json(
            {
                "ok": True,
                "saved_at": os.path.getmtime(pj),
                "path": pj.replace("\\", "/"),
            }
        )

    def _api_image(self, qs):
        dir_arg = (qs.get("dir") or [None])[0]
        section = (qs.get("section") or [None])[0]
        name = (qs.get("name") or [None])[0]

        ctype = (self.headers.get("Content-Type") or "").lower()
        if ctype.startswith("image/png"):
            png_bytes = self._read_body()
        else:
            payload = self._read_json()
            b64 = payload.get("png_b64")
            if not b64:
                return self._send_error_json("missing png bytes / png_b64")
            if "," in b64 and b64.lstrip().lower().startswith("data:"):
                b64 = b64.split(",", 1)[1]
            png_bytes = base64.b64decode(b64)
            section = payload.get("section", section)
            name = payload.get("name", name)

        if section is None:
            return self._send_error_json("missing 'section'")
        if not png_bytes:
            return self._send_error_json("empty image payload")
        if png_bytes[:8] != b"\x89PNG\r\n\x1a\n":
            return self._send_error_json("payload is not a PNG")

        project_dir = resolve_project_dir(dir_arg, create=True)
        rel, abs_path = next_image_path(project_dir, section, name)
        atomic_write(abs_path, png_bytes)
        return self._send_json({"file": rel})

    def _api_import_xlsx(self):
        payload = self._read_json()
        b64 = payload.get("xlsx_b64")
        mode = payload.get("mode", "grid")
        if not b64:
            return self._send_error_json("missing 'xlsx_b64'")
        if "," in b64 and b64.lstrip().lower().startswith("data:"):
            b64 = b64.split(",", 1)[1]
        xlsx_bytes = base64.b64decode(b64)
        if mode == "grid":
            return self._send_json(parse_xlsx_grid(xlsx_bytes))
        if mode == "compliance":
            return self._send_json(parse_xlsx_compliance(xlsx_bytes))
        return self._send_error_json("unknown mode: %r" % mode)

    def _api_validate_compliance(self):
        payload = self._read_json()
        data = payload.get("data")
        if data is None:
            return self._send_error_json("missing 'data'")
        try:
            result = validate_compliance(data)
        except (ImportError, ModuleNotFoundError) as exc:
            return self._send_error_json(
                "engine not available: %s" % exc, status=503
            )
        return self._send_json(result)

    def _api_export(self, qs):
        dir_arg = (qs.get("dir") or [None])[0]
        fmt = (qs.get("fmt") or ["docx"])[0]
        if fmt not in ("docx", "pdf"):
            return self._send_error_json("fmt must be docx|pdf")
        project_dir = resolve_project_dir(dir_arg, create=False)
        if not os.path.isfile(os.path.join(project_dir, "project.json")):
            return self._send_error_json("no project.json in dir", status=404)
        payload = {}
        if int(self.headers.get("Content-Length") or 0) > 0:
            payload = self._read_json()
        save_first = bool(payload.get("save_first"))
        try:
            result = run_export(project_dir, fmt, save_first=save_first)
        except (ImportError, ModuleNotFoundError) as exc:
            return self._send_error_json(
                "engine not available: %s" % exc, status=503
            )
        return self._send_json(result)


def _guess_content_type(path):
    ext = os.path.splitext(path)[1].lower()
    return {
        ".html": "text/html; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".svg": "image/svg+xml",
        ".json": "application/json; charset=utf-8",
        ".woff2": "font/woff2",
        ".woff": "font/woff",
    }.get(ext, "application/octet-stream")


# ---------------------------------------------------------------------------
# Entry point.
# ---------------------------------------------------------------------------


def make_server(port=None, root=None, config_path=None, bind="127.0.0.1"):
    """Construct (but do not start) the HTTP server. Used by smoke tests too."""
    if port is not None:
        CFG.port = port
    if root is not None:
        CFG.reports_root = os.path.abspath(root)
    if config_path is not None:
        CFG.template_config_path = os.path.abspath(config_path)
    CFG.bind = bind
    httpd = ThreadingHTTPServer((bind, CFG.port), Handler)
    return httpd


def default_config_path():
    """Best-effort default template config path.

    Prefer an explicit --config / BUILDER_TEMPLATE_CONFIG. Otherwise look in a
    sibling `local/` folder for a single `template_config_*.json` and use it.
    Returns None if nothing is found (the server still starts; endpoints that
    need the config then report a clean error).
    """
    import glob

    local_dir = os.path.abspath(os.path.join(HERE, "..", "local"))
    matches = sorted(glob.glob(os.path.join(local_dir, "template_config_*.json")))
    return matches[0] if matches else None


def main(argv=None):
    parser = argparse.ArgumentParser(description="Structured document builder server")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument(
        "--root",
        default=os.environ.get("BUILDER_REPORTS_ROOT"),
        help="reports_root: project folders must stay under this path",
    )
    parser.add_argument(
        "--config",
        default=os.environ.get("BUILDER_TEMPLATE_CONFIG") or default_config_path(),
        help="path to the template config JSON",
    )
    parser.add_argument("--bind", default="127.0.0.1")
    args = parser.parse_args(argv)

    CFG.reports_root = os.path.abspath(args.root) if args.root else None
    CFG.template_config_path = os.path.abspath(args.config) if args.config else None
    CFG.bind = args.bind
    CFG.port = args.port

    if args.bind != "127.0.0.1":
        sys.stderr.write(
            "WARNING: binding to %s; this server is intended for 127.0.0.1 only.\n"
            % args.bind
        )

    httpd = ThreadingHTTPServer((args.bind, args.port), Handler)
    sys.stderr.write(
        "Document builder server on http://%s:%d (root=%s, config=%s)\n"
        % (args.bind, args.port, CFG.reports_root, CFG.template_config_path)
    )
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
