#!/usr/bin/env python3
"""One-shot migration: give every plain-table row a ROW KIND.

A plain table (``block.type == "table"``) used to shade its rows through
``row_fills`` -- a {row_index: hex6} map. Addressing a colour by index means
inserting a row shifts every colour below it. ``core/tables.py`` now renders a
free table from a per-row KIND instead (``header`` / ``setting`` / ``result``),
mapping kind -> fill through the template config the same way the compliance
renderer already does, and keeping ``row_fills`` as a fallback so the older
editor -- which knows nothing about kinds -- keeps drawing the same bands.

This script derives the kinds for existing data:

  * for every ``project.json`` under the reports root, find each plain table
    that carries ``row_fills``;
  * invert the render map (``tables.free_kind_fills``) to turn each row stored
    fill back into a kind: a header row is ``header``, the setting fill named by
    the template is ``setting``, an unshaded row is ``result``;
  * write the result to ``block["row_kinds"]`` -- a list positionally parallel
    to ``rows``, so a row insert splices the kinds along with the rows;
  * LEAVE ``row_fills`` exactly as it was.

Because the kinds are derived by inverting the map the renderer itself uses, the
rendered document is unchanged. A row whose fill matches no kind (for example
the alternating band fills a table preset can carry) is left with ``null`` and
keeps rendering from ``row_fills``; those rows are reported so the choice is
visible rather than silent.

Idempotent: running it twice writes nothing the second time.

CLI::

    python builder/store/migrate_row_kind.py                    # dry run
    python builder/store/migrate_row_kind.py --apply            # write
    python builder/store/migrate_row_kind.py --rollback <snap>  # undo

``--apply`` copies every ``project.json`` it is about to rewrite into
``<root>/_migrations/row_kind/<timestamp>/`` before it writes anything, refuses
to write at all if any of those copies failed, and prints the exact rollback
command. Only those files are copied: nothing else under the reports root is
rewritten, so nothing else has to be duplicated.

Standard library only, apart from an optional import of the renderer so the
kind -> fill map can never drift from the one that draws the document.
"""

import argparse
import datetime
import json
import os
import shutil
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_BUILDER = os.path.dirname(_HERE)
_REPO = os.path.dirname(_BUILDER)

# Optional: use the render map from ``tables`` so the inversion below can never
# disagree with what is drawn. The renderer pulls in python-docx, which a machine
# that only wants to migrate data need not have, hence the soft import.
try:
    if _BUILDER not in sys.path:
        sys.path.insert(0, _BUILDER)
    import buildpath  # noqa: F401  (side effect: registers the layer dirs)
    import tables as _tables
except Exception:                                    # pragma: no cover
    _tables = None

# Mirror of tables._DEFAULT_SETTING_FILL, used only when the renderer could not
# be imported. A fallback, never the primary source of truth.
_FALLBACK_KIND_FILLS = {"header": "D9D9D9", "setting": "EEECE1", "result": None}

SNAPSHOT_SUBDIR = os.path.join("_migrations", "row_kind")
SNAPSHOT_MANIFEST = "_snapshot.json"

# The reports folder beside the repo, i.e. the default root of every other entry
# point (the server, the patch tool, the layout migration).
_REPORTS_DIRNAME = "local"


class MigrationError(RuntimeError):
    """Raised instead of touching a report the migration cannot undo."""


# Bookkeeping folders never hold a live report; this mirrors the server tree
# walk, where a name starting with "_" or "." is not a project.
_SKIP_DIR_PREFIXES = ("_", ".")


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
def resolve_root(arg=None):
    """The reports root: the argument, then BUILDER_REPORTS_ROOT, then the
    reports folder beside the repo.

    The last step mirrors ``migrate_layout.resolve_root`` (and the server's own
    default) exactly. The two migrations must agree on where reports live: a
    default that resolves to the checkout instead would point this tool at the
    source tree and walk it.
    """
    if arg:
        return os.path.abspath(arg)
    env = os.environ.get("BUILDER_REPORTS_ROOT")
    if env:
        return os.path.abspath(env)
    cand = os.path.join(_REPO, _REPORTS_DIRNAME)
    return cand if os.path.isdir(cand) else _REPO


def _walk_projects(root):
    """Absolute paths of every live ``project.json`` under ``root``."""
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames
                       if not d.startswith(_SKIP_DIR_PREFIXES)]
        if "project.json" in filenames:
            out.append(os.path.join(dirpath, "project.json"))
    out.sort()
    return out


