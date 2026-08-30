# -*- coding: utf-8 -*-
"""Regression test for the flat -> three-level layout migrator.

Builds a throw-away reports root in a temp directory with three flat module
folders (neutral sample names only) and drives plan() / apply() / rollback():

  1. plan() emits one move per mapped module, with the right target and stage
  2. a module missing from the mapping lands in "unmapped" and is not moved
  3. apply() moves every sibling directory and file, not just project.json
  4. project.json is byte-identical after the move (sha256)
  5. project_meta.json appears at the project and the module level, right ids
  6. rollback() restores the original tree exactly (full recursive digest)
  7. an existing target refuses BEFORE anything moves (no half-done state)
  8. an interrupted run is resumable and never moves a module twice
  9. a dry run writes nothing at all
 10. rollback NAMES every directory it has to leave behind, and why
 11. rollback with --root acts on that root, not the one in the manifest
 12. requirements.txt still declares the optional preview dependencies, and
     still resolves on a machine that has no Word and is not even Windows

10 and 11 are the two ways a rollback used to mislead. It restored the reports
correctly but said "restored N directory(ies)" and nothing else, so a stage
created after the migration stayed stranded in a half-populated tree with no
mention of it; and it read the reports root out of the manifest's absolute
``root`` field, so rehearsing against a COPY of a snapshot silently operated on
the original.

12 lives here because this file is the only test that owns requirements.txt: the
handover's setup step is "pip install -r requirements.txt", and the optional
preview dependencies were missing from it, so following the instructions left
the feature quietly unavailable.

Neutral: no project or company data. Run: python builder/tests/test_migrate_layout.py
"""
import hashlib
import io
import json
import os
import re
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))   # builder/tests
BUILDER = os.path.dirname(HERE)                     # builder/
REPO = os.path.dirname(BUILDER)                     # repo root
if BUILDER not in sys.path:
    sys.path.insert(0, BUILDER)
import buildpath  # noqa: E402,F401  (registers core/docx_io/store/sync/web)
import migrate_layout as ml  # noqa: E402


# --------------------------------------------------------------------------
# Fixture: three flat modules, each with siblings around project.json.
# --------------------------------------------------------------------------

MODULE_TITLES = [
    ("CLKDIV_5G", "CLKDIV_5G XDR Simulation Report"),
    ("MODULE_A", "MODULE_A PDR Simulation Report"),
    ("TXBUF_2G", "TXBUF_2G FDR Simulation Report"),
]

MAPPING = {
    "modules": {
        # stage given explicitly -- must win over the XDR in the title
        "CLKDIV_5G": {"project": "P1108", "stage": "CDR"},
        # no stage -- must be read out of meta.title
        "MODULE_A": {"project": "P1108"},
        # TXBUF_2G deliberately absent -> unmapped
    },
    "projects": {"P1108": {"name": "Program 1108", "description": "sample set"}},
    "moduleMeta": {"CLKDIV_5G": {"name": "Clock divider", "description": "d1"}},
}

EXPECTED = {
    "CLKDIV_5G": ("P1108/CLKDIV_5G/CDR", "CDR", "stage from mapping"),
    "MODULE_A": ("P1108/MODULE_A/PDR", "PDR", "stage read from meta.title"),
}

# Siblings that must travel with the module directory.
SIBLINGS = [
    ("images/fig1.png", b"\x89PNG\r\n\x1a\nfig1"),
    ("images/sub/fig2.png", b"\x89PNG\r\n\x1a\nfig2"),
    ("out/report.docx", b"PK\x03\x04 not-really-a-docx"),
    ("_baseline.json", b'{"outline": []}'),
    ("notes.txt", b"loose file at the module root\n"),
]


def _project_bytes(module, title):
    doc = {
        "schema_version": 1,
        "template": "sample",
        "meta": {"title": title, "module": module},
        "outline": [{"id": "n-1", "title": "Overview", "blocks": []}],
    }
    return json.dumps(doc, ensure_ascii=False, indent=2).encode("utf-8")


