#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Regression test: render_datatable() must scale ~linearly with row count.

python-docx's ``Table.cell(r, c)`` rebuilds the table's ENTIRE cell list on
every call (a full walk of ``w:tc`` elements, expanding merges) -- calling it
inside a loop over rows x cols is O(rows^2 * cols^2) instead of O(rows * cols).
Before the fix, a synthetic 200-row compliance table took ~100s to render (see
audit finding F7-03); a 25-row table took ~2s. This test renders 25 /
50 / 100 / 200 row synthetic tables, prints the timing curve, and fails if the
200-row render does not comfortably finish inside a generous ceiling or if the
curve shows quadratic (not linear) growth.

Reuses the golden fixture's compliance config (test_render_golden.golden_config)
so the table shape (3 groups: spec + 2 sims, 3 axes each, category+item+unit
columns) matches a real report table. Neutral / ASCII-only.
"""
import os
import sys
import time

import docx

HERE = os.path.dirname(os.path.abspath(__file__))  # builder/tests
BUILDER = os.path.dirname(HERE)                  # builder/
if BUILDER not in sys.path:
    sys.path.insert(0, BUILDER)
import buildpath  # noqa: E402,F401  (registers core/docx_io/store/sync/web)
import tables as T                     # noqa: E402
import test_render_golden as G         # noqa: E402

_fails = []


def check(cond, name):
    print(("  PASS  " if cond else "  FAIL  ") + name)
    if not cond:
        _fails.append(name)


def _synthetic_rows(n):
    rows = []
    for i in range(n):
        kind = "common_setting" if i % 10 == 0 else "result"
        rows.append({
            "cat": "cat%d" % (i // 5),
            "item": "item %d" % i,
            "kind": kind,
            "limit": "le",
            "unit": "V",
            "spec_mtm": [None, None, 1.0],
            "spec_ntwc": 1.0,
            "sim_mtm": [0.1, 0.5, 0.9],
            "sim_ntwc": 0.6,
            "sims": {
                "pdr": {"mtm": [0.2, 0.4, 0.8], "ntwc": 0.5},
            },
        })
    return rows


def _timed_render(n, cfg):
    doc = docx.Document()
    data = {
        "spec_name": "Spec",
        "show_spec": True,
        "sims": [
            {"key": "sim", "title": "Sim", "axes": ["MIN", "TYP", "MAX", "NTWC"]},
            {"key": "pdr", "title": "PDR", "axes": ["MIN", "TYP", "MAX", "NTWC"]},
        ],
        "rows": _synthetic_rows(n),
    }
    t0 = time.time()
    result = T.render_datatable(doc, data, cfg)
    dt = time.time() - t0
    return dt, result


def main():
    cfg = dict(G.golden_config()["compliance"])

    print("== render_datatable row-count scaling ==")
    sizes = (25, 50, 100, 200)
    timings = {}
    for n in sizes:
        dt, result = _timed_render(n, cfg)
        timings[n] = dt
        print("  rows=%-4d -> %6.3fs  (total_rows=%d)" % (n, dt, result["total_rows"]))
        check(result["table"] is not None, "rows=%d produced a table" % n)
        check(result["total_rows"] == n, "rows=%d total_rows matches" % n)

    t200 = timings[200]
    check(t200 < 5.0, "200-row datatable renders in under 5s (got %.3fs)" % t200)

    # A quadratic curve quadruples the time on each doubling of n; a linear
    # (or better) curve merely doubles it. Allow generous slack (10x per
    # doubling would still be well short of the ~4x-per-doubling quadratic
    # signature) so this never flakes on a slow CI box while still catching a
    # regression back to O(n^2).
    t25 = timings[25]
    ratio = t200 / t25 if t25 > 0 else float("inf")
    check(ratio < 30.0,
          "200/25-row timing ratio stays roughly linear, not quadratic "
          "(got %.1fx; O(n^2) would be ~64x)" % ratio)

    print("\n== SUMMARY ==  %s" % ("ALL PASSED" if not _fails else "%d FAILED" % len(_fails)))
    return 1 if _fails else 0


if __name__ == "__main__":
    sys.exit(main())
