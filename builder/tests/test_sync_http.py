#!/usr/bin/env python3
"""Regression tests for the upstream exchange HTTP surface.

The work machine can only send plain text back, so /api/apply-update and the
two merge endpoints ARE the upstream channel. These tests pin the two rules
that channel breaks on when they drift:

1. THE BASELINE RULE lives in exactly one place, apply_update.check_baseline,
   and it compares LIKE WITH LIKE: the content of the local ``_baseline.json``
   (the state both sides last agreed on) against the ``base_sha`` the package
   declares it was cut from. It must never fingerprint the CURRENT
   project.json: local drift since the last exchange is expected, and is
   precisely what an incoming op-diff is merged onto. A server that measured
   the package against the live file refused every report edited since its last
   exchange -- in practice all of them -- so test_drifted_report_still_applies
   below fails against that behaviour, as does the localBase assertion in
   test_real_mismatch_is_refused.

2. A REFUSED APPLY WRITES NOTHING. /api/merge3-apply used to take its snapshot
   before validating, so a request that was then turned away still left a file
   behind; test_apply_without_token_writes_nothing fails against that.

3. UNDO ACTS ON THE REPORT THE SCREEN IS SHOWING. ``_backups/`` is one history
   for the whole root, so its newest entry belongs to whichever report was
   written last -- not necessarily the open one. /api/rollback used to ignore
   the ``dir`` its caller sends and restore that newest entry regardless, which
   silently reverted another report while reporting the open one as restored;
   test_rollback_is_scoped_to_the_open_report fails against that.

Run:  python builder/tests/test_sync_http.py
"""

import copy
import glob
import hashlib
import json
import os
import shutil
import sys
import tempfile
import threading
import time
from urllib.request import Request, urlopen
from urllib.error import HTTPError

HERE = os.path.dirname(os.path.abspath(__file__))       # builder/tests
BUILDER = os.path.dirname(HERE)                         # builder/
if BUILDER not in sys.path:
    sys.path.insert(0, BUILDER)
import buildpath  # noqa: E402,F401  (registers core/docx_io/store/sync/web)

import apply_update  # noqa: E402  (builder/sync)
import server        # noqa: E402  (builder/web)

PORT = 8797
BASE = "http://127.0.0.1:%d" % PORT

FAILURES = []


def check(name, cond, detail=""):
    if cond:
        print("  [ok  ] %s" % name)
    else:
        FAILURES.append(name)
        print("  [FAIL] %s %s" % (name, detail))


def post(path, body):
    return _send("POST", path, body)


def put(path, body):
    return _send("PUT", path, body)


def get(path):
    return _send("GET", path, None)


def _send(method, path, body):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = Request(BASE + path, data=data,
                  headers={"Content-Type": "application/json"}, method=method)
    try:
        with urlopen(req) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except HTTPError as exc:
        raw = exc.read().decode("utf-8")
        try:
            return exc.code, json.loads(raw)
        except ValueError:
            return exc.code, raw


# ---------------------------------------------------------------------------
# Fixtures: a small neutral report, its baseline, and some local drift.
# ---------------------------------------------------------------------------


def sample_report():
    def section(i):
        return {"id": "n%d" % i, "title": "Section %d" % i,
                "blocks": [{"type": "para",
                            "runs": [{"t": "Body text %d." % i}]}],
                "children": []}
    return {"meta": {"title": "Sample Report", "stage": "check"},
            "outline": [section(i) for i in range(1, 7)]}


def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False, indent=2)


def digest(path):
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def snapshots(project_dir):
    return sorted(os.path.basename(p) for p in
                  glob.glob(os.path.join(project_dir, "_autosave", "*")))


def make_report(root, name, drift=True, baseline=True):
    """A report as it really is on this machine: exchanged once (so it has a
    baseline) and edited since (so project.json no longer equals it)."""
    pdir = os.path.join(root, name)
    agreed = sample_report()
    if baseline:
        write_json(os.path.join(pdir, "_baseline.json"), agreed)
    current = copy.deepcopy(agreed)
    if drift:
        current["outline"][5]["blocks"][0]["runs"][0]["t"] = \
            "Body text 6, rewritten on this machine after the last exchange."
    write_json(os.path.join(pdir, "project.json"), current)
    return pdir


