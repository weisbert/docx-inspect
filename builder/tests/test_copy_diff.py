#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Regression tests for the upstream "Copy diff" channel (apply_update.py):
make_text_diff -> apply_text_diff must reproduce the edited project EXACTLY, for
block edits, renames, meta / top-level changes, and sub-structure changes; an
unchanged pair yields an empty diff; the applier flags a drifted local copy.

Also pins the BASELINE INVARIANT: ``_baseline.json`` is the last state both sides
agreed on, so it moves only when a whole report crosses the channel (package,
paste-import, rollback) and NEVER when a one-way delta is applied. That is what
makes a delta cumulative since the last full exchange and idempotent on re-paste;
moving it would refuse every delta after the first.

Pure logic (no server) -- fast, run in CI alongside the render golden. See
test_app_logic.js for the GUI side.
"""
import copy
import json
import os
import sys
import tempfile
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))  # builder/tests
BUILDER = os.path.dirname(HERE)                  # builder/
if BUILDER not in sys.path:
    sys.path.insert(0, BUILDER)
import buildpath  # noqa: E402,F401  (registers core/docx_io/store/sync/web)
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
    check(res.get("base_match") is True, "%s -> base_sha matches seeded project" % name)
    # This report had no _baseline.json, so the apply establishes the FIRST
    # agreement (it does not move an existing one -- see the invariant tests).
    check(res.get("baseline") == "no_baseline",
          "%s -> unexchanged report takes the no_baseline path" % name)
    check(base_stamped and canon(base_after) == canon(cur),
          "%s -> first baseline established from the applied state" % name)


def seed(root, project, baseline=None, dname="demo"):
    """Write <root>/<dname>/project.json, plus _baseline.json when given.
    Returns (project_dir, project_path, baseline_path)."""
    d = os.path.join(root, dname)
    os.makedirs(d, exist_ok=True)
    pj = os.path.join(d, "project.json")
    with open(pj, "w", encoding="utf-8") as fh:
        json.dump(project, fh, ensure_ascii=False, indent=2)
    bl = os.path.join(d, "_baseline.json")
    if baseline is not None:
        with open(bl, "w", encoding="utf-8") as fh:
            json.dump(baseline, fh, ensure_ascii=False, indent=2)
    return d, pj, bl


def rb(path):
    with open(path, "rb") as fh:
        return fh.read()


def edit_para(project, chapter, child, text):
    project["outline"][chapter]["children"][child]["blocks"][0]["runs"][0]["t"] = text


def baseline_invariant():
    """The rule the "second Copy diff is dead" bug broke: a one-way delta never
    moves _baseline.json, so consecutive cumulative deltas cut from the same
    far-side baseline all apply."""
    print("== two consecutive cumulative diffs (the bug this pins) ==")
    with tempfile.TemporaryDirectory() as root:
        # Both sides last agreed on BASE. The local copy has ALSO drifted since
        # then (ordinary local edits) -- exactly what a delta is merged onto.
        local = copy.deepcopy(BASE)
        edit_para(local, 1, 0, "local drift")
        d, pj, bl = seed(root, local, baseline=BASE)
        before = rb(bl)

        # Far side: cuts d1, edits more, cuts d2. ITS baseline stayed BASE, so
        # d2 is cumulative and declares the same ancestor as d1.
        far1 = copy.deepcopy(BASE)
        edit_para(far1, 0, 1, "far edit one")
        d1 = A.make_text_diff(BASE, far1, "demo")
        far2 = copy.deepcopy(far1)
        far2["outline"][0]["children"][0]["title"] = "Renamed by far side"
        d2 = A.make_text_diff(BASE, far2, "demo")
        check(d1["base_sha"] == d2["base_sha"],
              "consecutive diffs declare the same ancestor")

        r1 = A.apply_text_diff(root, d1, dir_name="demo")
        check(r1.get("baseline") == "ok", "first diff applies (baseline ok)")
        check(rb(bl) == before, "baseline byte-identical after the first diff")

        try:
            r2 = A.apply_text_diff(root, d2, dir_name="demo")
            applied2 = r2.get("baseline") == "ok"
        except A.BaselineMismatch as ex:
            applied2 = False
            print("     refused: %s" % ex)
        check(applied2, "SECOND cumulative diff applies too")
        check(rb(bl) == before, "baseline byte-identical after the second diff")

        got = json.load(open(pj, encoding="utf-8"))
        check(got["outline"][0]["children"][1]["blocks"][0]["runs"][0]["t"] == "far edit one"
              and got["outline"][0]["children"][0]["title"] == "Renamed by far side",
              "after d2 the far side's whole cumulative edit has landed")
        check(got["outline"][1]["children"][0]["blocks"][0]["runs"][0]["t"] == "local drift",
              "local drift survives both applies")
        # ...and the merged result equals the far side's state plus the local
        # drift the far side never saw.
        want = copy.deepcopy(far2)
        edit_para(want, 1, 0, "local drift")
        check(canon(got) == canon(want), "merged result == far state + local drift")

    print("== re-pasting the SAME diff is idempotent ==")
    with tempfile.TemporaryDirectory() as root:
        d, pj, bl = seed(root, copy.deepcopy(BASE), baseline=BASE)
        far = copy.deepcopy(BASE)
        edit_para(far, 0, 1, "once")
        diff = A.make_text_diff(BASE, far, "demo")
        A.apply_text_diff(root, diff, dir_name="demo")
        after_first, base_after_first = rb(pj), rb(bl)
        try:
            A.apply_text_diff(root, diff, dir_name="demo")
            ok2 = True
        except A.BaselineMismatch as ex:
            ok2 = False
            print("     refused: %s" % ex)
        check(ok2, "the same diff pasted twice is accepted the second time")
        check(rb(pj) == after_first, "second paste leaves project.json byte-identical")
        check(rb(bl) == base_after_first, "second paste leaves the baseline untouched")

    print("== a full package DOES move the baseline ==")
    with tempfile.TemporaryDirectory() as root:
        d, pj, bl = seed(root, copy.deepcopy(BASE), baseline=BASE)
        incoming = copy.deepcopy(BASE)
        edit_para(incoming, 0, 0, "came in a package")
        zpath = os.path.join(root, "pkg.zip")
        with zipfile.ZipFile(zpath, "w") as zf:
            zf.writestr("update.json",
                        json.dumps({"projects": {"demo": {"mode": "replace"}}}))
            zf.writestr("demo/project.json",
                        json.dumps(incoming, ensure_ascii=False, indent=2))
        A.apply_bundle(root, zpath)
        check(canon(json.load(open(bl, encoding="utf-8"))) == canon(incoming),
              "apply_bundle moves the baseline to the applied report")

    with tempfile.TemporaryDirectory() as root:
        d, pj, bl = seed(root, copy.deepcopy(BASE), baseline=BASE)
        pasted = copy.deepcopy(BASE)
        edit_para(pasted, 1, 0, "came in a paste-import")
        body = json.dumps(pasted, ensure_ascii=False, indent=2).encode("utf-8")
        A.record_replace(root, os.path.join("demo", "project.json"), body)
        check(canon(json.load(open(bl, encoding="utf-8"))) == canon(pasted),
              "record_replace (paste-import) moves the baseline")

    print("== a diff cut from a genuinely different ancestor is still refused ==")
    with tempfile.TemporaryDirectory() as root:
        stale = copy.deepcopy(BASE)
        stale["meta"]["title"] = "an older agreement"
        d, pj, bl = seed(root, copy.deepcopy(BASE), baseline=BASE)
        far = copy.deepcopy(stale)
        edit_para(far, 0, 1, "cut from a state this machine never agreed on")
        diff = A.make_text_diff(stale, far, "demo")
        before_bl, before_pj = rb(bl), rb(pj)
        refused = False
        try:
            A.apply_text_diff(root, diff, dir_name="demo")
        except A.BaselineMismatch:
            refused = True
        check(refused, "mismatched ancestor -> still refused")
        check(rb(bl) == before_bl and rb(pj) == before_pj,
              "a refused diff writes neither project.json nor the baseline")


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

    print("== no-op diff ignores editor UI state & cosmetic table ids ==")
    # The GUI sends stripInternal(current): no _collapsed, but the grid editor has
    # stamped a fresh per-table id on load. The baseline keeps _collapsed and lacks
    # those ids. A no-op must still diff to EMPTY -- the real-world bug report.
    b_col = copy.deepcopy(BASE)
    b_col["outline"][0]["_collapsed"] = True
    b_col["outline"][0]["children"][0]["_collapsed"] = False
    check(A.diff_is_empty(A.make_text_diff(b_col, copy.deepcopy(BASE), "demo")),
          "baseline _collapsed vs stripped current -> empty diff")

    b_tbl = copy.deepcopy(BASE)
    b_tbl["outline"][0]["blocks"].append(
        {"type": "table", "rows": [["a", "b"]], "header_rows": 1})
    c_tbl = copy.deepcopy(b_tbl)
    c_tbl["outline"][0]["blocks"][-1]["id"] = "n-abc123-xyz"     # editor-stamped id
    check(A.diff_is_empty(A.make_text_diff(b_tbl, c_tbl, "demo")),
          "table id stamped on current only -> empty diff")

    both = copy.deepcopy(b_tbl)
    for n in both["outline"]:
        n["_collapsed"] = True
    c_both = copy.deepcopy(BASE)                                 # stripped, no id
    c_both["outline"][0]["blocks"].append(
        {"type": "table", "rows": [["a", "b"]], "header_rows": 1, "id": "n-q9-z"})
    check(A.diff_is_empty(A.make_text_diff(both, c_both, "demo")),
          "_collapsed + table id across the tree -> empty diff")

    print("== a real edit still travels through the noise ==")
    b_mix = copy.deepcopy(BASE)
    b_mix["outline"][1]["_collapsed"] = True
    b_mix["outline"][1]["children"][0]["blocks"].append(
        {"type": "table", "rows": [["x"]], "header_rows": 0})
    c_mix = copy.deepcopy(b_mix)
    del c_mix["outline"][1]["_collapsed"]                        # GUI stripped it
    c_mix["outline"][1]["children"][0]["blocks"][-1]["id"] = "n-t1"   # + table id
    c_mix["outline"][1]["children"][0]["blocks"][0]["runs"][0]["t"] = "EDITED"  # real
    diff = A.make_text_diff(b_mix, c_mix, "demo")
    ops = diff.get("ops") or []
    check(len(ops) == 1 and ops[0].get("node_id") == "s3",
          "mixed edit + noise -> exactly the edited section travels")
    check(all("remove_fields" not in op for op in ops),
          "mixed edit + noise -> no _collapsed leaks into remove_fields")
    proj = copy.deepcopy(b_mix)
    A._apply_text_diff_into(proj, diff)
    check(proj["outline"][1]["children"][0]["blocks"][0]["runs"][0]["t"] == "EDITED",
          "mixed edit + noise -> apply lands the real edit")

    baseline_invariant()

    print("\n== SUMMARY ==  %s" % ("ALL PASSED" if not _fails else "%d FAILED" % len(_fails)))
    return 1 if _fails else 0


if __name__ == "__main__":
    sys.exit(main())