def make_root(prefix="migrate_test_"):
    root = tempfile.mkdtemp(prefix=prefix)
    for module, title in MODULE_TITLES:
        mdir = os.path.join(root, module)
        os.makedirs(mdir)
        with open(os.path.join(mdir, "project.json"), "wb") as fh:
            fh.write(_project_bytes(module, title))
        for rel, blob in SIBLINGS:
            path = os.path.join(mdir, rel.replace("/", os.sep))
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as fh:
                fh.write(blob)
    return root


# --------------------------------------------------------------------------
# Digest helpers -- a full recursive fingerprint of a directory tree.
# --------------------------------------------------------------------------

def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def tree_digest(root, skip=()):
    """Fingerprint of every directory and file under root (empty dirs included)."""
    lines = []
    for dirpath, dirnames, filenames in os.walk(root):
        rel = os.path.relpath(dirpath, root).replace("\\", "/")
        rel = "" if rel == "." else rel
        dirnames[:] = sorted(d for d in dirnames if d not in skip)
        lines.append("d %s" % rel)
        for name in sorted(filenames):
            frel = ("%s/%s" % (rel, name)).lstrip("/")
            lines.append("f %s %s" % (frel,
                                      sha256_file(os.path.join(dirpath, name))))
    return hashlib.sha256("\n".join(lines).encode("utf-8")).hexdigest()


def by_module(items, key="module"):
    out = {}
    for it in items:
        out[it.get(key) or it.get("from")] = it
    return out


COUNT = [0]


def check(cond, msg):
    COUNT[0] += 1
    assert cond, msg


def run_cli(argv):
    """Drive ml.main() and hand back ``(exit code, stdout)``."""
    buf, real = io.StringIO(), sys.stdout
    sys.stdout = buf
    try:
        rc = ml.main(argv)
    finally:
        sys.stdout = real
    return rc, buf.getvalue()


# --------------------------------------------------------------------------
# 1, 2, 3, 4, 5, 6, 9 -- the happy path and its exact reversal.
# --------------------------------------------------------------------------

