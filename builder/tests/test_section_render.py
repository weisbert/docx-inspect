#!/usr/bin/env python3
"""Section-only render regression test, driven by the REAL reports on this machine.

``engine.render_report(..., section_only=<node id>)`` -- and its named wrapper
``engine.render_section_docx`` -- renders ONE outline node as a proof fragment
for the live preview. ``test_render_golden.py`` locks that behaviour against a
small synthetic fixture; this test locks it against the actual documents in the
reports root, because the interesting failure modes only appear at real scale.

  1. NUMBERING PARITY -- a proof render of a mid-document section that owns a
     figure and a cross-reference shows exactly the numbers that section shows
     inside the full document. Word does not refresh fields when it exports to
     PDF, so a field's cached placeholder IS what the proof image shows; the
     numbers are therefore read straight out of ``word/document.xml`` rather
     than through python-docx.
  2. NO FRONT MATTER -- the fragment carries no cover and no table of contents.
  3. NO DANGLING REFERENCE -- a reference pointing at a figure in ANOTHER
     section still resolves; it must not degrade to the red "[ref: ...]" marker.
  4. FULL RENDER UNCHANGED -- ``section_only=None`` still produces the same
     document. Rendering "before and after the change" is no longer possible,
     so this is asserted structurally, by two guards:
       (a) a hardcoded golden fingerprint (paragraph / table / image / SEQ /
           REF / TOC counts) over an inline, neutral fixture. It is committed
           and never regenerated automatically, so any future change to the
           full-render path has to move it deliberately;
       (b) for the real reports -- whose content legitimately changes as the
           author edits them -- a fingerprint cache keyed by the sha1 of the
           project plus its config. The same input must give the same
           structure; a changed input records a new entry instead of raising a
           false alarm. That cache is machine-local state, not source, so it
           lives outside the repository (see GOLDEN_STORE).
     Plus an invariance check: a full render is byte-identical before and after
     a section-only render made with the same config object, so section mode
     cannot leak numbering state into a subsequent export.

NO report content is written into this file. The reports are addressed by path
relative to the reports root, everything else -- which section, which figure,
which cross-reference target -- is discovered at run time, and the on-disk
project.json files are never modified: the cross-reference assertion 1 needs is
injected into an in-memory copy.

When the reports root holds no reports (a fresh clone of the public mirror
carries none), the test prints SKIP and exits 0.

Run:
    python builder/tests/test_section_render.py
"""

import copy
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
import time
import zipfile
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))    # builder/tests
BUILDER = os.path.dirname(HERE)                      # builder/
if BUILDER not in sys.path:
    sys.path.insert(0, BUILDER)
import buildpath  # noqa: E402,F401  (registers core/docx_io/store/sync/web)

import engine  # noqa: E402
import apply_update  # noqa: E402  (reports-root resolution)
import templates_store as tstore  # noqa: E402

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"

# The demo report ships with the tool and is neutral, so it may be named here.
# Every other report is discovered, never named.
DEMO_DIRNAME = "demo_project"

# Folder names that are tooling, not reports -- skipped while walking the root.
NON_REPORT_DIRS = {"templates", "images", "out", "assets", "hooks", "docs",
                   "fill", "legacy", "scratch", "outbox", "inbox", "design",
                   "tests", "node_modules"}

# Fingerprint cache for assertion 4b. Deliberately NOT inside the repository:
# it is derived from whatever reports this machine happens to hold, which makes
# it machine-local state rather than source. Override with BUILDER_SECTION_GOLDEN.
GOLDEN_STORE = os.environ.get(
    "BUILDER_SECTION_GOLDEN",
    os.path.join(tempfile.gettempdir(), "report_workbench_section_goldens.json"))


# ---------------------------------------------------------------------------
# Assertion harness (same shape as test_render_golden.py).
# ---------------------------------------------------------------------------
PASS = 0
FAIL = 0


