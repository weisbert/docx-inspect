# -*- coding: utf-8 -*-
"""Regression test for store/assets_store.py (the asset tray index).

Everything runs against a throwaway report folder built in code: a handful of
tiny image files whose bytes are assembled here from real format headers, plus
an outline that references some of them from ``image`` and ``imagegrid`` blocks.
No project or company data is involved.

Covered:
  1. list_assets finds every file, with the right byte size and pixel size for
     PNG / JPEG / GIF / BMP, and reports no size (rather than failing) for a
     format whose header it cannot read.
  2. usedIn is right for both image and imagegrid blocks; unused is true only
     for a file nothing points at.
  3. set_tags round-trips through assets.json and survives a re-scan.
  4. rename moves the file and repoints every reference, imagegrid items too.
  5. A rename collision takes a numeric suffix instead of overwriting.
  6. Traversal, absolute paths and sub-folders are refused.
  7. delete refuses a used asset and trashes an unused one.
  8. A missing or damaged assets.json degrades to an empty index.

Run: python builder/tests/test_assets_store.py
"""
import json
import os
import shutil
import struct
import sys
import tempfile
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))   # builder/tests
BUILDER = os.path.dirname(HERE)                     # builder/
if BUILDER not in sys.path:
    sys.path.insert(0, BUILDER)
import buildpath  # noqa: E402,F401  (registers core/docx_io/store/sync/web)
import assets_store  # noqa: E402


CHECKS = [0]


def check(cond, msg):
    CHECKS[0] += 1
    if not cond:
        raise AssertionError(msg)


def raises(exc, fn, *args, **kwargs):
    """Assert fn(...) raises exc; return the exception for further checks."""
    CHECKS[0] += 1
    try:
        fn(*args, **kwargs)
    except exc as err:
        return err
    except Exception as other:            # the wrong type is still a failure
        raise AssertionError("expected %s, got %r" % (exc.__name__, other))
    raise AssertionError("expected %s, nothing raised" % exc.__name__)


# ---------------------------------------------------------------------------
# Tiny image blobs, assembled from the real headers of each format.
# ---------------------------------------------------------------------------


def png_bytes(w, h):
    """A complete, valid greyscale PNG: signature, IHDR, IDAT, IEND."""
    def chunk(kind, body):
        return (struct.pack(">I", len(body)) + kind + body
                + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0)
    raw = b"".join(b"\x00" + b"\x80" * w for _ in range(h))   # filter 0 + pixels
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def jpeg_bytes(w, h):
    """SOI + APP0/JFIF + SOF0 carrying the size + EOI."""
    app0 = (b"\xff\xe0" + struct.pack(">H", 16) + b"JFIF\x00"
            + b"\x01\x01\x00" + struct.pack(">HH", 1, 1) + b"\x00\x00")
    sof0 = (b"\xff\xc0" + struct.pack(">H", 17) + b"\x08"
            + struct.pack(">HH", h, w) + b"\x03"
            + b"\x01\x11\x00" + b"\x02\x11\x01" + b"\x03\x11\x01")
    return b"\xff\xd8" + app0 + sof0 + b"\xff\xd9"


def gif_bytes(w, h):
    """GIF89a header (the size lives in the logical screen descriptor)."""
    return b"GIF89a" + struct.pack("<HH", w, h) + b"\x00\x00\x00" + b";"


def bmp_bytes(w, h):
    """BITMAPFILEHEADER + BITMAPINFOHEADER + one 32bpp row per line."""
    row = b"\x00\x00\x00\xff" * w
    pixels = row * h
    info = struct.pack("<IiiHHIIiiII", 40, w, h, 1, 32, 0, len(pixels),
                       2835, 2835, 0, 0)
    offset = 14 + len(info)
    head = b"BM" + struct.pack("<IHHI", offset + len(pixels), 0, 0, offset)
    return head + info + pixels


# Deliberately a format whose size the header reader does not decode.
SVG_BODY = b'<svg xmlns="http://www.w3.org/2000/svg" width="30" height="20"/>'

FILES = {
    "waveform_a.png": (png_bytes(7, 3), 7, 3),
    "curve_b.jpg": (jpeg_bytes(5, 9), 5, 9),
    "eye_c.gif": (gif_bytes(11, 4), 11, 4),
    "spare_d.bmp": (bmp_bytes(2, 6), 2, 6),
    "sketch_e.svg": (SVG_BODY, None, None),
}