def cut_diff(root, name):
    """The op-diff the work machine produces: baseline -> their edits."""
    with open(os.path.join(root, name, "_baseline.json"), encoding="utf-8") as fh:
        agreed = json.load(fh)
    theirs = copy.deepcopy(agreed)
    theirs["outline"][0]["blocks"][0]["runs"][0]["t"] = \
        "Body text 1, retyped on the work machine."
    return apply_update.make_text_diff(agreed, theirs, name)


# ---------------------------------------------------------------------------
# The baseline rule.
# ---------------------------------------------------------------------------


def test_drifted_report_still_applies(root):
    """A correctly-cut diff applies to a report that has drifted since the last
    exchange -- the drift is what it merges ONTO, never a reason to refuse."""
    name = "drifted"
    pdir = make_report(root, name)
    diff = cut_diff(root, name)
    rel = os.path.join(name, "project.json")
    baseline_sha = apply_update.baseline_state(root, rel)[1]
    current_sha = apply_update.project_sha(os.path.join(root, rel))
    check("fixture really has drifted", baseline_sha != current_sha)
    check("the diff declares our baseline as its ancestor",
          diff.get("base_sha") == baseline_sha)

    before = digest(os.path.join(pdir, "_baseline.json"))
    status, body = post("/api/apply-update", {"dir": name, "diff": diff})
    check("drifted report accepts a correctly-cut diff (was 409)",
          status == 200 and body.get("ok"), "-> %s %s" % (status, body))
    check("the library's own verdict is reported", body.get("baseline") == "ok",
          "-> %r" % body.get("baseline"))

    with open(os.path.join(pdir, "project.json"), encoding="utf-8") as fh:
        merged = json.load(fh)
    check("their edit landed",
          "retyped on the work machine"
          in merged["outline"][0]["blocks"][0]["runs"][0]["t"])
    check("our local drift survived the merge",
          "rewritten on this machine"
          in merged["outline"][5]["blocks"][0]["runs"][0]["t"])
    check("a one-way diff does NOT move the baseline",
          digest(os.path.join(pdir, "_baseline.json")) == before)

    # Cumulative-since-the-last-full-sync: re-pasting the same diff is a no-op.
    after_first = digest(os.path.join(pdir, "project.json"))
    status, _ = post("/api/apply-update", {"dir": name, "diff": diff})
    check("re-pasting the same diff is idempotent",
          status == 200
          and digest(os.path.join(pdir, "project.json")) == after_first)


def test_real_mismatch_is_refused(root):
    """A package cut from an ancestor we never held is still refused, and the
    body names BOTH shas so the drawer can explain the two ways forward."""
    name = "mismatch"
    pdir = make_report(root, name)
    diff = cut_diff(root, name)
    diff["base_sha"] = "0" * 64
    before = digest(os.path.join(pdir, "project.json"))
    status, body = post("/api/apply-update", {"dir": name, "diff": diff})
    check("a genuinely different ancestor is refused",
          status == 409 and body.get("error") == "baseline_mismatch",
          "-> %s %s" % (status, body))
    check("the refusal carries the package's ancestor",
          body.get("packageBase") == "0" * 64)
    baseline_sha = apply_update.baseline_state(
        root, os.path.join(name, "project.json"))[1]
    current_sha = apply_update.project_sha(os.path.join(pdir, "project.json"))
    check("localBase is the BASELINE sha, not the live file's",
          body.get("localBase") == baseline_sha != current_sha,
          "-> %r (baseline %r, current %r)"
          % (body.get("localBase"), baseline_sha, current_sha))
    check("a refused apply left project.json alone",
          digest(os.path.join(pdir, "project.json")) == before)