def test_plan_apply_rollback():
    root = make_root()
    try:
        before = tree_digest(root)
        top_before = set(os.listdir(root))

        p = ml.plan(root, MAPPING)

        # -- 9a: plan() is read-only.
        check(tree_digest(root) == before, "plan() must not touch the disk")

        # -- 1: one move per mapped module, right target and stage.
        check(p["conflicts"] == [], "clean fixture must not conflict: %r"
              % (p["conflicts"],))
        check(len(p["moves"]) == 2, "expected 2 moves, got %r" % (p["moves"],))
        mv = by_module(p["moves"])
        for module, (to, stage, reason) in EXPECTED.items():
            check(module in mv, "no move planned for %s" % module)
            check(mv[module]["to"] == to,
                  "%s -> %r, expected %r" % (module, mv[module]["to"], to))
            check(mv[module]["from"] == module,
                  "%s source should be the flat folder, got %r"
                  % (module, mv[module]["from"]))
            check(mv[module]["stage"] == stage,
                  "%s stage %r, expected %r" % (module, mv[module]["stage"], stage))
            check(mv[module]["reason"] == reason,
                  "%s reason %r, expected %r"
                  % (module, mv[module]["reason"], reason))
            check(mv[module]["project"] == "P1108",
                  "%s project %r" % (module, mv[module]["project"]))

        # -- 2: the unmapped module is reported, not moved.
        check(len(p["unmapped"]) == 1,
              "expected 1 unmapped, got %r" % (p["unmapped"],))
        un = p["unmapped"][0]
        check(un["module"] == "TXBUF_2G", "unmapped module %r" % (un["module"],))
        check(un["stage"] == "FDR",
              "unmapped stage should still be inferred, got %r" % (un["stage"],))
        check(not any(m["module"] == "TXBUF_2G" for m in p["moves"]),
              "an unmapped module must never be planned for a move")

        # -- 9b: the CLI dry run (the default) writes nothing either.
        map_file = os.path.join(tempfile.mkdtemp(prefix="migrate_map_"), "map.json")
        with open(map_file, "w", encoding="utf-8") as fh:
            json.dump(MAPPING, fh)
        buf, real = io.StringIO(), sys.stdout
        sys.stdout = buf
        try:
            rc = ml.main(["--root", root, "--map", map_file])
        finally:
            sys.stdout = real
        check(rc == 0, "dry run should exit 0 on a clean plan, got %r" % rc)
        check("dry run" in buf.getvalue(), "dry run must say so on stdout")
        check(tree_digest(root) == before, "the dry run must not touch the disk")
        check(set(os.listdir(root)) == top_before,
              "the dry run must not create anything at the root")

        # -- apply.
        res = ml.apply(root, p)
        check(res["moved"] == 2, "moved %r, expected 2" % (res["moved"],))
        check(res["warnings"] == [], "unexpected warnings: %r" % (res["warnings"],))
        check(os.path.isfile(res["manifest"]), "manifest not written")

        # -- 3: every sibling directory and file travelled, source is gone.
        for module, (to, _stage, _r) in EXPECTED.items():
            dst = os.path.join(root, to.replace("/", os.sep))
            check(os.path.isfile(os.path.join(dst, "project.json")),
                  "%s: project.json missing at the target" % module)
            check(not os.path.exists(os.path.join(root, module)),
                  "%s: the flat source folder should be gone" % module)
            for rel, blob in SIBLINGS:
                path = os.path.join(dst, rel.replace("/", os.sep))
                check(os.path.isfile(path), "%s: %s did not travel" % (module, rel))
                with open(path, "rb") as fh:
                    check(fh.read() == blob,
                          "%s: %s changed during the move" % (module, rel))

        # -- 4: project.json is byte-identical (hash from the plan, re-hashed now).
        for module, (to, _stage, _r) in EXPECTED.items():
            dst = os.path.join(root, to.replace("/", os.sep), "project.json")
            check(sha256_file(dst) == mv[module]["sha256"],
                  "%s: project.json hash drifted across the move" % module)
            check(sha256_file(dst) ==
                  hashlib.sha256(_project_bytes(
                      module, dict(MODULE_TITLES)[module])).hexdigest(),
                  "%s: project.json bytes differ from the fixture" % module)

        # -- 2 (continued): the unmapped module stayed exactly where it was.
        check(os.path.isfile(os.path.join(root, "TXBUF_2G", "project.json")),
              "the unmapped module must be left in place")
        check(not os.path.exists(os.path.join(root, "P1108", "TXBUF_2G")),
              "the unmapped module must not appear under a project")

        # -- 5: project_meta.json at both levels, with the right ids and names.
        pmeta_path = os.path.join(root, "P1108", "project_meta.json")
        check(os.path.isfile(pmeta_path), "project-level project_meta.json missing")
        with open(pmeta_path, "r", encoding="utf-8") as fh:
            pmeta = json.load(fh)
        check(pmeta.get("id") == "P1108", "project meta id %r" % (pmeta.get("id"),))
        check(pmeta.get("name") == "Program 1108",
              "project meta name %r" % (pmeta.get("name"),))

        mmeta_path = os.path.join(root, "P1108", "CLKDIV_5G", "project_meta.json")
        check(os.path.isfile(mmeta_path), "module-level project_meta.json missing")
        with open(mmeta_path, "r", encoding="utf-8") as fh:
            mmeta = json.load(fh)
        check(mmeta.get("id") == "CLKDIV_5G",
              "module meta id %r" % (mmeta.get("id"),))
        check(mmeta.get("name") == "Clock divider",
              "module meta name %r" % (mmeta.get("name"),))

        mmeta2_path = os.path.join(root, "P1108", "MODULE_A", "project_meta.json")
        check(os.path.isfile(mmeta2_path),
              "a module with no display name still needs its project_meta.json")
        with open(mmeta2_path, "r", encoding="utf-8") as fh:
            mmeta2 = json.load(fh)
        check(mmeta2.get("id") == "MODULE_A",
              "module meta id %r" % (mmeta2.get("id"),))
        check(mmeta2.get("name") == "MODULE_A",
              "the folder name should stand in as the display name, got %r"
              % (mmeta2.get("name"),))

        # -- 6: rollback restores the tree exactly.
        rb = ml.rollback(res["snapshot"])
        check(rb["restored"] == 2, "restored %r, expected 2" % (rb["restored"],))
        check(rb["warnings"] == [],
              "clean rollback should warn about nothing: %r" % (rb["warnings"],))
        check(tree_digest(root, skip=("_migrate",)) == before,
              "rollback did not restore the original tree byte for byte")
        check(set(os.listdir(root)) - top_before == {"_migrate"},
              "rollback left something behind at the root: %r"
              % (sorted(set(os.listdir(root)) - top_before),))
    finally:
        shutil.rmtree(root, ignore_errors=True)


