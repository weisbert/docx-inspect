#!/usr/bin/env python3
"""Asset index for one report's ``images/`` folder.

The tray behind the editor needs three things the file system alone cannot give:
a stable "added" date, free-form tags, and -- most importantly -- where each file
is actually used in the document.

Two of those are stored, one is not:

    <report>/images/            the files themselves (the only place they may live)
    <report>/assets.json        {"images/<name>": {"tags": [], "added": 0, "note": ""}}

``assets.json`` holds tags / added / note and nothing else. **Usage is derived on
every call** by walking the outline for ``image`` and ``imagegrid`` blocks. A
stored usage index would be wrong the moment a package is applied or an outline
node is moved, and a wrong usage count is worse than none: it is what makes a
"delete, it is unused" offer dangerous.

Why the file names matter enough to deserve a module: figures only ever arrive as
files, and a draft that comes back edited refers to a figure by its file name
alone. Renaming therefore has to stay cheap and safe, which is why ``rename``
rewrites the file on disk and every ``file:`` reference in the project in one
operation instead of leaving the two to drift.

Every path is validated to be exactly ``images/<one component>`` inside the given
report folder. Absolute paths, traversal, sub-folders and empty names are refused
with ValueError (the server turns that into a 400).

Standard library only; image dimensions are read from the file header, never by
decoding the pixels.
"""

import json
import os
import struct
import time


INDEX_NAME = "assets.json"
IMAGES_DIR = "images"

# What the tray shows. Anything else in images/ is ignored rather than listed:
# the pool is a picture pool, not a general file drop.
IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tif", ".tiff",
              ".webp", ".emf", ".wmf", ".svg")

MAX_TAGS = 24
MAX_TAG_LEN = 40


# ---------------------------------------------------------------------------
# Paths: one component, directly under <report>/images/.
# ---------------------------------------------------------------------------


def _images_dir(project_dir):
    return os.path.join(os.path.abspath(project_dir), IMAGES_DIR)


def _norm_rel(name):
    """Normalise a caller-supplied file name to ``images/<base>``.

    Accepts "foo.png" and "images/foo.png" (either slash). Everything else is a
    refusal, because an image that is not directly under images/ is a state the
    tray must never be able to create -- content_lint already errors on it, and
    the only file route the server has serves exactly that one subtree.
    """
    if not isinstance(name, str):
        raise ValueError("missing file name")
    rel = name.replace("\\", "/").strip()
    if not rel:
        raise ValueError("missing file name")
    # An absolute path (POSIX or drive-lettered) is never a project-relative name.
    if rel.startswith("/") or (len(rel) > 1 and rel[1] == ":"):
        raise ValueError("file name must be relative to the report folder")
    parts = [p for p in rel.split("/") if p != ""]
    if parts and parts[0].lower() == IMAGES_DIR:
        parts = parts[1:]
    if len(parts) != 1:
        raise ValueError("an image must sit directly in images/")
    base = parts[0]
    if base in (".", "..") or base != os.path.basename(base):
        raise ValueError("bad file name: %s" % name)
    return IMAGES_DIR + "/" + base


def _abs_path(project_dir, rel):
    """Absolute path for an already-normalised ``images/<base>``, re-checked.

    The containment test is repeated on the resolved path so a name that only
    turns dangerous after the OS normalises it (a trailing dot or space on
    Windows, say) still cannot escape.
    """
    idir = _images_dir(project_dir)
    # normpath() after abspath(): on Windows a name made only of dots collapses
    # away, leaving the images directory itself *with* a trailing separator,
    # which would slip past the identity test below.
    full = os.path.normpath(os.path.abspath(os.path.join(idir, os.path.basename(rel))))
    try:
        common = os.path.commonpath([idir, full])
    except ValueError:      # different drives
        raise ValueError("file name escapes images/")
    if os.path.normcase(common) != os.path.normcase(idir) or \
            os.path.normcase(full) == os.path.normcase(idir):
        raise ValueError("file name escapes images/")
    return full


def _is_image(base):
    return base.lower().endswith(IMAGE_EXTS)


# ---------------------------------------------------------------------------
# The stored side: tags / added / note.
# ---------------------------------------------------------------------------


def _index_path(project_dir):
    return os.path.join(os.path.abspath(project_dir), INDEX_NAME)