def test_missing_baseline_is_not_a_mismatch(root):
    """A report that has never been exchanged has nothing to compare against.
    Refusing it would lock it out of the channel for good, so it is applied
    after a snapshot and earns its first baseline."""
    name = "never_exchanged"
    pdir = make_report(root, name, drift=False, baseline=False)
    theirs = copy.deepcopy(sample_report())
    theirs["outline"][0]["title"] = "Section 1 renamed"
    with open(os.path.join(pdir, "project.json"), encoding="utf-8") as fh:
        diff = apply_update.make_text_diff(json.load(fh), theirs, name)
    status, body = post("/api/apply-update", {"dir": name, "diff": diff})
    check("a report with no baseline is let through",
          status == 200 and body.get("baseline") == "no_baseline",
          "-> %s %s" % (status, body))
    check("it was snapshotted before the write",
          any("prebaseline" in s for s in snapshots(pdir)),
          "-> %s" % snapshots(pdir))
    check("and it earned a baseline for next time",
          os.path.isfile(os.path.join(pdir, "_baseline.json")))


# ---------------------------------------------------------------------------
# The merge surface.
# ---------------------------------------------------------------------------


def test_merge3_shape(root):
    name = "merge_shape"
    pdir = make_report(root, name)
    with open(os.path.join(pdir, "project.json"), encoding="utf-8") as fh:
        theirs = json.load(fh)
    theirs["outline"][1]["blocks"][0]["runs"][0]["t"] = "Body text 2, returned."
    status, body = post("/api/merge3", {"dir": name, "incoming": theirs})
    check("merge3 answers 200", status == 200, "-> %s %s" % (status, body))
    for key in ("merged", "conflicts", "auto", "pending", "deletions", "token",
                "truncated"):
        check("merge3 returns %r" % key, key in body)
    check("merge3 returns a usable token", bool(body.get("token")))
    check("merge3 truncated is null on the happy path",
          body.get("truncated") is None)
    return body


def test_truncation_guard(root):
    name = "truncated"
    pdir = make_report(root, name)
    with open(os.path.join(pdir, "_baseline.json"), encoding="utf-8") as fh:
        cut = json.load(fh)
    cut["outline"] = cut["outline"][:1]      # arrived cut off
    status, body = post("/api/merge3", {"dir": name, "incoming": cut})
    check("a package that looks cut off is refused",
          status == 409 and body.get("error") == "truncated",
          "-> %s %s" % (status, body))
    t = body.get("truncated") or {}
    for key in ("kind", "missing", "total", "detail"):
        check("the refusal says %r" % key, t.get(key) not in (None, ""))
    status, body = post("/api/merge3",
                        {"dir": name, "incoming": cut, "allowBulkDelete": True})
    check("allowBulkDelete forwards to the merge and lets it through",
          status == 200 and body.get("truncated") is None,
          "-> %s %s" % (status, json.dumps(body)[:120]))
    check("the honoured deletions are reported",
          len(body.get("deletions") or []) > 0)


def test_apply_without_token_writes_nothing(root):
    """The refusal shapes, and the rule that a turned-away apply leaves the
    disk exactly as it found it -- snapshot included."""
    name = "merge_apply"
    pdir = make_report(root, name)
    with open(os.path.join(pdir, "project.json"), encoding="utf-8") as fh:
        theirs = json.load(fh)
    theirs["outline"][2]["blocks"][0]["runs"][0]["t"] = "Body text 3, returned."
    status, merge = post("/api/merge3", {"dir": name, "incoming": theirs})
    check("merge3 computed", status == 200, "-> %s %s" % (status, merge))

    before_file, before_snaps = digest(os.path.join(pdir, "project.json")), \
        snapshots(pdir)
    status, body = post("/api/merge3-apply",
                        {"dir": name, "merged": merge["merged"], "choices": {}})
    check("apply without a token is a 400 merge_token_missing",
          status == 400 and body.get("error") == "merge_token_missing",
          "-> %s %s" % (status, body))
    check("that refusal wrote NOTHING -- not even a snapshot",
          digest(os.path.join(pdir, "project.json")) == before_file
          and snapshots(pdir) == before_snaps,
          "-> snapshots %s" % snapshots(pdir))

    status, body = post("/api/merge3-apply",
                        {"dir": name, "merged": merge["merged"], "choices": {},
                         "token": "0" * 64})
    check("a stale token is a 409 stale_merge",
          status == 409 and body.get("error") == "stale_merge",
          "-> %s %s" % (status, body))
    check("stale_merge names expected and actual",
          body.get("expected") == "0" * 64 and bool(body.get("actual")),
          "-> %s" % body)
    check("the stale refusal wrote NOTHING either",
          digest(os.path.join(pdir, "project.json")) == before_file
          and snapshots(pdir) == before_snaps,
          "-> snapshots %s" % snapshots(pdir))

    status, body = post("/api/merge3-apply",
                        {"dir": name, "merged": merge["merged"], "choices": {},
                         "token": merge["token"]})
    check("apply with the merge3 token succeeds",
          status == 200 and body.get("ok") is True
          and "applied" in body and "snapshot" in body,
          "-> %s %s" % (status, body))
    check("and only then is a snapshot taken",
          snapshots(pdir) != before_snaps)
    with open(os.path.join(pdir, "project.json"), encoding="utf-8") as fh:
        written = json.load(fh)
    check("the merged report is what landed",
          written["outline"][2]["blocks"][0]["runs"][0]["t"]
          == "Body text 3, returned.")


