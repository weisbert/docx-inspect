#!/usr/bin/env python3
"""Regression test for core/report_new.py -- inherit + reference column.

Two jobs are covered, both on a throwaway reports root built from scratch in a
temp folder. No project or company data is read: the fixture uses the neutral
sample names the public repo is allowed to carry (MODULE_A under project 1108).

What is asserted, in the order the checks run:

  1. Inheriting keeps the section tree and the titles identical -- ids, titles,
     levels, fixed_body and the nesting.
  2. Result-row simulated values are blanked, SETTING-row values survive. This
     is the one that matters most: a setting row is a test condition, not a
     result, and re-typing the conditions every stage is exactly the drudgery
     this feature removes.
  3. Table STRUCTURE survives: the same simulation groups, the same spec name,
     and per row the same category / item / unit / limit / kind / sim_span and
     the same spec values.
  4. clearPolicy addresses a SUBTREE: pictures under it lose their file and
     keep their block, caption and position; pictures outside it are untouched;
     and with no clearPolicy at all nothing is blanked. Only the still-needed
     picture files are copied into the new folder.
  5. Cross-references still resolve after inheriting -- every ``ref`` in a
     paragraph run still names a numbering target, and the numbers themselves
     are unchanged (checked against the renderer's own _collect_ref_targets, so
     the test cannot drift from the numbering the .docx actually gets).
  6. build_reference_column pairs by item name: an identical name is
     ``matched``, a name differing only in case / spacing / punctuation is
     ``renamed``, and anything else is ``nomatch`` with a genuinely EMPTY cell
     -- never a guess.
  7. The delta direction is "toward" / "away" for both le and ge limits and
     "none" when the row carries no limit.
  8. The inherited report is lint-clean: content_lint reports zero errors.

Run: python builder/tests/test_report_new.py
"""

import json
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))     # builder/tests
BUILDER = os.path.dirname(HERE)                       # builder/
if BUILDER not in sys.path:
    sys.path.insert(0, BUILDER)
import buildpath  # noqa: E402,F401  (registers core/docx_io/store/sync/web)

import content_lint  # noqa: E402
import engine  # noqa: E402
import report_new  # noqa: E402


# ---------------------------------------------------------------------------
# Fixture: one finished report, neutral in every field.
# ---------------------------------------------------------------------------

# A 1x1 PNG. Only its presence on disk matters (the copy step, and the linter's
# "is the file really there" rule), never its pixels.
PNG = bytes([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00,
    0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
    0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
])

IMAGE_FILES = ("topology.png", "bench.png", "result.png",
               "aging_a.png", "aging_b.png")


def _sim_row(cat, item, kind, unit, limit, spec, sim, span=False, flat=False):
    """One compliance row. ``flat`` writes the single-group schema instead of
    the per-group ``sims`` map, so both shapes get exercised."""
    row = {"cat": cat, "item": item, "kind": kind, "unit": unit,
           "limit": limit, "spec_mtm": list(spec), "sim_span": span}
    if flat:
        row["sim_mtm"] = list(sim)
        row["sim_ntwc"] = None
    else:
        row["sims"] = {"post": {"mtm": list(sim), "ntwc": None}}
    return row


