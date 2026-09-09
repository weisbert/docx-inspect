#!/usr/bin/env python3
"""A row can carry a colour of its own, and it reaches the document.

WHY THIS EXISTS
A plain table's colour came from a row's KIND -- header, setting, result -- each
mapped to a fill by the template. That vocabulary covers the rows a report keeps
talking about and nothing else: a comparison table shaped as before / after /
difference triplets has no kind for "difference", so the only way to colour
those rows was ``row_fills``, the index-keyed map handed to the wrong rows by
the next insert or delete (twice now: 7af349c, and the migration before it), or a
template config edit inventing a kind -- a config edit for what should be a click.

A row written as a dict may now carry ``fill``, a bare RRGGBB, and it wins over
every other rule. It is written ON the row, so it travels with the row.

WHAT THIS FILE ASSERTS
  1. a row's own fill shades it in a REAL engine.render_report
  2. it beats the kind's colour and the legacy index map on the same row
  3. a row without one is untouched, and a table without any is unshaded --
     the colour is opt-in, byte for byte
  4. a colour that is not a colour is ignored, not raised, and the row falls
     through to its kind (a typo in a report must not stop a render)
  5. '#rrggbb' and lower case are read; the field is stored bare and upper
  6. the .xlsx export paints the same rows the same colours

AGAINST THE PRE-FIX FILES: 1, 2, 5 and 6 fail -- the field was not read at all.

ASCII-only fixture; the template config comes from test_render_golden so both
tests describe the same document. Nothing here writes to a real report.

Run:
    python builder/tests/test_row_fill.py
"""

import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
BUILDER = os.path.dirname(HERE)
if BUILDER not in sys.path:
    sys.path.insert(0, BUILDER)
import buildpath  # noqa: E402,F401

from docx import Document  # noqa: E402
from docx.oxml.ns import qn  # noqa: E402

import engine  # noqa: E402
import tables  # noqa: E402
import xlsx_export  # noqa: E402
from test_render_golden import golden_config  # noqa: E402

DIFF_FILL = "DCE6F1"             # the colour the difference rows are given
SETTING_FILL = "EEECE1"          # what the 'setting' kind maps to
HEADER_FILL = "D9D9D9"
LEGACY_FILL = "FFF2CC"

FAILED = []


def check(ok, label, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + (("  [%s]" % detail) if detail else ""))
    if not ok:
        FAILED.append(label)


# ---------------------------------------------------------------------------
# Fixtures.
# ---------------------------------------------------------------------------
def triplet_table():
    """The shape that asked for this: before / after / difference, three rows a
    group, the difference row carrying a colour no kind names."""
    return {
        "type": "table", "id": "tbl-diff", "caption": "Comparison",
        "header_rows": 1,
        "rows": [
            ["Item", "Value"],
            ["Before", "1.10"],
            ["After", "1.14"],
            {"cells": ["Difference", "+0.04"], "fill": DIFF_FILL},
        ],
    }


def contested_table():
    """One row that every rule wants to colour: its own fill must win."""
    return {
        "type": "table", "id": "tbl-contested", "caption": "Contested",
        "header_rows": 1,
        "rows": [
            ["Part", "Reading"],
            {"cells": ["Supply", "1.1"], "kind": "setting", "fill": DIFF_FILL},
            {"cells": ["Margin", "11.4"], "kind": "setting"},
        ],
        "row_fills": {"1": LEGACY_FILL, "2": LEGACY_FILL},
    }


def spelling_table():
    """The same colour written three ways, plus one that is not a colour."""
    return {
        "type": "table", "id": "tbl-spelling", "caption": "Spellings",
        "header_rows": 1,
        "rows": [
            ["Device", "Reading"],
            {"cells": ["hash", "1"], "fill": "#" + DIFF_FILL},
            {"cells": ["lower", "2"], "fill": DIFF_FILL.lower()},
            {"cells": ["nonsense", "3"], "kind": "setting", "fill": "cornflower"},
        ],
    }


def plain_table():
    """No colour anywhere: the control."""
    return {
        "type": "table", "id": "tbl-plain", "caption": "Plain",
        "header_rows": 1,
        "rows": [["Name", "Number"], ["Supply", "1.1"]],
    }


def project():
    return {
        "schema_version": 1,
        "template": "golden_tpl_v1",
        "meta": {"title": "Row colour", "author": "Tester", "reviewers": [], "revisions": []},
        "outline": [
            {"id": "ch1", "title": "Tables", "blocks": [
                triplet_table(), contested_table(), spelling_table(), plain_table(),
            ], "children": []},
        ],
    }


# ---------------------------------------------------------------------------
# Reading the document back.
# ---------------------------------------------------------------------------
def cell_fill(cell):
    tcPr = cell._tc.find(qn("w:tcPr"))
    if tcPr is None:
        return None
    shd = tcPr.find(qn("w:shd"))
    if shd is None:
        return None
    val = shd.get(qn("w:fill"))
    return None if val in (None, "auto") else val.upper()


def row_fill(table, r):
    return cell_fill(table.rows[r].cells[0])


def text_of(cell):
    return "\n".join(p.text for p in cell.paragraphs).strip()