def make_project():
    """A temp report folder: images/ full of the blobs above, plus an outline.

    Section numbers fall out of the outline shape:
        1     Overview        -> sketch_e.svg
        2     Simulation
        2.1   Testbench       -> waveform_a.png            (image block)
        2.2   Results         -> curve_b.jpg + eye_c.gif   (one imagegrid)
        3     Layout          -> waveform_a.png            (second use)
    spare_d.bmp is referenced by nothing.
    """
    root = tempfile.mkdtemp(prefix="assets_test_")
    idir = os.path.join(root, "images")
    os.makedirs(idir)
    for name, (blob, _w, _h) in FILES.items():
        with open(os.path.join(idir, name), "wb") as fh:
            fh.write(blob)
    project = {
        "schema_version": 1,
        "meta": {"module": "CLKDIV_5G"},
        "outline": [
            {"id": "n-intro", "title": "Overview", "blocks": [
                {"id": "b-svg", "type": "image", "file": "images/sketch_e.svg",
                 "caption": "Block sketch"},
            ]},
            {"id": "n-sim", "title": "Simulation", "blocks": [], "children": [
                {"id": "n-setup", "title": "Testbench", "blocks": [
                    {"id": "b-a1", "type": "image", "file": "images/waveform_a.png",
                     "caption": "Startup waveform"},
                ]},
                {"id": "n-res", "title": "Results", "blocks": [
                    {"id": "b-grid", "type": "imagegrid", "cols": 2, "items": [
                        {"file": "images/curve_b.jpg"},
                        {"file": "images/eye_c.gif"},
                    ]},
                ]},
            ]},
            {"id": "n-layout", "title": "Layout", "blocks": [
                {"id": "b-a2", "type": "image", "file": "images/waveform_a.png",
                 "caption": "Placement"},
            ]},
        ],
    }
    return root, project


def by_file(listing):
    return {a["file"]: a for a in listing["assets"]}


# ---------------------------------------------------------------------------
# 1 + 2: the scan, the sizes, the derived usage.
# ---------------------------------------------------------------------------


def test_scan_and_usage():
    root, project = make_project()
    try:
        out = assets_store.list_assets(root, project)
        got = by_file(out)

        check(out["count"] == len(FILES),
              "expected %d assets, got %d" % (len(FILES), out["count"]))
        check(set(got) == set("images/" + n for n in FILES),
              "unexpected asset set: %s" % sorted(got))

        for name, (blob, w, h) in FILES.items():
            card = got["images/" + name]
            check(card["bytes"] == len(blob),
                  "%s: bytes %r != %d" % (name, card["bytes"], len(blob)))
            check(card["w"] == w and card["h"] == h,
                  "%s: size (%r,%r) != (%r,%r)" % (name, card["w"], card["h"], w, h))
            # image_size() gives the same answer read straight off the file.
            direct = assets_store.image_size(os.path.join(root, "images", name))
            check(direct == (w, h), "%s: image_size %r != %r" % (name, direct, (w, h)))

        # usedIn: image blocks, nested children, and imagegrid items.
        check(got["images/waveform_a.png"]["usedIn"] == ["2.1", "3"],
              "waveform usedIn %r" % got["images/waveform_a.png"]["usedIn"])
        check(got["images/curve_b.jpg"]["usedIn"] == ["2.2"],
              "curve usedIn %r" % got["images/curve_b.jpg"]["usedIn"])
        check(got["images/eye_c.gif"]["usedIn"] == ["2.2"],
              "eye usedIn %r" % got["images/eye_c.gif"]["usedIn"])
        check(got["images/sketch_e.svg"]["usedIn"] == ["1"],
              "sketch usedIn %r" % got["images/sketch_e.svg"]["usedIn"])
        check(got["images/spare_d.bmp"]["usedIn"] == [],
              "spare usedIn %r" % got["images/spare_d.bmp"]["usedIn"])

        # unused is exactly "nothing points at it".
        check(got["images/spare_d.bmp"]["unused"] is True, "bmp should be unused")
        for name in ("waveform_a.png", "curve_b.jpg", "eye_c.gif", "sketch_e.svg"):
            check(got["images/" + name]["unused"] is False,
                  "%s should not be unused" % name)
        check(out["unused"] == 1, "unused count %r != 1" % out["unused"])

        # uses carries the jump target for each of those sections.
        uses = got["images/waveform_a.png"]["uses"]
        check([u["node"] for u in uses] == ["n-setup", "n-layout"],
              "uses nodes %r" % [u["node"] for u in uses])
        check([u["block"] for u in uses] == ["b-a1", "b-a2"],
              "uses blocks %r" % [u["block"] for u in uses])
        check([u["title"] for u in uses] == ["Testbench", "Layout"],
              "uses titles %r" % [u["title"] for u in uses])

        grid_uses = assets_store.usage_map(project)["images/eye_c.gif"]
        check(grid_uses == [{"section": "2.2", "title": "Results",
                             "node": "n-res", "block": "b-grid"}],
              "imagegrid usage_map entry %r" % grid_uses)
    finally:
        shutil.rmtree(root, ignore_errors=True)