def source_project():
    """A finished CDR: prose, pictures, cross-references and one table."""
    return {
        "schema_version": 1,
        "template": "sample_tpl",
        "meta": {
            "title": "MODULE_A CDR Simulation Report",
            "stage": "CDR",
            "version": "V1.0",
            "date": "2026-07-30",
            "author": "A. Engineer",
            "reviewers": ["B. Engineer"],
            "approver": "C. Engineer",
            "revisions": [{"ver": "V1.0", "date": "2026-07-30",
                           "author": "A. Engineer", "note": "issued"}],
        },
        "outline": [
            {"id": "n-1", "title": "Introduction", "level": 1, "blocks": [
                {"id": "b-intro", "type": "para", "cardStart": True, "runs": [
                    {"t": "The block diagram is shown in "},
                    {"t": "Figure", "ref": "img-topology"},
                    {"t": "."},
                ]},
            ], "children": [
                {"id": "n-1-1", "title": "Topology", "level": 2, "blocks": [
                    {"id": "img-topology", "type": "image",
                     "file": "images/topology.png",
                     "caption": "Block diagram", "width_cm": 12},
                ], "children": []},
            ]},
            {"id": "n-2", "title": "Simulation", "level": 1, "blocks": [],
             "children": [
                {"id": "n-2-1", "title": "Simulation Setting and Testbench",
                 "level": 2, "blocks": [
                     {"id": "img-bench", "type": "image",
                      "file": "images/bench.png",
                      "caption": "Testbench", "width_cm": 12},
                 ], "children": []},
                {"id": "n-2-2", "title": "Simulation Results", "level": 2,
                 "blocks": [
                     {"id": "b-lead", "type": "para", "cardStart": True,
                      "runs": [
                          {"t": "Measured data is collected in "},
                          {"t": "Table", "ref": "dt-main"},
                          {"t": " and the waveforms in "},
                          {"t": "Figure", "ref": "img-result"},
                          {"t": "."},
                      ]},
                     {"id": "dt-main", "type": "datatable",
                      "caption": "Performance", "data": {
                          "spec_name": "Spec",
                          "sims": [{"key": "post", "title": "Post-layout",
                                    "stage": "CDR",
                                    "axes": ["MIN", "TYP", "MAX"]}],
                          "rows": [
                              _sim_row("Condition", "Supply voltage",
                                       "common_setting", "V", None,
                                       [None, None, None],
                                       ["1.62", "1.80", "1.98"]),
                              _sim_row("Condition", "Temperature",
                                       "common_setting", "degC", None,
                                       [None, None, None],
                                       ["-40", "25", "125"], flat=True),
                              _sim_row("Power", "Current consumption",
                                       "result", "mA", "le",
                                       [None, None, "5.0"],
                                       ["3.1", "3.5", "4.2"]),
                              _sim_row("Power", "Output swing",
                                       "result", "mV", "ge",
                                       ["300", None, None],
                                       ["350", "420", "480"]),
                              _sim_row("Timing", "Duty cycle",
                                       "result", "%", "range",
                                       ["45", "50", "55"],
                                       ["47", "50", "53"], span=True),
                              _sim_row("Timing", "Settling time",
                                       "result", "us", None,
                                       [None, None, None],
                                       ["10", "12", "15"]),
                          ],
                      }},
                     {"id": "img-result", "type": "image",
                      "file": "images/result.png",
                      "caption": "Output waveform", "width_cm": 12},
                 ], "children": [
                     {"id": "n-2-2-1", "title": "Reliability Results",
                      "level": 3, "blocks": [
                          {"id": "ig-aging", "type": "imagegrid", "cols": 2,
                           "caption": "Aging",
                           "sub_captions": ["start", "end"],
                           "items": [{"file": "images/aging_a.png"},
                                     {"file": "images/aging_b.png"}]},
                      ], "children": []},
                 ]},
             ]},
            {"id": "n-3", "title": "Conclusion", "level": 1, "blocks": [
                {"id": "b-concl", "type": "para", "cardStart": True,
                 "runs": [{"t": "All targets are met at this stage."}]},
            ], "children": []},
        ],
    }


def build_root():
    """A reports root holding one CDR under project 1108 / module MODULE_A."""
    root = tempfile.mkdtemp(prefix="report_new_test_")
    src = os.path.join(root, "P1108", "MODULE_A", "CDR")
    os.makedirs(os.path.join(src, "images"))
    for name in IMAGE_FILES:
        with open(os.path.join(src, "images", name), "wb") as fh:
            fh.write(PNG)
    with open(os.path.join(src, "project.json"), "w", encoding="utf-8") as fh:
        json.dump(source_project(), fh, ensure_ascii=False, indent=1)
    return root


def read_project(root, rel):
    with open(os.path.join(root, rel.replace("/", os.sep), "project.json"),
              "r", encoding="utf-8") as fh:
        return json.load(fh)


# ---------------------------------------------------------------------------
# Small traversal helpers, written independently of report_new's own.
# ---------------------------------------------------------------------------


def skeleton(nodes):
    """The section tree stripped to what inheriting must never touch."""
    out = []
    for node in nodes or []:
        out.append({
            "id": node.get("id"),
            "title": node.get("title"),
            "level": node.get("level"),
            "fixed_body": node.get("fixed_body"),
            "children": skeleton(node.get("children")),
        })
    return out


def blocks_by_id(project):
    out = {}

    def walk(nodes):
        for node in nodes or []:
            for block in node.get("blocks") or []:
                if isinstance(block, dict) and block.get("id"):
                    out[block["id"]] = block
            walk(node.get("children"))

    walk((project or {}).get("outline") or [])
    return out


def block(project, block_id):
    """One block by id, with a readable failure when inheriting dropped it."""
    found = blocks_by_id(project)
    assert block_id in found, \
        "block %r is gone -- inheriting must keep every block" % (block_id,)
    return found[block_id]