# ---------------------------------------------------------------------------
# Addressing: a delta has to name the report it belongs to.
# ---------------------------------------------------------------------------


def test_nested_report_diff_is_addressed_by_path(root):
    """A delta carries the report's PATH under the reports root, not the
    basename of its folder.

    The pasted text is often all there is -- the CLI and the paste box route by
    the ``dir`` the delta declares when the caller gives none alongside. Once
    reports are nested as <project>/<module>/<stage>, a basename is the stage
    name, which every module shares. Against the old behaviour (basename) the
    delta below declares "check", the apply lands on the unrelated top-level
    report of that name, and the report it was cut for is never touched -- so
    both checks here fail.
    """
    deep = "site_x/unit_b/check"
    deep_dir = make_report(root, deep)
    decoy_dir = make_report(root, "check")

    with open(os.path.join(deep_dir, "_baseline.json"), encoding="utf-8") as fh:
        theirs = json.load(fh)
    theirs["outline"][0]["blocks"][0]["runs"][0]["t"] = "Retyped on the far side."

    req = Request(BASE + "/api/copy-diff?dir=" + deep.replace("/", "%2F"),
                  data=json.dumps(theirs).encode("utf-8"),
                  headers={"Content-Type": "application/json"}, method="POST")
    with urlopen(req) as resp:
        body = json.loads(resp.read().decode("utf-8"))
    declared = json.loads(body["diff_text"]).get("dir")
    check("the delta names the report by its path, not its folder name",
          declared == deep, "-> %r" % declared)

    before_decoy = digest(os.path.join(decoy_dir, "project.json"))
    status, applied = post("/api/apply-update", {"diff_text": body["diff_text"]})
    check("the pasted text alone routes to the report it was cut for",
          status == 200 and applied.get("rel") == deep + "/project.json",
          "-> %s %s" % (status, applied))
    with open(os.path.join(deep_dir, "project.json"), encoding="utf-8") as fh:
        landed = json.load(fh)
    check("the far side's edit reached that report",
          landed["outline"][0]["blocks"][0]["runs"][0]["t"]
          == "Retyped on the far side.")
    check("and no other report was written",
          digest(os.path.join(decoy_dir, "project.json")) == before_decoy)


# ---------------------------------------------------------------------------
# Undo: the backup history is shared, the screen is not.
# ---------------------------------------------------------------------------