def table_by_header(doc, header):
    for t in doc.tables:
        if t.rows and [text_of(c) for c in t.rows[0].cells] == header:
            return t
    return None


def render(tmp):
    cfg = golden_config()
    cfg["_logo_path"] = ""
    cfg["free_table"] = dict(cfg["free_table"], font_pt=8)
    out = os.path.join(tmp, "out", "row_fill.docx")
    engine.render_report(project(), cfg, tmp, out)
    return Document(out)


# ---------------------------------------------------------------------------
# 1-3. the colour reaches Word, and only where it was asked for
# ---------------------------------------------------------------------------
def test_row_carries_its_colour(doc):
    print("== a difference row is the colour it was given ==")
    t = table_by_header(doc, ["Item", "Value"])
    check(t is not None, "the comparison table was rendered")
    if t is None:
        return
    check(row_fill(t, 3) == DIFF_FILL, "the difference row carries its own colour",
          str(row_fill(t, 3)))
    check(all(cell_fill(c) == DIFF_FILL for c in t.rows[3].cells),
          "every cell of it, not just the first")
    check(row_fill(t, 1) is None and row_fill(t, 2) is None,
          "the two rows above it are untouched")
    check(row_fill(t, 0) == HEADER_FILL, "and the header row still takes the header fill")
    check(text_of(t.rows[3].cells[0]) == "Difference",
          "a dict row's cells are read, not its keys", text_of(t.rows[3].cells[0]))


def test_own_colour_wins(doc):
    print("== a row's own colour beats the kind and the legacy map ==")
    t = table_by_header(doc, ["Part", "Reading"])
    check(t is not None, "the contested table was rendered")
    if t is None:
        return
    check(row_fill(t, 1) == DIFF_FILL,
          "the row that names a colour gets it, over kind and over row_fills",
          str(row_fill(t, 1)))
    check(row_fill(t, 2) == SETTING_FILL,
          "the row beside it, naming none, still takes its kind's colour",
          str(row_fill(t, 2)))


def test_plain_table_unshaded(doc):
    print("== a table that names no colour has none ==")
    t = table_by_header(doc, ["Name", "Number"])
    check(t is not None, "the plain table was rendered")
    if t is None:
        return
    check(all(cell_fill(c) is None for c in t.rows[1].cells),
          "its body row carries no shading at all")


# ---------------------------------------------------------------------------
# 4-5. spellings
# ---------------------------------------------------------------------------
def test_spellings(doc):
    print("== how the colour may be written ==")
    t = table_by_header(doc, ["Device", "Reading"])
    check(t is not None, "the spellings table was rendered")
    if t is None:
        return
    check(row_fill(t, 1) == DIFF_FILL, "'#RRGGBB' is read", str(row_fill(t, 1)))
    check(row_fill(t, 2) == DIFF_FILL, "lower case is read", str(row_fill(t, 2)))
    check(row_fill(t, 3) == SETTING_FILL,
          "a word that is not a colour is ignored, and the row falls to its kind",
          str(row_fill(t, 3)))
    check(tables._hex6("#dce6f1") == DIFF_FILL and tables._hex6("nope") is None
          and tables._hex6("DCE6F") is None and tables._hex6(None) is None,
          "the reader normalises what it accepts and refuses the rest")


# ---------------------------------------------------------------------------
# 6. the spreadsheet says the same
# ---------------------------------------------------------------------------
def test_xlsx_mirrors(tmp):
    print("== the .xlsx export paints the same rows ==")
    try:
        from openpyxl import load_workbook
    except ImportError:
        print("  SKIP  openpyxl not installed")
        return
    cfg = golden_config()
    path = os.path.join(tmp, "diff.xlsx")
    with open(path, "wb") as fh:
        fh.write(xlsx_export.build_block_xlsx(triplet_table(), cfg))
    ws = load_workbook(path).active
    check(ws.cell(row=4, column=1).fill.fgColor.rgb == "FF" + DIFF_FILL,
          "the difference row is its own colour in the sheet",
          str(ws.cell(row=4, column=1).fill.fgColor.rgb))
    check(ws.cell(row=2, column=1).fill.fill_type in (None, "none"),
          "the rows above it are unshaded")
    check(ws.cell(row=4, column=1).value == "Difference",
          "and its cells came through", str(ws.cell(row=4, column=1).value))

    path = os.path.join(tmp, "contested.xlsx")
    with open(path, "wb") as fh:
        fh.write(xlsx_export.build_block_xlsx(contested_table(), cfg))
    ws = load_workbook(path).active
    check(ws.cell(row=2, column=1).fill.fgColor.rgb == "FF" + DIFF_FILL,
          "the sheet uses the same precedence as the document")


def main():
    tmp = tempfile.mkdtemp(prefix="row_fill_")
    os.makedirs(os.path.join(tmp, "images"), exist_ok=True)
    doc = render(tmp)
    test_row_carries_its_colour(doc)
    test_own_colour_wins(doc)
    test_plain_table_unshaded(doc)
    test_spellings(doc)
    test_xlsx_mirrors(tmp)
    print("")
    if FAILED:
        print("FAILED (%d): %s" % (len(FAILED), ", ".join(FAILED)))
        return 1
    print("all row-colour assertions passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