# ---------------------------------------------------------------------------
# 3: tags round-trip.
# ---------------------------------------------------------------------------


def test_tags_roundtrip():
    root, project = make_project()
    try:
        res = assets_store.set_tags(root, "waveform_a.png", ["startup", "post"])
        check(res["ok"] is True and res["file"] == "images/waveform_a.png",
              "set_tags result %r" % res)
        check(res["tags"] == ["startup", "post"], "set_tags tags %r" % res["tags"])

        # It really landed in assets.json, under the images/<name> key.
        with open(os.path.join(root, "assets.json"), "r", encoding="utf-8") as fh:
            stored = json.load(fh)
        check("images/waveform_a.png" in stored, "assets.json keys %r" % sorted(stored))
        check(stored["images/waveform_a.png"]["tags"] == ["startup", "post"],
              "stored tags %r" % stored["images/waveform_a.png"])
        check("usedIn" not in stored["images/waveform_a.png"]
              and "uses" not in stored["images/waveform_a.png"],
              "usage must never be stored: %r" % stored["images/waveform_a.png"])

        # A fresh scan still shows them, and only on that file.
        got = by_file(assets_store.list_assets(root, project))
        check(got["images/waveform_a.png"]["tags"] == ["startup", "post"],
              "rescan tags %r" % got["images/waveform_a.png"]["tags"])
        check(got["images/curve_b.jpg"]["tags"] == [],
              "another file picked up tags %r" % got["images/curve_b.jpg"]["tags"])

        # Accepts the images/-prefixed form too, and replaces rather than appends.
        assets_store.set_tags(root, "images/waveform_a.png", ["layout"])
        got = by_file(assets_store.list_assets(root, project))
        check(got["images/waveform_a.png"]["tags"] == ["layout"],
              "replace tags %r" % got["images/waveform_a.png"]["tags"])

        # A file that is not there cannot be tagged.
        raises(FileNotFoundError, assets_store.set_tags, root, "ghost.png", ["x"])
    finally:
        shutil.rmtree(root, ignore_errors=True)


# ---------------------------------------------------------------------------
# 4: rename moves the file and repoints every reference.
# ---------------------------------------------------------------------------


def test_rename_repoints_everything():
    root, project = make_project()
    try:
        assets_store.set_tags(root, "waveform_a.png", ["startup"])

        res = assets_store.rename(root, project, "waveform_a.png", "startup_edge.png")
        check(res["file"] == "images/startup_edge.png", "rename file %r" % res["file"])
        check(res["from"] == "images/waveform_a.png", "rename from %r" % res["from"])
        check(res["renamed"] == 2, "renamed %r != 2 references" % res["renamed"])

        idir = os.path.join(root, "images")
        check(not os.path.exists(os.path.join(idir, "waveform_a.png")),
              "the old file is still on disk")
        check(os.path.isfile(os.path.join(idir, "startup_edge.png")),
              "the new file is missing from disk")
        with open(os.path.join(idir, "startup_edge.png"), "rb") as fh:
            check(fh.read() == FILES["waveform_a.png"][0], "renamed file bytes changed")

        moved = res["project"]
        check(moved is project, "rename should hand back the same project object")
        check(moved["outline"][1]["children"][0]["blocks"][0]["file"]
              == "images/startup_edge.png", "image block not repointed")
        check(moved["outline"][2]["blocks"][0]["file"] == "images/startup_edge.png",
              "second image block not repointed")

        # The tag entry travels with the file.
        got = by_file(assets_store.list_assets(root, moved))
        check("images/waveform_a.png" not in got, "the old name is still listed")
        check(got["images/startup_edge.png"]["tags"] == ["startup"],
              "tags lost by rename: %r" % got["images/startup_edge.png"]["tags"])
        check(got["images/startup_edge.png"]["usedIn"] == ["2.1", "3"],
              "usedIn after rename %r" % got["images/startup_edge.png"]["usedIn"])

        # An imagegrid item is a reference like any other.
        res2 = assets_store.rename(root, moved, "eye_c.gif", "eye_diagram.gif")
        check(res2["renamed"] == 1, "imagegrid rename count %r" % res2["renamed"])
        items = moved["outline"][1]["children"][1]["blocks"][0]["items"]
        check(items[0]["file"] == "images/curve_b.jpg", "the sibling item was disturbed")
        check(items[1]["file"] == "images/eye_diagram.gif",
              "imagegrid item not repointed: %r" % items[1])
        check(os.path.isfile(os.path.join(idir, "eye_diagram.gif")),
              "the renamed gif is missing on disk")

        # A missing source is refused before anything moves.
        raises(FileNotFoundError, assets_store.rename, root, moved,
               "ghost.png", "other.png")
    finally:
        shutil.rmtree(root, ignore_errors=True)


