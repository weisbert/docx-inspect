# -*- coding: utf-8 -*-
"""Regression test for the local auto-snapshot backup (server.py).

Exercises the pure helpers on a temp reports root:
  - snapshot on save (dedupe identical, prune to KEEP)
  - snapshot-all before apply
  - list newest-first with reason tags
  - restore (and that restore snapshots the current state first, so it's undoable)

Neutral: no project/company data. Run: python builder/test_autosave.py
"""
import json, os, shutil, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import server  # noqa: E402


def _proj(d, marker):
    return json.dumps({"schema_version": 1, "template": "t",
                       "outline": [{"id": "n-1", "title": marker, "blocks": []}]},
                      ensure_ascii=False).encode("utf-8")


def main():
    root = tempfile.mkdtemp(prefix="autosave_test_")
    try:
        pdir = os.path.join(root, "PROJ")
        os.makedirs(pdir)
        pj = os.path.join(pdir, "project.json")

        # 1) snapshot on save
        server.atomic_write(pj, _proj(pdir, "v1"))
        n1 = server.autosave_snapshot(pdir, "save")
        assert n1 and n1.endswith(".json"), n1
        assert "__save" in n1, n1

        # 2) dedupe: identical content -> no new snapshot
        n_dup = server.autosave_snapshot(pdir, "save")
        assert n_dup is None, "identical content should not create a snapshot"

        # 3) changed content -> new snapshot
        server.atomic_write(pj, _proj(pdir, "v2"))
        n2 = server.autosave_snapshot(pdir, "save")
        assert n2 and n2 != n1, (n1, n2)

        snaps = server.list_autosaves(pdir)
        assert len(snaps) == 2, snaps
        assert snaps[0]["mtime"] >= snaps[1]["mtime"], "newest first"
        assert snaps[0]["reason"] == "save", snaps[0]

        # 4a) snapshot-all when nothing changed since last snapshot -> dedupe (empty),
        #     but the current state is still captured in _autosave/ (that's the point).
        assert server.autosave_all(root, "preapply") == [], "identical -> dedupe"
        # 4b) after an edit, snapshot-all captures it with a preapply tag
        server.atomic_write(pj, _proj(pdir, "v3"))
        made = server.autosave_all(root, "preapply")
        assert any(m.startswith("PROJ/") and "__preapply" in m for m in made), made

        # 5) restore an older snapshot. First write un-snapshotted content so the
        #    pre-restore capture is genuinely exercised (not deduped away).
        server.atomic_write(pj, _proj(pdir, "beforerestore"))
        before = server.list_autosaves(pdir)
        oldest = before[-1]["name"]  # the v1 save
        res = server.restore_autosave(pdir, oldest)
        assert res["ok"], res
        with open(pj, "rb") as fh:
            assert b'"v1"' in fh.read(), "restore should bring back v1 content"
        # the pre-restore state must have been captured -> restore is undoable
        after = server.list_autosaves(pdir)
        assert any(s["reason"] == "prerestore" for s in after), \
            "restore must snapshot current state first"
        pre = [s for s in after if s["reason"] == "prerestore"][0]
        with open(os.path.join(server._autosave_dir(pdir), pre["name"]), "rb") as fh:
            assert b'"beforerestore"' in fh.read(), "prerestore must hold prior state"

        # 6) bad names rejected
        for bad in ("../x.json", "a/b.json", "x.txt", ""):
            try:
                server.restore_autosave(pdir, bad)
                raise AssertionError("should have rejected %r" % bad)
            except (ValueError, FileNotFoundError):
                pass

        # 7) prune to AUTOSAVE_KEEP
        keep = server.AUTOSAVE_KEEP
        for i in range(keep + 5):
            server.atomic_write(pj, _proj(pdir, "bulk-%d" % i))
            server.autosave_snapshot(pdir, "save")
        assert len(server.list_autosaves(pdir)) <= keep, "must prune to KEEP"

        print("test_autosave: ALL PASS")
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    main()