# --------------------------------------------------------------------------
# 7 -- an existing target refuses before anything is moved.
# --------------------------------------------------------------------------

def test_existing_target_refuses_before_moving():
    # (a) the target is already there when the plan is made.
    root = make_root("migrate_conflict_")
    try:
        squatter = os.path.join(root, "P1108", "MODULE_A", "PDR")
        os.makedirs(squatter)
        with open(os.path.join(squatter, "keep.txt"), "w", encoding="utf-8") as fh:
            fh.write("a folder that already belongs to someone\n")
        before = tree_digest(root)
        top_before = set(os.listdir(root))

        p = ml.plan(root, MAPPING)
        conflicts = by_module(p["conflicts"])
        check("MODULE_A" in conflicts,
              "an occupied target must be a conflict, got %r" % (p["conflicts"],))
        check("already exists" in conflicts["MODULE_A"]["reason"],
              "conflict reason %r" % (conflicts["MODULE_A"]["reason"],))
        # The other module is still plannable, which is what makes the refusal
        # meaningful: apply() must refuse the whole run, not move that one.
        check(len(p["moves"]) == 1, "expected the clean module still planned: %r"
              % (p["moves"],))

        raised = None
        try:
            ml.apply(root, p)
        except ml.MigrationError as ex:
            raised = ex
        check(raised is not None, "apply() must refuse while a conflict stands")
        check(tree_digest(root) == before,
              "a refused apply must leave the disk untouched")
        check(set(os.listdir(root)) == top_before,
              "a refused apply must not even take a snapshot")
        check(os.path.isfile(os.path.join(root, "CLKDIV_5G", "project.json")),
              "the clean module must not have been half-moved")
    finally:
        shutil.rmtree(root, ignore_errors=True)

    # (b) the target appears between plan() and apply() -- the live re-check
    #     has to catch it before the first move, not after it.
    root = make_root("migrate_race_")
    try:
        p = ml.plan(root, MAPPING)
        check(len(p["moves"]) == 2, "fixture should plan 2 moves")
        check(p["moves"][0]["module"] == "CLKDIV_5G",
              "expected the first move to be CLKDIV_5G, got %r"
              % (p["moves"][0]["module"],))
        # Occupy the SECOND move's target only.
        os.makedirs(os.path.join(root, "P1108", "MODULE_A", "PDR"))
        before = tree_digest(root)

        raised = None
        try:
            ml.apply(root, p)
        except ml.MigrationError as ex:
            raised = ex
        check(raised is not None,
              "apply() must re-check the live disk and refuse")
        check(os.path.isfile(os.path.join(root, "CLKDIV_5G", "project.json")),
              "the FIRST move must not have happened: the refusal is not atomic")
        check(tree_digest(root) == before,
              "a late refusal must still leave the disk untouched")
    finally:
        shutil.rmtree(root, ignore_errors=True)


# --------------------------------------------------------------------------
# 8 -- an interrupted run resumes and never moves a module twice.
# --------------------------------------------------------------------------

class _Boom(Exception):
    pass


