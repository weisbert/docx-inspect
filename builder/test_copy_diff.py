#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Regression tests for the upstream "Copy diff" channel (apply_update.py):
make_text_diff -> apply_text_diff must reproduce the edited project EXACTLY, for
block edits, renames, meta / top-level changes, and sub-structure changes; an
unchanged pair yields an empty diff; the applier restamps the baseline and flags
a drifted local copy. Pure logic (no server) -- fast, run in CI alongside the
render golden. See test_app_logic.js for the GUI side.
"""
import copy
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(HERE, "..")))   # repo root: apply_update.py
import apply_update as A   # noqa: E402

_fails = []


def check(cond, msg):
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    if not cond:
        _fails.append(msg)


def canon(o):
    return json.dumps(o, ensure_ascii=False, sort_keys=True)


def node(nid, title, text, children=None):
    return {"id": nid, "title": title,
            "blocks": [{"type": "para", "runs": [{"t": text}]}],
            "children": children or []}


BASE = {
    "schema_version": 1,
    "meta": {"title": "Demo", "author": "x"},
    "sim_checklist": [{"key": "a", "done": False}],
    "outline": [
        node("c1", "Chapter 1", "intro", [
            node("s1", "Sec 1.1", "body 11"),
            node("s2", "Sec 1.2", "body 12"),
        ]),
        node("c2", "Chapter 2", "c2 intro", [
            node("s3", "Sec 2.1", "body 21"),
        ]),
    ],
}


def roundtrip(name, mutate, expect_empty=False):
    cur = copy.deepcopy(BASE)
    mutate(cur)
    diff = A.make_text_diff(BASE, cur, "demo")
    if expect_empty:
        check(A.diff_is_empty(diff), "%s -> empty diff" % name)
        return
    if A.diff_is_empty(diff):
        check(False, "%s -> diff unexpectedly empty" % name)
        return
    with tempfile.TemporaryDirectory() as root:
        d = os.path.join(root, "demo")
        os.makedirs(d)
        with open(os.path.join(d, "project.json"), "w", encoding="utf-8") as fh:
            json.dump(BASE, fh, ensure_ascii=False, indent=2)
        res = A.apply_text_diff(root, diff, dir_name="demo")
        with open(os.path.join(d, "project.json"), encoding="utf-8") as fh:
            got = json.load(fh)
        base_stamped = os.path.isfile(os.path.join(d, "_baseline.json"))
        with open(os.path.join(d, "_baseline.json"), encoding="utf-8") as fh:
            base_after = json.load(fh)
    ok = canon(got) == canon(cur)
    check(ok, "%s -> apply reproduces edited project" % name)
    if not ok:
        print("     got : %s" % canon(got))
        print("     want: %s" % canon(cur))
    check(res.get("base_match") is True, "%s -> base_sha matches seeded baseline" % name)
    check(base_stamped and canon(base_after) == canon(cur),
          "%s -> baseline restamped to applied state" % name)


def main():
    print("== round-trips ==")
    roundtrip("noop", lambda c: None, expect_empty=True)
    roundtrip("edit blocks",
              lambda c: c["outline"][0]["children"][1]["blocks"][0]["runs"][0].__setitem__("t", "EDIT"))
    roundtrip("rename title",
              lambda c: c["outline"][0]["children"][0].__setitem__("title", "Renamed"))
    roundtrip("meta change", lambda c: c["meta"].__setitem__("title", "Demo v2"))
    roundtrip("top-level key",
              lambda c: c["sim_checklist"].append({"key": "b", "done": True}))
    roundtrip("add subsection",
              lambda c: c["outline"][1]["children"].append(node("s4", "Sec 2.2", "new")))
    roundtrip("remove subsection", lambda c: c["outline"][0]["children"].pop(1))
    roundtrip("add top chapter",
              lambda c: c["outline"].append(node("c3", "Chapter 3", "c3")))
    roundtrip("reorder chapters", lambda c: c["outline"].reverse())

    def _combo(c):
        c["meta"]["author"] = "y"
        c["outline"][0]["children"][0]["blocks"][0]["runs"][0]["t"] = "combo"
        c["outline"][1]["title"] = "Chapter 2 Renamed"
        c["sim_checklist"][0]["done"] = True
    roundtrip("combo", _combo)

    print("== field removal (patch_node remove_fields) ==")
    cur = copy.deepcopy(BASE)
    cur["outline"][0]["fixed_body"] = "was absent"   # add a node-own field...
    d1 = A.make_text_diff(BASE, cur, "demo")
    cur2 = copy.deepcopy(cur)
    del cur2["outline"][0]["fixed_body"]             # ...then remove it in the next round
    d2 = A.make_text_diff(cur, cur2, "demo")
    proj = copy.deepcopy(cur)
    A._apply_text_diff_into(proj, d2)
    check("fixed_body" not in proj["outline"][0], "remove_fields drops a node-own key")

    print("== empty-diff detection ==")
    check(A.diff_is_empty(A.make_text_diff(BASE, copy.deepcopy(BASE), "demo")),
          "identical projects -> empty")

    print("== drift warning ==")
    with tempfile.TemporaryDirectory() as root:
        d = os.path.join(root, "demo")
        os.makedirs(d)
        drifted = copy.deepcopy(BASE)
        drifted["outline"][1]["children"][0]["blocks"][0]["runs"][0]["t"] = "drift"
        with open(os.path.join(d, "project.json"), "w", encoding="utf-8") as fh:
            json.dump(drifted, fh, ensure_ascii=False, indent=2)
        cur = copy.deepcopy(BASE)
        cur["outline"][0]["children"][0]["blocks"][0]["runs"][0]["t"] = "edit"
        diff = A.make_text_diff(BASE, cur, "demo")   # baseline fingerprint = BASE
        res = A.apply_text_diff(root, diff, dir_name="demo")
        check(res.get("base_match") is False, "drifted local copy -> base_match False")

    print("\n== SUMMARY ==  %s" % ("ALL PASSED" if not _fails else "%d FAILED" % len(_fails)))
    return 1 if _fails else 0


if __name__ == "__main__":
    sys.exit(main())
