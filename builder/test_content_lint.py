#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Tests for content_lint.py.

A single counter-example fixture project deliberately trips EVERY finding type,
so the linter's coverage is asserted rather than assumed (golden only ever
exercised missing_image). Run:

    .venv\\Scripts\\python.exe builder\\test_content_lint.py
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import content_lint as cl  # noqa: E402

# A project crafted so each rule fires at least once. Comments name the target.
FIXTURE = {
    "schema_version": 1,
    "outline": [
        {"title": "Empty", "blocks": [], "children": []},          # empty_section
        {"title": "Media", "blocks": [
            {"type": "image", "id": "i1", "file": "C:/abs/x.png", "caption": ""},   # image_path(abs)+no_caption
            {"type": "image", "id": "i2", "file": "../up.png", "caption": "ok"},     # image_path(..)
            {"type": "image", "id": "i3", "file": "notimages/x.png", "caption": "ok"},  # image_path(not images/)
            {"type": "imagegrid", "id": "g1", "items": [{"file": "/abs.png"}], "caption": ""},  # image_path+no_caption
            {"type": "table", "id": "t1"},                                          # table_no_rows
            {"type": "table", "id": "t2", "rows": [["a", "b"], ["c", "d"]],
             "merges": [{"r": 0, "c": 0, "rs": 5, "cs": 1}],
             "row_fills": {"9": "FFFF00"}},                                          # free_table_bounds x2
            {"type": "datatable", "id": "d0"},                                       # datatable_no_data
        ], "children": []},
        {"title": "Compliance", "blocks": [
            {"type": "datatable", "id": "d1", "caption": "C", "data": {
                "spec_name": "Spec",
                "sims": [{"key": "s1", "title": "S1", "axes": ["MIN", "TYP"]},        # 2 axes -> sim_span_axes
                         {"key": "s2", "title": "S2", "axes": ["MIN", "TYP"]}],        # 2 groups -> sim_span_multi
                "rows": [
                    {"item": "noKeys"},                                              # row_missing_key
                    {"cat": "C", "item": "r1", "kind": "result", "unit": "",         # unit_empty(info)
                     "limit": None, "spec": 5, "spec_mtm": [None, 5, None],          # limit_no_flag
                     "sim_span": True, "sims": {"bogus": {"mtm": [1, 2, 3]}}},        # unknown_sim_key + sim_span
                    {"cat": "C", "item": "r2", "kind": "result", "unit": "uA",
                     "limit": "le", "spec_mtm": [None, None, None],
                     "sim_mtm": [None, None, None]},                                  # empty_sim_result
                ]}},
            {"type": "datatable", "id": "d2", "caption": "C2", "data": {
                "sims": [{"key": "s1", "axes": ["MIN", "TYP", "MAX", "NTWC"]}],
                "rows": [{"cat": "X", "item": "y", "kind": "result", "unit": "V",
                          "limit": "le", "sim_mtm": [1, 2, 3]}]}},                    # no_setting_rows
        ], "children": []},
    ],
}

EXPECTED = {
    # every type content_lint can emit, with its expected level
    "empty_section": "warn",
    "image_path": "error",
    "no_caption": "warn",
    "table_no_rows": "error",
    "free_table_bounds": "error",
    "datatable_no_data": "error",
    "row_missing_key": "error",
    "sim_span_axes": "error",
    "sim_span_multi": "warn",
    "limit_no_flag": "warn",
    "unknown_sim_key": "warn",
    "empty_sim_result": "warn",
    "no_setting_rows": "warn",
    "unit_empty": "info",
}

fails = 0


def check(cond, name, detail=""):
    global fails
    print(("  PASS " if cond else "  FAIL ") + name + ("" if cond else "  -> " + detail))
    if not cond:
        fails += 1


def main():
    findings = cl.lint_project(FIXTURE, {})
    got = {}
    for f in findings:
        got.setdefault(f["type"], []).append(f)

    # every expected type fires...
    for t, lv in EXPECTED.items():
        check(t in got, "fires: %s" % t, "not found; got types=%r" % sorted(got))
        if t in got:
            check(all(f["level"] == lv for f in got[t]),
                  "level(%s)==%s" % (t, lv),
                  "levels=%r" % [f["level"] for f in got[t]])

    # ...and nothing unexpected fires (guards against a rule going rogue)
    unexpected = set(got) - set(EXPECTED)
    check(not unexpected, "no unexpected finding types", "extra=%r" % sorted(unexpected))

    # count-sensitive spots
    check(len(got.get("image_path", [])) == 4, "4 image_path findings",
          "got %d" % len(got.get("image_path", [])))
    check(len(got.get("free_table_bounds", [])) == 2, "2 free_table_bounds findings",
          "got %d" % len(got.get("free_table_bounds", [])))
    check(len(got.get("no_setting_rows", [])) == 2, "2 no_setting_rows findings",
          "got %d" % len(got.get("no_setting_rows", [])))

    # classify / stamp_levels
    check(cl.classify("block_error") == "error", "classify block_error -> error")
    check(cl.classify("totally_new_type") == "warn", "classify unknown -> warn")
    ws = [{"type": "missing_image"}, {"type": "block_error"}, {"type": "x", "level": "info"}]
    cl.stamp_levels(ws)
    check(ws[0]["level"] == "warn" and ws[1]["level"] == "error" and ws[2]["level"] == "info",
          "stamp_levels stamps + preserves existing")

    # a clean project yields nothing
    clean = {"schema_version": 1, "outline": [
        {"title": "S", "blocks": [{"type": "para", "runs": [{"t": "hi"}]}], "children": []}]}
    check(cl.lint_project(clean, {}) == [], "clean project -> no findings",
          "%r" % cl.lint_project(clean, {}))

    print("\n%d finding(s) from fixture; %d test failure(s)" % (len(findings), fails))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
