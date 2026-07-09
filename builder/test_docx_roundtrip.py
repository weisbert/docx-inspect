# -*- coding: utf-8 -*-
"""Round-trip regression: project.json -> render .docx -> import .docx, asserting
that content survives. Covers the fixes for silent round-trip loss:

  - plain-table cells (the id()-reuse merge bug)
  - bullet / numbered lists
  - image caption + imagegrid caption (engine emits caption AFTER the figure)
  - imagegrid reconstruction (pictures inside a borderless table are extracted)
  - compliance datatable: per-sim (e.g. PDR) values + setting-row kind
  - plain-table row_fills (condition-row shading)

Genuinely NOT recoverable from Word (documented, not asserted): a datatable row's
limit (le/ge) and sim_span, and meta.version (the engine never renders it).

ASCII-only, no company/CJK data. Run: python builder/test_docx_roundtrip.py
"""
import os, struct, sys, tempfile, zlib

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


def _png(w=100, h=60):
    raw = b"".join(b"\x00" + b"\xA0\xA0\xA0" * w for _ in range(h))
    def ch(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return (b"\x89PNG\r\n\x1a\n" + ch(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + ch(b"IDAT", zlib.compress(raw, 9)) + ch(b"IEND", b""))


PLAIN = {"type": "table", "caption": "Plain", "header_rows": 1, "merges": [],
         "col_w": [3, 3, 3], "row_fills": {"1": "EEECE1"}, "rows": [
             ["ColA", "ColB", "ColC"], ["1", "2", "3"],
             ["x", "", "z"], ["dup", "dup", "tail"]]}
MERGED = {"type": "table", "caption": "Merged", "header_rows": 2,
          "merges": [{"r": 0, "c": 0, "rs": 2}, {"r": 0, "c": 1, "cs": 2}],
          "col_w": [3, 2, 2], "rows": [
              ["Item", "Pair", ""], ["", "P1", "P2"],
              ["row1", "a", "b"], ["row2", "c", "d"]]}
DATATABLE = {"type": "datatable", "kind": "compliance", "caption": "Comp", "id": "dt",
             "data": {"spec_name": "Spec",
                      "sims": [{"key": "cdr", "title": "CDR", "stage": "post-sim", "axes": ["MIN", "TYP", "MAX"]},
                               {"key": "pdr", "title": "PDR", "stage": "pre-sim", "axes": ["MIN", "TYP", "MAX"]}],
                      "rows": [
                          {"cat": "Set", "item": "Temp", "unit": "C", "kind": "common_setting",
                           "spec_mtm": [None, None, None], "sim_mtm": [-40, 55, 125], "limit": None,
                           "sim_span": False, "sims": {"pdr": {"mtm": [-40, 55, 125], "ntwc": None}}},
                          {"cat": "Res", "item": "Ifoo", "unit": "uA", "kind": "result",
                           "spec_mtm": [None, None, 500], "sim_mtm": [100, 300, 872], "sim_ntwc": 872,
                           "limit": "le", "sim_span": False, "sims": {"pdr": {"mtm": [90, 280, 700], "ntwc": 700}}},
                      ]}}

PROJECT = {
    "schema_version": 1, "template": "t",
    "meta": {"title": "RT", "version": "V1.0", "secrecy": "x", "author": "a",
             "date": "2026-01-01", "revisions": []},
    "outline": [
        {"id": "n1", "title": "Tables", "origin": "template", "blocks": [PLAIN, MERGED], "children": []},
        {"id": "n2", "title": "Lists", "origin": "template", "blocks": [
            {"type": "para", "list": "bullet", "runs": [{"t": "bullet one"}]},
            {"type": "para", "list": "number", "runs": [{"t": "number one"}]}], "children": []},
        {"id": "n3", "title": "Media", "origin": "template", "blocks": [
            {"type": "image", "id": "im1", "file": "images/pic.png", "caption": "fig cap", "width_cm": 10.0},
            {"type": "imagegrid", "id": "ig", "cols": 2, "caption": "grid cap", "sub_captions": True,
             "items": [{"file": "images/a.png"}, {"file": "images/b.png"}, {"file": "images/c.png"}]}], "children": []},
        {"id": "n4", "title": "Datatable", "origin": "template", "blocks": [DATATABLE], "children": []},
    ],
}


def _blocks(project):
    out = []
    def walk(ns):
        for n in ns:
            out.extend(n.get("blocks", []))
            walk(n.get("children", []))
    walk(project["outline"])
    return out


def _norm(v):
    return "" if v is None else str(v).strip()


def main():
    cfg = golden_config()
    cfg["_logo_path"] = ""
    cfg["compliance"]["fills"]["header"] = "FFFF00"  # yellow -> classify_table sees a datatable
    tmp = tempfile.mkdtemp(prefix="rt_")
    pdir = os.path.join(tmp, "RT")
    os.makedirs(os.path.join(pdir, "images"))
    for nm in ("pic.png", "a.png", "b.png", "c.png"):
        open(os.path.join(pdir, "images", nm), "wb").write(_png())
    docx_path = os.path.join(pdir, "out.docx")
    engine.render_report(PROJECT, cfg, pdir, docx_path)
    imp = docx_import.parse_docx_report(docx_path, images_dir=os.path.join(tmp, "img"),
                                        warn=lambda w: None)
    B = _blocks(imp)

    # plain tables: no cell dropped
    for ti, tb in enumerate([b for b in B if b.get("type") == "table"][:2]):
        orig = [PLAIN, MERGED][ti]["rows"]
        lost = []
        for ri, row in enumerate(orig):
            irow = tb["rows"][ri] if ri < len(tb.get("rows", [])) else []
            for ci, val in enumerate(row):
                if _norm(val) == "":
                    continue
                if (_norm(irow[ci]) if ci < len(irow) else "") != _norm(val):
                    lost.append("r%dc%d" % (ri, ci))
        check(not lost, "plain table %d: no cell dropped %s" % (ti, lost))

    plains = [b for b in B if b.get("type") == "table"]
    check(any(b.get("row_fills") for b in plains), "plain-table row_fills preserved")

    paras = [b for b in B if b.get("type") == "para"]
    check(any(b.get("list") == "bullet" for b in paras), "bullet list preserved")
    check(any(b.get("list") == "number" for b in paras), "number list preserved")

    imgs = [b for b in B if b.get("type") == "image"]
    check(any(b.get("caption") == "fig cap" for b in imgs), "image caption preserved")

    grids = [b for b in B if b.get("type") == "imagegrid"]
    check(len(grids) == 1, "imagegrid reconstructed (not a plain table)")
    check(grids and len(grids[0].get("items", [])) == 3, "imagegrid kept all 3 images")
    check(grids and grids[0].get("caption") == "grid cap", "imagegrid caption preserved")
    check(grids and grids[0].get("sub_captions") is True, "imagegrid sub_captions preserved")

    dts = [b for b in B if b.get("type") == "datatable"]
    check(len(dts) == 1, "datatable preserved as datatable")
    if dts:
        rows = dts[0]["data"]["rows"]
        temp = next((r for r in rows if r["item"] == "Temp"), None)
        ifoo = next((r for r in rows if r["item"] == "Ifoo"), None)
        check(temp and temp["kind"] == "common_setting", "setting-row kind detected")
        check(ifoo and ifoo["kind"] == "result", "result-row kind detected")
        check(ifoo and ifoo["sim_mtm"] == [100, 300, 872], "datatable CDR values kept")
        check(ifoo and (ifoo.get("sims", {}).get("pdr", {}) or {}).get("mtm") == [90, 280, 700],
              "datatable PDR (per-sim) values kept")

    print("\n" + ("ALL PASS" if not FAILS else "FAILURES: %d" % len(FAILS)))
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