def test_rollback_is_scoped_to_the_open_report(root):
    """Undo on report A's sync screen undoes A, whatever landed after it.

    ``_backups/`` is one history for the whole root, so the newest entry in it
    belongs to whichever report was written last. Against the old behaviour
    (POST /api/rollback ignored the ``dir`` the client sends and restored that
    newest entry) this test reverts B while telling the caller A was restored:
    the "B kept the apply" and "A went back" checks both fail.
    """
    a, b = "undo_mine", "undo_theirs"
    adir, bdir = make_report(root, a), make_report(root, b)
    a_pre = digest(os.path.join(adir, "project.json"))

    status, _ = post("/api/apply-update", {"dir": a, "diff": cut_diff(root, a)})
    check("apply to A", status == 200)
    status, _ = post("/api/apply-update", {"dir": b, "diff": cut_diff(root, b)})
    check("apply to B lands on top of A in the shared history", status == 200)

    b_applied = digest(os.path.join(bdir, "project.json"))
    b_baseline = digest(os.path.join(bdir, "_baseline.json"))

    status, body = post("/api/rollback", {"dir": a})
    check("rollback of the open report succeeds",
          status == 200 and body.get("ok"), "-> %s %s" % (status, body))
    check("the answer names the report that was asked for",
          body.get("dir") == a, "-> %r" % body.get("dir"))
    check("only that report's file is reported restored",
          body.get("restored") == [a + "/project.json"],
          "-> %r" % body.get("restored"))
    check("A really is back to its pre-apply bytes",
          digest(os.path.join(adir, "project.json")) == a_pre)
    check("B kept the apply that was never undone",
          digest(os.path.join(bdir, "project.json")) == b_applied)
    check("and the baseline stamped by the rollback is A's, not B's",
          digest(os.path.join(bdir, "_baseline.json")) == b_baseline
          and digest(os.path.join(adir, "_baseline.json"))
          == digest(os.path.join(adir, "project.json")))


def test_rollback_refuses_when_nothing_of_ours_is_on_record(root):
    """A report with no change of its own to undo is told so -- it does not get
    somebody else's undone on its behalf."""
    quiet, loud = "undo_quiet", "undo_loud"
    qdir, ldir = make_report(root, quiet), make_report(root, loud)
    status, _ = post("/api/apply-update", {"dir": loud, "diff": cut_diff(root, loud)})
    check("apply to the other report", status == 200)

    q_before = digest(os.path.join(qdir, "project.json"))
    l_before = digest(os.path.join(ldir, "project.json"))
    status, body = post("/api/rollback", {"dir": quiet})
    check("undo with nothing of ours on record is refused",
          status == 409 and "error" in body, "-> %s %s" % (status, body))
    check("the refusal says whose report it is about",
          quiet in str(body.get("error", "")), "-> %r" % body.get("error"))
    check("the refusal wrote nothing at all",
          digest(os.path.join(qdir, "project.json")) == q_before
          and digest(os.path.join(ldir, "project.json")) == l_before)


def test_rollback_without_a_dir_still_undoes_the_newest(root):
    """The old single-file UI sends no ``dir``; root-wide undo stays its answer."""
    name = "undo_legacy"
    pdir = make_report(root, name)
    before = digest(os.path.join(pdir, "project.json"))
    status, _ = post("/api/apply-update", {"dir": name, "diff": cut_diff(root, name)})
    check("apply to the last-written report", status == 200)
    status, body = post("/api/rollback", {})
    check("a rollback with no dir undoes the newest change anywhere",
          status == 200 and body.get("ok")
          and body.get("restored") == [name + "/project.json"],
          "-> %s %s" % (status, body))
    check("which is exactly the file it backed up",
          digest(os.path.join(pdir, "project.json")) == before)
# A save never brings a report back.
# ---------------------------------------------------------------------------