def test_partial_move_is_resumable():
    root = make_root("migrate_resume_")
    real_move = shutil.move
    calls = [0]

    def flaky_move(src, dst, *a, **kw):
        calls[0] += 1
        if calls[0] > 1:
            raise _Boom("interrupted after the first move")
        return real_move(src, dst, *a, **kw)

    try:
        p1 = ml.plan(root, MAPPING)
        check(len(p1["moves"]) == 2, "fixture should plan 2 moves")
        first = p1["moves"][0]["module"]

        shutil.move = flaky_move
        boomed = False
        try:
            ml.apply(root, p1)
        except _Boom:
            boomed = True
        finally:
            shutil.move = real_move
        check(boomed, "the injected failure should have propagated")

        moved_to = os.path.join(root, EXPECTED[first][0].replace("/", os.sep))
        check(os.path.isfile(os.path.join(moved_to, "project.json")),
              "%s should have landed before the interruption" % first)
        rest = [m for m in EXPECTED if m != first]
        check(len(rest) == 1, "fixture bookkeeping")
        second = rest[0]
        check(os.path.isfile(os.path.join(root, second, "project.json")),
              "%s should still be at the flat source" % second)

        # Re-plan against the half-migrated root.
        p2 = ml.plan(root, MAPPING)
        check(p2["conflicts"] == [],
              "a half-migrated root must not deadlock: %r" % (p2["conflicts"],))
        done = by_module(p2["done"])
        check(first in done,
              "%s is already migrated and must be reported done, not moved" % first)
        check(done[first]["to"] == EXPECTED[first][0],
              "done target %r" % (done[first]["to"],))
        check([m["module"] for m in p2["moves"]] == [second],
              "only the unmoved module may be planned again, got %r"
              % ([m["module"] for m in p2["moves"]],))

        # Contents of the already-migrated module must survive untouched.
        digest_first = sha256_file(os.path.join(moved_to, "project.json"))

        res2 = ml.apply(root, p2)
        check(res2["moved"] == 1,
              "resumed run moved %r, expected 1" % (res2["moved"],))
        # The resume normally happens inside the same second as the run it is
        # resuming; the two snapshots must not land on the same folder.
        check(os.path.isdir(os.path.join(res2["snapshot"], "tree")),
              "the resumed run took no snapshot of its own")
        check(len(os.listdir(os.path.join(root, "_migrate"))) == 2,
              "the resumed run reused the interrupted run snapshot folder: %r"
              % (os.listdir(os.path.join(root, "_migrate")),))
        check(sha256_file(os.path.join(moved_to, "project.json")) == digest_first,
              "the resumed run disturbed the already-migrated module")
        for module, (to, _s, _r) in EXPECTED.items():
            dst = os.path.join(root, to.replace("/", os.sep))
            check(os.path.isfile(os.path.join(dst, "project.json")),
                  "%s missing after the resumed run" % module)
            check(not os.path.exists(os.path.join(root, module)),
                  "%s left a duplicate at the flat source" % module)

        # A third plan has nothing left to do -- the stage of a module whose
        # source is gone is read back off the folder it landed in.
        p3 = ml.plan(root, MAPPING)
        check(p3["moves"] == [], "a finished root must plan no moves: %r"
              % (p3["moves"],))
        check(sorted(d["module"] for d in p3["done"]) == sorted(EXPECTED),
              "a finished root should report both modules done: %r" % (p3["done"],))
        res3 = ml.apply(root, p3)
        check(res3["moved"] == 0, "re-applying a finished plan must move nothing")
        check(res3["snapshot"] is None,
              "a no-op apply should not take a snapshot")
    finally:
        shutil.move = real_move
        shutil.rmtree(root, ignore_errors=True)


# --------------------------------------------------------------------------
# 10 -- rollback names every directory it leaves behind.
#
# The migration creates <root>/PROJECT and <root>/PROJECT/MODULE. Seed a second
# stage inside one of them afterwards -- exactly what happens when an FDR is
# added beside a migrated CDR -- and rollback can no longer remove that pair:
# rmdir skips a non-empty directory. It used to skip them in silence, leaving
# the owner with the flat layout back AND a half-populated tree beside it, and
# a run that said only "restored N directory(ies)".
# --------------------------------------------------------------------------

LATER_STAGE = ("P1108", "CLKDIV_5G", "FDR")
PROJECT_JSON = "project.json"


