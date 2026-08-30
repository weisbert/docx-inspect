#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Move a flat reports root onto the three-level PROJECT / MODULE / STAGE layout.

Today a report lives one level under the reports root::

    <root>/<MODULE>/project.json

The layout the workbench addresses adds TWO levels::

    <root>/<PROJECT>/<MODULE>/<STAGE>/project.json

This module plans and performs that migration. It is a data move only: the whole
module directory travels as one unit (``images/``, ``out/``, ``data/``,
``_backups/``, ``_autosave/``, ``_baseline.json`` and any loose files come along)
and ``project.json`` is never rewritten -- its bytes are hashed before the move
and re-hashed afterwards, and a mismatch aborts the run.

Which project a module belongs to is NEVER guessed. The caller supplies the
mapping::

    {"<module dir>": {"project": "<project id>", "stage": "XDR|PDR|CDR|FDR"}}

``stage`` may be omitted, in which case it is read out of the report's own
``meta.title`` when the title names a stage code. A module that is absent from
the mapping is reported under ``"unmapped"`` and left exactly where it is.

The mapping file may also carry display names, so no folder id has to double as a
label::

    {"modules":  {"MODULE_A": {"project": "P1", "stage": "CDR"}},
     "projects": {"P1": {"name": "...", "description": "..."}},
     "moduleMeta": {"MODULE_A": {"name": "...", "description": "..."}}}

Safety, because this runs against real reports on the owner's machine:

  * ``--dry-run`` is the default and prints the complete move plan;
  * a full copy of the reports root is taken before the first move;
  * the exact rollback command is the last line the apply prints;
  * the run is refused outright if any target path already exists, or if any
    ``project.json`` in the plan fails to parse;
  * the run is resumable -- a module already sitting at its target with no source
    left behind is reported as done instead of being moved a second time;
  * a rollback never deletes anything the migration did not create, and names
    every directory it therefore has to leave standing.

Nothing here changes how old paths are read: the server walks depth 1, 2 and 3 in
one pass, so a half-migrated root keeps working.

