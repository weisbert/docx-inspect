#!/usr/bin/env python3
"""A note must never reach the Word body.

Run:  python builder/tests/test_notes_never_render.py

WHY THIS FILE EXISTS
    A note is a remark ABOUT the report -- an instruction, a question, a reply --
    written on the cover, on a section or on a card and carried inside
    project.json so it travels with the text exchange. The whole arrangement
    rests on one promise: the exported document does not contain it. A note that
    printed would put a private remark into a delivered report, and nothing in
    the export flow would have said so.

    The promise holds because the engine renders known block types and known
    fields and `notes` is neither -- which is true until someone adds a generic
    "render whatever is here" path. This test is what notices that.

WHAT IT ASSERTS
    Notes on project.meta, on an outline node (both the plain-string `note` and
    the `notes` array) and on a block do not appear anywhere in the .docx --
    not in the body, the header, the footer, the cover or the properties.

The template config is the golden test's own ASCII-only fixture, imported rather
than copied so the two cannot drift apart.
"""

import importlib.util
import json
import os
import sys
import tempfile
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "builder"))

import buildpath  # noqa: F401,E402  (registers core/ on sys.path)
import engine  # noqa: E402

_spec = importlib.util.spec_from_file_location(
    "golden_fixture", os.path.join(HERE, "test_render_golden.py"))
_golden = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_golden)

# One needle, no spaces and no punctuation: a run split across XML elements
# would hide a phrase, and this way a single match is a real leak.
SECRET = "NOTEMUSTNOTPRINT"


def sample_project():
    return {
        "schema_version": 1,
        "template": "golden_tpl_v1",
        "meta": {
            "title": "Sample report", "doc_no": "D-1", "version": "V1.0",
            "secrecy": "Internal", "author": "A. Engineer", "date": "2026-09-08",
            "reviewers": [], "approver": "", "revisions": [],
            "notes": [{"by": "user", "at": "2026-09-08", "status": "open",
                       "text": SECRET + "cover"}],
        },
        "outline": [{
            "id": "n1",
            "title": "Results",
            "note": SECRET + "sectionstring",
            "notes": [{"by": "claude", "at": "2026-09-08", "status": "open",
                       "text": SECRET + "sectionarray"}],
            "blocks": [
                {"type": "para", "cardStart": True, "list": None,
                 "runs": [{"t": "Body text."}],
                 "notes": [{"by": "user", "at": "2026-09-08", "status": "done",
                            "text": SECRET + "block"}]},
            ],
            "children": [],
        }],
    }


def main():
    project = sample_project()
    cfg = _golden.golden_config()
    cfg["_logo_path"] = ""          # no logo file in a temporary fixture

    tmp = tempfile.mkdtemp(prefix="notes-never-render-")
    project_dir = os.path.join(tmp, "CDR")
    os.makedirs(os.path.join(project_dir, "images"), exist_ok=True)
    with open(os.path.join(project_dir, "project.json"), "w", encoding="utf-8") as fh:
        json.dump(project, fh)

    out = os.path.join(tmp, "out.docx")
    engine.render_report(project, cfg, project_dir, out)

    hits = []
    with zipfile.ZipFile(out) as zf:
        for name in zf.namelist():
            if not name.endswith(".xml"):
                continue
            blob = zf.read(name).decode("utf-8", "replace")
            if SECRET in blob:
                hits.append(name)

    print("  rendered: " + out)
    if hits:
        print("  [FAIL] a note reached the document -> " + ", ".join(hits))
        print("")
        print("1 assertion(s) failed")
        return 1
    print("  [ok  ] no note text anywhere in the .docx")
    print("")
    print("all assertions passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