def test_save_after_delete_is_refused(root):
    """A PUT that carries the optimistic token is a save of a report the client
    has read. If that report was moved to the trash meanwhile, the save must
    answer 410 and write NOTHING -- against the old behaviour the folder came
    back holding only project.json (no images, no baseline, no history) and
    then blocked its own restore, which refuses an occupied path."""
    name = "unit_c/deleted_while_open"
    pdir = make_report(root, name)
    os.makedirs(os.path.join(pdir, "images"), exist_ok=True)
    with open(os.path.join(pdir, "images", "plot.png"), "wb") as fh:
        fh.write(b"\x89PNG\r\n\x1a\n")
    enc = name.replace("/", "%2F")

    status, body = get("/api/project?dir=" + enc)
    token = body["meta_info"]["mtime"]
    doc = body["project"]
    doc["outline"][0]["blocks"][0]["runs"][0]["t"] = "Typed while the report was open."
    status, saved = put("/api/project?dir=%s&saved_at=%r" % (enc, token), doc)
    check("a save with the current token still lands", status == 200 and saved.get("ok"),
          "-> %s %s" % (status, saved))
    token = saved["saved_at"]

    status, gone = post("/api/project-delete", {"dir": name})
    check("the report goes to the trash", status == 200 and gone.get("id"),
          "-> %s %s" % (status, gone))
    check("and its folder is gone", not os.path.exists(pdir))

    doc["outline"][0]["blocks"][0]["runs"][0]["t"] = "The save that was still owed."
    status, refused = put("/api/project?dir=%s&saved_at=%r" % (enc, token), doc)
    check("the save that lands after the delete answers 410",
          status == 410 and refused.get("gone") is True, "-> %s %s" % (status, refused))
    check("and the folder is NOT recreated", not os.path.exists(pdir))

    status, refused = put("/api/project?dir=%s&overwrite=1" % enc, doc)
    check("an explicit overwrite of a deleted report is refused the same way",
          status == 410 and refused.get("gone") is True, "-> %s %s" % (status, refused))
    check("and still nothing was created", not os.path.exists(pdir))

    status, back = post("/api/trash-restore", {"id": gone["id"]})
    check("so the trashed copy can be put back", status == 200 and back.get("ok"),
          "-> %s %s" % (status, back))
    check("with its figure and its baseline intact",
          os.path.isfile(os.path.join(pdir, "images", "plot.png"))
          and os.path.isfile(os.path.join(pdir, "_baseline.json")))
    with open(os.path.join(pdir, "project.json"), encoding="utf-8") as fh:
        restored = json.load(fh)
    check("holding the last save that landed before the delete",
          restored["outline"][0]["blocks"][0]["runs"][0]["t"]
          == "Typed while the report was open.")

    # The explicit overwrite keeps what it replaces.
    status, body = get("/api/project?dir=" + enc)
    other = copy.deepcopy(body["project"])
    other["outline"][1]["blocks"][0]["runs"][0]["t"] = "Written by the other window."
    write_json(os.path.join(pdir, "project.json"), other)
    status, refused = put("/api/project?dir=%s&saved_at=%r" % (enc, body["meta_info"]["mtime"]),
                          doc)
    check("a stale token is still refused with 409",
          status == 409 and refused.get("conflict") is True, "-> %s" % status)
    status, kept = put("/api/project?dir=%s&overwrite=1" % enc, doc)
    check("the explicit overwrite writes without the token", status == 200 and kept.get("ok"),
          "-> %s %s" % (status, kept))
    snaps = snapshots(pdir)
    held = []
    for snap in snaps:
        with open(os.path.join(pdir, "_autosave", snap), encoding="utf-8") as fh:
            if "Written by the other window." in fh.read():
                held.append(snap)
    check("and the version it replaced is in a snapshot first",
          any("__overwrite" in s for s in held), "-> %s" % snaps)


def run():
    tmp = tempfile.mkdtemp(prefix="sync_http_")
    root = os.path.join(tmp, "reports")
    os.makedirs(root, exist_ok=True)
    config_path = os.path.join(tmp, "template_config_test.json")
    write_json(config_path, {"id": "test_tpl_v1", "styles": {}})

    httpd = server.make_server(port=PORT, root=root, config_path=config_path,
                               bind="127.0.0.1")
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    for _ in range(50):
        try:
            with urlopen(BASE + "/api/health") as resp:
                if resp.status == 200:
                    break
        except Exception:
            time.sleep(0.05)
    try:
        print("baseline rule")
        test_drifted_report_still_applies(root)
        test_real_mismatch_is_refused(root)
        test_missing_baseline_is_not_a_mismatch(root)
        print("merge surface")
        test_merge3_shape(root)
        test_truncation_guard(root)
        test_apply_without_token_writes_nothing(root)
        print("addressing")
        test_nested_report_diff_is_addressed_by_path(root)
        print("undo")
        test_rollback_is_scoped_to_the_open_report(root)
        test_rollback_refuses_when_nothing_of_ours_is_on_record(root)
        test_rollback_without_a_dir_still_undoes_the_newest(root)
        print("a save never brings a report back")
        test_save_after_delete_is_refused(root)
    finally:
        httpd.shutdown()
        httpd.server_close()
        shutil.rmtree(tmp, ignore_errors=True)

    print()
    if FAILURES:
        print("FAILED (%d): %s" % (len(FAILURES), ", ".join(FAILURES)))
        return 1
    print("all sync HTTP checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(run())