Usage (from the repo root, with the project's python)::

    python builder/store/migrate_layout.py --root <reports root> --map map.json
    python builder/store/migrate_layout.py --root <reports root> --map map.json --apply
    python builder/store/migrate_layout.py --rollback <reports root>/_migrate/<stamp>
    python builder/store/migrate_layout.py --rollback <a copy of that folder> \
        --root <the root that copy belongs to>

``--root`` defaults to ``$BUILDER_REPORTS_ROOT``, then to the sibling reports
folder next to the repo -- the same resolution ``apply_update.py`` already uses.
For ``--rollback`` it instead defaults to the root recorded in the snapshot's
manifest, and passing it explicitly is what makes rehearsing a rollback against
a COPY of a snapshot act on the copy. Either way the root in use is printed
before the first directory moves.

Standard library only. Public API: ``plan()``, ``apply()``, ``rollback()``.
"""

import argparse
import datetime
import hashlib
import json
import os
import re
import shutil
import sys


SELF = os.path.dirname(os.path.abspath(__file__))          # builder/store
REPO = os.path.dirname(os.path.dirname(SELF))              # repo root

PROJECT_FILE = "project.json"

# Written at the project and the module level: {"id", "name", "description"}.
# Optional for the reader -- the server falls back to the folder name.
PROJECT_META_FILE = "project_meta.json"

# Everything this tool writes lives under one root-level folder. It starts with
# "_" so the server's tree walk skips it and it can never be taken for a project.
MIGRATE_DIRNAME = "_migrate"
SNAPSHOT_TREE = "tree"                 # the full copy of the reports root
MANIFEST_FILE = "migrate_manifest.json"

STAGES = ("XDR", "PDR", "CDR", "FDR")

# A stage code standing on its own inside a title or a folder name. Mirrors the
# server's _STAGE_RE so both sides agree on what "names a stage" means.
_STAGE_RE = re.compile(r"(?:^|[^A-Z])(XDR|PDR|CDR|FDR)(?:[^A-Z]|$)")

# Root-level folders that are bookkeeping, never a report.
RESERVED_DIRS = {
    "_backups", "_updates", "_outbox", "_trash", "_autosave", "_migrate",
    "__pycache__", "assets", "templates", "images", "out", "data",
}


class MigrationError(Exception):
    """A refusal: something about the plan or the disk makes the move unsafe."""


# ---------------------------------------------------------------------------
# Small helpers.
# ---------------------------------------------------------------------------


def resolve_root(arg):
    """Absolute reports root: the argument, else the env var, else <repo>/local."""
    if arg:
        return os.path.abspath(arg)
    env = os.environ.get("BUILDER_REPORTS_ROOT")
    if env:
        return os.path.abspath(env)
    cand = os.path.join(REPO, "local")
    return cand if os.path.isdir(cand) else REPO


def _rel(root, path):
    """Root-relative path with forward slashes (the server's addressing form)."""
    return os.path.relpath(path, root).replace("\\", "/")


def _sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _listdir_quiet(path):
    try:
        return sorted(os.listdir(path))
    except OSError:
        return []


def _is_candidate_dir(root, name):
    """True for a root-level folder that could hold a report."""
    if not name or name.startswith("_") or name.startswith("."):
        return False
    if name in RESERVED_DIRS:
        return False
    return os.path.isdir(os.path.join(root, name))


def _has_project(path):
    return os.path.isfile(os.path.join(path, PROJECT_FILE))


def stage_from_title(text):
    """The stage code named by a title or a folder name, else an empty string.

    The last standalone code wins, so a title that mentions an earlier stage in
    passing still resolves to the stage the document actually is.
    """
    up = str(text or "").upper()
    found = ""
    for m in _STAGE_RE.finditer(up):
        found = m.group(1)
    return found


def _read_json(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _write_json(path, data):
    """Write JSON via a temp file + replace, so a crash cannot truncate a file."""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    os.replace(tmp, path)


def _safe_segment(name):
    """A single path segment with no separators, no traversal, no leading dot."""
    s = str(name or "").strip().strip("/\\")
    if not s or s in (".", "..") or s.startswith(".") or s.startswith("_"):
        return ""
    if "/" in s or "\\" in s or os.path.sep in s:
        return ""
    return s


def normalize_mapping(mapping):
    """Accept either the flat form or the wrapper form.

    Returns ``(modules, project_meta, module_meta)`` where ``modules`` is
    ``{module: {"project":..., "stage":...}}`` and the two meta dicts are
    ``{id: {"name":..., "description":...}}`` (possibly empty).
    """
    if not isinstance(mapping, dict):
        raise MigrationError("mapping must be an object")

    modules = mapping
    project_meta = {}
    module_meta = {}
    if isinstance(mapping.get("modules"), dict):
        modules = mapping["modules"]
        if isinstance(mapping.get("projects"), dict):
            project_meta = mapping["projects"]
        if isinstance(mapping.get("moduleMeta"), dict):
            module_meta = mapping["moduleMeta"]

    out = {}
    for key, val in modules.items():
        if not isinstance(val, dict):
            raise MigrationError(
                "mapping entry for %r must be an object with a \"project\" key"
                % (key,))
        out[str(key)] = val
    return out, project_meta, module_meta


# ---------------------------------------------------------------------------
# plan()
# ---------------------------------------------------------------------------


def plan(root, mapping):
    """Work out what would move, without touching a single file.

    ``root``    -- the reports root (flat today, three-level after the move).
    ``mapping`` -- supplied by the caller, see ``normalize_mapping``. Company and
                   product names live in the caller's mapping file, never here.

    Returns::

        {"root": <abs>,
         "moves":     [{"from","to","stage","reason","project","module","sha256"}],
         "unmapped":  [{"module","from","stage","title","reason"}],
         "conflicts": [{"module","from","to","reason"}],
         "done":      [{"module","to","reason"}]}

    ``from`` / ``to`` are root-relative. A non-empty ``conflicts`` list means
    ``apply()`` will refuse to run.
    """
    root = os.path.abspath(root)
    if not os.path.isdir(root):
        raise MigrationError("reports root does not exist: %s" % root)

    modules, project_meta, module_meta = normalize_mapping(mapping)

    result = {
        "root": root,
        "moves": [],
        "unmapped": [],
        "conflicts": [],
        "done": [],
        "projectMeta": {},
        "moduleMeta": {},
    }

    # Every flat report currently sitting one level under the root, plus every
    # module the mapping names (so a stale mapping entry is reported, not
    # silently ignored).
    present = [n for n in _listdir_quiet(root)
               if _is_candidate_dir(root, n) and _has_project(os.path.join(root, n))]
    names = list(present)
    for name in sorted(modules):
        if name not in names:
            names.append(name)

    seen_targets = {}

    for name in names:
        src = os.path.join(root, name)
        entry = modules.get(name)
        src_has_project = _has_project(src)

        if entry is None:
            # Not in the mapping: the stage can be inferred, the project cannot.
            title = _title_of(src)
            result["unmapped"].append({
                "module": name,
                "from": _rel(root, src),
                "stage": stage_from_title(title),
                "title": title,
                "reason": "not in mapping: add a \"project\" for this module",
            })
            continue

        project = _safe_segment(entry.get("project"))
        if not project:
            result["conflicts"].append({
                "module": name, "from": _rel(root, src), "to": "",
                "reason": "mapping entry has no usable \"project\" name",
            })
            continue

        module_seg = _safe_segment(entry.get("module") or name)
        if not module_seg:
            result["conflicts"].append({
                "module": name, "from": _rel(root, src), "to": "",
                "reason": "module folder name is not usable as a path segment",
            })
            continue

        stage = _safe_segment(entry.get("stage")).upper()
        stage_reason = "stage from mapping"
        title = _title_of(src) if src_has_project else ""
        if not stage:
            stage = stage_from_title(title)
            stage_reason = "stage read from meta.title"
        if not stage and not src_has_project:
            # A resumed run: the source is already gone, so its title can no
            # longer supply the stage. Read it back off the migrated target.
            landed = _migrated_stages(root, project, module_seg)
            if len(landed) == 1:
                stage = landed[0]
                stage_reason = "stage read from the migrated target"
            elif len(landed) > 1:
                result["conflicts"].append({
                    "module": name, "from": _rel(root, src),
                    "to": "%s/%s" % (project, module_seg),
                    "reason": "several stages already exist (%s), name the one "
                              "this module belongs to in the mapping"
                              % ", ".join(landed),
                })
                continue
        if not stage:
            result["unmapped"].append({
                "module": name,
                "from": _rel(root, src),
                "stage": "",
                "title": title,
                "reason": "stage unknown: add a \"stage\" to the mapping entry",
            })
            continue
        if stage not in STAGES:
            result["conflicts"].append({
                "module": name, "from": _rel(root, src), "to": "",
                "reason": "unknown stage %r (expected one of %s)"
                          % (stage, ", ".join(STAGES)),
            })
            continue

        dst = os.path.join(root, project, module_seg, stage)
        dst_rel = _rel(root, dst)

        # Resumable: already at the target with nothing left at the source.
        if _has_project(dst) and not src_has_project:
            result["done"].append({
                "module": name, "to": dst_rel, "reason": "already migrated",
            })
            _remember_meta(result, project, module_seg, project_meta, module_meta)
            continue

        if not src_has_project:
            result["conflicts"].append({
                "module": name, "from": _rel(root, src), "to": dst_rel,
                "reason": "no %s at the source and nothing at the target"
                          % PROJECT_FILE,
            })
            continue

        # Refusal 1: the target must not exist at all.
        if os.path.exists(dst):
            result["conflicts"].append({
                "module": name, "from": _rel(root, src), "to": dst_rel,
                "reason": "target path already exists",
            })
            continue

        # Refusal 2: two modules cannot land on the same target.
        if dst_rel in seen_targets:
            result["conflicts"].append({
                "module": name, "from": _rel(root, src), "to": dst_rel,
                "reason": "target already claimed by %r" % seen_targets[dst_rel],
            })
            continue

        # Refusal 3: the report must parse. A file that cannot be read is a file
        # this tool has no business moving.
        pj = os.path.join(src, PROJECT_FILE)
        try:
            _read_json(pj)
        except Exception as ex:
            result["conflicts"].append({
                "module": name, "from": _rel(root, src), "to": dst_rel,
                "reason": "%s does not parse (%s)" % (PROJECT_FILE, ex),
            })
            continue

        seen_targets[dst_rel] = name
        result["moves"].append({
            "from": _rel(root, src),
            "to": dst_rel,
            "stage": stage,
            "reason": stage_reason,
            "project": project,
            "module": module_seg,
            "sha256": _sha256_file(pj),
        })
        _remember_meta(result, project, module_seg, project_meta, module_meta)

    return result


def _title_of(project_dir):
    """``meta.title`` of the report in ``project_dir``, or "" if unreadable."""
    try:
        data = _read_json(os.path.join(project_dir, PROJECT_FILE)) or {}
        return str((data.get("meta") or {}).get("title") or "")
    except Exception:
        return ""


def _migrated_stages(root, project, module_seg):
    """Stage folders that already hold a report under ``<root>/<project>/<module>``."""
    mod_dir = os.path.join(root, project, module_seg)
    return [s for s in STAGES if _has_project(os.path.join(mod_dir, s))]


def _remember_meta(result, project, module_seg, project_meta, module_meta):
    """Collect the project / module display names the plan will need to write."""
    pm = project_meta.get(project) if isinstance(project_meta, dict) else None
    result["projectMeta"][project] = {
        "id": project,
        "name": str((pm or {}).get("name") or project),
        "description": str((pm or {}).get("description") or ""),
    }
    mm = module_meta.get(module_seg) if isinstance(module_meta, dict) else None
    result["moduleMeta"]["%s/%s" % (project, module_seg)] = {
        "id": module_seg,
        "name": str((mm or {}).get("name") or module_seg),
        "description": str((mm or {}).get("description") or ""),
    }


# ---------------------------------------------------------------------------
# apply()
# ---------------------------------------------------------------------------


def default_snapshot_dir(root):
    """A snapshot folder that is not taken yet: ``<root>/_migrate/<stamp>``.

    The stamp only resolves to the second, and a resumed run commonly follows
    the interrupted one inside the same second. Two runs must never share a
    folder -- the second snapshot would land on top of the first one -- so an
    already-used stamp gets a ``-2``, ``-3``, ... suffix.
    """
    base = os.path.join(root, MIGRATE_DIRNAME,
                        datetime.datetime.now().strftime("%Y%m%d-%H%M%S"))
    cand, n = base, 2
    while os.path.exists(cand):
        cand = "%s-%d" % (base, n)
        n += 1
    return cand


def _snapshot(root, snapshot_dir, needed):
    """Copy the whole reports root into ``<snapshot_dir>/tree``.

    ``needed`` is the set of root-relative module folders that must survive the
    copy; if any of their ``project.json`` files did not make it, the migration
    is refused before a single file moves. Returns the list of copy warnings.
    """
    tree = os.path.join(snapshot_dir, SNAPSHOT_TREE)
    if os.path.exists(tree):
        # Refuse in this module's own terms rather than letting copytree raise
        # a bare FileExistsError; writing into someone else's snapshot would
        # also corrupt the rollback it belongs to.
        raise MigrationError(
            "a snapshot already exists at %s -- pass a different "
            "--snapshot-dir" % tree)
    os.makedirs(snapshot_dir, exist_ok=True)

    def _ignore(dirpath, names):
        # Skip only this tool's own folder, so the snapshot cannot copy itself.
        if os.path.normcase(os.path.abspath(dirpath)) == os.path.normcase(root):
            return [n for n in names if n == MIGRATE_DIRNAME]
        return []

    warnings = []
    try:
        shutil.copytree(root, tree, ignore=_ignore, symlinks=True,
                        ignore_dangling_symlinks=True)
    except shutil.Error as ex:
        # copytree keeps going and reports every failure at the end.
        for item in (ex.args[0] if ex.args else []):
            warnings.append("snapshot could not copy: %s" % (item,))

    for rel in sorted(needed):
        if not os.path.isfile(os.path.join(tree, rel.replace("/", os.sep),
                                           PROJECT_FILE)):
            raise MigrationError(
                "snapshot is incomplete (%s/%s missing) -- refusing to move. "
                "Snapshot left at %s" % (rel, PROJECT_FILE, snapshot_dir))
    return warnings


def apply(root, plan, snapshot_dir=None):
    """Perform the moves in ``plan`` after taking a full snapshot of the root.

    Refuses when the plan carries conflicts. Writes ``project_meta.json`` at the
    project and module level (never overwriting one that already exists), and
    verifies every moved ``project.json`` against the hash taken before the move.

    Returns ``{"moved": n, "snapshot": <path or None>, "warnings": [...],
    "manifest": <path or None>}``.
    """
    root = os.path.abspath(root)
    if not isinstance(plan, dict):
        raise MigrationError("plan must be the dict returned by plan()")

    conflicts = plan.get("conflicts") or []
    if conflicts:
        lines = ["%s -> %s : %s" % (c.get("from") or c.get("module"),
                                    c.get("to") or "?", c.get("reason"))
                 for c in conflicts]
        raise MigrationError(
            "refusing to move, %d conflict(s):\n  %s"
            % (len(conflicts), "\n  ".join(lines)))

    moves = plan.get("moves") or []
    if not moves:
        return {"moved": 0, "snapshot": None, "manifest": None, "warnings": []}

    # Re-check the refusals against the live disk: the plan may be minutes old.
    for mv in moves:
        src = os.path.join(root, mv["from"].replace("/", os.sep))
        dst = os.path.join(root, mv["to"].replace("/", os.sep))
        if not _has_project(src):
            raise MigrationError("source vanished since the plan: %s" % mv["from"])
        if os.path.exists(dst):
            raise MigrationError("target appeared since the plan: %s" % mv["to"])

    snapshot_dir = os.path.abspath(snapshot_dir or default_snapshot_dir(root))
    warnings = _snapshot(root, snapshot_dir, set(mv["from"] for mv in moves))

    manifest_path = os.path.join(snapshot_dir, MANIFEST_FILE)
    manifest = {
        "version": 1,
        "root": root,
        "created": datetime.datetime.now().isoformat(timespec="seconds"),
        "snapshotTree": os.path.join(snapshot_dir, SNAPSHOT_TREE),
        "moves": [],            # appended as each one completes
        "createdDirs": [],      # shallowest first; rollback removes in reverse
        "createdMeta": [],
        "warnings": warnings,
    }
    _write_json(manifest_path, manifest)

    moved = 0
    for mv in moves:
        src = os.path.join(root, mv["from"].replace("/", os.sep))
        dst = os.path.join(root, mv["to"].replace("/", os.sep))

        parent = os.path.dirname(dst)
        for made in _makedirs_tracked(root, parent):
            manifest["createdDirs"].append(_rel(root, made))

        shutil.move(src, dst)
        moved += 1

        after = _sha256_file(os.path.join(dst, PROJECT_FILE))
        manifest["moves"].append(dict(mv, sha256After=after))
        _write_json(manifest_path, manifest)
        if after != mv["sha256"]:
            raise MigrationError(
                "%s changed during the move of %s (%s -> %s). Roll back with:\n"
                "  %s" % (PROJECT_FILE, mv["from"], mv["sha256"], after,
                          rollback_command(snapshot_dir)))

        # Display names for the two new levels, only where none exists yet.
        pmeta = (plan.get("projectMeta") or {}).get(mv["project"])
        mmeta = (plan.get("moduleMeta") or {}).get(
            "%s/%s" % (mv["project"], mv["module"]))
        for path, data in (
            (os.path.join(root, mv["project"], PROJECT_META_FILE), pmeta),
            (os.path.join(root, mv["project"], mv["module"], PROJECT_META_FILE),
             mmeta),
        ):
            if data and not os.path.exists(path):
                _write_json(path, data)
                manifest["createdMeta"].append(_rel(root, path))

        _write_json(manifest_path, manifest)

    return {"moved": moved, "snapshot": snapshot_dir,
            "manifest": manifest_path, "warnings": warnings}


def _makedirs_tracked(root, path):
    """Create ``path`` and return the directories that did not exist before.

    Shallowest first, so rollback can remove them in reverse order.
    """
    made = []
    missing = []
    cur = os.path.abspath(path)
    root = os.path.abspath(root)
    while True:
        if os.path.isdir(cur) or os.path.normcase(cur) == os.path.normcase(root):
            break
        missing.append(cur)
        parent = os.path.dirname(cur)
        if parent == cur:
            break
        cur = parent
    for d in reversed(missing):
        os.mkdir(d)
        made.append(d)
    return made


# ---------------------------------------------------------------------------
# rollback()
# ---------------------------------------------------------------------------


def _manifest_path_for(snapshot):
    """The manifest file inside ``snapshot``, which may be the file itself."""
    snapshot = os.path.abspath(snapshot)
    manifest_path = snapshot
    if os.path.isdir(snapshot):
        manifest_path = os.path.join(snapshot, MANIFEST_FILE)
    if not os.path.isfile(manifest_path):
        raise MigrationError("no %s at %s" % (MANIFEST_FILE, snapshot))
    return manifest_path


def snapshot_sits_under(manifest_path):
    """The reports root a snapshot is SITTING IN, or "" if it is not in one.

    ``apply()`` writes its snapshot to ``<root>/_migrate/<stamp>``, so the root
    is two levels above the manifest. Copy that folder somewhere else to
    rehearse a rollback and the relation no longer holds -- which is exactly the
    case worth naming out loud, because the manifest still points at the live
    root the snapshot was taken from.
    """
    stamp_dir = os.path.dirname(os.path.abspath(manifest_path))
    migrate_dir = os.path.dirname(stamp_dir)
    if os.path.basename(migrate_dir) != MIGRATE_DIRNAME:
        return ""
    return os.path.dirname(migrate_dir)


def resolve_rollback_root(snapshot, root=None):
    """Work out which reports root a rollback would act on, touching nothing.

    An explicit ``root`` wins; otherwise the absolute path recorded in the
    manifest when the migration ran. Separate from ``rollback()`` so a caller
    can print the answer -- and where it came from -- before the first directory
    moves.

    Returns ``(manifest_path, manifest, root, source)``, ``source`` being the
    human-readable origin of the root (``"--root"`` or the manifest file name).
    """
    manifest_path = _manifest_path_for(snapshot)
    manifest = _read_json(manifest_path)
    if root:
        return manifest_path, manifest, os.path.abspath(root), "--root"
    named = str(manifest.get("root") or "")
    if not named:
        # abspath("") is the CURRENT directory, which would send the rollback
        # somewhere nobody asked for. Make the caller name a root instead.
        raise MigrationError(
            "%s names no reports root -- pass --root to say which one to roll "
            "back" % manifest_path)
    return manifest_path, manifest, os.path.abspath(named), MANIFEST_FILE


def foreign_snapshot_note(manifest_path, root, root_source):
    """Warning text when the snapshot is not sitting in the root being used.

    One string, so the CLI can print it before anything moves and then skip the
    identical entry in the warning list rather than saying it twice.
    """
    sits = snapshot_sits_under(manifest_path)
    if not sits or os.path.normcase(sits) == os.path.normcase(root):
        return ""
    return ("this snapshot sits under %s but the rollback is acting on %s "
            "(root from %s) -- re-run with --root \"%s\" to act on the folder "
            "the snapshot is in" % (sits, root, root_source, sits))


def rollback(snapshot, root=None):
    """Undo a migration recorded in ``snapshot`` (a snapshot dir or a manifest).

    Each move is reversed by moving the directory back where it came from, so
    edits made after the migration travel back with it. Only when the target is
    gone does the snapshot copy get restored. The ``project_meta.json`` files and
    the directories this tool created are removed -- except that a directory
    holding anything the migration did not create is left standing, with its
    path and its contents reported in ``left`` so the caller can say so.

    ``root`` overrides the reports root named in the manifest; without it the
    manifest's own absolute path is used. Pass it to roll back a COPY of a
    snapshot, whose manifest still names the live root it was taken from.

    Returns ``{"restored": n, "warnings": [...], "left": [{"path","entries"}],
    "root": <path>, "rootSource": <str>, "manifest": <path>}``.
    """
    manifest_path, manifest, root, root_source = resolve_rollback_root(
        snapshot, root)
    if not os.path.isdir(root):
        raise MigrationError("the reports root named by %s is gone: %s"
                             % (root_source, root))

    # Prefer the copy sitting beside THIS manifest over the absolute path the
    # manifest recorded: for a snapshot that never moved they are the same
    # folder, and for one that was copied only the former belongs to this run.
    beside = os.path.join(os.path.dirname(manifest_path), SNAPSHOT_TREE)
    tree = beside if os.path.isdir(beside) else (
        manifest.get("snapshotTree") or beside)

    warnings = []
    restored = 0

    note = foreign_snapshot_note(manifest_path, root, root_source)
    if note:
        warnings.append(note)

    for mv in reversed(manifest.get("moves") or []):
        src = os.path.join(root, mv["from"].replace("/", os.sep))   # where it was
        dst = os.path.join(root, mv["to"].replace("/", os.sep))     # where it went
        if os.path.exists(src):
            warnings.append("%s is occupied again, left %s in place"
                            % (mv["from"], mv["to"]))
            continue
        if os.path.isdir(dst):
            parent = os.path.dirname(src)
            if parent:
                os.makedirs(parent, exist_ok=True)
            shutil.move(dst, src)
            restored += 1
            continue
        keep = os.path.join(tree, mv["from"].replace("/", os.sep))
        if os.path.isdir(keep):
            shutil.copytree(keep, src, symlinks=True)
            restored += 1
            warnings.append("%s was gone, restored from the snapshot copy"
                            % mv["to"])
        else:
            warnings.append("%s is gone and is not in the snapshot" % mv["to"])

    for rel in manifest.get("createdMeta") or []:
        path = os.path.join(root, rel.replace("/", os.sep))
        try:
            if os.path.isfile(path):
                os.remove(path)
        except OSError as ex:
            warnings.append("could not remove %s (%s)" % (rel, ex))

    # Deepest first, so a directory emptied by removing its children can still
    # go. Whatever is still standing afterwards is reported rather than dropped:
    # a stage created after the migration (a new FDR beside the migrated CDR)
    # lives inside a directory this tool made, and rmdir simply skips it.
    left = []
    for rel in reversed(manifest.get("createdDirs") or []):
        path = os.path.join(root, rel.replace("/", os.sep))
        if not os.path.isdir(path):
            continue
        try:
            entries = sorted(os.listdir(path))
        except OSError as ex:
            warnings.append("could not read %s (%s)" % (rel, ex))
            continue
        if entries:
            left.append({"path": rel, "entries": entries})
            continue
        try:
            os.rmdir(path)
        except OSError as ex:
            warnings.append("could not remove %s (%s)" % (rel, ex))

    left.sort(key=lambda item: item["path"])
    return {"restored": restored, "warnings": warnings, "left": left,
            "root": root, "rootSource": root_source,
            "manifest": manifest_path}


# ---------------------------------------------------------------------------
# CLI.
# ---------------------------------------------------------------------------


def rollback_command(snapshot_dir):
    return 'python builder/store/migrate_layout.py --rollback "%s"' % snapshot_dir


def format_left(left):
    """Lines naming every directory a rollback left standing, and what is in it.

    Without these the run prints only "restored N directory(ies)", which is true
    but not the whole truth: the flat layout is back AND a partly populated tree
    is still standing beside it.
    """
    if not left:
        return []
    out = ["",
           "LEFT IN PLACE (%d) -- created by the migration, not empty now"
           % len(left)]
    for item in left:
        entries = item.get("entries") or []
        shown = ", ".join(entries[:6])
        if len(entries) > 6:
            shown = "%s, ... (%d more)" % (shown, len(entries) - 6)
        out.append("  %-40s holds: %s" % (item["path"], shown))
    out.append("  Nothing was moved or deleted here: these hold work the "
               "migration did not create, so the rollback did not touch them.")
    return out


def format_plan(result):
    """The full plan, as lines, for a human to read before anything moves."""
    out = []
    out.append("reports root: %s" % result.get("root", ""))
    out.append("")

    moves = result.get("moves") or []
    out.append("MOVES (%d)" % len(moves))
    if not moves:
        out.append("  (nothing to move)")
    for mv in moves:
        out.append("  %-28s -> %-40s  [%s, %s]"
                   % (mv["from"], mv["to"], mv["stage"], mv["reason"]))

    done = result.get("done") or []
    if done:
        out.append("")
        out.append("ALREADY DONE (%d)" % len(done))
        for d in done:
            out.append("  %-28s at %s" % (d["module"], d["to"]))

    unmapped = result.get("unmapped") or []
    if unmapped:
        out.append("")
        out.append("UNMAPPED (%d) -- left where they are" % len(unmapped))
        for u in unmapped:
            out.append("  %-28s stage=%-4s %s"
                       % (u["module"], u.get("stage") or "?", u["reason"]))

    conflicts = result.get("conflicts") or []
    if conflicts:
        out.append("")
        out.append("CONFLICTS (%d) -- these block the whole run" % len(conflicts))
        for c in conflicts:
            out.append("  %-28s -> %-30s %s"
                       % (c.get("from") or c.get("module"),
                          c.get("to") or "?", c["reason"]))

    meta = result.get("projectMeta") or {}
    if moves and meta:
        out.append("")
        out.append("NEW %s FILES" % PROJECT_META_FILE)
        for pid in sorted(meta):
            out.append("  %s/%s" % (pid, PROJECT_META_FILE))
        for key in sorted(result.get("moduleMeta") or {}):
            out.append("  %s/%s" % (key, PROJECT_META_FILE))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Move a flat reports root to PROJECT/MODULE/STAGE.")
    ap.add_argument("--root", default=None,
                    help="reports root (default: $BUILDER_REPORTS_ROOT or "
                         "./local; with --rollback, the root named in the "
                         "snapshot manifest)")
    ap.add_argument("--map", dest="map_file", default=None,
                    help="JSON mapping: {module: {project, stage}}")
    ap.add_argument("--dry-run", action="store_true", default=True,
                    help="print the plan and change nothing (the default)")
    ap.add_argument("--apply", action="store_true",
                    help="actually move, after taking a snapshot")
    ap.add_argument("--rollback", metavar="SNAPSHOT", default=None,
                    help="undo a migration from its snapshot folder "
                         "(add --root to act on a copy of that folder)")
    ap.add_argument("--snapshot-dir", default=None,
                    help="snapshot location (default: <root>/_migrate/<stamp>)")
    ap.add_argument("--json", action="store_true",
                    help="print the plan as JSON instead of text")
    args = ap.parse_args(argv)

    if args.rollback:
        # Resolve and announce the root BEFORE anything moves: rolling a copied
        # snapshot back against the live root it was taken from is silent
        # otherwise, and by then it has already happened.
        try:
            mpath, manifest, rb_root, source = resolve_rollback_root(
                args.rollback, args.root)
        except MigrationError as ex:
            print("error: %s" % ex, file=sys.stderr)
            return 2
        print("reports root: %s  (from %s)" % (rb_root, source))
        named = os.path.abspath(manifest.get("root") or "")
        if (source == "--root" and named
                and os.path.normcase(named) != os.path.normcase(rb_root)):
            print("  the manifest names %s -- --root wins" % named)
        note = foreign_snapshot_note(mpath, rb_root, source)
        if note:
            print("warn: %s" % note)

        try:
            res = rollback(args.rollback, root=args.root)
        except MigrationError as ex:
            print("error: %s" % ex, file=sys.stderr)
            return 2
        for w in res["warnings"]:
            if w == note:
                continue            # already said, before anything moved
            print("warn: %s" % w)
        print("restored %d directory(ies) under %s"
              % (res["restored"], res["root"]))
        for line in format_left(res["left"]):
            print(line)
        return 0

    root = resolve_root(args.root)
    if not args.map_file:
        print("error: --map is required (a JSON file mapping each module folder "
              "to its project and stage)", file=sys.stderr)
        return 2
    try:
        mapping = _read_json(args.map_file)
    except Exception as ex:
        print("error: cannot read mapping %s (%s)" % (args.map_file, ex),
              file=sys.stderr)
        return 2

    try:
        result = plan(root, mapping)
    except MigrationError as ex:
        print("error: %s" % ex, file=sys.stderr)
        return 2

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        for line in format_plan(result):
            print(line)

    if not args.apply:
        print("")
        print("dry run -- nothing was moved. To migrate, add --apply:")
        print('  python builder/store/migrate_layout.py --root "%s" '
              '--map "%s" --apply' % (root, args.map_file))
        return 1 if result["conflicts"] else 0

    try:
        res = apply(root, result, args.snapshot_dir)
    except MigrationError as ex:
        print("")
        print("error: %s" % ex, file=sys.stderr)
        return 2

    print("")
    for w in res["warnings"]:
        print("warn: %s" % w)
    print("moved %d report(s)" % res["moved"])
    if res["snapshot"]:
        print("snapshot: %s" % res["snapshot"])
        print("To undo, run:")
        print("  %s" % rollback_command(res["snapshot"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