def _rel(root, path):
    try:
        return os.path.relpath(path, root).replace("\\", "/")
    except ValueError:
        return path


def _safe(text):
    """A string that is always printable on this console."""
    enc = getattr(sys.stdout, "encoding", None) or "ascii"
    return str(text).encode(enc, "replace").decode(enc, "replace")


# ---------------------------------------------------------------------------
# Template config -> the kind -> fill map the renderer will use
# ---------------------------------------------------------------------------
def _load_json(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return None


def _template_free_cfg(root, project):
    """The ``free_table`` section of the config this report renders with."""
    tid = (project or {}).get("template")
    if not tid or not isinstance(tid, str):
        return {}
    cfg = _load_json(os.path.join(root, "templates", tid, "config.json"))
    if not isinstance(cfg, dict):
        return {}
    free = cfg.get("free_table")
    return free if isinstance(free, dict) else {}


def kind_fills(free_cfg, header_fill=None):
    """kind -> fill for one table, straight from the renderer when available."""
    if _tables is not None:
        return _tables.free_kind_fills(free_cfg, header_fill)
    m = dict(_FALLBACK_KIND_FILLS)
    m["header"] = header_fill or free_cfg.get("header_fill", m["header"])
    src = free_cfg.get("kind_fills")
    if not isinstance(src, dict):
        src = free_cfg.get("fills")
    if isinstance(src, dict):
        for k, v in src.items():
            if k == "header" and header_fill:
                continue
            m[k] = v or None
    return m


def _norm_fill(v):
    return v.strip().lstrip("#").upper() if isinstance(v, str) else None


# ---------------------------------------------------------------------------
# The derivation
# ---------------------------------------------------------------------------
def derive_kinds(block, free_cfg):
    """Row kinds for one plain table, or None when there is nothing to derive.

    Returns ``(kinds, unmapped)``: ``kinds`` is a list parallel to ``rows``
    holding a kind or None; ``unmapped`` lists the indices of rows whose stored
    fill matches no kind, which keep rendering from ``row_fills``.
    """
    rows = block.get("rows")
    if not isinstance(rows, list) or not rows:
        return None, []
    fills = block.get("row_fills")
    if not isinstance(fills, dict):
        return None, []
    header_rows = block.get("header_rows", 1)
    try:
        header_rows = int(header_rows)
    except (TypeError, ValueError):
        header_rows = 1
    kmap = kind_fills(free_cfg, block.get("header_fill"))
    # Invert the map: fill -> kind. "result" normally maps to None (unshaded),
    # handled separately below, so only real colours enter the lookup.
    #
    # "header" is deliberately NOT in the lookup. The header rows are identified
    # by position (r < header_rows) just below, so this lookup only ever sees a
    # BODY row -- and calling a body row "header" because it happens to carry the
    # header colour would silently change the document: the renderer bolds every
    # row whose kind is "header", so a mid-table divider row would come out bold
    # when it was not before. Such a row is left unmapped instead, keeping its
    # row_fills entry and getting reported, like any other unrecognised colour.
    by_fill = {}
    for kind in ("result", "setting"):               # later wins on a tie
        f = _norm_fill(kmap.get(kind))
        if f:
            by_fill[f] = kind
    indexed = {}
    for k, v in fills.items():
        try:
            indexed[int(k)] = _norm_fill(v)
        except (TypeError, ValueError):
            continue

    kinds = [None] * len(rows)
    unmapped = []
    for r in range(len(rows)):
        if r < header_rows:
            kinds[r] = "header"
            continue
        fill = indexed.get(r)
        if not fill:
            kinds[r] = "result"                      # unshaded == a result row
            continue
        kind = by_fill.get(fill)
        if kind:
            kinds[r] = kind
        else:
            unmapped.append(r)                       # left to row_fills
    return kinds, unmapped


def _iter_tables(project):
    """(section_path, block_index, block) for every plain table, outline order."""
    def walk(node, path):
        here = path + [node.get("title") or ""]
        for idx, block in enumerate(node.get("blocks") or []):
            if isinstance(block, dict) and block.get("type") == "table":
                yield here, idx, block
        for child in node.get("children") or []:
            for item in walk(child, here):
                yield item
    for node in (project.get("outline") or []):
        for item in walk(node, []):
            yield item


def _table_key(section, idx):
    return (" / ".join(s for s in section if s), idx)


def scan_project(root, path):
    """Plan the change for one report: ``(entries, changed_blocks)``."""
    project = _load_json(path)
    if not isinstance(project, dict):
        return [], 0
    free_cfg = _template_free_cfg(root, project)
    entries = []
    changed = 0
    for section, idx, block in _iter_tables(project):
        if not isinstance(block.get("row_fills"), dict) or not block["row_fills"]:
            continue                                 # only tables that shade by index
        kinds, unmapped = derive_kinds(block, free_cfg)
        if kinds is None or not any(k for k in kinds):
            continue
        already = block.get("row_kinds") == kinds
        if not already:
            changed += 1
        counts = {}
        for k in kinds:
            counts[k or "unmapped"] = counts.get(k or "unmapped", 0) + 1
        entries.append({
            "report": _rel(root, os.path.dirname(path)),
            "section": _table_key(section, idx)[0],
            "block": block.get("id"),
            "block_index": idx,
            "rows": len(kinds),
            "counts": counts,
            "unmapped_rows": unmapped,
            "kinds": kinds,
            "already": already,
        })
    return entries, changed


def _write_kinds(path, entries):
    """Write the planned ``row_kinds`` back into one report, atomically."""
    with open(path, "rb") as fh:
        raw = fh.read()
    project = json.loads(raw.decode("utf-8"))
    plan = {(e["section"], e["block_index"]): e["kinds"] for e in entries}
    n = 0
    for section, idx, block in _iter_tables(project):
        kinds = plan.get(_table_key(section, idx))
        if kinds is None or block.get("row_kinds") == kinds:
            continue
        block["row_kinds"] = kinds
        n += 1
    if not n:
        return 0
    text = json.dumps(project, ensure_ascii=False, indent=2)
    if raw.endswith(b"\n"):
        text += "\n"
    if b"\r\n" in raw:                               # keep the line endings it had
        text = text.replace("\n", "\r\n")
    tmp = path + ".tmp.%d" % os.getpid()
    with open(tmp, "wb") as fh:
        fh.write(text.encode("utf-8"))
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)
    return n