def _migrate_then_add_a_later_stage(prefix):
    """Migrate the fixture, then create a stage the migration knows nothing of.

    Returns ``(root, snapshot, sha256 of the new report)``.
    """
    root = make_root(prefix)
    res = ml.apply(root, ml.plan(root, MAPPING))
    check(res["moved"] == 2, "fixture should migrate 2 modules, got %r"
          % (res["moved"],))
    later = os.path.join(root, *LATER_STAGE)
    os.makedirs(later)
    blob = _project_bytes("CLKDIV_5G", "CLKDIV_5G FDR Simulation Report")
    with open(os.path.join(later, PROJECT_JSON), "wb") as fh:
        fh.write(blob)
    return root, res["snapshot"], hashlib.sha256(blob).hexdigest()


def test_rollback_names_what_it_leaves_behind():
    # (a) the structured answer: every stranded directory, and what holds it up.
    root, snapshot, later_sha = _migrate_then_add_a_later_stage("migrate_left_")
    try:
        rb = ml.rollback(snapshot)
        check(rb["restored"] == 2, "restored %r, expected 2" % (rb["restored"],))
        check("left" in rb, "rollback() must report what it left behind")
        left = {item["path"]: item for item in rb["left"]}
        check(sorted(left) == ["P1108", "P1108/CLKDIV_5G"],
              "expected both created directories reported as left behind, "
              "got %r" % (sorted(left),))
        check(left["P1108/CLKDIV_5G"]["entries"] == ["FDR"],
              "the report must name what is keeping the directory alive, "
              "got %r" % (left["P1108/CLKDIV_5G"]["entries"],))
        check(left["P1108"]["entries"] == ["CLKDIV_5G"],
              "the parent must be reported too, got %r"
              % (left["P1108"]["entries"],))

        # The four flat reports came back and the stranded one was not touched.
        for module, _t in MODULE_TITLES:
            check(os.path.isfile(os.path.join(root, module, PROJECT_JSON)),
                  "%s did not come back to the flat layout" % module)
        stranded = os.path.join(root, *(LATER_STAGE + (PROJECT_JSON,)))
        check(os.path.isfile(stranded),
              "the stage created after the migration must survive rollback")
        check(sha256_file(stranded) == later_sha,
              "rollback altered a report the migration never created")

        # Every left-behind path is rendered for a human to read.
        lines = "\n".join(ml.format_left(rb["left"]))
        for rel in left:
            check(rel in lines, "format_left() did not name %r: %r" % (rel, lines))
    finally:
        shutil.rmtree(root, ignore_errors=True)

    # (b) the same run through the CLI: the stdout the owner actually sees has
    #     to name them. This is the assertion the old behaviour fails -- it
    #     printed the "restored" line and stopped.
    root, snapshot, _sha = _migrate_then_add_a_later_stage("migrate_left_cli_")
    try:
        rc, out = run_cli(["--rollback", snapshot])
        check(rc == 0, "rollback should exit 0, got %r" % rc)
        check("restored 2 directory(ies)" in out,
              "the restored line should still be there: %r" % out)
        for rel in ("P1108", "P1108/CLKDIV_5G"):
            check(rel in out,
                  "the run must name %r on stdout, printed:\n%s" % (rel, out))
        check("FDR" in out,
              "the run must say what is still standing there:\n%s" % out)
        check("not empty" in out,
              "the run must say WHY the directory was left:\n%s" % out)
    finally:
        shutil.rmtree(root, ignore_errors=True)


# --------------------------------------------------------------------------
# 11 -- rollback acts on the root it is given, not the one in the manifest.
#
# The manifest records an ABSOLUTE root. Copy a snapshot somewhere to rehearse
# a rollback -- the cautious thing to do -- and following that field operates on
# the original instead. --root now wins, and whichever root is in use is named
# before a single directory moves.
# --------------------------------------------------------------------------

def _copy_root(src, prefix):
    dst = tempfile.mkdtemp(prefix=prefix)
    shutil.rmtree(dst)
    shutil.copytree(src, dst)
    return dst