def datatable_rows(project, block_id):
    return block(project, block_id)["data"]["rows"]


def row_by_item(rows, item):
    for row in rows:
        if row.get("item") == item:
            return row
    raise AssertionError("no row named %r" % item)


def ref_ids(project):
    """Every block id a paragraph run points at, in document order."""
    out = []

    def walk(nodes):
        for node in nodes or []:
            for block in node.get("blocks") or []:
                if not isinstance(block, dict) or block.get("type") != "para":
                    continue
                for run in block.get("runs") or []:
                    if isinstance(run, dict) and run.get("ref"):
                        out.append(run["ref"])
            walk(node.get("children"))

    walk((project or {}).get("outline") or [])
    return out


def all_values(row):
    """Every simulated number on a row, whichever schema it uses."""
    vals = list(row.get("sim_mtm") or [])
    vals.append(row.get("sim_ntwc"))
    sims = row.get("sims")
    if isinstance(sims, dict):
        for entry in sims.values():
            if isinstance(entry, dict):
                vals += list(entry.get("mtm") or [])
                vals.append(entry.get("ntwc"))
    return [v for v in vals if v not in (None, "")]


# ---------------------------------------------------------------------------
# 1-5 and 8: inherit
# ---------------------------------------------------------------------------


def check_inherit(root):
    src = read_project(root, "P1108/MODULE_A/CDR")

    res = report_new.create_report(root, {
        "project": "P1108", "module": "MODULE_A", "stage": "FDR",
        "mode": "inherit", "from": "P1108/MODULE_A/CDR",
        "clearValues": True,
        # the results section loses its pictures; everything else keeps them
        "clearPolicy": {"clearImagesUnder": ["n-2-2"]},
    })
    assert res["dir"] == "P1108/MODULE_A/FDR", res["dir"]
    assert res["mode"] == "inherit", res
    new = read_project(root, "P1108/MODULE_A/FDR")

    # -- 1. the section tree and its titles are untouched --------------------
    assert skeleton(new["outline"]) == skeleton(src["outline"]), \
        "inheriting must not move, rename or drop a single section"

    # -- 2. result values gone, setting values kept -------------------------
    src_rows = datatable_rows(src, "dt-main")
    new_rows = datatable_rows(new, "dt-main")
    assert len(new_rows) == len(src_rows), "a row was added or lost"

    supply = row_by_item(new_rows, "Supply voltage")
    temp = row_by_item(new_rows, "Temperature")
    assert supply["sims"]["post"]["mtm"] == ["1.62", "1.80", "1.98"], \
        "a setting row is a test condition and must carry over: %r" % (supply,)
    assert temp["sim_mtm"] == ["-40", "25", "125"], \
        "the flat-schema setting row must carry over too: %r" % (temp,)

    for row in new_rows:
        if row["kind"] in report_new.DEFAULT_SETTING_KINDS:
            continue
        assert all_values(row) == [], \
            "result row %r still carries values %r" % (row["item"],
                                                       all_values(row))
    # ... and the source really did have values to clear, so the loop above is
    # not vacuously true against a fixture that never had any.
    cleared_rows = [r for r in src_rows
                    if r["kind"] not in report_new.DEFAULT_SETTING_KINDS]
    assert all(all_values(r) for r in cleared_rows), "fixture has no results"
    assert res["cleared"]["resultRows"] == len(cleared_rows), res["cleared"]
    assert res["cleared"]["values"] == sum(len(all_values(r))
                                           for r in cleared_rows), \
        res["cleared"]

    # -- 3. the table structure itself survives -----------------------------
    src_block = block(src, "dt-main")
    new_block = block(new, "dt-main")
    assert new_block["caption"] == src_block["caption"]
    assert new_block["data"]["sims"] == src_block["data"]["sims"], \
        "the simulation groups (columns) must survive"
    assert new_block["data"]["spec_name"] == src_block["data"]["spec_name"]
    for old, fresh in zip(src_rows, new_rows):
        for key in ("cat", "item", "kind", "unit", "limit", "sim_span",
                    "spec_mtm"):
            assert fresh.get(key) == old.get(key), \
                "row %r lost %s: %r != %r" % (old.get("item"), key,
                                              fresh.get(key), old.get(key))

    # -- 4. pictures: the named subtree only --------------------------------
    for bid in ("img-topology", "img-bench"):
        assert block(new, bid)["file"] == block(src, bid)["file"], \
            "%s sits outside clearImagesUnder and must be untouched" % bid
    assert block(new, "img-result")["file"] == "", \
        "a picture under the named section must be blanked"
    assert block(new, "img-result")["caption"] == "Output waveform", \
        "clearing a picture must keep its caption"
    assert [it["file"] for it in block(new, "ig-aging")["items"]] == ["", ""], \
        "a grid in a descendant of the named section is cleared too"
    assert block(new, "ig-aging")["sub_captions"] == ["start", "end"]
    assert res["cleared"]["images"] == 1, res["cleared"]
    assert res["cleared"]["gridImages"] == 2, res["cleared"]
    # only the pictures that are still pointed at get copied across
    assert res["cleared"]["imagesCopied"] == 2, res["cleared"]
    kept = sorted(os.listdir(os.path.join(root, "P1108", "MODULE_A", "FDR",
                                          "images")))
    assert kept == ["bench.png", "topology.png"], kept

    # the conclusion prose is emptied, ordinary prose is not
    assert block(new, "b-concl")["runs"] == [], "conclusion prose must clear"
    assert block(new, "b-intro")["runs"], "ordinary prose must survive"

    # a new stage starts unissued
    assert new["meta"]["stage"] == "FDR", new["meta"]
    assert new["meta"]["date"] == "", new["meta"]
    assert new["meta"]["version"] != src["meta"]["version"], new["meta"]
    assert "FDR" in new["meta"]["title"], new["meta"]["title"]
    assert "CDR" not in new["meta"]["title"], new["meta"]["title"]

    # -- 4b. no clearPolicy -> no picture is blanked ------------------------
    res2 = report_new.create_report(root, {
        "project": "P1108", "module": "MODULE_A", "stage": "FDR",
        "dirName": "FDR_KEEPALL", "mode": "inherit",
        "from": "P1108/MODULE_A/CDR", "clearValues": True,
    })
    keepall = read_project(root, res2["dir"])
    for bid in ("img-topology", "img-bench", "img-result"):
        assert block(keepall, bid)["file"] == block(src, bid)["file"], \
            "with no clearPolicy every picture is kept (%s)" % bid
    assert [it["file"] for it in block(keepall, "ig-aging")["items"]] == \
        [it["file"] for it in block(src, "ig-aging")["items"]]
    assert res2["cleared"]["images"] == 0, res2["cleared"]
    assert res2["cleared"]["gridImages"] == 0, res2["cleared"]
    assert res2["cleared"]["imagesCopied"] == len(IMAGE_FILES), res2["cleared"]
    # values are still cleared -- clearPolicy governs pictures, not results
    assert all_values(row_by_item(datatable_rows(keepall, "dt-main"),
                                  "Current consumption")) == []

    # -- 5. cross-references still resolve ----------------------------------
    src_targets = engine._collect_ref_targets(src["outline"])
    new_targets = engine._collect_ref_targets(new["outline"])
    refs = ref_ids(new)
    assert refs, "fixture carries no cross-reference"
    assert refs == ref_ids(src), "a cross-reference was dropped"
    dangling = [r for r in refs if r not in new_targets]
    assert not dangling, \
        "dangling cross-reference(s) after inheriting: %r" % (dangling,)
    assert new_targets == src_targets, \
        "clearing a picture must not renumber anything: %r != %r" % (
            new_targets, src_targets)

    # -- 8. and the result is lint-clean ------------------------------------
    fdr_dir = os.path.join(root, "P1108", "MODULE_A", "FDR")
    report = content_lint.lint_project(new, None, fdr_dir)
    counts = content_lint.summarize(report)
    assert counts["error"] == 0, "lint errors in the inherited report: %s" % (
        json.dumps(report["errors"], indent=1),)
    return res