# ---------------------------------------------------------------------------
# Snapshot / rollback
# ---------------------------------------------------------------------------
def take_snapshot(root, paths):
    """Copy the reports about to be rewritten aside; return the snapshot dir.

    ``paths`` are the absolute ``project.json`` files this run will write, and
    they are the ONLY files copied. The snapshot exists so ``rollback`` has a
    pre-image of every file the migration touches; the migration touches nothing
    else, so copying the rest of the root would duplicate every figure and every
    unrelated file for no gain -- and would drop that copy at a path inside the
    checkout when the root is the checkout.

    A copy that fails raises ``MigrationError`` rather than being skipped: a
    rewritten file with no pre-image is a file that cannot be rolled back.
    """
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    dest = os.path.join(root, SNAPSHOT_SUBDIR, stamp)
    if os.path.exists(dest):
        dest += "-%d" % os.getpid()
    os.makedirs(dest, exist_ok=True)
    count = 0
    for src in paths:
        rel = os.path.relpath(src, root)
        if rel.split(os.sep)[0] == os.pardir:
            raise MigrationError(
                "refusing to snapshot %s: it is outside the reports root %s"
                % (src, root))
        target = os.path.join(dest, rel)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        try:
            shutil.copy2(src, target)
        except OSError as ex:
            raise MigrationError(
                "snapshot is incomplete (%s could not be copied: %s) -- "
                "refusing to write. Snapshot left at %s"
                % (rel.replace("\\", "/"), ex, dest))
        if not os.path.isfile(target):
            raise MigrationError(
                "snapshot is incomplete (%s missing after the copy) -- "
                "refusing to write. Snapshot left at %s"
                % (rel.replace("\\", "/"), dest))
        count += 1
    with open(os.path.join(dest, SNAPSHOT_MANIFEST), "w", encoding="utf-8") as fh:
        json.dump({"root": os.path.abspath(root), "created": stamp,
                   "files": count, "migration": "row_kind"}, fh, indent=2)
    return dest