def check(cond, name, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  [PASS] %s" % name)
    else:
        FAIL += 1
        print("  [FAIL] %s%s" % (name, ("  -> " + detail) if detail else ""))


def brief(value):
    """ascii() so a report's own (possibly non-ASCII) text can appear in a
    failure message without depending on the console encoding -- and so this
    file never has to contain any of it."""
    return ascii(value)[:400]


# ---------------------------------------------------------------------------
# Reading a rendered .docx: unzip and walk word/document.xml directly.
#
# A field is written as begin / instrText / separate / <placeholder> / end
# (engine.add_field). The placeholder is the cached result Word shows until F9,
# and therefore what a proof page image shows -- so it is exactly what these
# assertions must read.
# ---------------------------------------------------------------------------
def document_xml(path):
    with zipfile.ZipFile(path) as z:
        return z.read("word/document.xml")


def paragraphs(xml_bytes):
    """[{text, fields:[(instruction, placeholder)], bookmarks:[name]}] in order."""
    root = ET.fromstring(xml_bytes)
    out = []
    for p in root.iter(W + "p"):
        text, fields, bookmarks = [], [], []
        state, instr, result = None, [], []
        for el in p.iter():
            tag = el.tag
            if tag == W + "fldChar":
                kind = el.get(W + "fldCharType")
                if kind == "begin":
                    state, instr, result = "instr", [], []
                elif kind == "separate":
                    state = "result"
                elif kind == "end":
                    fields.append((" ".join("".join(instr).split()),
                                   "".join(result)))
                    state = None
            elif tag == W + "instrText" and state == "instr":
                instr.append(el.text or "")
            elif tag == W + "t":
                if state == "result":
                    result.append(el.text or "")
                text.append(el.text or "")
            elif tag == W + "bookmarkStart":
                bookmarks.append(el.get(W + "name"))
        out.append({"text": "".join(text), "fields": fields,
                    "bookmarks": bookmarks})
    return out


def field_instructions(paras):
    return [ins for p in paras for ins, _ph in p["fields"]]


def captions(paras):
    """Map a caption's bookmark name -> the number its fields spell out.

    A caption paragraph reads  <prefix> [STYLEREF 1 \\s]-[SEQ Figure|Table ...]
    with the SEQ field wrapped in bm_<block id>_num, so the two placeholders are
    the "<chapter>-<sequence>" a reader sees un-refreshed. Captions of blocks
    with no stable id get a render-local bm_auto_<n>_num name whose number
    depends on how many captions were emitted, so they are skipped here; the
    tests give every media block an id first (see ensure_block_ids)."""
    found = {}
    for p in paras:
        chap = seq = None
        for ins, ph in p["fields"]:
            if ins.startswith("STYLEREF"):
                chap = ph
            elif ins.startswith("SEQ "):
                seq = ph
        if chap is None or seq is None:
            continue
        for name in p["bookmarks"]:
            if name and not name.startswith("bm_auto_"):
                found[name] = {"number": "%s-%s" % (chap, seq),
                               "text": p["text"]}
    return found


def ref_placeholders(paras):
    """Map a REF field's target bookmark name -> the placeholders it prints."""
    out = {}
    for p in paras:
        for ins, ph in p["fields"]:
            m = re.match(r"REF\s+(\S+)", ins)
            if m:
                out.setdefault(m.group(1), []).append(ph)
    return out


def fingerprint(xml_bytes):
    """Structural counts of a rendered body -- the assertion-4 golden."""
    root = ET.fromstring(xml_bytes)
    instrs = [" ".join((el.text or "").split())
              for el in root.iter(W + "instrText")]
    return {
        "paragraphs": sum(1 for _ in root.iter(W + "p")),
        "tables": sum(1 for _ in root.iter(W + "tbl")),
        "rows": sum(1 for _ in root.iter(W + "tr")),
        "images": sum(1 for _ in root.iter(A + "blip")),
        "seq_figure": sum(1 for i in instrs if i.startswith("SEQ Figure")),
        "seq_table": sum(1 for i in instrs if i.startswith("SEQ Table")),
        "styleref": sum(1 for i in instrs if i.startswith("STYLEREF")),
        "ref": sum(1 for i in instrs if i.startswith("REF ")),
        "toc": sum(1 for i in instrs if i.startswith("TOC")),
        "chars": sum(len(el.text or "") for el in root.iter(W + "t")),
    }


# ---------------------------------------------------------------------------
# Locating reports and their template config.
# ---------------------------------------------------------------------------
def resolve_root():
    """The reports root, resolved exactly the way the sync layer resolves it."""
    return apply_update.resolve_root(None)


def discover_reports(root, max_depth=3):
    """Relative paths of every report folder under the root (depth-limited).

    Mirrors how the server walks the tree: a report is any folder holding a
    project.json. Bookkeeping folders (leading underscore or dot) are skipped."""
    found = []

    def walk(rel, depth):
        here = os.path.join(root, rel) if rel else root
        if rel and os.path.isfile(os.path.join(here, "project.json")):
            found.append(rel.replace(os.sep, "/"))
            return
        if depth >= max_depth:
            return
        try:
            names = sorted(os.listdir(here))
        except OSError:
            return
        for name in names:
            if name.startswith(("_", ".")) or name in NON_REPORT_DIRS:
                continue
            if os.path.isdir(os.path.join(here, name)):
                walk(os.path.join(rel, name) if rel else name, depth + 1)

    walk("", 0)
    return found


def load_project(project_dir):
    with open(os.path.join(project_dir, "project.json"), encoding="utf-8") as f:
        return json.load(f)


def config_path_for(root, project, project_dir):
    """The template config the server would use, then the engine's own lookup."""
    tid = project.get("template", "")
    try:
        path = tstore.template_config_path(root, tid)
        if path and os.path.isfile(path):
            return path
    except Exception:
        pass
    return engine._resolve_config_path(project, project_dir, None)


def fresh_cfg(config_path):
    """A brand-new config dict per render: the engine stashes state on it."""
    return engine._load_config(config_path)


# ---------------------------------------------------------------------------
# Building the proof scenario out of whatever a report happens to contain.
# ---------------------------------------------------------------------------
def media_blocks(node):
    """The node's blocks that the engine bookmarks as cross-reference targets:
    every image / imagegrid, and a table only when it carries a caption."""
    out = []
    for block in node.get("blocks", []) or []:
        btype = block.get("type")
        if btype in ("image", "imagegrid"):
            out.append(block)
        elif btype in ("datatable", "table") and block.get("caption"):
            out.append(block)
    return out


def survey(project):
    """[{node, id, chapter, depth, media:[block id]}] in document order."""
    rows = []

    def walk(nodes, depth, chapter):
        for idx, node in enumerate(nodes or [], start=1):
            chap = idx if depth == 0 else chapter
            rows.append({
                "node": node,
                "id": node.get("id"),
                "chapter": chap,
                "depth": depth + 1,
                "media": [b.get("id") for b in media_blocks(node) if b.get("id")],
            })
            walk(node.get("children", []), depth + 1, chap)

    walk(project.get("outline", []), 0, 0)
    return rows


def ensure_block_ids(project):
    """Give every cross-referenceable block a stable id in this in-memory copy.

    Blocks written by the editor always have one; older hand-built content may
    not, and without an id the engine falls back to a render-local bookmark name
    whose number depends on how many captions were emitted -- which would make a
    section render and a full render incomparable for a reason that has nothing
    to do with section mode. Neutral synthetic ids, never written back."""
    n = [0]

    def walk(nodes):
        for node in nodes or []:
            for block in media_blocks(node):
                if not block.get("id"):
                    n[0] += 1
                    block["id"] = "probe-block-%d" % n[0]
            walk(node.get("children", []))

    walk(project.get("outline", []))
    return n[0]


def plan_scenario(project, require_mid=True):
    """Choose the section to proof-render and the references to inject into it.

    Wanted: a nested section (so the fragment needs synthesised ancestor
    headings) sitting mid-document (so its chapter number is neither the first
    nor the last), owning at least one figure, with another figure available in
    a different chapter to reference from inside it. Returns None when the
    report cannot supply that shape."""
    rows = survey(project)
    if not rows:
        return None
    chapters = max((r["chapter"] for r in rows), default=0)
    for row in rows:
        if not row["id"] or not row["media"]:
            continue
        if require_mid:
            if row["depth"] < 2:
                continue
            if row["chapter"] < 2 or row["chapter"] >= chapters:
                continue
        outside = None
        for other in rows:
            if other["chapter"] != row["chapter"] and other["media"]:
                outside = other["media"][0]
                if other["chapter"] < row["chapter"]:
                    break
        if require_mid and not outside:
            continue
        return {"node_id": row["id"], "chapter": row["chapter"],
                "depth": row["depth"], "inside": row["media"][0],
                "outside": outside}
    return None


def inject_reference(project, plan):
    """Prepend a paragraph holding the cross-references to the target section.

    The reports on this machine contain no cross-reference runs yet, so the
    condition assertions 1 and 3 are about has to be created. It is created in
    the in-memory project only, as a LEADING paragraph, which moves no figure or
    table counter -- so every caption number stays exactly what it was."""
    runs = [{"t": "See "}, {"ref": plan["inside"]}]
    if plan.get("outside"):
        runs += [{"t": " and "}, {"ref": plan["outside"]}]
    runs.append({"t": "."})
    for row in survey(project):
        if row["id"] == plan["node_id"]:
            row["node"].setdefault("blocks", []).insert(
                0, {"type": "para", "list": None, "runs": runs})
            return True
    return False


# ---------------------------------------------------------------------------
# Rendering helper.
# ---------------------------------------------------------------------------
def render(project, config_path, project_dir, out_path, cfg=None, **kwargs):
    cfg = cfg if cfg is not None else fresh_cfg(config_path)
    started = time.time()
    result = engine.render_report(project, cfg, project_dir, out_path, **kwargs)
    return result, document_xml(out_path), time.time() - started


def cover_markers(cfg):
    """Text that only the cover / contents front matter puts into the body."""
    marks = []
    cover = cfg.get("cover", {}) or {}
    if cover.get("company_line"):
        marks.append(cover["company_line"])
    for line in cover.get("company_names", []) or []:
        if isinstance(line, dict) and line.get("text"):
            marks.append(line["text"])
    title = (cfg.get("toc", {}) or {}).get("title")
    if title:
        marks.append(title)
    return marks


# ---------------------------------------------------------------------------
# The four assertions, per report.
# ---------------------------------------------------------------------------
def check_report(root, rel, label, require_mid):
    """Run every assertion this report can support. Returns True when it
    supplied the mid-document figure + cross-reference scenario assertion 1
    needs (so the caller knows the strict scenario really ran somewhere)."""
    project_dir = os.path.join(root, rel.replace("/", os.sep))
    on_disk = load_project(project_dir)
    config_path = config_path_for(root, on_disk, project_dir)

    project = copy.deepcopy(on_disk)
    ensure_block_ids(project)
    plan = plan_scenario(project, require_mid=require_mid)
    if plan is None and require_mid:
        return False
    print("\n--- %s: %s  (config %s)"
          % (label, rel, os.path.basename(config_path)))
    if plan is None:
        plan = plan_scenario(project, require_mid=False)
    if plan is None:
        print("    (no cross-referenceable block: structure assertions only)")

    tmp = tempfile.mkdtemp(prefix="section_render_")
    supplied = False
    try:
        if plan:
            supplied = bool(require_mid and plan.get("outside"))
            inject_reference(project, plan)
            full_res, full_xml, secs = render(
                project, config_path, project_dir, os.path.join(tmp, "full.docx"))
            sec_res, sec_xml, sec_secs = render(
                project, config_path, project_dir,
                os.path.join(tmp, "section.docx"), section_only=plan["node_id"])
            print("    full render %.1fs / section render %.2fs  "
                  "(section %s, chapter %s, depth %s)"
                  % (secs, sec_secs, brief(plan["node_id"]), plan["chapter"],
                     plan["depth"]))
            full_p, sec_p = paragraphs(full_xml), paragraphs(sec_xml)

            _check_caption_parity(label, plan, full_p, sec_p)
            _check_no_front_matter(label, config_path, full_p, sec_p)
            _check_references(label, plan, full_p, sec_p, sec_res)

        _check_full_render_unchanged(on_disk, config_path, project_dir, label,
                                     tmp, plan)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return supplied


def _check_caption_parity(label, plan, full_p, sec_p):
    """Assertion 1: the fragment's caption numbers are the document's numbers."""
    full_caps, sec_caps = captions(full_p), captions(sec_p)
    check(bool(sec_caps),
          "%s: the fragment emits at least one numbered caption" % label,
          brief(sorted(sec_caps)))
    shared = sorted(set(sec_caps) & set(full_caps))
    check(len(shared) == len(sec_caps),
          "%s: every fragment caption also exists in the full render" % label,
          brief(sorted(set(sec_caps) - set(full_caps))))
    mismatched = [(k, sec_caps[k]["number"], full_caps[k]["number"])
                  for k in shared
                  if sec_caps[k]["number"] != full_caps[k]["number"]]
    check(not mismatched,
          "%s: fragment caption NUMBERS equal the full-document numbers" % label,
          brief(mismatched))
    retext = [k for k in shared if sec_caps[k]["text"] != full_caps[k]["text"]]
    check(not retext,
          "%s: fragment caption TEXT is verbatim the full render's" % label,
          brief(retext))
    inside_cap = sec_caps.get("bm_%s_num" % plan["inside"])
    check(inside_cap is not None
          and inside_cap["number"].split("-")[0] == str(plan["chapter"]),
          "%s: the fragment's figure keeps its chapter number (%s-x) instead of "
          "restarting at 1-1" % (label, plan["chapter"]),
          brief(inside_cap))


def _check_no_front_matter(label, config_path, full_p, sec_p):
    """Assertion 2: no cover, no table of contents -- with positive controls."""
    marks = cover_markers(fresh_cfg(config_path))
    sec_instr, full_instr = field_instructions(sec_p), field_instructions(full_p)
    check(not any(i.startswith("TOC") for i in sec_instr),
          "%s: the fragment has NO table of contents field" % label)
    check(any(i.startswith("TOC") for i in full_instr),
          "%s: (control) the full render does have one" % label)
    check(not any(i.startswith("NUMPAGES") for i in sec_instr),
          "%s: the fragment has NO cover page-count field" % label)
    check(any(i.startswith("NUMPAGES") for i in full_instr),
          "%s: (control) the full render does have one" % label)
    sec_texts = {p["text"] for p in sec_p}
    full_texts = {p["text"] for p in full_p}
    leaked = [m for m in marks if m in sec_texts]
    control = [m for m in marks if m in full_texts]
    check(not leaked,
          "%s: no cover / contents text appears in the fragment" % label,
          brief(leaked))
    check(bool(control),
          "%s: (control) that same text IS in the full render" % label,
          brief(len(marks)))


def _check_references(label, plan, full_p, sec_p, sec_res):
    """Assertion 3: references resolve, including one pointing out of section."""
    full_caps = captions(full_p)
    sec_caps = captions(sec_p)
    sec_refs = ref_placeholders(sec_p)
    body = "\n".join(p["text"] for p in sec_p)
    check("[ref:" not in body,
          "%s: no reference degraded to the red '[ref: ...]' marker" % label)
    types = [w.get("type") for w in sec_res.get("warnings", [])]
    check("dangling_ref" not in types,
          "%s: no dangling_ref warning in the fragment's manifest" % label,
          brief(sorted(set(types))))
    inside_key = "bm_%s_num" % plan["inside"]
    check(sec_refs.get(inside_key)
          and sec_refs[inside_key][0] == full_caps.get(inside_key, {}).get("number"),
          "%s: an in-section reference prints the full-document number" % label,
          brief((sec_refs.get(inside_key),
                 full_caps.get(inside_key, {}).get("number"))))
    if plan.get("outside"):
        out_key = "bm_%s_num" % plan["outside"]
        expected = full_caps.get(out_key, {}).get("number")
        check(bool(expected) and sec_refs.get(out_key)
              and sec_refs[out_key][0] == expected,
              "%s: a reference to a figure OUTSIDE the fragment resolves to its "
              "full-document number" % label,
              brief((sec_refs.get(out_key), expected)))
        check(out_key not in sec_caps,
              "%s: (control) that figure's own caption is NOT in the fragment"
              % label)


def _check_full_render_unchanged(on_disk, config_path, project_dir, label, tmp,
                                 plan):
    """Assertion 4b: same input -> same structure, and a section render in
    between changes nothing about the full render."""
    project = copy.deepcopy(on_disk)
    cfg = fresh_cfg(config_path)
    _r1, xml1, _t1 = render(project, config_path, project_dir,
                            os.path.join(tmp, "fp1.docx"), cfg=cfg)
    fp1 = fingerprint(xml1)

    if plan:
        render(project, config_path, project_dir,
               os.path.join(tmp, "fp_section.docx"), cfg=cfg,
               section_only=plan["node_id"])

    _r2, xml2, _t2 = render(project, config_path, project_dir,
                            os.path.join(tmp, "fp2.docx"), cfg=cfg)
    check(xml1 == xml2,
          "%s: a full render is byte-identical before and after a section "
          "render made with the same config object" % label,
          brief((fp1, fingerprint(xml2))))

    with open(config_path, "rb") as f:
        cfg_bytes = f.read()
    key = hashlib.sha1(
        json.dumps(on_disk, sort_keys=True, ensure_ascii=False).encode("utf-8")
        + cfg_bytes).hexdigest()[:16]
    store = _load_goldens()
    prior = store.get(key)
    if prior is None:
        store[key] = fp1
        _save_goldens(store)
        print("    [note] no golden recorded for this exact input yet; "
              "recorded %s under %s" % (brief(fp1), key))
    else:
        check(prior == fp1,
              "%s: the full-render fingerprint matches the recorded golden"
              % label, brief((prior, fp1)))


def _load_goldens():
    try:
        with open(GOLDEN_STORE, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_goldens(store):
    try:
        with open(GOLDEN_STORE, "w", encoding="utf-8") as f:
            json.dump(store, f, indent=1, sort_keys=True)
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Assertion 4a: a hardcoded golden over an inline, neutral fixture.
#
# Recorded from the current engine and committed on purpose: unlike a real
# report this fixture never changes, so any future change to the FULL-render
# path has to move these numbers deliberately.
# ---------------------------------------------------------------------------
FIXTURE_FULL_FINGERPRINT = {
    "paragraphs": 63,     # cover + contents + 3 headings + bodies + captions
    "tables": 5,          # 3 cover tables + 2 free tables
    "rows": 11,
    "images": 1,          # the fixture's 1x1 PNG, embedded
    "seq_figure": 1,      # one figure caption
    "seq_table": 2,       # two table captions
    "styleref": 3,        # one chapter field per caption
    "ref": 3,             # three cross-reference runs
    "toc": 1,             # the table of contents
    "chars": 376,
}


def fixture_project():
    return {
        "schema_version": 1,
        "template": "fixture_tpl_v1",
        "meta": {"title": "MODULE_A Stage Report", "author": "Tester",
                 "doc_no": "DOC-001", "reviewers": ["R1"],
                 "revisions": [{"date": "2026-01-01", "ver": "1.0",
                                "note": "first", "author": "Tester"}]},
        "outline": [
            {"id": "n-1", "title": "Scope", "children": [], "blocks": [
                {"type": "para", "list": None, "runs": [{"t": "Scope body."}]},
                {"type": "table", "id": "tbl-1", "caption": "Scope table",
                 "header_rows": 1, "rows": [["Name", "Value"], ["a", "1"]]},
            ]},
            {"id": "n-2", "title": "Blocks", "blocks": [], "children": [
                {"id": "n-2-1", "title": "CLKDIV_5G", "children": [], "blocks": [
                    # one reference to this section's own figure and one to a
                    # table in another chapter: the second is the case a naive
                    # slice-the-outline render turns into a red "[ref: ...]".
                    {"type": "para", "list": None,
                     "runs": [{"t": "See "}, {"ref": "img-2"},
                              {"t": " and "}, {"ref": "tbl-1"}, {"t": "."}]},
                    {"type": "image", "id": "img-2", "file": "images/x.png",
                     "caption": "Block diagram", "width_cm": 10.0},
                ]},
            ]},
            {"id": "n-3", "title": "Results", "children": [], "blocks": [
                {"type": "table", "id": "tbl-3", "caption": "Result table",
                 "header_rows": 1, "rows": [["Item", "Unit"], ["b", "V"]]},
                {"type": "para", "list": None,
                 "runs": [{"t": "Back to "}, {"ref": "img-2"}, {"t": "."}]},
            ]},
        ],
    }


def fixture_config():
    """A complete, ASCII-only template config built inline -- never copied from
    a real one, so the fixture stays neutral and stable."""
    return {
        "id": "fixture_tpl_v1",
        "caption_prefix": {"image": "Figure", "table": "Table"},
        "toc": {"title": "Contents", "field": 'TOC \\o "1-3" \\h \\z \\u',
                "placeholder": "(update field)", "size_pt": 20},
        "logo": "",
        # normally filled in by engine._load_config; there is no logo file here,
        # so the render records a missing_logo warning and draws none.
        "_logo_path": "",
        "styles": {
            "page": {"w_cm": 21.0, "h_cm": 29.7, "margin_cm": 2.5,
                     "header_dist_cm": 1.2, "footer_dist_cm": 1.2,
                     "different_first_page": True},
            "normal": {"ascii": "Arial", "eastAsia": "Arial", "size_pt": 10.5},
            "headings": {
                "levels": {
                    "1": {"ascii": "Arial", "size_pt": 16, "bold": True},
                    "2": {"ascii": "Arial", "size_pt": 14, "bold": True},
                    "3": {"ascii": "Arial", "size_pt": 12, "bold": True},
                    "default": {"ascii": "Arial", "size_pt": 12, "bold": False},
                },
                "space_before_pt": {"1": 12, "2": 10, "3": 8},
                "h1_after_pt": 24,
                "h1_bottom_border": {"val": "single", "sz": 6, "color": "auto"},
                "autonumber": {"num_id": 88, "suffix": "space", "ascii": "Arial"},
            },
            "caption": {"ascii": "Arial", "size_pt": 9, "bold": True,
                        "align": "center"},
            "body": {"name": "SampleBody", "base": "Normal", "size_pt": 10.5,
                     "left_cm": 0.0, "first_line_cm": 0.74},
            "mybody": {"name": "SampleBodyIndent", "base": "SampleBody",
                       "ascii": "Arial", "left_cm": 0.0, "first_line_cm": 0.74},
            "header_table": {
                "cols_cm": [1.5, 12.0, 2.5],
                "row_h_twips": 751,
                "cell_bottom_border": {"val": "single", "sz": 6, "color": "auto"},
                "logo_cm": 1.13,
                "title_font": {"ascii": "Arial", "eastAsia": "Arial",
                               "size_pt": 9},
                "title_placeholder": "Stage Report",
                "secrecy_label": "Internal",
            },
            "footer_table": {
                "cols_cm": [5.0, 6.0, 5.0],
                "top_border": {"val": "single", "sz": 4},
                "date_format": "yyyy-MM-dd",
                "center_text": "",
                "page_text": ["", " / ", ""],
                "font": {"ascii": "Arial", "size_pt": 9},
            },
            "colors": {"red": "FF0000", "secrecy": "4F81BD"},
        },
        "cover": {
            "company_line": "SAMPLE ORG",
            "secrecy_default": "Internal",
            "page_count_field": True,
            "page_text": ["", " pages"],
            "company_names": [{"text": "Sample Org", "ascii": "Arial",
                               "size_pt": 16}],
            "logo_cm": 2.6,
            "big_title": {"placeholder": "Stage Report", "subtitle": "",
                          "size_pt": 24},
            "fields": [
                {"key": "title", "label": "Title", "table": "info",
                 "required": True},
            ],
            "tables": {
                "info": {
                    "cols_cm": [3.0, 3.0, 4.0, 3.0, 3.0],
                    "outer": "double", "inner": "single", "sz": 14,
                    "labels": {"title": "Project", "doc_no": "Code",
                               "secrecy": "Secrecy", "pages": "Pages"},
                },
                "signature": {
                    "cols_cm": [3.0, 3.0, 1.0, 3.0, 3.0],
                    "rows": [["Author", ""], ["Checker", ""], ["Approver", ""]],
                    "sign_underline": True, "sign_cols": [1, 4],
                },
                "revision": {
                    "cols_cm": [4.0, 3.0, 6.0, 3.0],
                    "headers": ["Date", "Version", "Note", "Author"],
                    "header_font": {"ascii": "Arial", "size_pt": 10.5},
                    "border": "single",
                    "title": {"text": "Revision History", "ascii": "Arial",
                              "eastAsia": "Arial", "size_pt": 16},
                },
            },
        },
        "compliance": {
            "col_w_cm": {"cat": 2.0, "item": 3.0, "spec": 1.5, "axis": 1.4,
                         "spacer": 0.2, "unit": 1.2},
            "font_pt": 7,
            "row_h_pt": {"header": 12, "data": 10},
            "axis_labels": ["MIN", "TYP", "MAX", "NTWC"],
            "fills": {"header": "FFF2CC", "setting": "DDEBF7",
                      "result": "FFFFFF", "separator": "BFBFBF"},
            "setting_kinds": ["common_setting", "module_setting", "tb"],
            "default_limit": {"le": "<= upper", "ge": ">= target",
                              "range": "within"},
            "flag_color": "FF0000",
            "borders": {"val": "single", "sz": 4, "color": "000000"},
        },
        "free_table": {
            "header_fill": "D9D9D9",
            "border": {"val": "single", "sz": 4, "color": "000000"},
        },
        "fixed_bodies": {},
        "ui_strings": {},
    }


def write_fixture_image(project_dir):
    """A real 1x1 PNG for the fixture's image block, so the golden fingerprint
    actually counts an embedded picture instead of a missing-image warning."""
    import base64
    png = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8"
        "z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
    images = os.path.join(project_dir, "images")
    os.makedirs(images, exist_ok=True)
    with open(os.path.join(images, "x.png"), "wb") as f:
        f.write(png)


def check_fixture_golden():
    """Assertion 4a -- the committed, never-auto-regenerated golden."""
    print("\n--- inline fixture (neutral, committed golden)")
    tmp = tempfile.mkdtemp(prefix="section_fixture_")
    try:
        write_fixture_image(tmp)
        project = fixture_project()
        out = os.path.join(tmp, "fixture.docx")
        engine.render_report(project, fixture_config(), tmp, out)
        full_xml = document_xml(out)
        fp = fingerprint(full_xml)
        if FIXTURE_FULL_FINGERPRINT is None:
            print("    [record] %s" % json.dumps(fp, sort_keys=True))
            check(False, "fixture: the golden fingerprint is recorded in this "
                         "file", "FIXTURE_FULL_FINGERPRINT is None")
        else:
            check(fp == FIXTURE_FULL_FINGERPRINT,
                  "fixture: the full render's structure matches the committed "
                  "golden", brief((FIXTURE_FULL_FINGERPRINT, fp)))

        sec_out = os.path.join(tmp, "fixture_section.docx")
        engine.render_section_docx(project, fixture_config(), tmp, sec_out,
                                   "n-2-1")
        sec_xml = document_xml(sec_out)
        sec_fp = fingerprint(sec_xml)
        check(sec_fp["toc"] == 0 and sec_fp["tables"] == 0,
              "fixture: the fragment drops the contents and the cover tables",
              brief(sec_fp))
        check(sec_fp["paragraphs"] < fp["paragraphs"],
              "fixture: the fragment is smaller than the full document",
              brief((sec_fp["paragraphs"], fp["paragraphs"])))
        full_p, sec_p = paragraphs(full_xml), paragraphs(sec_xml)
        f_caps, s_caps = captions(full_p), captions(sec_p)
        check(s_caps.get("bm_img-2_num", {}).get("number")
              == f_caps.get("bm_img-2_num", {}).get("number") == "2-1",
              "fixture: the fragment's figure keeps the full-document number",
              brief((s_caps, f_caps)))
        refs = ref_placeholders(sec_p)
        check(refs.get("bm_tbl-1_num", [None])[0]
              == f_caps.get("bm_tbl-1_num", {}).get("number") == "1-1",
              "fixture: a reference OUT of the fragment keeps its number",
              brief((refs, f_caps.get("bm_tbl-1_num"))))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ---------------------------------------------------------------------------
def main():
    root = resolve_root()
    print("=== SECTION-ONLY RENDER TEST ===")
    print("reports root: %s" % root)
    print("golden store: %s" % GOLDEN_STORE)
    reports = discover_reports(root)
    if not reports:
        print("SKIP: no reports under the reports root "
              "(a fresh clone carries none)")
        return 0
    print("reports found: %d" % len(reports))

    check_fixture_golden()

    demo = [r for r in reports if r.split("/")[-1] == DEMO_DIRNAME]
    others = [r for r in reports if r not in demo]
    if demo:
        check_report(root, demo[0], "demo", require_mid=False)
    else:
        print("\n[note] the demo report is not present; its checks are skipped")

    used = None
    for rel in others:
        try:
            if check_report(root, rel, "report", require_mid=True):
                used = rel
                break
        except Exception as ex:   # one broken report must not mask the others
            print("    [note] %s: %s: %s"
                  % (rel, type(ex).__name__, brief(str(ex))))
    check(used is not None,
          "a real report supplied the mid-document figure + cross-reference "
          "scenario that assertion 1 needs", brief(others))
    if used:
        print("\nreal report used: %s" % used)

    print("\n=== SECTION RENDER SUMMARY ===")
    print("  PASS: %d   FAIL: %d" % (PASS, FAIL))
    print("==============================")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
