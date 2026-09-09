#!/usr/bin/env python3
"""A merged cell is one line tall, not one line per cell it swallowed.

WHY THIS EXISTS
Every merge in this module was ``a.merge(b)``, and python-docx concatenates the
paragraphs of EVERY cell a merge swallows. Each cell is written with exactly one
paragraph before the merge happens, and the swallowed ones are empty -- so a
header merged across three columns came out holding 'Alpha' plus two blank
paragraphs, and the row was drawn THREE LINES TALL.

    r0  | Offset | Alpha\\n\\n | Beta\\n\\n | Gamma\\n\\n |

It shows wherever a table merges, which is every clustered header and every
sign-off sheet: one real report had twenty-three merges each carrying four to six
blank lines. Nothing was wrong with the document -- it was just loose everywhere,
and a clustered header bought less than it should have.

The compliance table escaped it in three of its four merge sites by writing the
cell AFTER merging (``_set_cell_text`` clears the cell first). The fourth --
a ``sim_span`` row, whose axis cells are written and THEN merged -- did not, and
that one hides behind an EXACT row height instead of growing: the text is pushed
against a box that cannot grow to hold it.

WHAT THIS FILE ASSERTS
  1. a free table's merged cell holds ONE paragraph and its text
  2. a merge of cells that are all empty keeps exactly one paragraph (a cell
     with none is not a valid document)
  3. a vertical merge behaves the same
  4. a compliance sim_span row's merged cell holds one paragraph
  5. the text itself is unchanged -- the fix removes blank lines, not content

AGAINST THE PRE-FIX FILE: 1, 3, 4 and 5 fail (the text comes back with trailing
newlines and the paragraph counts are 3, 4 and 3).

ASCII-only, self-contained, writes nothing outside a temporary directory.

Run:
    python builder/tests/test_merge_blanks.py
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
BUILDER = os.path.dirname(HERE)
if BUILDER not in sys.path:
    sys.path.insert(0, BUILDER)
import buildpath  # noqa: E402,F401

from docx import Document  # noqa: E402

import tables  # noqa: E402
from test_render_golden import golden_config  # noqa: E402

FAILED = []


def check(ok, label, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + (("  [%s]" % detail) if detail else ""))
    if not ok:
        FAILED.append(label)


def free_cfg():
    cfg = golden_config()["free_table"]
    return dict(cfg, font_pt=8)


# ---------------------------------------------------------------------------
# 1-3. the free table
# ---------------------------------------------------------------------------
def test_clustered_header():
    """The shape the defect was found in: a header clustering three columns."""
    print("== a clustered header is one line tall ==")
    rows = [
        ["Offset", "Alpha", "", "", "Beta", "", ""],
        ["1 MHz", "1.0", "2.0", "3.0", "4.0", "5.0", "6.0"],
    ]
    merges = [{"r": 0, "c": 1, "rs": 1, "cs": 3}, {"r": 0, "c": 4, "rs": 1, "cs": 3}]
    doc = Document()
    t = tables.render_free_table(doc, rows, free_cfg(), header_rows=1, merges=merges)["table"]
    head = t.rows[0].cells
    check(len(head[1].paragraphs) == 1,
          "a cell merged across three columns holds one paragraph",
          "%d paragraphs" % len(head[1].paragraphs))
    check(head[1].text == "Alpha", "and exactly its text, with nothing trailing",
          repr(head[1].text))
    check(head[4].text == "Beta" and len(head[4].paragraphs) == 1,
          "the second cluster too", repr(head[4].text))
    check(head[0].text == "Offset" and len(head[0].paragraphs) == 1,
          "an unmerged cell is unchanged")
    check([c.text for c in t.rows[1].cells] == ["1 MHz", "1.0", "2.0", "3.0", "4.0", "5.0", "6.0"],
          "and the row below still says what it said")


def test_all_blank_merge():
    print("== a merge of empty cells keeps one paragraph ==")
    rows = [["Item", "Value", "Note"], ["", "", ""]]
    doc = Document()
    t = tables.render_free_table(doc, rows, free_cfg(), header_rows=1,
                                 merges=[{"r": 1, "c": 0, "rs": 1, "cs": 3}])["table"]
    cell = t.rows[1].cells[0]
    check(len(cell.paragraphs) == 1,
          "one paragraph survives -- a cell with none is not a valid document",
          "%d paragraphs" % len(cell.paragraphs))
    check(cell.text == "", "and it is empty", repr(cell.text))


def test_vertical_merge():
    print("== a vertical merge is the same ==")
    rows = [["Group", "Value"], ["A", "1"], ["", "2"], ["", "3"]]
    doc = Document()
    t = tables.render_free_table(doc, rows, free_cfg(), header_rows=1,
                                 merges=[{"r": 1, "c": 0, "rs": 3, "cs": 1}])["table"]
    cell = t.rows[1].cells[0]
    check(len(cell.paragraphs) == 1, "a cell merged down three rows holds one paragraph",
          "%d paragraphs" % len(cell.paragraphs))
    check(cell.text == "A", "and its text", repr(cell.text))


# ---------------------------------------------------------------------------
# 4. the compliance table's one exposed merge
# ---------------------------------------------------------------------------
def test_sim_span_row():
    print("== a sim_span row's merged cell is one line tall ==")
    comp = golden_config()["compliance"]
    data = {
        "spec_name": "Spec",
        "sims": [{"key": "pilot", "title": "Pilot", "stage": "Pre"}],
        "rows": [
            {"cat": "Supply", "item": "VDD", "unit": "V", "kind": "common_setting",
             "spec": None, "spec_mtm": [None, None, None],
             "sim_mtm": ["1.1", None, None], "sim_ntwc": None,
             "limit": None, "sim_span": True},
            {"cat": "Power", "item": "I_total", "unit": "uA", "kind": "result",
             "spec": 500, "spec_mtm": [None, 500, None],
             "sim_mtm": [279, 490, 498], "sim_ntwc": None,
             "limit": "le", "sim_span": False},
        ],
    }
    doc = Document()
    t = tables.render_datatable(doc, data, comp)["table"]
    check(t is not None, "the compliance table was rendered")
    if t is None:
        return
    # The span row is the first data row, under the three header rows.
    row = t.rows[3]
    spanned = [c for c in row.cells if c.text.strip() == "1.1"]
    check(len(spanned) >= 1, "the spanned value is in the row",
          str([c.text for c in row.cells]))
    if spanned:
        check(len(spanned[0].paragraphs) == 1,
              "and its merged cell holds one paragraph, not one per axis",
              "%d paragraphs" % len(spanned[0].paragraphs))
        check(spanned[0].text == "1.1", "with nothing trailing", repr(spanned[0].text))
    # the header merges, which were always written after merging, are unchanged
    check(all(len(c.paragraphs) == 1 for c in t.rows[0].cells),
          "the header band is still one paragraph a cell")


def main():
    test_clustered_header()
    test_all_blank_merge()
    test_vertical_merge()
    test_sim_span_row()
    print("")
    if FAILED:
        print("FAILED (%d): %s" % (len(FAILED), ", ".join(FAILED)))
        return 1
    print("all merged-cell assertions passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