def test_rollback_root_argument_wins_over_the_manifest():
    live = make_root("migrate_liveroot_")
    copies = []
    try:
        res = ml.apply(live, ml.plan(live, MAPPING))
        migrated = tree_digest(live, skip=("_migrate",))

        # (a) explicit --root: the copy is rolled back, the live root is not.
        rehearsal = _copy_root(live, "migrate_rehearse_")
        copies.append(rehearsal)
        snap = os.path.join(rehearsal, ml.MIGRATE_DIRNAME,
                            os.path.basename(res["snapshot"]))
        check(os.path.isfile(os.path.join(snap, ml.MANIFEST_FILE)),
              "the copied root should carry the snapshot and its manifest")

        rc, out = run_cli(["--rollback", snap, "--root", rehearsal])
        check(rc == 0, "rollback should exit 0, got %r (%s)" % (rc, out))

        for module in EXPECTED:
            check(os.path.isfile(os.path.join(rehearsal, module, PROJECT_JSON)),
                  "%s was not restored inside the copy" % module)
        check(not os.path.exists(os.path.join(rehearsal, "P1108")),
              "the copy should be flat again, P1108 is still there")
        check(tree_digest(live, skip=("_migrate",)) == migrated,
              "the live root must not have been touched by a rehearsal")

        # It said which root, and said it before anything moved.
        check("(from --root)" in out,
              "the run must say the root came from --root:\n%s" % out)
        check(os.path.normcase(rehearsal) in os.path.normcase(out),
              "the run must name the root it acts on:\n%s" % out)
        check(out.index("reports root:") < out.index("restored"),
              "the root must be named BEFORE the result:\n%s" % out)
        check(os.path.normcase(live) in os.path.normcase(out),
              "the run should also name the root the manifest points at, so "
              "the difference is visible:\n%s" % out)

        # (b) no --root: the manifest still decides, but the run says out loud
        #     that the snapshot it was handed lives somewhere else.
        rehearsal2 = _copy_root(live, "migrate_rehearse2_")
        copies.append(rehearsal2)
        snap2 = os.path.join(rehearsal2, ml.MIGRATE_DIRNAME,
                             os.path.basename(res["snapshot"]))
        rb = ml.rollback(snap2)
        check(os.path.normcase(rb["root"]) == os.path.normcase(live),
              "without --root the manifest root is still used, got %r"
              % (rb["root"],))
        check(rb["rootSource"] == ml.MANIFEST_FILE,
              "rootSource %r" % (rb["rootSource"],))
        check(any(os.path.normcase(rehearsal2) in os.path.normcase(w)
                  for w in rb["warnings"]),
              "a snapshot rolled back from somewhere other than its own root "
              "must warn about it: %r" % (rb["warnings"],))

        # (c) a manifest that names no root at all must refuse rather than
        #     resolve to the current directory, which is what abspath("") does.
        blind = _copy_root(live, "migrate_blind_")
        copies.append(blind)
        snap3 = os.path.join(blind, ml.MIGRATE_DIRNAME,
                             os.path.basename(res["snapshot"]))
        mpath = os.path.join(snap3, ml.MANIFEST_FILE)
        with open(mpath, "r", encoding="utf-8") as fh:
            broken = json.load(fh)
        broken.pop("root", None)
        with open(mpath, "w", encoding="utf-8") as fh:
            json.dump(broken, fh)
        raised = None
        try:
            ml.rollback(snap3)
        except ml.MigrationError as ex:
            raised = str(ex)
        check(raised is not None,
              "a manifest with no root must refuse, not fall back to the "
              "working directory")
        check("--root" in (raised or ""),
              "the refusal should say how to fix it, got %r" % (raised,))
    finally:
        shutil.rmtree(live, ignore_errors=True)
        for path in copies:
            shutil.rmtree(path, ignore_errors=True)


# --------------------------------------------------------------------------
# 12 -- requirements.txt still carries the optional preview dependencies.
#
# The handover's setup step is `pip install -r requirements.txt`. pymupdf and
# pywin32 were missing from it, so live section preview came out silently
# unavailable. They are optional -- live_preview.py imports them inside the
# functions that need them and refuses with a typed error -- so the file must
# still resolve where they cannot be installed at all.
# --------------------------------------------------------------------------

REQUIREMENTS = os.path.join(REPO, "requirements.txt")

