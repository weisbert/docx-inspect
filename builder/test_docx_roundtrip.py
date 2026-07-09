# -*- coding: utf-8 -*-
"""Round-trip regression: project.json -> render .docx -> import .docx back, and
assert that plain-table cell values survive.

Guards the id()-reuse bug in docx_import._free_table_model: python-docx returns a
throwaway cell wrapper per tbl.cell() call, so reading cells one at a time let
CPython recycle id(cell._tc) and blanked distinct cells that collided with a
freed id. The fix materializes the whole cell grid first (refs held) before
merge-detection.

ASCII-only, no company/CJK data. Run: python builder/test_docx_roundtrip.py
"""
import os, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import engine          # noqa: E402
import docx_import     # noqa: E402
from test_render_golden import golden_config  # noqa: E402

FAILS = []


def check(cond, msg):
    print(("  PASS " if cond else "  FAIL ") + msg)
    if not cond:
        FAILS.append(msg)


# A plain table sized so that read-one-at-a-time id() reuse would blank cells
# (the original bug lost r1c2, r2c2, r3c0, r3c2 here).
PLAIN = {
    "type": "table", "caption": "Plain", "header_rows": 1, "merges": [],
    "col_w": [3, 3, 3], "rows": [
        ["ColA", "ColB", "ColC"],
        ["1", "2", "3"],
        ["x", "", "z"],           # a legitimately empty middle cell
        ["dup", "dup", "tail"],   # a value repeated within a row
    ],
}
# A table with real merges (row-span + col-span) that must still round-trip.
MERGED = {
    "type": "table", "caption": "Merged", "header_rows": 2,
    "merges": [{"r": 0, "c": 0, "rs": 2}, {"r": 0, "c": 1, "cs": 2}],
    "col_w": [3, 2, 2], "rows": [
        ["Item", "Pair", ""],
        ["", "P1", "P2"],
        ["row1", "a", "b"],
        ["row2", "c", "d"],
    ],
}

PROJECT = {
    "schema_version": 1, "template": "t",
    "meta": {"title": "RT", "version": "V1.0", "secrecy": "x", "author": "a",
             "date": "2026-01-01", "revisions": []},
    "outline": [
        {"id": "n1", "title": "Plain section", "origin": "template",
         "blocks": [PLAIN], "children": []},
        {"id": "n2", "title": "Merged section", "origin": "template",
         "blocks": [MERGED], "children": []},
    ],
}


def _tables(project):
    out = []

    def walk(ns):
        for n in ns:
            for b in n.get("blocks", []):
                if b.get("type") == "table":
                    out.append(b.get("rows", []))
            walk(n.get("children", []))
    walk(project["outline"])
    return out


def _norm(v):
    return "" if v is None else str(v).strip()


def main():
    cfg = golden_config()
    cfg["_logo_path"] = ""
    tmp = tempfile.mkdtemp(prefix="rt_")
    pdir = os.path.join(tmp, "RT")
    os.makedirs(pdir)
    docx_path = os.path.join(pdir, "out.docx")
    engine.render_report(PROJECT, cfg, pdir, docx_path)
    check(os.path.isfile(docx_path), "rendered a .docx")

    imported = docx_import.parse_docx_report(
        docx_path, images_dir=os.path.join(tmp, "img"), warn=lambda w: None)

    orig, imp = _tables(PROJECT), _tables(imported)
    check(len(imp) >= len(orig), "all %d tables present after import (got %d)"
          % (len(orig), len(imp)))

    for ti, o_rows in enumerate(orig):
        i_rows = imp[ti] if ti < len(imp) else []
        # every non-empty original cell must survive somewhere in its row's cell
        lost = []
        for ri, row in enumerate(o_rows):
            irow = i_rows[ri] if ri < len(i_rows) else []
            for ci, val in enumerate(row):
                if _norm(val) == "":
                    continue
                got = _norm(irow[ci]) if ci < len(irow) else ""
                if got != _norm(val):
                    lost.append("t%d r%d c%d: %r -> %r" % (ti, ri, ci, val, got))
        check(not lost, "table %d: no cell values dropped" % ti
              + ("" if not lost else "  " + "; ".join(lost)))

    print("\n" + ("ALL PASS" if not FAILS else "FAILURES: %d" % len(FAILS)))
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
