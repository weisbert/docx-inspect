#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""The 'copy' manifest entry: a package moves a file that already lives on the
target machine under another report.

Why this exists: a patch that carries a section over from an earlier report
carries its image references too, and those image files may exist only on the
machine that receives the package -- the sender never had the bytes, so it cannot
put them in the zip. Before this op, every such apply left the figures blank and
someone had to copy files by hand. The rules the test pins down:

  * an absent destination is created from the named source;
  * an existing destination is KEPT, not clobbered, unless the entry opts in;
  * a source that is not on this machine is skipped, and the rest of the package
    still applies (a package must never fail as a whole over a missing figure);
  * paths that try to leave the reports root are dropped while reading;
  * --rollback removes what the copy created.

Run:  python builder/tests/test_apply_copy.py
"""
import json
import os
import shutil
import sys
import tempfile
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))          # builder/
import buildpath  # noqa: F401,E402  (registers the layer dirs on sys.path)
import apply_update as ap  # noqa: E402

PNG = b"\x89PNG\r\n\x1a\n" + b"source-bytes"
OTHER = b"\x89PNG\r\n\x1a\n" + b"already-there"

fails = []


def check(cond, what):
    if cond:
        print("  ok   %s" % what)
    else:
        print("  FAIL %s" % what)
        fails.append(what)


def project(title="Section A"):
    return {"schema_version": 1, "meta": {"title": "T"},
            "outline": [{"id": "n-1", "title": title, "blocks": [], "children": []}]}


def make_root():
    root = tempfile.mkdtemp(prefix="copyop_")
    for rel in ("proj/A", "proj/B"):
        os.makedirs(os.path.join(root, rel, "images"))
        with open(os.path.join(root, rel, "project.json"), "w", encoding="utf-8") as fh:
            json.dump(project(), fh)
    with open(os.path.join(root, "proj/A/images/fig.png"), "wb") as fh:
        fh.write(PNG)
    return root


def bundle(root, copies, ops=None, name="b.zip"):
    man = {"format": "ndiv-update/1", "note": "t", "files": [], "copy": copies}
    if ops is not None:
        man["projects"] = {"proj/B": {"mode": "patch", "ops": ops}}
    path = os.path.join(root, name)
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("update.json", json.dumps(man))
    return path


def main():
    # --- 1. plain copy into a report that does not have the file -------------
    root = make_root()
    dst = os.path.join(root, "proj/B/images/fig.png")
    ap.apply_bundle(root, bundle(root, [{"from": "proj/A/images/fig.png",
                                         "to": "proj/B/images/fig.png"}]))
    check(os.path.isfile(dst), "absent destination is created")
    check(open(dst, "rb").read() == PNG, "copied bytes match the source")

    # --- 2. re-apply keeps what is already there ------------------------------
    with open(dst, "wb") as fh:
        fh.write(OTHER)                      # stand-in for a newer local figure
    res = ap.apply_bundle(root, bundle(root, [{"from": "proj/A/images/fig.png",
                                               "to": "proj/B/images/fig.png"}]))
    check(open(dst, "rb").read() == OTHER, "existing destination is not clobbered")
    check(any(a["verb"] == "skip" for a in res["actions"]), "kept file reports verb 'skip'")

    # --- 3. opt-in overwrite --------------------------------------------------
    ap.apply_bundle(root, bundle(root, [{"from": "proj/A/images/fig.png",
                                         "to": "proj/B/images/fig.png",
                                         "overwrite": True}]))
    check(open(dst, "rb").read() == PNG, "overwrite:true replaces the destination")
    shutil.rmtree(root)

    # --- 4. missing source: skipped, and the patch in the same package lands ---
    root = make_root()
    ops = [{"op": "set_blocks", "title": "Section A",
            "blocks": [{"type": "para", "runs": [{"t": "filled"}]}]}]
    res = ap.apply_bundle(root, bundle(root, [{"from": "proj/A/images/gone.png",
                                               "to": "proj/B/images/gone.png"}], ops))
    check(not os.path.exists(os.path.join(root, "proj/B/images/gone.png")),
          "missing source writes nothing")
    check(any(a["verb"] == "skip" for a in res["actions"]), "missing source reports 'skip'")
    check(not res["failed"], "missing source is not an apply failure")
    with open(os.path.join(root, "proj/B/project.json"), encoding="utf-8") as fh:
        got = json.load(fh)
    check(got["outline"][0]["blocks"], "the patch in the same package still applied")
    shutil.rmtree(root)

    # --- 5. containment: a path leaving the root never becomes an action ------
    root = make_root()
    for bad in ("../outside.png", "/etc/passwd", "C:/x.png"):
        _, actions = ap.read_bundle(root, bundle(root, [{"from": "proj/A/images/fig.png",
                                                         "to": bad}], name="bad.zip"))
        check(not [a for a in actions if a[0] == "copy"], "destination %r is dropped" % bad)
    _, actions = ap.read_bundle(root, bundle(root, [{"from": "../secret.png",
                                                     "to": "proj/B/images/f.png"}],
                                             name="bad2.zip"))
    check(not [a for a in actions if a[0] == "copy"], "source '../secret.png' is dropped")
    shutil.rmtree(root)

    # --- 6. rollback removes the copied file ---------------------------------
    root = make_root()
    ap.apply_bundle(root, bundle(root, [{"from": "proj/A/images/fig.png",
                                         "to": "proj/B/images/fig.png"}]))
    check(os.path.isfile(os.path.join(root, "proj/B/images/fig.png")), "copied before rollback")
    ap.rollback_last(root)
    check(not os.path.exists(os.path.join(root, "proj/B/images/fig.png")),
          "rollback removes the copied file")
    check(os.path.isfile(os.path.join(root, "proj/A/images/fig.png")),
          "rollback leaves the source alone")
    shutil.rmtree(root)

    print("\n%d check(s) failed" % len(fails) if fails else "\nall checks passed")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