# name [==version] [; marker]
_REQ_RE = re.compile(
    r"^([A-Za-z0-9][A-Za-z0-9._-]*)\s*([<>=!~][^;]*)?\s*(?:;\s*(.+))?$")


def _norm(name):
    return re.sub(r"[-_.]+", "-", name).lower()


def read_requirements(path=REQUIREMENTS):
    """``[{"name","norm","spec","marker","line"}]`` -- comments and blanks out."""
    entries = []
    with open(path, "r", encoding="utf-8") as fh:
        for raw in fh:
            line = raw.split("#", 1)[0].strip()
            if not line:
                continue
            m = _REQ_RE.match(line)
            check(m is not None, "unparsable requirement line: %r" % line)
            entries.append({
                "name": m.group(1),
                "norm": _norm(m.group(1)),
                "spec": (m.group(2) or "").strip(),
                "marker": (m.group(3) or "").strip(),
                "line": line,
            })
    return entries


def test_requirements_declare_the_optional_preview_dependencies():
    check(os.path.isfile(REQUIREMENTS), "no requirements.txt at %s" % REQUIREMENTS)
    entries = read_requirements()
    by_name = {e["norm"]: e for e in entries}

    # The four that were always there must not have been disturbed.
    for name in ("lxml", "python-docx", "typing-extensions", "openpyxl"):
        check(name in by_name, "%s disappeared from requirements.txt" % name)

    # The two the handover told the owner to install by hand.
    for name in ("pymupdf", "pywin32"):
        check(name in by_name,
              "%s is missing from requirements.txt, so `pip install -r "
              "requirements.txt` leaves live section preview unavailable"
              % name)
        check(by_name[name]["spec"].startswith("=="),
              "%s must be pinned like the entries around it, got %r"
              % (name, by_name[name]["spec"]))

    # Every entry is pinned -- the file's existing style, and what makes the
    # handover reproducible.
    for e in entries:
        check(e["spec"].startswith("=="),
              "%s is not pinned with ==: %r" % (e["name"], e["line"]))

    # Installable where Word can never run. pywin32 has no distribution off
    # Windows, so without a marker the whole file fails to resolve there.
    win_only = by_name["pywin32"]["marker"]
    check("sys_platform" in win_only and "win32" in win_only,
          "pywin32 needs a sys_platform marker or requirements.txt cannot be "
          "installed off Windows, got marker %r" % (win_only,))
    check(by_name["pymupdf"]["marker"] == "",
          "pymupdf ships everywhere and should not be narrowed by a marker, "
          "got %r" % (by_name["pymupdf"]["marker"],))

    # Evaluate the markers for real when the machine can. Nothing here needs
    # Word, or a network, or the packages themselves to be installed.
    try:
        from packaging.requirements import Requirement
    except ImportError:
        print("     (packaging not importable -- marker evaluation skipped)")
        return
    for e in entries:
        req = Requirement(e["line"])
        on_win = req.marker is None or req.marker.evaluate({"sys_platform": "win32"})
        off_win = req.marker is None or req.marker.evaluate({"sys_platform": "linux"})
        check(on_win, "%s would not install on Windows" % e["name"])
        if e["norm"] == "pywin32":
            check(not off_win,
                  "pywin32 must drop out off Windows, or the file cannot be "
                  "resolved there")
        else:
            check(off_win,
                  "%s must still resolve off Windows, marker %r"
                  % (e["name"], e["marker"]))


def main():
    failures = []
    for fn in (test_plan_apply_rollback,
               test_existing_target_refuses_before_moving,
               test_partial_move_is_resumable,
               test_rollback_names_what_it_leaves_behind,
               test_rollback_root_argument_wins_over_the_manifest,
               test_requirements_declare_the_optional_preview_dependencies):
        try:
            fn()
            print("ok   %s" % fn.__name__)
        except AssertionError as ex:
            failures.append("%s: %s" % (fn.__name__, ex))
            print("FAIL %s: %s" % (fn.__name__, ex))
    print("%d assertions" % COUNT[0])
    if failures:
        print("FAILED (%d)" % len(failures))
        return 1
    print("PASS test_migrate_layout")
    return 0


if __name__ == "__main__":
    sys.exit(main())