# ---------------------------------------------------------------------------
# 6-7: reference column
# ---------------------------------------------------------------------------


def fill_current_stage(root):
    """Play the author: rename one item, add one that is genuinely new, and
    type this stage's own numbers in. That is the state a reference column gets
    asked for in."""
    path = os.path.join(root, "P1108", "MODULE_A", "FDR", "project.json")
    with open(path, "r", encoding="utf-8") as fh:
        project = json.load(fh)
    rows = datatable_rows(project, "dt-main")

    def put(item, values):
        row_by_item(rows, item)["sims"]["post"]["mtm"] = list(values)

    # same name -> exact match; 'le' limit, this stage is lower  -> "toward"
    put("Current consumption", ["2.8", "3.0", "3.6"])
    # spelling drift only -> "renamed"; 'ge' limit, lower now    -> "away"
    row_by_item(rows, "Output swing")["item"] = "Output Swing"
    put("Output Swing", ["330", "400", "450"])
    # no limit at all -> "none", whichever way it moved
    put("Settling time", ["11", "11", "13"])
    # this stage drops a metric, so its source row is left UNSPENT. The new row
    # below must not be handed those numbers just because they are going spare:
    # a non-match has to be decided by the name, not by what is left over.
    rows.remove(row_by_item(rows, "Duty cycle"))
    # brand new at this stage -> "nomatch"
    rows.append(_sim_row("Timing", "Overshoot ratio", "result", "%", "le",
                         [None, None, "10"], ["4", "5", "6"]))
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(project, fh, ensure_ascii=False, indent=1)