# ---------------------------------------------------------------------------
# 5: a collision takes a suffix; it never overwrites.
# ---------------------------------------------------------------------------


def test_rename_collision_suffixes():
    root, project = make_project()
    try:
        res = assets_store.rename(root, project, "curve_b.jpg", "waveform_a.png")
        check(res["file"] == "images/waveform_a_2.png",
              "collision name %r != images/waveform_a_2.png" % res["file"])
        check(res["renamed"] == 1, "collision renamed %r" % res["renamed"])

        idir = os.path.join(root, "images")
        with open(os.path.join(idir, "waveform_a.png"), "rb") as fh:
            check(fh.read() == FILES["waveform_a.png"][0],
                  "the pre-existing file was overwritten")
        with open(os.path.join(idir, "waveform_a_2.png"), "rb") as fh:
            check(fh.read() == FILES["curve_b.jpg"][0],
                  "the renamed file did not keep its own bytes")

        items = project["outline"][1]["children"][1]["blocks"][0]["items"]
        check(items[0]["file"] == "images/waveform_a_2.png",
              "reference not repointed to the suffixed name: %r" % items[0])

        got = by_file(assets_store.list_assets(root, project))
        check(got["images/waveform_a.png"]["usedIn"] == ["2.1", "3"],
              "victim usedIn %r" % got["images/waveform_a.png"]["usedIn"])
        check(got["images/waveform_a_2.png"]["usedIn"] == ["2.2"],
              "suffixed usedIn %r" % got["images/waveform_a_2.png"]["usedIn"])
    finally:
        shutil.rmtree(root, ignore_errors=True)


# ---------------------------------------------------------------------------
# 6: nothing may address a file outside images/.
# ---------------------------------------------------------------------------


BAD_NAMES = [
    "../x.png",
    "images/../x.png",
    "..\\x.png",
    "sub/dir/x.png",
    "images/sub/x.png",
    "/etc/x.png",
    "C:/Windows/x.png",
    "C:\\Windows\\x.png",
    "",
    "   ",
]


def test_path_traversal_refused():
    root, project = make_project()
    try:
        for bad in BAD_NAMES:
            raises(ValueError, assets_store.set_tags, root, bad, ["x"])
            raises(ValueError, assets_store.rename, root, project, bad, "safe.png")
            raises(ValueError, assets_store.rename, root, project,
                   "waveform_a.png", bad)
            raises(ValueError, assets_store.delete, root, project, bad)

        # A name that the OS normalises away must not resolve to the images
        # directory itself. On Windows abspath("<idir>/...") collapses to
        # "<idir>\", whose trailing separator makes a naive equality test miss.
        for dots in ("...", "....", "images/..."):
            raises(ValueError, assets_store._abs_path, root,
                   assets_store._norm_rel(dots))
            raises(ValueError, assets_store.set_tags, root, dots, ["x"])
            raises(ValueError, assets_store.delete, root, project, dots)
            raises(ValueError, assets_store.rename, root, project,
                   dots, "safe.png")
        check(os.path.isdir(os.path.join(root, "images")),
              "images/ itself must survive a refused dotted name")

        # Nothing escaped, and nothing moved while refusing.
        listed = sorted(os.listdir(os.path.join(root, "images")))
        check(listed == sorted(FILES),
              "images/ changed while refusing bad names: %s" % listed)
        check(not os.path.exists(os.path.join(root, "safe.png")),
              "a refused rename created a file beside the report")
    finally:
        shutil.rmtree(root, ignore_errors=True)


# ---------------------------------------------------------------------------
# 7: delete only ever touches an asset nothing points at.
# ---------------------------------------------------------------------------


