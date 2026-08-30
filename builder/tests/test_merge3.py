#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Unit tests for sync/merge3.py plus the baseline policy in apply_update.py.

The work machine can only send plain text back, so a returned report is merged
against the ``_baseline.json`` common ancestor. What this file pins down:

  1. disjoint edits on different sections merge with zero conflicts
  2. the same section edited on both sides -> exactly one conflict, and nothing
     is resolved until a choice is applied
  3. apply_choices honours mine / theirs / both
  4. a section renamed on one side and edited on the other still pairs up, and a
     section re-created with a fresh id pairs up by title
  5. nothing is silently dropped -- the merged block count is base + additions
  6. baseline policy: the guard compares the local ``_baseline.json`` CONTENT
     against the package fingerprint -- never the freely drifting project.json --
     so a matching ancestor proceeds even when the local file has moved on, a
     genuinely different ancestor refuses, and a MISSING baseline applies and
     stamps one (a never-exchanged report must not be locked out)
  7. applying a merge leaves a recoverable snapshot
  8. concurrency: a merge carries the fingerprint of the report it was computed
     from, and applying it after something else wrote is REFUSED, not silently
     overwritten
  9. truncation: a returned report missing most of the ancestor is refused
     instead of read as a mass deletion, while one honest deletion still goes
     through and is reported
 10. truncation one level down, and the false positive it must not cause: a
     package cut INSIDE its sections (outline intact, blocks short) is refused
     too; a section that loses most of its blocks on a one-sided change is a
     PENDING decision, never a silent take; every honoured deletion, section or
     block, is in result['deletions']; a COMPLETE report whose sections came back
     with fresh ids and new titles merges cleanly and is not called truncated;
     and the override is reachable under the wire spelling

All fixtures are built in code with neutral placeholder names.

