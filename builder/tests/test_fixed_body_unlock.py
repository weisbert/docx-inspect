#!/usr/bin/env python3
"""Overriding a fixed template body must not change one word of the export.

A section can be pinned to a run of paragraphs the TEMPLATE owns: ``fixed_body``
names an entry in the template config's ``fixed_bodies``, and ``engine`` renders
that entry instead of the section's own blocks ("fixed body wins over blocks").
The editor now lets a user take such a section over -- "Edit this text" drops the
key and puts the same words in as ordinary ``para`` blocks -- and the promise
that action makes is that NOTHING about the document changes until the user
actually types something.

That promise spans two languages: the conversion is written in the browser
(``blocksFromFixedBody`` in builder/web/assets/v2/js/views/editor.js) and the
render is written here. So this test does not re-implement the conversion: it
RUNS the browser's, through node, and renders both sides with the real engine.

  1. EQUIVALENCE -- one section rendered pinned, and the same section rendered
     from the blocks the conversion produced, give byte-identical paragraphs in
     word/document.xml: same count, same text, same style, same run properties.
  2. IT IS A REAL COMPARISON -- the same check against a deliberately lossy
     conversion (the words only, styles dropped) FAILS, so assertion 1 has teeth.
  3. THE KEY IS WHAT SWITCHES -- with the key still on the node, the engine
     ignores the blocks entirely; that is the behaviour the conversion exists to
     work around, and it is asserted rather than assumed.

The fixture is inline and neutral: the template config comes from
test_render_golden.golden_config() and the fixed body is invented here.

Without node on PATH the conversion cannot be exercised and the test prints SKIP
and exits 0 -- the same stance the browser tests take.

Run:
    python builder/tests/test_fixed_body_unlock.py
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))    # builder/tests
BUILDER = os.path.dirname(HERE)                      # builder/
REPO = os.path.dirname(BUILDER)
if BUILDER not in sys.path:
    sys.path.insert(0, BUILDER)
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import buildpath  # noqa: E402,F401  (registers core/docx_io/store/sync/web)

import engine  # noqa: E402
from test_render_golden import golden_config  # noqa: E402

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"

EDITOR_JS = os.path.join(BUILDER, "web", "assets", "v2", "js", "views", "editor.js")

FIXED_KEY = "preface"
LEAD = "Scope of this document."
TAIL = "The same words appear in every report of this kind."


# ---------------------------------------------------------------------------
# Fixture
# ---------------------------------------------------------------------------
def fixed_body():
    """A template body that uses every field the block model can carry: a
    group-level style two paragraphs inherit differently, bold / italic / colour
    runs, and a list item with a level."""
    return {
        "style": "mybody",
        "paragraphs": [
            {"runs": [{"t": LEAD, "b": True}]},
            {"style": "body", "list": "bullet", "level": 1,
             "runs": [{"t": TAIL, "i": True, "color": "404040"},
                      {"t": " Second run, plain."}]},
        ],
    }


def project_with(node):
    return {
        "schema_version": 1,
        "meta": {"title": "Sample report", "doc_no": "DOC-1", "version": "V1.0",
                 "secrecy": "Internal", "author": "A. Engineer",
                 "date": "2026-09-02", "reviewers": [], "approver": "",
                 "revisions": []},
        "outline": [node],
    }


# ---------------------------------------------------------------------------
# The conversion, run where it is written
# ---------------------------------------------------------------------------
NODE_SCRIPT = """
import { pathToFileURL } from 'node:url';
globalThis.preact = { h: () => null, Fragment: {}, render: () => {} };
globalThis.preactHooks = {
  useState: () => [null, () => {}], useEffect: () => {}, useLayoutEffect: () => {},
  useRef: () => ({ current: null }), useMemo: (fn) => fn(), useCallback: (fn) => fn,
  useId: () => 'id',
};
globalThis.htm = { bind: () => () => null };
const mod = await import(pathToFileURL(process.argv[2]).href);
const out = mod.blocksFromFixedBody(JSON.parse(process.argv[3]));
process.stdout.write(JSON.stringify(out));
"""


class ConversionMissing(Exception):
    """node ran and the editor has no conversion to run -- a failure, not a skip."""


def convert_through_node(fb):
    """The browser's blocksFromFixedBody, run by node.

    Returns None only when node itself is unavailable (then the test skips, as
    the browser tests do). When node runs and the editor does not publish the
    conversion, that is the very thing this file exists to catch, so it raises."""
    node_exe = shutil.which("node")
    if not node_exe:
        return None
    tmp = tempfile.mkdtemp(prefix="rw-fixed-body-")
    try:
        script = os.path.join(tmp, "convert.mjs")
        with open(script, "w", encoding="utf-8") as fh:
            fh.write(NODE_SCRIPT)
        proc = subprocess.run(
            [node_exe, script, EDITOR_JS, json.dumps(fb)],
            cwd=REPO, capture_output=True, text=True, timeout=60)
        if proc.returncode != 0:
            raise ConversionMissing((proc.stderr or "").strip()[:400])
        return json.loads(proc.stdout)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ---------------------------------------------------------------------------
# Reading the rendered document
# ---------------------------------------------------------------------------
def body_paragraphs(docx_path):
    """Every paragraph of word/document.xml as canonical XML, with the paragraph
    ids Word allows itself to vary stripped. Comparing the XML rather than the
    text is the point: a dropped style or a lost colour has to show up."""
    with zipfile.ZipFile(docx_path) as zf:
        xml = zf.read("word/document.xml")
    root = ET.fromstring(xml)
    body = root.find(W + "body")
    out = []
    for para in body.iter(W + "p"):
        for key in list(para.attrib):
            if key.endswith("}paraId") or key.endswith("}textId") or key.endswith("}rsidR"):
                del para.attrib[key]
        out.append(ET.tostring(para, encoding="unicode"))
    return out


def render(project, cfg, tag):
    tmp = tempfile.mkdtemp(prefix="rw-fixed-body-" + tag + "-")
    out = os.path.join(tmp, "out.docx")
    engine.render_report(project, cfg, tmp, out,
                         section_only=project["outline"][0]["id"])
    return tmp, out


FAILURES = []


def check(name, ok, detail=""):
    print(("  [ok  ] " if ok else "  [FAIL] ") + name)
    if not ok:
        if detail:
            print("         " + str(detail)[:600])
        FAILURES.append(name)


def main():
    fb = fixed_body()
    try:
        blocks = convert_through_node(fb)
    except ConversionMissing as exc:
        print("")
        print("the section renders the same either way")
        check("the editor publishes blocksFromFixedBody", False, str(exc))
        print("")
        print("1 failure(s):")
        print("  - the editor publishes blocksFromFixedBody")
        return 1
    if blocks is None:
        print("SKIP: node is not available, so the browser's conversion "
              "cannot be exercised.")
        return 0

    cfg = golden_config()
    cfg["_logo_path"] = ""            # no logo file, as the golden test does
    cfg["fixed_bodies"] = {FIXED_KEY: fb}

    pinned = project_with({"id": "n-1", "title": "Preface",
                           "fixed_body": FIXED_KEY, "blocks": [], "children": []})
    opened = project_with({"id": "n-1", "title": "Preface",
                           "blocks": blocks, "children": []})

    dirs = []
    try:
        d1, f1 = render(pinned, cfg, "pinned")
        dirs.append(d1)
        d2, f2 = render(opened, cfg, "opened")
        dirs.append(d2)

        before = body_paragraphs(f1)
        after = body_paragraphs(f2)

        print("")
        print("the section renders the same either way")
        check("the same number of paragraphs", len(before) == len(after),
              "%d pinned vs %d unlocked" % (len(before), len(after)))
        same = before == after
        first_diff = ""
        if not same:
            for i, (a, b) in enumerate(zip(before, after)):
                if a != b:
                    first_diff = "paragraph %d\n  pinned : %s\n  opened : %s" % (i, a, b)
                    break
        check("every paragraph is identical, XML and all", same, first_diff)

        # 2. teeth: a conversion that keeps the words and loses everything else
        # must NOT pass the same comparison.
        lossy = [{"type": "para",
                  "runs": [{"t": r.get("t", "")} for r in blk.get("runs", [])]}
                 for blk in blocks]
        d3, f3 = render(project_with({"id": "n-1", "title": "Preface",
                                      "blocks": lossy, "children": []}), cfg, "lossy")
        dirs.append(d3)
        check("TEETH: a conversion that drops the styles is caught",
              body_paragraphs(f3) != before, "the comparison would accept anything")

        # 4. THE ONE THING THAT DOES NOT SURVIVE, pinned here so it cannot be
        # forgotten. A fixed-body run may name a font (_render_fixed_body passes
        # `ascii` / `eastAsia` to run_fmt); a block run has no field for one and
        # _render_para never passes it, so a converted run falls back to its
        # paragraph style's font. The conversion carries the keys across anyway,
        # and the editor says so when it converts such a body. If this assertion
        # starts failing, _render_para has learned about fonts -- delete it, and
        # delete the warning in editor.js with it.
        fonted = {"style": "mybody",
                  "paragraphs": [{"runs": [{"t": LEAD, "ascii": "Times New Roman"}]}]}
        cfg_font = golden_config()
        cfg_font["_logo_path"] = ""
        cfg_font["fixed_bodies"] = {FIXED_KEY: fonted}
        fonted_blocks = convert_through_node(fonted)
        check("the conversion keeps the font key on the run",
              bool(fonted_blocks) and fonted_blocks[0]["runs"][0].get("ascii")
              == "Times New Roman", json.dumps(fonted_blocks))
        d5, f5 = render(project_with({"id": "n-1", "title": "Preface",
                                      "fixed_body": FIXED_KEY, "blocks": [],
                                      "children": []}), cfg_font, "font-pinned")
        dirs.append(d5)
        d6, f6 = render(project_with({"id": "n-1", "title": "Preface",
                                      "blocks": fonted_blocks, "children": []}),
                        cfg_font, "font-opened")
        dirs.append(d6)
        check("KNOWN GAP: a run-level font is the one thing the engine drops",
              body_paragraphs(f5) != body_paragraphs(f6),
              "the engine now renders block-run fonts -- remove this assertion "
              "and the editor's warning")

        # 3. the key really is the switch.
        both = project_with({"id": "n-1", "title": "Preface",
                             "fixed_body": FIXED_KEY, "blocks": lossy, "children": []})
        d4, f4 = render(both, cfg, "both")
        dirs.append(d4)
        check("with the key still there the blocks are ignored",
              body_paragraphs(f4) == before,
              "the engine no longer lets a fixed body win over blocks")

        # 5. A KEY THIS TEMPLATE DOES NOT HAVE. The render falls back to the
        # section's own blocks -- one step reported per block -- but the step
        # COUNT gave such a section one step for the whole thing, so the export
        # progress ran past its own total and the bar sat full while the render
        # was still going. It is a report bound to another template, which is
        # exactly when an export is being watched.
        stray = project_with({"id": "n-1", "title": "Preface",
                              "fixed_body": "a-key-this-template-does-not-have",
                              "blocks": lossy, "children": []})
        d5 = tempfile.mkdtemp(prefix="rw-fixed-body-stray-")
        dirs.append(d5)
        prog = []
        engine.render_report(stray, cfg, d5, os.path.join(d5, "out.docx"),
                             on_progress=lambda d, t, _l: prog.append((d, t)))
        totals = sorted({t for _d, t in prog})
        dones = [d for d, _t in prog]
        check("an unresolvable key does not walk the progress past its own total",
              bool(prog) and len(totals) == 1 and dones == list(range(1, totals[0] + 1)),
              "%d steps reported against a total of %r" % (len(dones), totals))
    finally:
        for d in dirs:
            shutil.rmtree(d, ignore_errors=True)

    print("")
    if FAILURES:
        print("%d failure(s):" % len(FAILURES))
        for f in FAILURES:
            print("  - " + f)
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