def test_delete_guards_used_assets():
    root, project = make_project()
    try:
        err = raises(ValueError, assets_store.delete, root, project,
                     "waveform_a.png")
        msg = str(err)
        check("2.1" in msg and "3" in msg,
              "the refusal should name the sections still using it: %r" % msg)
        check(os.path.isfile(os.path.join(root, "images", "waveform_a.png")),
              "a refused delete must leave the file alone")

        res = assets_store.delete(root, project, "spare_d.bmp")
        check(res["ok"] is True and res["file"] == "images/spare_d.bmp",
              "delete result %r" % res)
        check(not os.path.exists(os.path.join(root, "images", "spare_d.bmp")),
              "the deleted file is still in images/")
        trashed = os.path.join(root, "_trash", "assets", "spare_d.bmp")
        check(os.path.isfile(trashed), "the deleted file was not trashed at %s" % trashed)
        with open(trashed, "rb") as fh:
            check(fh.read() == FILES["spare_d.bmp"][0], "trashed bytes changed")

        out = assets_store.list_assets(root, project)
        check(out["count"] == len(FILES) - 1, "count after delete %r" % out["count"])
        check(out["unused"] == 0, "unused after delete %r" % out["unused"])
        check("images/spare_d.bmp" not in by_file(out),
              "the deleted file is still listed")

        raises(FileNotFoundError, assets_store.delete, root, project, "spare_d.bmp")
    finally:
        shutil.rmtree(root, ignore_errors=True)


# ---------------------------------------------------------------------------
# 8: a missing or damaged index is an empty index, never an exception.
# ---------------------------------------------------------------------------


DAMAGED = (
    b"",
    b"not json at all",
    b"[1, 2, 3]",
    b"null",
    b'{"images/waveform_a.png": "not an object"}',
    b'{"../escape.png": {"tags": ["x"]}}',
    b'{"images/waveform_a.png": {"tags": "startup"}}',
)


def test_index_damage_degrades():
    root, project = make_project()
    try:
        index_path = os.path.join(root, "assets.json")
        check(not os.path.exists(index_path), "no index should exist yet")

        # Missing: the tray still lists everything, with empty tags.
        out = assets_store.list_assets(root, project)
        check(out["count"] == len(FILES), "a missing index broke the scan")
        check(all(a["tags"] == [] for a in out["assets"]), "tags out of nowhere")

        for junk in DAMAGED:
            with open(index_path, "wb") as fh:
                fh.write(junk)
            check(assets_store._load_index(root) in ({}, {"images/waveform_a.png": {
                "tags": [], "added": 0, "note": ""}}),
                  "damaged index %r did not degrade: %r"
                  % (junk[:24], assets_store._load_index(root)))
            out = assets_store.list_assets(root, project)
            check(out["count"] == len(FILES),
                  "damaged index %r broke the scan" % junk[:24])
            check(all(a["tags"] == [] for a in out["assets"]),
                  "damaged index %r produced tags" % junk[:24])
            # Tagging still works afterwards, i.e. the index was rebuilt.
            assets_store.set_tags(root, "curve_b.jpg", ["ok"])
            got = by_file(assets_store.list_assets(root, project))
            check(got["images/curve_b.jpg"]["tags"] == ["ok"],
                  "could not recover the index after %r" % junk[:24])
            os.remove(index_path)

        # A folder with no images/ at all is an empty tray, not a crash.
        bare = tempfile.mkdtemp(prefix="assets_bare_")
        try:
            out = assets_store.list_assets(bare, project)
            check(out == {"assets": [], "count": 0, "unused": 0},
                  "bare folder listing %r" % out)
        finally:
            shutil.rmtree(bare, ignore_errors=True)
    finally:
        shutil.rmtree(root, ignore_errors=True)


TESTS = (
    test_scan_and_usage,
    test_tags_roundtrip,
    test_rename_repoints_everything,
    test_rename_collision_suffixes,
    test_path_traversal_refused,
    test_delete_guards_used_assets,
    test_index_damage_degrades,
)


def main():
    failures = []
    for fn in TESTS:
        try:
            fn()
            print("  ok   %s" % fn.__name__)
        except Exception as err:
            failures.append("%s: %s" % (fn.__name__, err))
            print("  FAIL %s: %s" % (fn.__name__, err))
    print("assertions: %d" % CHECKS[0])
    if failures:
        print("FAIL test_assets_store (%d failing case(s))" % len(failures))
        return 1
    print("OK test_assets_store")
    return 0


if __name__ == "__main__":
    sys.exit(main())