Run:  .venv\\Scripts\\python.exe builder\\tests\\test_merge3.py
"""
import copy
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))   # builder/tests
BUILDER = os.path.dirname(HERE)                     # builder/
if BUILDER not in sys.path:
    sys.path.insert(0, BUILDER)
import buildpath  # noqa: E402,F401  (registers core/docx_io/store/sync/web)

import apply_update as A    # noqa: E402
import merge3 as M          # noqa: E402

_fails = []


def check(cond, msg, detail=""):
    print(("  PASS  " if cond else "  FAIL  ") + msg
          + ("" if cond or not detail else "  -> " + detail))
    if not cond:
        _fails.append(msg)


def canon(o):
    return json.dumps(o, ensure_ascii=False, sort_keys=True)


# ---------------------------------------------------------------------------
# Fixtures (neutral placeholder content only).
# ---------------------------------------------------------------------------


def para(text):
    return {"type": "para", "runs": [{"t": text}]}


def node(nid, title, texts, children=None):
    return {"id": nid, "title": title,
            "blocks": [para(t) for t in texts],
            "children": children or []}


def base_project():
    return {
        "schema_version": 1,
        "meta": {"title": "CLKDIV_5G Stage Report", "author": "owner"},
        "sim_checklist": [{"key": "a", "done": False}],
        "outline": [
            node("c1", "Overview", ["overview intro"], [
                node("s11", "Scope", ["scope body"]),
                node("s12", "Interfaces", ["interface body"]),
            ]),
            node("c2", "Simulation", ["simulation intro"], [
                node("s21", "Setup", ["setup body"]),
                node("s22", "Results", ["results body"]),
            ]),
        ],
    }


def find(project, nid):
    def walk(nodes):
        for n in nodes:
            if n.get("id") == nid:
                return n
            hit = walk(n.get("children") or [])
            if hit:
                return hit
        return None
    return walk(project.get("outline") or [])


def find_by_title(project, title):
    def walk(nodes):
        out = []
        for n in nodes:
            if n.get("title") == title:
                out.append(n)
            out += walk(n.get("children") or [])
        return out
    return walk(project.get("outline") or [])


def texts_of(n):
    return [b["runs"][0]["t"] for b in (n or {}).get("blocks") or []
            if b.get("type") == "para"]


def count_blocks(nodes):
    return sum(len(n.get("blocks") or []) + count_blocks(n.get("children") or [])
               for n in nodes)


def set_text(project, nid, text):
    find(project, nid)["blocks"] = [para(text)]


def seed_report(root, name, project, baseline=None):
    """Write <root>/<name>/project.json, optionally with a _baseline.json."""
    d = os.path.join(root, name)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "project.json"), "w", encoding="utf-8") as fh:
        json.dump(project, fh, ensure_ascii=False, indent=2)
    if baseline is not None:
        with open(os.path.join(d, "_baseline.json"), "w", encoding="utf-8") as fh:
            json.dump(baseline, fh, ensure_ascii=False, indent=2)
    return d


def read_json(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def has_marker(nodes):
    for n in nodes:
        if any(str(k).startswith("_conflict") for k in n):
            return True
        if has_marker(n.get("children") or []):
            return True
    return False


# ---------------------------------------------------------------------------
# 1. Disjoint edits.
# ---------------------------------------------------------------------------


def test_disjoint():
    print("== 1. disjoint edits on different sections ==")
    base = base_project()
    mine, theirs = copy.deepcopy(base), copy.deepcopy(base)
    set_text(mine, "s11", "scope edited locally")
    set_text(theirs, "s21", "setup edited over there")

    res = M.merge3(base, mine, theirs)
    merged = res["merged"]
    check(res["conflicts"] == [], "no conflicts", canon(res["conflicts"])[:200])
    check(res["pending"] == 0, "pending == 0")
    check(texts_of(find(merged, "s11")) == ["scope edited locally"],
          "local edit survives", canon(texts_of(find(merged, "s11"))))
    check(texts_of(find(merged, "s21")) == ["setup edited over there"],
          "returned edit is taken", canon(texts_of(find(merged, "s21"))))
    check(texts_of(find(merged, "s12")) == ["interface body"],
          "untouched section unchanged")
    check(not has_marker(merged["outline"]), "no conflict marker left behind")
    check(res["auto"] >= 2, "auto count reports the resolved sections",
          str(res["auto"]))


# ---------------------------------------------------------------------------
# 2. Same section on both sides.
# ---------------------------------------------------------------------------


def both_edit_case():
    base = base_project()
    mine, theirs = copy.deepcopy(base), copy.deepcopy(base)
    set_text(mine, "s12", "interface body, local wording")
    set_text(theirs, "s12", "interface body, returned wording")
    return base, mine, theirs


def test_both_sides():
    print("== 2. the same section edited on both sides ==")
    base, mine, theirs = both_edit_case()
    res = M.merge3(base, mine, theirs)
    merged = res["merged"]

    check(len(res["conflicts"]) == 1, "exactly one conflict",
          canon([c["id"] for c in res["conflicts"]]))
    if not res["conflicts"]:
        return
    c = res["conflicts"][0]
    check(c["node_id"] == "s12", "conflict names the section", str(c["node_id"]))
    check(c["kind"] == "blocks", "conflict kind is blocks", str(c["kind"]))
    check(res["pending"] == 1, "pending == 1")

    # The ancestor rides on the conflict, so the pre-merge state of the section
    # is always recoverable from what merge3 returns.
    check(canon(c["base"]) == canon(A._node_own(find(base, "s12"))),
          "conflict carries the common ancestor of the section")
    check(canon(c["mine"]) == canon(A._node_own(find(mine, "s12"))),
          "conflict carries the local version")
    check(canon(c["theirs"]) == canon(A._node_own(find(theirs, "s12"))),
          "conflict carries the returned version")

    got = texts_of(find(merged, "s12"))
    check(got != texts_of(find(theirs, "s12")),
          "the returned version is NOT taken automatically", canon(got))
    check(got == texts_of(find(mine, "s12")),
          "unresolved section holds the local version provisionally", canon(got))
    marker = find(merged, "s12").get(M.CONFLICT_KEY)
    check(isinstance(marker, dict) and marker.get("id") == c["id"],
          "the section carries the marker apply_choices needs")
    check(texts_of(find(merged, "s21")) == ["setup body"],
          "sections neither side touched are untouched")


# ---------------------------------------------------------------------------
# 3. apply_choices: mine / theirs / both.
# ---------------------------------------------------------------------------


def apply_case(root, name, pick):
    base, mine, theirs = both_edit_case()
    res = M.merge3(base, mine, theirs)
    cid = res["conflicts"][0]["id"]
    d = seed_report(root, name, mine, baseline=base)
    out = M.apply_choices(d, res["merged"], {cid: pick})
    return d, out, read_json(os.path.join(d, "project.json")), mine, theirs


def test_apply_choices():
    print("== 3. apply_choices mine / theirs / both ==")
    with tempfile.TemporaryDirectory() as root:
        d, out, written, mine, theirs = apply_case(root, "keep_mine", "mine")
        check(out.get("ok") is True, "mine -> ok", canon(out))
        check(texts_of(find(written, "s12")) == texts_of(find(mine, "s12")),
              "mine -> local version written",
              canon(texts_of(find(written, "s12"))))

        d, out, written, mine, theirs = apply_case(root, "keep_theirs", "theirs")
        check(texts_of(find(written, "s12")) == texts_of(find(theirs, "s12")),
              "theirs -> returned version written",
              canon(texts_of(find(written, "s12"))))
        check(out.get("applied") == 1, "theirs -> one decision applied",
              canon(out))

        d, out, written, mine, theirs = apply_case(root, "keep_both", "both")
        want = texts_of(find(mine, "s12")) + texts_of(find(theirs, "s12"))
        check(texts_of(find(written, "s12")) == want,
              "both -> local blocks then returned blocks",
              canon(texts_of(find(written, "s12"))))

        check(not has_marker(written["outline"]),
              "written project.json carries no conflict marker")
        check(M.TOP_CONFLICT_KEY not in written,
              "written project.json carries no top-level marker")
        check(os.path.isfile(os.path.join(d, "_baseline.json")),
              "apply re-stamps the baseline")
        stamped = read_json(os.path.join(d, "_baseline.json"))
        check(canon(stamped) == canon(written),
              "the stamped baseline is the written state")

        # the server posts choices as a list of objects; that shape works too
        base, mine, theirs = both_edit_case()
        res = M.merge3(base, mine, theirs)
        cid = res["conflicts"][0]["id"]
        d2 = seed_report(root, "MODULE_A", mine, baseline=base)
        M.apply_choices(d2, res["merged"], [{"id": cid, "choice": "theirs"}])
        w2 = read_json(os.path.join(d2, "project.json"))
        check(texts_of(find(w2, "s12")) == texts_of(find(theirs, "s12")),
              "choices as a list of {id, choice} works too")


# ---------------------------------------------------------------------------
# 4. Matching: rename on one side, and the title fallback.
# ---------------------------------------------------------------------------


def test_matching():
    print("== 4. renamed / re-created sections still pair up ==")
    base = base_project()
    mine, theirs = copy.deepcopy(base), copy.deepcopy(base)
    find(theirs, "s12")["title"] = "Interfaces and Ports"    # renamed over there
    set_text(mine, "s12", "interface body, local wording")   # edited here

    res = M.merge3(base, mine, theirs)
    merged = res["merged"]
    kids = find(merged, "c1")["children"]
    check(len(kids) == 2, "renamed + edited section is not duplicated",
          canon([k.get("title") for k in kids]))
    check(len(res["conflicts"]) == 1,
          "renamed + edited raises exactly one conflict",
          canon([c["kind"] for c in res["conflicts"]]))
    if res["conflicts"]:
        check(res["conflicts"][0]["node_id"] == "s12",
              "the conflict is on the matched section")

    # Title fallback: the returned report re-created the section under a fresh id
    # (ids drift through the text channel), and nothing changed locally.
    base2 = base_project()
    mine2, theirs2 = copy.deepcopy(base2), copy.deepcopy(base2)
    tgt = find(theirs2, "s12")
    tgt["id"] = "n-regenerated-01"
    tgt["blocks"] = [para("interface body, returned wording")]

    res2 = M.merge3(base2, mine2, theirs2)
    merged2 = res2["merged"]
    kids2 = find(merged2, "c1")["children"]
    check(len(kids2) == 2, "id drift does not duplicate the section",
          canon([k.get("title") for k in kids2]))
    check(res2["conflicts"] == [], "id drift alone is not a conflict",
          canon([c["kind"] for c in res2["conflicts"]]))
    hits = find_by_title(merged2, "Interfaces")
    check(len(hits) == 1
          and texts_of(hits[0]) == ["interface body, returned wording"],
          "matched by title -> the returned edit is taken",
          canon([texts_of(h) for h in hits]))


# ---------------------------------------------------------------------------
# 5. Nothing is silently dropped.
# ---------------------------------------------------------------------------


def test_no_silent_drop():
    print("== 5. nothing is silently dropped ==")
    base = base_project()
    mine, theirs = copy.deepcopy(base), copy.deepcopy(base)

    base_blocks = count_blocks(base["outline"])
    # local: one extra block in an existing section + a whole new subsection
    find(mine, "s11")["blocks"].append(para("scope addendum"))
    find(mine, "c1")["children"].append(node("s13", "Constraints", ["limits body"]))
    # returned: one extra block elsewhere + a new top chapter
    find(theirs, "s22")["blocks"].append(para("results addendum"))
    theirs["outline"].append(node("c3", "Conclusion", ["closing body"]))
    added = 4        # two loose blocks + one block in each new section

    res = M.merge3(base, mine, theirs)
    merged = res["merged"]
    got = count_blocks(merged["outline"])
    check(got == base_blocks + added,
          "merged block count == base + additions from both sides",
          "got %d, want %d" % (got, base_blocks + added))
    check(res["conflicts"] == [], "additions on both sides are not a conflict",
          canon([c["kind"] for c in res["conflicts"]]))
    for nid in ("s11", "s12", "s21", "s22", "s13", "c3"):
        check(find(merged, nid) is not None, "section %s survives the merge" % nid)

    # ... and the same holds once the decisions are written out
    with tempfile.TemporaryDirectory() as root:
        d = seed_report(root, "TXBUF_2G", mine, baseline=base)
        M.apply_choices(d, merged, {})
        written = read_json(os.path.join(d, "project.json"))
        check(count_blocks(written["outline"]) == base_blocks + added,
              "the written project keeps every block",
              str(count_blocks(written["outline"])))


# ---------------------------------------------------------------------------
# 6. Baseline policy (apply_update).
# ---------------------------------------------------------------------------


def test_baseline_policy():
    print("== 6. baseline policy: match / mismatch / missing ==")
    base = base_project()
    edited = copy.deepcopy(base)
    set_text(edited, "s11", "scope edited upstream")
    diff = A.make_text_diff(base, edited, "CLKDIV_5G")

    # (a) fingerprints agree -> apply proceeds
    with tempfile.TemporaryDirectory() as root:
        d = seed_report(root, "CLKDIV_5G", base, baseline=base)
        res = A.apply_text_diff(root, diff, dir_name="CLKDIV_5G")
        check(res.get("baseline") == "ok", "matching sha -> baseline 'ok'",
              str(res.get("baseline")))
        check(res.get("base_match") is True, "matching sha -> base_match True")
        got = read_json(os.path.join(d, "project.json"))
        check(texts_of(find(got, "s11")) == ["scope edited upstream"],
              "matching sha -> the diff is applied")

    # (a2) the local project.json has drifted since the last exchange, but both
    # sides still name the SAME ancestor -> apply, and merge onto the drift.
    # Local drift is the normal state of a report (saves + content-filling
    # scripts rewrite project.json and nothing re-stamps the baseline), so if this
    # case ever refuses again the upstream channel is dead for every real report.
    with tempfile.TemporaryDirectory() as root:
        drifted = copy.deepcopy(base)
        set_text(drifted, "s22", "results rewritten locally")
        d = seed_report(root, "CLKDIV_5G", drifted, baseline=base)
        rel = os.path.join("CLKDIV_5G", "project.json")
        check(A.project_sha(os.path.join(root, rel)) != diff["base_sha"],
              "fixture really has a drifted project.json")
        res = A.apply_text_diff(root, diff, dir_name="CLKDIV_5G")
        check(res.get("baseline") == "ok",
              "drifted file + matching ancestor -> baseline 'ok'",
              str(res.get("baseline")))
        check(res.get("base_match") is False,
              "drift is still reported (base_match False), it just is not the guard")
        got = read_json(os.path.join(d, "project.json"))
        check(texts_of(find(got, "s11")) == ["scope edited upstream"],
              "drifted file + matching ancestor -> the diff is applied",
              canon(texts_of(find(got, "s11"))))
        check(texts_of(find(got, "s22")) == ["results rewritten locally"],
              "drifted file + matching ancestor -> the local edit survives",
              canon(texts_of(find(got, "s22"))))

    # (b) the two sides name DIFFERENT ancestors -> refuse. The local baseline
    # holds a state the package was never cut from.
    with tempfile.TemporaryDirectory() as root:
        other_ancestor = copy.deepcopy(base)
        set_text(other_ancestor, "s21", "setup as of some other exchange")
        d = seed_report(root, "CLKDIV_5G", base, baseline=other_ancestor)
        before = read_json(os.path.join(d, "project.json"))
        raised = None
        try:
            A.apply_text_diff(root, diff, dir_name="CLKDIV_5G")
        except A.BaselineMismatch as exc:
            raised = exc
        check(raised is not None, "mismatched sha -> BaselineMismatch raised")
        if raised is not None:
            check(raised.packageBase == diff.get("base_sha"),
                  "mismatch carries the package fingerprint")
            check(bool(raised.localBase) and raised.localBase != raised.packageBase,
                  "mismatch carries the local fingerprint")
            check(raised.localBase
                  == A.project_sha(os.path.join(d, "_baseline.json")),
                  "the local fingerprint is the BASELINE, not project.json",
                  "%s vs project.json %s"
                  % (raised.localBase,
                     A.project_sha(os.path.join(d, "project.json"))))
            check(raised.dir == "CLKDIV_5G", "mismatch names the report")
            check(raised.as_dict().get("error") == "baseline_mismatch",
                  "mismatch renders for the HTTP layer", canon(raised.as_dict()))
        after = read_json(os.path.join(d, "project.json"))
        check(canon(after) == canon(before),
              "a refused apply leaves project.json untouched")

    # (c) never exchanged: no _baseline.json at all -> apply anyway, then stamp
    with tempfile.TemporaryDirectory() as root:
        drifted = copy.deepcopy(base)
        set_text(drifted, "s22", "results rewritten locally")
        d = seed_report(root, "MODULE_A", drifted)      # no baseline seeded
        check(not os.path.isfile(os.path.join(d, "_baseline.json")),
              "fixture really has no baseline")
        diff2 = A.make_text_diff(base, edited, "MODULE_A")
        res = A.apply_text_diff(root, diff2, dir_name="MODULE_A")
        check(res.get("ok") is True, "missing baseline -> apply succeeds",
              canon(res))
        check(res.get("baseline") == "no_baseline",
              "missing baseline is reported as its own case",
              str(res.get("baseline")))
        got = read_json(os.path.join(d, "project.json"))
        check(texts_of(find(got, "s11")) == ["scope edited upstream"],
              "missing baseline -> the diff is applied")
        check(texts_of(find(got, "s22")) == ["results rewritten locally"],
              "missing baseline -> the untouched local edit is kept")
        check(os.path.isfile(os.path.join(d, "_baseline.json")),
              "missing baseline -> a baseline is stamped for next time")
        snaps = os.path.join(d, A.AUTOSAVE_DIRNAME)
        check(os.path.isdir(snaps) and bool(os.listdir(snaps)),
              "missing baseline -> a snapshot is taken before writing")

    # The raw guard, straight from check_baseline -- on a report whose local file
    # has drifted away from its baseline, so the two candidate fingerprints are
    # different and the guard cannot pass by accident.
    with tempfile.TemporaryDirectory() as root:
        drifted = copy.deepcopy(base)
        set_text(drifted, "s22", "results rewritten locally")
        d = seed_report(root, "TXBUF_2G", drifted, baseline=base)
        rel = os.path.join("TXBUF_2G", "project.json")
        ancestor = A.project_sha(os.path.join(d, "_baseline.json"))
        current = A.project_sha(os.path.join(root, rel))
        check(ancestor != current, "fixture: baseline and project.json differ")
        has, local = A.baseline_state(root, rel)
        check(has and local == ancestor,
              "baseline_state reports the BASELINE's fingerprint",
              "%s (project.json is %s)" % (local, current))
        check(A.check_baseline(root, rel, ancestor, "TXBUF_2G") == "ok",
              "check_baseline: package cut from the same ancestor -> ok")
        check(A.check_baseline(root, rel, None, "TXBUF_2G") == "no_fingerprint",
              "check_baseline: no fingerprint in the package -> no_fingerprint")
        try:
            A.check_baseline(root, rel, current, "TXBUF_2G")
            check(False, "check_baseline: the CURRENT file's sha is not the guard")
        except A.BaselineMismatch:
            check(True, "check_baseline: the CURRENT file's sha is not the guard")
        try:
            A.check_baseline(root, rel, "0" * 40, "TXBUF_2G")
            check(False, "check_baseline: stale fingerprint -> raises")
        except A.BaselineMismatch:
            check(True, "check_baseline: stale fingerprint -> raises")


# ---------------------------------------------------------------------------
# 7. Applying a merge stays undoable.
# ---------------------------------------------------------------------------


def test_snapshot():
    print("== 7. apply_choices leaves a recoverable snapshot ==")
    base, mine, theirs = both_edit_case()
    res = M.merge3(base, mine, theirs)
    cid = res["conflicts"][0]["id"]
    with tempfile.TemporaryDirectory() as root:
        d = seed_report(root, "CLKDIV_5G", mine, baseline=base)
        before = read_json(os.path.join(d, "project.json"))
        out = M.apply_choices(d, res["merged"], {cid: "theirs"})
        snap = out.get("snapshot")
        check(bool(snap), "apply_choices reports a snapshot path", canon(out))
        check(bool(snap) and os.path.isfile(snap), "the snapshot file exists",
              str(snap))
        written = read_json(os.path.join(d, "project.json"))
        if snap and os.path.isfile(snap):
            check(canon(read_json(snap)) == canon(before),
                  "the snapshot holds the pre-merge report")
            check(canon(read_json(snap)) != canon(written),
                  "so the snapshot is a genuine restore point")
        check(canon(written) != canon(before),
              "the merge really changed the report")


# ---------------------------------------------------------------------------
# 8. Concurrency: something else wrote while the user was deciding.
# ---------------------------------------------------------------------------


def test_stale_merge():
    print("== 8. a write that lands mid-merge is not overwritten ==")
    base, mine, theirs = both_edit_case()
    res = M.merge3(base, mine, theirs)
    cid = res["conflicts"][0]["id"]
    token = res.get("base_sha")
    check(bool(token), "merge3 returns the fingerprint it merged from",
          str(token))
    check(res["merged"].get(M.BASE_SHA_KEY) == token,
          "the token rides on the merged object through the round trip")

    with tempfile.TemporaryDirectory() as root:
        # (a) something else writes between the merge and the apply
        d = seed_report(root, "CLKDIV_5G", mine, baseline=base)
        check(A.project_sha(os.path.join(d, "project.json")) == token,
              "the token fingerprints the project.json on disk")
        meanwhile = copy.deepcopy(mine)
        set_text(meanwhile, "s22", "results rewritten by an autosave")
        seed_report(root, "CLKDIV_5G", meanwhile, baseline=base)
        before = read_json(os.path.join(d, "project.json"))
        out = M.apply_choices(d, res["merged"], {cid: "theirs"})
        check(out.get("ok") is not True, "stale token -> apply refuses",
              canon(out))
        check(out.get("error") == "stale_merge",
              "stale token -> the caller can tell why", str(out.get("error")))
        after = read_json(os.path.join(d, "project.json"))
        check(canon(after) == canon(before),
              "a refused apply writes nothing at all")
        check(texts_of(find(after, "s22")) == ["results rewritten by an autosave"],
              "the write that landed mid-merge survives",
              canon(texts_of(find(after, "s22"))))

        # (b) nothing wrote in between -> the same merge applies normally
        d2 = seed_report(root, "MODULE_A", mine, baseline=base)
        out2 = M.apply_choices(d2, res["merged"], {cid: "theirs"})
        check(out2.get("ok") is True, "fresh token -> apply succeeds", canon(out2))
        w2 = read_json(os.path.join(d2, "project.json"))
        check(texts_of(find(w2, "s12")) == texts_of(find(theirs, "s12")),
              "fresh token -> the decision is written",
              canon(texts_of(find(w2, "s12"))))
        check(M.BASE_SHA_KEY not in w2,
              "the token is stripped before the write")

        # (c) a merged object with no token at all is not a licence to overwrite
        naked = copy.deepcopy(res["merged"])
        naked.pop(M.BASE_SHA_KEY, None)
        d3 = seed_report(root, "TXBUF_2G", mine, baseline=base)
        out3 = M.apply_choices(d3, naked, {cid: "theirs"})
        check(out3.get("ok") is not True, "no token -> apply refuses", canon(out3))
        check(canon(read_json(os.path.join(d3, "project.json"))) == canon(mine),
              "no token -> nothing is written")
        # ... and the token may also be supplied out of band
        out4 = M.apply_choices(d3, naked, {cid: "theirs"}, base_sha=token)
        check(out4.get("ok") is True, "an explicit token applies", canon(out4))


# ---------------------------------------------------------------------------
# 9. Truncation vs. an honest deletion.
# ---------------------------------------------------------------------------


def test_truncated_incoming():
    print("== 9. a truncated package is refused, an honest deletion is not ==")
    base = base_project()
    mine = copy.deepcopy(base)

    # The paste stopped halfway: it still parses and still has an outline, so
    # every section past the cut reads as a deletion.
    cut = copy.deepcopy(base)
    cut["outline"] = cut["outline"][:1]
    res = M.merge3(base, mine, cut)
    check(bool(res.get("error")), "a half report is refused", canon(res.get("error")))
    check((res.get("truncated") or {}).get("missing") == 3,
          "the refusal counts the missing sections", canon(res.get("truncated")))
    check(res["conflicts"] == [], "a refusal raises no conflicts")
    for nid in ("c2", "s21", "s22"):
        check(find(res["merged"], nid) is not None,
              "section %s is NOT dropped by a refused merge" % nid)
    check(M.BASE_SHA_KEY not in res["merged"],
          "a refused merge carries no token, so it cannot be applied")

    # ... and the truncated body never reaches disk either
    with tempfile.TemporaryDirectory() as root:
        d = seed_report(root, "CLKDIV_5G", mine, baseline=base)
        out = M.apply_choices(d, res["merged"], {})
        check(out.get("ok") is not True,
              "the merged body of a refused merge cannot be written", canon(out))
        check(canon(read_json(os.path.join(d, "project.json"))) == canon(mine),
              "a refused merge leaves project.json untouched")

    # An explicit override still lets a genuine bulk deletion through.
    forced = M.merge3(base, mine, cut, allow_bulk_delete=True)
    check(not forced.get("error"), "the override merges it anyway",
          canon(forced.get("error")))
    check(find(forced["merged"], "c2") is None,
          "the override really honours the deletions")

    # One section deleted over there, untouched here -> honoured AND reported.
    one = copy.deepcopy(base)
    one["outline"][0]["children"] = [c for c in one["outline"][0]["children"]
                                     if c.get("id") != "s12"]
    res2 = M.merge3(base, mine, one)
    check(not res2.get("error"), "one deleted section is not read as truncation",
          canon(res2.get("error")))
    check(find(res2["merged"], "s12") is None,
          "the single deletion is honoured")
    dels = res2.get("deletions") or []
    check(len(dels) == 1, "the honoured deletion is reported", canon(dels))
    if dels:
        check(dels[0].get("node_id") == "s12"
              and dels[0].get("title") == "Interfaces",
              "the report names the section that went away", canon(dels[0]))
        check(dels[0].get("side") == "theirs",
              "and which side dropped it", canon(dels[0]))
    check(res["merged"].get(M.CONFLICT_KEY) is None,
          "an honoured deletion is not turned into a conflict")


# ---------------------------------------------------------------------------
# 10. Truncation INSIDE the sections, and the false positive it must not cause.
# ---------------------------------------------------------------------------


def long_report(chapters=3, blocks=30):
    """A report big enough for a cut to be measurable in blocks: every chapter
    carries a whole page of passages, and nothing but passages."""
    return {"schema_version": 1,
            "meta": {"title": "CLKDIV_5G Stage Report"},
            "outline": [node("c%d" % i, "Chapter %d" % i,
                             ["chapter %d passage %d" % (i, k)
                              for k in range(blocks)])
                        for i in range(1, chapters + 1)]}


def test_truncated_inside_sections():
    print("== 10a. a package cut INSIDE its sections is refused ==")
    base = long_report()
    mine = copy.deepcopy(base)
    # The paste stopped inside each section: every section is still there, so a
    # section count sees nothing at all, and only the blocks are short.
    cut = copy.deepcopy(base)
    for n in cut["outline"]:
        n["blocks"] = n["blocks"][:2]

    res = M.merge3(base, mine, cut)
    check(M._count_sections(cut["outline"])
          == M._count_sections(base["outline"]),
          "fixture: the outline is intact, only the blocks are short",
          "%d blocks vs %d" % (count_blocks(cut["outline"]),
                               count_blocks(base["outline"])))
    check(res.get("error") == "truncated",
          "a package cut inside its sections is refused", canon(res.get("error")))
    trunc = res.get("truncated") or {}
    check(trunc.get("kind") == "blocks",
          "the refusal names the shape of the cut", canon(trunc))
    check(trunc.get("missing") == 84 and trunc.get("total") == 90,
          "the refusal counts the missing blocks", canon(trunc))
    check(bool(trunc.get("detail")),
          "the refusal can be shown to the user", canon(trunc))
    check(trunc.get("override") == "allowBulkDelete",
          "the refusal names the override, under its wire spelling",
          canon(trunc))
    check(count_blocks(res["merged"]["outline"]) == 90,
          "a refused merge keeps every block",
          str(count_blocks(res["merged"]["outline"])))
    check(M.BASE_SHA_KEY not in res["merged"] and res.get("token") is None,
          "a refused merge carries no token, so it cannot be applied",
          canon(res.get("token")))

    # ... and the override still gets a genuine bulk deletion through, with every
    # dropped block recorded.
    forced = M.merge3(base, mine, cut, allowBulkDelete=True)
    check(not forced.get("error"),
          "allowBulkDelete merges a genuinely bulk-deleting package",
          canon(forced.get("error")))
    check(count_blocks(forced["merged"]["outline"]) == 6,
          "the override really honours the block deletions",
          str(count_blocks(forced["merged"]["outline"])))
    dels = forced.get("deletions") or []
    check(len(dels) == 3 and all(d.get("kind") == "blocks" for d in dels),
          "every section that lost blocks is recorded", canon(dels)[:300])
    check(sum(d.get("blocks", 0) for d in dels) == 84,
          "and the record accounts for all 84 blocks", canon(dels)[:300])
    check(M.merge3(base, mine, cut, allow_bulk_delete=True).get("error") is None,
          "the python spelling of the override still works")
    raised = None
    try:
        M.merge3(base, mine, cut, allowbulkdelete=True)
    except TypeError as exc:
        raised = exc
    check(raised is not None,
          "a misspelled override is a loud error, not a silent refusal")


def test_section_block_collapse():
    print("== 10b. one section losing most of its blocks is a decision ==")
    base = base_project()
    find(base, "s21")["blocks"] = [para("setup step %d" % k) for k in range(10)]
    mine = copy.deepcopy(base)
    theirs = copy.deepcopy(base)
    # Seven of ten blocks gone from ONE section, nothing touched locally. Under
    # the whole-report floor, so only the per-section rule can catch it.
    find(theirs, "s21")["blocks"] = find(theirs, "s21")["blocks"][:3]

    res = M.merge3(base, mine, theirs)
    check(res.get("error") is None,
          "the whole-report guard does not fire on one section",
          canon(res.get("error")))
    check(res["pending"] == 1 and len(res["conflicts"]) == 1,
          "a collapsed section is a pending decision, not a silent take",
          canon([c.get("id") for c in res["conflicts"]]))
    if res["conflicts"]:
        c = res["conflicts"][0]
        check(c.get("node_id") == "s21", "the decision names the section",
              str(c.get("node_id")))
        check(c.get("reason") == "blocks_removed" and c.get("removed_blocks") == 7,
              "and says how much the returned version drops", canon(c)[:200])
    check(len(texts_of(find(res["merged"], "s21"))) == 10,
          "until it is decided the local blocks are still there",
          str(len(texts_of(find(res["merged"], "s21")))))
    check((res.get("deletions") or []) == [],
          "a pending decision is not also reported as an honoured deletion",
          canon(res.get("deletions")))

    # Deciding for the returned version applies it, exactly like any conflict.
    with tempfile.TemporaryDirectory() as root:
        d = seed_report(root, "CLKDIV_5G", mine, baseline=base)
        cid = res["conflicts"][0]["id"]
        out = M.apply_choices(d, res["merged"], {cid: "theirs"})
        check(out.get("ok") is True, "the decision applies", canon(out))
        written = read_json(os.path.join(d, "project.json"))
        check(len(texts_of(find(written, "s21"))) == 3,
              "'theirs' writes the shorter section",
              str(len(texts_of(find(written, "s21")))))


def test_honoured_deletions_are_reported():
    print("== 10c. every honoured deletion leaves a trace ==")
    # (a) one whole section, dropped over there, untouched here
    base = base_project()
    mine = copy.deepcopy(base)
    theirs = copy.deepcopy(base)
    theirs["outline"][1]["children"] = [c for c in theirs["outline"][1]["children"]
                                        if c.get("id") != "s22"]
    res = M.merge3(base, mine, theirs)
    check(res.get("error") is None, "one section deleted is not a truncation",
          canon(res.get("error")))
    check(find(res["merged"], "s22") is None, "the section deletion is honoured")
    dels = res.get("deletions") or []
    check(len(dels) == 1, "the section deletion is reported", canon(dels))
    if dels:
        check(dels[0].get("kind") == "section"
              and dels[0].get("node_id") == "s22"
              and dels[0].get("title") == "Results"
              and dels[0].get("side") == "theirs"
              and dels[0].get("blocks") == 1,
              "the record names the section, the side and its size", canon(dels[0]))

    # (b) one block, dropped from a section that stays
    base2 = base_project()
    find(base2, "s11")["blocks"] = [para("scope step %d" % k) for k in range(4)]
    mine2 = copy.deepcopy(base2)
    theirs2 = copy.deepcopy(base2)
    find(theirs2, "s11")["blocks"] = find(theirs2, "s11")["blocks"][:3]

    res2 = M.merge3(base2, mine2, theirs2)
    check(res2.get("error") is None, "one dropped block is not a truncation",
          canon(res2.get("error")))
    check(res2["conflicts"] == [],
          "a small one-sided prune is still taken automatically",
          canon([c.get("kind") for c in res2["conflicts"]]))
    check(len(texts_of(find(res2["merged"], "s11"))) == 3,
          "the block deletion is honoured",
          str(len(texts_of(find(res2["merged"], "s11")))))
    dels2 = res2.get("deletions") or []
    check(len(dels2) == 1, "the block deletion is reported", canon(dels2))
    if dels2:
        check(dels2[0].get("kind") == "blocks"
              and dels2[0].get("node_id") == "s11"
              and dels2[0].get("title") == "Scope"
              and dels2[0].get("blocks") == 1
              and dels2[0].get("side") == "theirs",
              "the record names the section, the side and how much went",
              canon(dels2[0]))


def test_recreated_ids_are_not_truncation():
    print("== 10d. a complete report with fresh ids + retitles is not a cut ==")
    base = base_project()
    base["outline"].append(node("c3", "Conclusion", ["closing body"]))
    mine = copy.deepcopy(base)
    theirs = copy.deepcopy(base)

    # The other side re-created the whole outline: every node id is new, and
    # several sections were retitled while they were at it. Nothing was lost.
    counter = [0]

    def renumber(nodes):
        for n in nodes:
            counter[0] += 1
            n["id"] = "n-fresh-%02d" % counter[0]
            renumber(n["children"])

    renumber(theirs["outline"])
    find_by_title(theirs, "Interfaces")[0]["title"] = "Interfaces and Ports"
    find_by_title(theirs, "Simulation")[0]["title"] = "Simulation and Verification"
    find_by_title(theirs, "Conclusion")[0]["title"] = "Closing Remarks"

    res = M.merge3(base, mine, theirs)
    check(res.get("error") is None,
          "a complete report is NOT refused as truncated",
          canon(res.get("error")))
    check(res.get("truncated") is None,
          "and the answer says so explicitly", canon(res.get("truncated")))
    merged = res["merged"]
    check(M._count_sections(merged["outline"]) == 7,
          "no section is duplicated and none is dropped",
          str(M._count_sections(merged["outline"])))
    check(count_blocks(merged["outline"]) == count_blocks(base["outline"]),
          "every block survives",
          "%d vs %d" % (count_blocks(merged["outline"]),
                        count_blocks(base["outline"])))
    check(res["conflicts"] == [], "re-creation alone raises no conflict",
          canon([c.get("kind") for c in res["conflicts"]]))
    check((res.get("deletions") or []) == [],
          "and nothing is reported as deleted", canon(res.get("deletions")))
    for title in ("Interfaces and Ports", "Simulation and Verification",
                  "Closing Remarks"):
        hits = find_by_title(merged, title)
        check(len(hits) == 1, "the retitled section '%s' is taken once" % title,
              str(len(hits)))
    check(find_by_title(merged, "Interfaces") == [],
          "the old title does not survive alongside the new one")
    check(bool(res.get("token")), "a clean merge hands out a token",
          canon(res.get("token")))


def main():
    test_disjoint()
    test_both_sides()
    test_apply_choices()
    test_matching()
    test_no_silent_drop()
    test_baseline_policy()
    test_snapshot()
    test_stale_merge()
    test_truncated_incoming()
    test_truncated_inside_sections()
    test_section_block_collapse()
    test_honoured_deletions_are_reported()
    test_recreated_ids_are_not_truncation()
    print("\n== SUMMARY ==  %s"
          % ("ALL PASSED" if not _fails else "%d FAILED" % len(_fails)))
    for f in _fails:
        print("   FAILED: " + f)
    return 1 if _fails else 0


if __name__ == "__main__":
    sys.exit(main())