def check_reference_column(root):
    fill_current_stage(root)
    out = report_new.build_reference_column(root, {
        "dir": "P1108/MODULE_A/FDR",
        "srcReport": "P1108/MODULE_A/CDR",
        "targetBlock": "dt-main",
        "group": "post",
        "axis": "TYP",
    })
    by_item = {m["item"]: m for m in out["matches"]}
    rows = out["column"]["rows"]

    # -- 6. exact / renamed / nomatch ---------------------------------------
    exact = by_item["Current consumption"]
    assert exact["status"] == "matched", exact
    assert exact["srcItem"] == "Current consumption", exact
    assert exact["value"] == "3.5", exact
    assert exact["values"] == {"MIN": "3.1", "TYP": "3.5", "MAX": "4.2"}, \
        "all three axes come across, not just the one asked for: %r" % (exact,)

    renamed = by_item["Output Swing"]
    assert renamed["status"] == "renamed", renamed
    assert renamed["srcItem"] == "Output swing", renamed
    assert renamed["values"] == {"MIN": "350", "TYP": "420", "MAX": "480"}, \
        renamed

    nomatch = by_item["Overshoot ratio"]
    assert nomatch["status"] == "nomatch", nomatch
    assert nomatch["srcRow"] is None, nomatch
    assert nomatch["value"] is None, nomatch
    assert nomatch["values"] == {}, "an unmatched row is empty, never guessed"
    assert nomatch["score"] < report_new.SIMILARITY_THRESHOLD, nomatch
    assert rows[nomatch["row"]] is None, \
        "an unmatched row leaves an empty cell: %r" % (rows[nomatch["row"]],)
    # the dropped metric's source row goes spare -- and stays spare
    assert "Duty cycle" not in [m["srcItem"] for m in out["matches"]], \
        "a spare source row must never be handed to an unrelated item"

    assert out["summary"]["nomatch"] == 1, out["summary"]
    assert out["summary"]["renamed"] == 1, out["summary"]
    assert out["summary"]["total"] == len(out["matches"]), out["summary"]
    used = [m["srcRow"] for m in out["matches"] if m["srcRow"] is not None]
    assert len(set(used)) == len(used), \
        "one source row must never feed two target rows"

    # the column is a snapshot and says where it came from
    source = out["column"]["source"]
    assert source["report"] == "P1108/MODULE_A/CDR", source
    assert source["stage"] == "CDR", source
    assert source["version"] == "V1.0", source
    assert source["date"] == "2026-07-30", source
    assert len(source["hash"]) == 64, source
    assert out["column"]["readOnly"] is True, out["column"]

    # -- 7. delta direction --------------------------------------------------
    assert exact["direction"] == "toward", \
        "3.0 against 3.5 under a 'le' limit is an improvement: %r" % (exact,)
    assert renamed["direction"] == "away", \
        "400 against 420 under a 'ge' limit is a regression: %r" % (renamed,)
    nolimit = by_item["Settling time"]
    assert nolimit["status"] == "matched", nolimit
    assert nolimit["limit"] is None, nolimit
    assert nolimit["direction"] == "none", \
        "a row with no limit has no direction: %r" % (nolimit,)
    assert abs(nolimit["delta"] - (11.0 - 12.0)) < 1e-9, nolimit

    # and the helper on its own, both ways round for both limits
    assert report_new.delta_direction("le", "1.0", "2.0") == "toward"
    assert report_new.delta_direction("le", "3.0", "2.0") == "away"
    assert report_new.delta_direction("ge", "3.0", "2.0") == "toward"
    assert report_new.delta_direction("ge", "1.0", "2.0") == "away"
    assert report_new.delta_direction(None, "1.0", "2.0") == "none"
    assert report_new.delta_direction("", "1.0", "2.0") == "none"


def main():
    root = build_root()
    try:
        check_inherit(root)
        check_reference_column(root)
    finally:
        shutil.rmtree(root, ignore_errors=True)
    print("test_report_new: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