def _load_index(project_dir):
    """Read assets.json. A missing or damaged file is an empty index, never an
    error: tags are a convenience and must not be able to break the tray."""
    try:
        with open(_index_path(project_dir), "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception:
        return {}
    if not isinstance(data, dict):
        return {}
    clean = {}
    for key, entry in data.items():
        try:
            rel = _norm_rel(key)
        except ValueError:
            continue
        if not isinstance(entry, dict):
            entry = {}
        note = entry.get("note")
        clean[rel] = {
            "tags": _clean_tags(entry.get("tags")),
            "added": _as_ts(entry.get("added")),
            "note": note if isinstance(note, str) else "",
        }
    return clean


def _save_index(project_dir, index):
    """Write assets.json atomically. Best effort: a read-only folder loses the
    tags, it does not lose the tray."""
    path = _index_path(project_dir)
    tmp = path + ".tmp"
    try:
        blob = json.dumps(index, ensure_ascii=False, indent=2,
                          sort_keys=True).encode("utf-8")
        with open(tmp, "wb") as fh:
            fh.write(blob)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
        return True
    except Exception:
        try:
            os.remove(tmp)
        except OSError:
            pass
        return False


def _as_ts(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _clean_tags(tags):
    """Trimmed, de-duplicated (case-insensitively), bounded list of strings."""
    out = []
    seen = set()
    if not isinstance(tags, (list, tuple)):
        return out
    for tag in tags:
        if not isinstance(tag, str):
            continue
        tag = " ".join(tag.split())[:MAX_TAG_LEN].strip()
        if not tag:
            continue
        key = tag.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(tag)
        if len(out) >= MAX_TAGS:
            break
    return out


# ---------------------------------------------------------------------------
# Image dimensions from the file header (no decoding, no dependency).
# ---------------------------------------------------------------------------


def _dims_png(fh):
    head = fh.read(24)
    if len(head) < 24 or head[:8] != b"\x89PNG\r\n\x1a\n" or head[12:16] != b"IHDR":
        return None
    w, h = struct.unpack(">II", head[16:24])
    return int(w), int(h)


def _dims_gif(fh):
    head = fh.read(10)
    if len(head) < 10 or head[:6] not in (b"GIF87a", b"GIF89a"):
        return None
    w, h = struct.unpack("<HH", head[6:10])
    return int(w), int(h)


def _dims_bmp(fh):
    head = fh.read(26)
    if len(head) < 26 or head[:2] != b"BM":
        return None
    w, h = struct.unpack("<ii", head[18:26])
    return abs(int(w)), abs(int(h))


# JPEG frame markers that carry the size. C4 / C8 / CC sit inside the SOFn range
# but are a Huffman table, a reserved extension and an arithmetic-coding table.
_JPEG_SOF = set(range(0xC0, 0xD0)) - {0xC4, 0xC8, 0xCC}


def _dims_jpeg(fh):
    """Walk the marker segments to the first frame header.

    Segment headers only, so a 20 MB photograph costs a handful of short reads.
    """
    if fh.read(2) != b"\xff\xd8":
        return None
    while True:
        byte = fh.read(1)
        if not byte:
            return None
        if byte != b"\xff":
            continue                       # resync on the next marker prefix
        marker = fh.read(1)
        while marker == b"\xff":           # fill bytes ahead of a marker
            marker = fh.read(1)
        if not marker:
            return None
        code = marker[0]
        if code in (0x00, 0x01, 0xD8) or 0xD0 <= code <= 0xD7:
            continue                       # standalone markers carry no length
        if code in (0xD9, 0xDA):
            return None                    # end of image / start of scan
        size = fh.read(2)
        if len(size) < 2:
            return None
        length = struct.unpack(">H", size)[0]
        if length < 2:
            return None
        if code in _JPEG_SOF:
            body = fh.read(5)
            if len(body) < 5:
                return None
            h, w = struct.unpack(">HH", body[1:5])
            return int(w), int(h)
        fh.seek(length - 2, os.SEEK_CUR)


_DIM_READERS = (_dims_png, _dims_jpeg, _dims_gif, _dims_bmp)


def image_size(path):
    """(width, height) read from the file header, or (None, None).

    Formats whose header answers the question: PNG, JPEG, GIF, BMP. Anything else
    (EMF, SVG, a vendor TIFF) simply reports no size -- the card still shows the
    file name and the byte size, which is what the tray is really for.
    """
    try:
        with open(path, "rb") as fh:
            for reader in _DIM_READERS:
                fh.seek(0)
                try:
                    got = reader(fh)
                except Exception:
                    got = None
                if got and got[0] > 0 and got[1] > 0:
                    return got
    except OSError:
        pass
    return (None, None)


# ---------------------------------------------------------------------------
# The derived side: who uses what.
# ---------------------------------------------------------------------------


def _iter_uses(project):
    """Yield (rel_file, section_number, node_title, node_id, block_id).

    The section number is the 1-based index path of the outline node ("4.1"),
    which is how every heading is numbered in the rendered document.
    """
    outline = (project or {}).get("outline") or []

    def walk(nodes, prefix):
        for i, node in enumerate(nodes or []):
            if not isinstance(node, dict):
                continue
            num = prefix + [str(i + 1)]
            section = ".".join(num)
            for block in node.get("blocks") or []:
                if not isinstance(block, dict):
                    continue
                btype = block.get("type")
                if btype == "image":
                    files = [block.get("file")]
                elif btype == "imagegrid":
                    files = [it.get("file") for it in (block.get("items") or [])
                             if isinstance(it, dict)]
                else:
                    continue
                for raw in files:
                    if not raw:
                        continue
                    try:
                        rel = _norm_rel(raw)
                    except ValueError:
                        # A path outside images/ is a lint error elsewhere; it is
                        # simply not one of the assets this tray owns.
                        continue
                    yield (rel, section, node.get("title", ""),
                           node.get("id", ""), block.get("id", ""))
            for item in walk(node.get("children") or [], num):
                yield item

    for item in walk(outline, []):
        yield item


def usage_map(project):
    """{"images/<name>": [{"section","title","node","block"}, ...]}.

    Document order, one entry per use, so a file placed twice lists twice.
    """
    uses = {}
    for rel, section, title, node_id, block_id in _iter_uses(project):
        uses.setdefault(rel, []).append({
            "section": section, "title": title,
            "node": node_id, "block": block_id,
        })
    return uses


# ---------------------------------------------------------------------------
# Public API (the server calls exactly these).
# ---------------------------------------------------------------------------


def list_assets(project_dir, project):
    """Scan images/, merge the stored tags, derive the usage.

    Returns {"assets": [{file, bytes, w, h, added, tags, note, usedIn, uses,
    unused}], "count": n, "unused": n}. Newest first, so the collapsed bar can
    take the first three as "the most recently added".

    ``usedIn`` is the plain list of section numbers a card prints; ``uses`` is
    the same list with the node and block ids, for jumping to the spot.
    """
    idir = _images_dir(project_dir)
    index = _load_index(project_dir)
    uses = usage_map(project)

    try:
        names = sorted(os.listdir(idir))
    except OSError:
        names = []

    assets = []
    dirty = False
    for base in names:
        if not _is_image(base):
            continue
        full = os.path.join(idir, base)
        if not os.path.isfile(full):
            continue
        try:
            stat = os.stat(full)
        except OSError:
            continue
        rel = IMAGES_DIR + "/" + base
        entry = index.get(rel)
        if entry is None:
            # First sight: remember when it appeared, so the ordering stays put
            # even after something touches the file.
            entry = {"tags": [], "added": int(stat.st_mtime), "note": ""}
            index[rel] = entry
            dirty = True
        elif not entry.get("added"):
            entry["added"] = int(stat.st_mtime)
            dirty = True
        where = uses.get(rel) or []
        width, height = image_size(full)
        assets.append({
            "file": rel,
            "bytes": int(stat.st_size),
            "w": width,
            "h": height,
            "added": int(entry.get("added") or 0),
            "tags": list(entry.get("tags") or []),
            "note": entry.get("note") or "",
            "usedIn": [u["section"] for u in where],
            "uses": where,
            "unused": not where,
        })

    if dirty:
        _save_index(project_dir, index)

    assets.sort(key=lambda a: (-a["added"], a["file"].lower()))
    return {
        "assets": assets,
        "count": len(assets),
        "unused": sum(1 for a in assets if a["unused"]),
    }


def set_tags(project_dir, file, tags):
    """Replace one file's tags. The file has to exist in images/."""
    rel = _norm_rel(file)
    full = _abs_path(project_dir, rel)
    if not os.path.isfile(full):
        raise FileNotFoundError(rel)
    index = _load_index(project_dir)
    entry = index.get(rel)
    if entry is None:
        try:
            added = int(os.stat(full).st_mtime)
        except OSError:
            added = int(time.time())
        entry = {"tags": [], "added": added, "note": ""}
        index[rel] = entry
    entry["tags"] = _clean_tags(tags)
    _save_index(project_dir, index)
    return {"ok": True, "file": rel, "tags": list(entry["tags"])}


def _free_name(project_dir, rel):
    """Return ``rel``, or the first free ``<stem>_<n><ext>`` beside it."""
    full = _abs_path(project_dir, rel)
    if not os.path.exists(full):
        return rel, full
    base = os.path.basename(rel)
    stem, ext = os.path.splitext(base)
    for n in range(2, 1000):
        cand = IMAGES_DIR + "/" + "%s_%d%s" % (stem, n, ext)
        cand_full = _abs_path(project_dir, cand)
        if not os.path.exists(cand_full):
            return cand, cand_full
    raise ValueError("too many files named like %s" % base)


def _repoint(project, old_rel, new_rel):
    """Rewrite every image / imagegrid reference in place; returns the count."""
    state = {"n": 0}

    def same(value):
        if not value:
            return False
        try:
            return _norm_rel(value) == old_rel
        except ValueError:
            return False

    def walk(nodes):
        for node in nodes or []:
            if not isinstance(node, dict):
                continue
            for block in node.get("blocks") or []:
                if not isinstance(block, dict):
                    continue
                btype = block.get("type")
                if btype == "image":
                    if same(block.get("file")):
                        block["file"] = new_rel
                        state["n"] += 1
                elif btype == "imagegrid":
                    for item in block.get("items") or []:
                        if isinstance(item, dict) and same(item.get("file")):
                            item["file"] = new_rel
                            state["n"] += 1
            walk(node.get("children") or [])

    walk((project or {}).get("outline") or [])
    return state["n"]


def rename(project_dir, project, old, new):
    """Rename a stored file AND repoint every reference to it, in one step.

    Returns {"renamed": n, "file": "images/<new>", "from": "images/<old>",
    "project": <the rewritten project>}; the caller saves the project. Doing the
    disk rename and the reference rewrite as two separate calls is exactly how a
    figure ends up pointing at nothing, so this never offers that shape.

    A collision gets a numeric suffix (``name_2.png``). A new name with no
    extension keeps the old one, so editing only the visible part of a
    middle-truncated name cannot silently produce an extension-less file.
    """
    old_rel = _norm_rel(old)
    old_full = _abs_path(project_dir, old_rel)
    if not os.path.isfile(old_full):
        raise FileNotFoundError(old_rel)

    new_rel = _norm_rel(new)
    if not os.path.splitext(os.path.basename(new_rel))[1]:
        new_rel = _norm_rel(new_rel + os.path.splitext(os.path.basename(old_rel))[1])

    if os.path.normcase(new_rel) == os.path.normcase(old_rel):
        # The same name, or a case-only change on a case-insensitive file system:
        # nothing to move and nothing to repoint.
        return {"ok": True, "renamed": 0, "file": old_rel, "from": old_rel,
                "project": project}

    new_rel, new_full = _free_name(project_dir, new_rel)
    os.rename(old_full, new_full)

    renamed = _repoint(project, old_rel, new_rel)

    index = _load_index(project_dir)
    entry = index.pop(old_rel, None)
    if entry is not None:
        index[new_rel] = entry
        _save_index(project_dir, index)

    return {"ok": True, "renamed": renamed, "file": new_rel, "from": old_rel,
            "project": project}


def delete(project_dir, project, file):
    """Delete an asset -- only when nothing points at it.

    Refuses with a ValueError naming the sections that still use it; the
    alternative is a figure block that turns into a missing-image warning at
    export time. The file moves to ``<report>/_trash/assets/`` rather than being
    unlinked, so a mistake is recoverable the same way a deleted report is.
    """
    rel = _norm_rel(file)
    full = _abs_path(project_dir, rel)
    if not os.path.isfile(full):
        raise FileNotFoundError(rel)

    where = usage_map(project).get(rel) or []
    if where:
        raise ValueError("%s is still used in %s -- remove those uses first"
                         % (rel, ", ".join(sorted({u["section"] for u in where}))))

    trash = os.path.join(os.path.abspath(project_dir), "_trash", "assets")
    base = os.path.basename(rel)
    moved = None
    try:
        os.makedirs(trash, exist_ok=True)
        target = os.path.join(trash, base)
        if os.path.exists(target):
            stem, ext = os.path.splitext(base)
            target = os.path.join(trash, "%s_%d%s" % (stem, int(time.time()), ext))
        os.replace(full, target)
        moved = os.path.relpath(target, os.path.abspath(project_dir)).replace("\\", "/")
    except OSError:
        os.remove(full)

    index = _load_index(project_dir)
    if index.pop(rel, None) is not None:
        _save_index(project_dir, index)

    return {"ok": True, "file": rel, "trashed": moved}