def rollback(snapshot):
    """Restore the ``project.json`` files this migration can have written.

    Only ``project.json`` is restored, and only where the bytes differ: the
    migration writes nothing else, so a wider restore would quietly revert
    unrelated edits made after the snapshot -- and the snapshot holds nothing
    else to restore from.
    """
    snapshot = os.path.abspath(snapshot)
    manifest = _load_json(os.path.join(snapshot, SNAPSHOT_MANIFEST)) or {}
    root = manifest.get("root")
    if not root or not os.path.isdir(root):
        root = os.path.dirname(os.path.dirname(os.path.dirname(snapshot)))
    restored = []
    for dirpath, dirnames, filenames in os.walk(snapshot):
        if "project.json" not in filenames:
            continue
        src = os.path.join(dirpath, "project.json")
        rel = os.path.relpath(src, snapshot)
        dst = os.path.join(root, rel)
        try:
            with open(src, "rb") as fh:
                want = fh.read()
        except OSError:
            continue
        have = None
        if os.path.exists(dst):
            try:
                with open(dst, "rb") as fh:
                    have = fh.read()
            except OSError:
                have = None
        if have == want:
            continue
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)
        restored.append(rel.replace("\\", "/"))
    return {"restored": len(restored), "files": restored,
            "root": root, "snapshot": snapshot}


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------
def migrate(root, dry_run=True):
    """Derive and (unless ``dry_run``) store the row kinds under ``root``.

    Returns ``{"scanned": n, "changed": n, "tables": [...], "snapshot": path}``
    where ``scanned`` counts the plain tables that carry ``row_fills``,
    ``changed`` counts those that gained (or would gain) ``row_kinds``, and
    ``snapshot`` is the pre-write copy of the reports being rewritten (None on a
    dry run). A snapshot that cannot be completed aborts the run before any
    report is written.
    """
    root = os.path.abspath(root)
    plans = []
    tables_out = []
    scanned = 0
    changed = 0
    for path in _walk_projects(root):
        entries, n_changed = scan_project(root, path)
        if not entries:
            continue
        scanned += len(entries)
        changed += n_changed
        tables_out.extend(entries)
        if n_changed:
            plans.append((path, entries))

    snapshot = None
    if not dry_run and plans:
        snapshot = take_snapshot(root, [path for path, _ in plans])
        for path, entries in plans:
            _write_kinds(path, entries)
    return {"scanned": scanned, "changed": changed, "tables": tables_out,
            "snapshot": snapshot}


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _script_path():
    try:
        return os.path.relpath(os.path.abspath(__file__), os.getcwd()).replace("\\", "/")
    except ValueError:
        return os.path.abspath(__file__)


def _print_report(result, root, dry_run):
    print("reports root                : %s" % _safe(root))
    print("plain tables with row_fills : %d" % result["scanned"])
    print("tables to change            : %d" % result["changed"])
    for e in result["tables"]:
        counts = ", ".join("%s=%d" % (k, v) for k, v in sorted(e["counts"].items()))
        print("  %-24s block %-10s rows=%-3d %s%s"
              % (_safe(e["report"]), _safe(e["block"] or "#%d" % e["block_index"]),
                 e["rows"], counts, "  [already migrated]" if e["already"] else ""))
        if e["unmapped_rows"]:
            print("      rows %s carry a fill that matches no kind; left on row_fills"
                  % ", ".join(str(i) for i in e["unmapped_rows"]))
    if dry_run:
        print("")
        print("DRY RUN -- nothing written. Re-run with --apply to write.")
    elif result["snapshot"]:
        print("")
        print("snapshot: %s" % _safe(result["snapshot"]))
        print("rollback with:")
        print("  python %s --root %s --rollback %s"
              % (_script_path(), _safe(root), _safe(result["snapshot"])))
    else:
        print("")
        print("nothing to change; no snapshot taken.")


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Derive a row kind for every plain table that shades by row index.")
    ap.add_argument("--root",
                    help="reports root (default: $BUILDER_REPORTS_ROOT, "
                         "else the reports folder beside the repo)")
    ap.add_argument("--dry-run", action="store_true", default=True,
                    help="preview only (the default)")
    ap.add_argument("--apply", action="store_true", help="take a snapshot and write")
    ap.add_argument("--rollback", metavar="SNAPSHOT",
                    help="restore the project.json files from a snapshot directory")
    a = ap.parse_args(argv)
    root = resolve_root(a.root)
    if a.rollback:
        res = rollback(a.rollback)
        print("restored %d project.json file(s) from %s"
              % (res["restored"], _safe(res["snapshot"])))
        for f in res["files"]:
            print("  %s" % _safe(f))
        return 0
    if not os.path.isdir(root):
        print("no such reports root: %s" % _safe(root))
        return 2
    dry_run = not a.apply
    res = migrate(root, dry_run=dry_run)
    _print_report(res, root, dry_run)
    return 0


if __name__ == "__main__":
    sys.exit(main())
