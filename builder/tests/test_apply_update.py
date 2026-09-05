#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Unit tests for apply_update.py (the pure section-patch + bundle logic).

The apply/rollback engine had zero tests; the smoke test only ever exercised the
server route. These cover the pure functions directly:
  _find_node / _count_title_matches / _apply_ops (incl. the duplicate-title warn),
  run_plan (backup + incremental state + per-item error isolation),
  record_replace, rollback_last, and apply_bundle over a crafted smart zip.

Run:  .venv\\Scripts\\python.exe builder\\test_apply_update.py
"""
import io
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

import apply_update as au  # noqa: E402

fails = 0


def check(cond, name, detail=""):
    global fails
    print(("  PASS " if cond else "  FAIL ") + name + ("" if cond else "  -> " + detail))
    if not cond:
        fails += 1


def _proj():
    return {
        "schema_version": 1,
        "outline": [
            {"id": "a", "title": "Intro", "blocks": [], "children": [
                {"id": "b", "title": "Detail", "blocks": [], "children": []}]},
            {"id": "c", "title": "Detail", "blocks": [], "children": []},   # dup title
        ],
    }


def test_find_and_ops():
    p = _proj()
    check(au._find_node(p["outline"], node_id="b")["title"] == "Detail", "_find_node by id")
    check(au._find_node(p["outline"], title="Intro")["id"] == "a", "_find_node by title")
    check(au._find_node(p["outline"], node_id="zzz") is None, "_find_node miss -> None")
    check(au._count_title_matches(p["outline"], "Detail") == 2, "_count_title_matches counts dups")

    # set_blocks by id
    log = au._apply_ops(p, [{"op": "set_blocks", "node_id": "a",
                             "blocks": [{"type": "para", "runs": [{"t": "hi"}]}]}])
    check(au._find_node(p["outline"], node_id="a")["blocks"][0]["type"] == "para",
          "_apply_ops set_blocks", str(log))

    # set_title
    au._apply_ops(p, [{"op": "set_title", "node_id": "b", "value": "Renamed"}])
    check(au._find_node(p["outline"], node_id="b")["title"] == "Renamed", "_apply_ops set_title")

    # duplicate-title op warns and patches the first (fresh project -- the block
    # above renamed one 'Detail', so re-create the two-'Detail' shape).
    p2 = _proj()
    log = au._apply_ops(p2, [{"op": "set_blocks", "title": "Detail", "blocks": []}])
    check(any("matches" in ln and "FIRST" in ln for ln in log),
          "_apply_ops warns on ambiguous title", str(log))

    # node not found
    log = au._apply_ops(p2, [{"op": "set_title", "node_id": "nope", "value": "x"}])
    check(any("not found" in ln for ln in log), "_apply_ops logs a missing node")


def _make_smart_zip(projects=None, files=None, note=""):
    buf = io.BytesIO()
    manifest = {"note": note, "projects": projects or {}, "files": list((files or {}).keys())}
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("update.json", json.dumps(manifest))
        for rel, data in (files or {}).items():
            z.writestr(rel, data)
        for pdir, spec in (projects or {}).items():
            if spec.get("mode") != "patch" and "content" in spec:
                z.writestr(pdir + "/project.json", spec["content"])
    return buf.getvalue()


def test_run_plan_and_bundle():
    root = tempfile.mkdtemp(prefix="au_test_")
    os.makedirs(os.path.join(root, "proj"))
    pj = os.path.join(root, "proj", "project.json")
    with open(pj, "w", encoding="utf-8") as fh:
        json.dump({"schema_version": 1, "outline": [{"id": "s", "title": "S", "blocks": []}]}, fh)

    # patch bundle: set_blocks on section S
    zbytes = _make_smart_zip(projects={
        "proj": {"mode": "patch", "ops": [
            {"op": "set_blocks", "node_id": "s", "blocks": [{"type": "para", "runs": [{"t": "x"}]}]}]}})
    bundle = os.path.join(root, "_updates", "u.zip")
    os.makedirs(os.path.dirname(bundle), exist_ok=True)
    with open(bundle, "wb") as fh:
        fh.write(zbytes)

    summary = au.apply_bundle(root, bundle, dry=False)
    on_disk = json.load(open(pj, encoding="utf-8"))
    check(on_disk["outline"][0]["blocks"][0]["type"] == "para", "apply_bundle patch applied")
    check(os.path.isdir(summary["backup"]), "apply_bundle made a backup")
    check("refresh" in summary and summary["failed"] == [], "apply_bundle refresh note + no failures")
    # state saved
    st = au._load_state(root)
    check(any("project.json" in k for k in st), "apply_bundle recorded applied-state")

    # rollback restores the pre-patch content
    res = au.rollback_last(root)
    restored = json.load(open(pj, encoding="utf-8"))
    check(res["ok"] and not restored["outline"][0]["blocks"], "rollback_last restores pre-patch")

    # record_replace round-trip + backup
    rec = au.record_replace(root, os.path.join("proj", "project.json"), b'{"schema_version":1}')
    check(rec["existed"] and os.path.isdir(rec["backup"]), "record_replace backs up existing")
    check(json.load(open(pj, encoding="utf-8")) == {"schema_version": 1}, "record_replace wrote new content")


def test_partial_failure():
    # A patch whose target project.json is not valid JSON must fail that ONE item
    # (annotate error) without taking down the whole run.
    root = tempfile.mkdtemp(prefix="au_test2_")
    os.makedirs(os.path.join(root, "bad"))
    with open(os.path.join(root, "bad", "project.json"), "w", encoding="utf-8") as fh:
        fh.write("{not json")
    os.makedirs(os.path.join(root, "good"))
    with open(os.path.join(root, "good", "project.json"), "w", encoding="utf-8") as fh:
        json.dump({"schema_version": 1, "outline": [{"id": "g", "title": "G", "blocks": []}]}, fh)

    zbytes = _make_smart_zip(projects={
        "bad": {"mode": "patch", "ops": [{"op": "set_title", "node_id": "g", "value": "X"}]},
        "good": {"mode": "patch", "ops": [
            {"op": "set_blocks", "node_id": "g", "blocks": [{"type": "para", "runs": [{"t": "ok"}]}]}]},
    })
    bundle = os.path.join(root, "u.zip")
    with open(bundle, "wb") as fh:
        fh.write(zbytes)
    summary = au.apply_bundle(root, bundle, dry=False)
    check(len(summary["failed"]) == 1 and "bad" in summary["failed"][0]["rel"],
          "partial failure: bad item reported, not fatal", str(summary["failed"]))
    good = json.load(open(os.path.join(root, "good", "project.json"), encoding="utf-8"))
    check(good["outline"][0]["blocks"][0]["type"] == "para",
          "partial failure: the good item still applied")


def test_rollback_created():
    # A create-only op (e.g. paste-import of a brand-new project) must leave a
    # backup dir so rollback targets THAT op, and rollback must delete the created
    # file rather than silently reverting an older, unrelated op.
    root = tempfile.mkdtemp(prefix="au_rbcreate_")
    rec = au.record_replace(root, os.path.join("newproj", "project.json"),
                            b'{"schema_version":1}')
    check(not rec["existed"] and os.path.isdir(rec["backup"]),
          "record_replace(create) still makes a backup dir")
    pj = os.path.join(root, "newproj", "project.json")
    check(os.path.isfile(pj), "created file exists after record_replace")
    res = au.rollback_last(root)
    check(res["ok"] and not os.path.isfile(pj),
          "rollback of a create deletes the created file")
    check(res.get("deleted") and res["deleted"][0].endswith("newproj/project.json"),
          "rollback reports the deleted create", str(res.get("deleted")))


def test_rollback_scope_case():
    # A scoped rollback is asked for by path, and on Windows the path that comes
    # back from the address bar, from a saved link or from a hand-typed --dir
    # need not carry the folder's own capitals. The scope test has to answer the
    # same for all of them, or a rollback that had nothing wrong with it is
    # refused with "the changes on record belong to other reports".
    root = tempfile.mkdtemp(prefix="au_rbcase_")
    rel = os.path.join("Proj", "Mod", "CDR", "project.json")
    au.record_replace(root, rel, b'{"schema_version":1,"outline":[]}')
    au.record_replace(root, rel, b'{"schema_version":1,"outline":[{"id":"s"}]}')
    pj = os.path.join(root, rel)
    check(json.load(open(pj, encoding="utf-8"))["outline"] == [{"id": "s"}],
          "the second write is what is on disk")

    res = au.rollback_last(root, dir_name="proj/mod/cdr")
    check(res.get("ok"), "a scope spelled in another case still finds its backup",
          str(res))
    check(json.load(open(pj, encoding="utf-8"))["outline"] == [],
          "and it is the one that was rolled back")

    # ... and the guard it must not lose: a scope that names nobody is refused.
    other = au.rollback_last(root, dir_name="Proj/Mod/FDR")
    check(not other.get("ok") and other.get("reason") == "out_of_scope",
          "a scope with no backup of its own is still refused", str(other))


def test_snapshot_finds_nested_reports():
    # Reports live three levels down (<project>/<module>/<stage>), and the
    # packager used to look one level down only: under a real reports root it
    # found nothing at all, and aiming it at the module directory produced
    # members named "CDR/project.json" -- an address nothing on the receiving
    # side understands. Both layouts must be found, addressed by their path
    # relative to the root.
    root = tempfile.mkdtemp(prefix="au_snap_")
    for rel in ("P1/MOD_A/CDR", "P1/MOD_A/FDR", "flat"):
        d = os.path.join(root, *rel.split("/"))
        os.makedirs(d)
        with open(os.path.join(d, "project.json"), "w", encoding="utf-8") as fh:
            json.dump({"schema_version": 1, "outline": []}, fh)
    # noise that is not a report: bookkeeping, a template library, images
    for junk in ("_backups/old", "templates/sample", "P1/MOD_A/CDR/images",
                 "P1/MOD_A/CDR/_autosave"):
        os.makedirs(os.path.join(root, *junk.split("/")), exist_ok=True)
    with open(os.path.join(root, "_backups", "old", "project.json"),
              "w", encoding="utf-8") as fh:
        fh.write("{}")

    check(au.cmd_snapshot(root) == 0, "cmd_snapshot packages a three-level root")
    outbox = os.path.join(root, "_outbox")
    zips = [os.path.join(outbox, n) for n in os.listdir(outbox)
            if n.endswith(".zip")]
    names = []
    if zips:
        with zipfile.ZipFile(zips[0]) as z:
            names = sorted(z.namelist())
    check(names == ["P1/MOD_A/CDR/project.json", "P1/MOD_A/FDR/project.json",
                    "flat/project.json", "update.json"],
          "each member is addressed by its path under the reports root",
          str(names))

    # A package that does not say which state it was cut from makes the
    # receiving side warn that the common ancestor cannot be checked -- on every
    # package, which is how that warning stopped being read. A report with a
    # baseline now travels with its fingerprint.
    base_dir = os.path.join(root, "P1", "MOD_A", "CDR")
    with open(os.path.join(base_dir, "project.json"), "rb") as fh:
        au._atomic_write(os.path.join(base_dir, "_baseline.json"), fh.read())
    au.cmd_snapshot(root)
    zips = sorted(os.listdir(outbox))
    with zipfile.ZipFile(os.path.join(outbox, zips[-1])) as z:
        manifest = json.loads(z.read("update.json").decode("utf-8"))
    declared = (manifest.get("projects") or {}).get("P1/MOD_A/CDR") or {}
    _has, ancestor = au.baseline_state(root, "P1/MOD_A/CDR/project.json")
    check(declared.get("base_sha") == ancestor and bool(ancestor),
          "the package names the state each report was cut from",
          str(manifest.get("projects")))
    check("base_sha" not in ((manifest.get("projects") or {}).get("flat") or {}),
          "and says nothing for a report that has never been exchanged",
          str(manifest.get("projects")))

    found = au.find_report_dirs(root)
    check(found == ["P1/MOD_A/CDR", "P1/MOD_A/FDR", "flat"],
          "find_report_dirs walks the three-level layout and keeps the flat one",
          str(found))


def test_delete_node():
    """A section can be dropped without its siblings riding along.

    Before delete_node the only way to remove a sub-section was set_children on
    its parent, which ships every sibling too -- one removal, a dozen unrelated
    sections overwritten. These check that the removal is surgical, that it
    reaches a nested section as well as a top-level one, and that re-applying the
    same bundle is a no-op rather than an error.
    """
    p = _proj()
    au._find_node(p["outline"], node_id="a")["children"].append(
        {"id": "b2", "title": "Keep me", "blocks": [], "children": []})

    log = au._apply_ops(p, [{"op": "delete_node", "node_id": "b"}])
    kept = au._find_node(p["outline"], node_id="a")["children"]
    check(au._find_node(p["outline"], node_id="b") is None,
          "delete_node removes the addressed section", str(log))
    check([n["id"] for n in kept] == ["b2"],
          "and leaves its siblings in place", str([n["id"] for n in kept]))
    check(any("deleted section" in ln for ln in log), "and says so", str(log))

    # Re-applying the same op is a no-op: a patch bundle is meant to be
    # re-runnable, and the section it names is already gone.
    log = au._apply_ops(p, [{"op": "delete_node", "node_id": "b"}])
    check(any("already absent" in ln for ln in log),
          "delete_node is idempotent", str(log))

    # Top-level chapter, addressed by title.
    log = au._apply_ops(p, [{"op": "delete_node", "title": "Intro"}])
    check(au._find_node(p["outline"], node_id="a") is None,
          "delete_node reaches a top-level chapter by title", str(log))
    check(len(p["outline"]) == 1 and p["outline"][0]["id"] == "c",
          "and the chapter's children go with it", str(p["outline"]))


def main():
    test_find_and_ops()
    test_delete_node()
    test_run_plan_and_bundle()
    test_partial_failure()
    test_rollback_created()
    test_rollback_scope_case()
    test_snapshot_finds_nested_reports()
    print("\n%d test failure(s)" % fails)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
