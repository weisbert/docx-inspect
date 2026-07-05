#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Apply / roll back report update bundles -- safely, with one command.

A small standard-library CLI for moving structured-document updates between
machines without losing local edits. It operates on a "reports root" (the folder
that holds the per-report ``<name>/project.json`` directories plus a
``templates/`` library). By default the reports root is ``./local`` next to this
script; override with ``--root`` or the ``BUILDER_REPORTS_ROOT`` env var.

Usage (run with the project's venv python, from the repo root):

  python apply_update.py [bundle.zip] [--root DIR] [--dry-run] [--yes]
      Apply an update bundle. With NO path, picks the newest *.zip in
      ``<root>/_updates/`` (drop a bundle there and run with no path). Every file
      it would overwrite is copied to ``<root>/_backups/<timestamp>/`` first, so
      an apply is always reversible.

  python apply_update.py --snapshot [--root DIR]
      Package the current ``project.json`` files into
      ``<root>/_outbox/to_send_<ts>.zip`` (images are NOT included -- they stay on
      disk, referenced by path) to hand back for the next round-trip.

  python apply_update.py --rollback [--root DIR] [--yes]
      Restore the most recent backup (undo the last apply).

  python apply_update.py --list [--root DIR]
      Show available backups and the managed file set.

Bundle formats (auto-detected):
  * plain zip -- every member is written under the reports root (full replace).
  * smart zip -- contains an ``update.json`` manifest:
        {"projects": {"<dir>": {"mode": "replace"}|{"mode":"patch","ops":[...]}},
         "files": ["templates/.../config.json", ...], "note": "..."}
    'patch' mode merges ops into the LOCAL ``project.json`` by section id, leaving
    every other section (prose + image references) untouched -- so a single
    section can be updated without a full round-trip and without losing edits.

Safety: never deletes an ``images/`` folder; only touches files it is told to;
backs up before writing; warns if a target changed locally since the last apply.
"""
import argparse
import datetime
import hashlib
import json
import os
import shutil
import sys
import zipfile

SELF = os.path.dirname(os.path.abspath(__file__))
RESERVED = {"_backups", "_updates", "_outbox", "__pycache__"}


# ---------------------------------------------------------------------------
# Reports-root resolution + path helpers.
# ---------------------------------------------------------------------------


def resolve_root(arg):
    if arg:
        return os.path.abspath(arg)
    env = os.environ.get("BUILDER_REPORTS_ROOT")
    if env:
        return os.path.abspath(env)
    cand = os.path.join(SELF, "local")
    return cand if os.path.isdir(cand) else SELF


def _backups(root):
    return os.path.join(root, "_backups")


def _updates(root):
    return os.path.join(root, "_updates")


def _outbox(root):
    return os.path.join(root, "_outbox")


def _state_path(root):
    return os.path.join(root, ".update_state.json")


def _ts():
    return datetime.datetime.now().strftime("%Y%m%d-%H%M%S")


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _read(path):
    with open(path, "rb") as fh:
        return fh.read()


def _atomic_write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "wb") as fh:
        fh.write(data)
    os.replace(tmp, path)


def _safe_rel(name):
    """Return a root-relative path for a zip member, or None if unsafe."""
    n = name.replace("\\", "/").strip()
    if not n or n.endswith("/"):
        return None
    if os.path.isabs(n) or ".." in n.split("/") or ":" in n:
        return None
    parts = n.split("/")
    if parts[0] in RESERVED:
        return None
    return os.path.normpath(os.path.join(*parts))


def _load_state(root):
    try:
        with open(_state_path(root), encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return {}


def _save_state(root, st):
    _atomic_write(_state_path(root),
                  json.dumps(st, ensure_ascii=False, indent=2).encode("utf-8"))


# A backup dir that only CREATED files (no pre-image to restore) still needs to
# exist so rollback_last targets THAT op, not an older one; this marker inside it
# lists the created rel paths so rollback deletes them instead of silently
# reverting an unrelated earlier change.
_CREATED_MARK = ".op_created"


def _write_created(bdir, created):
    if created:
        os.makedirs(bdir, exist_ok=True)
        _atomic_write(os.path.join(bdir, _CREATED_MARK),
                      "\n".join(created).encode("utf-8"))


def _new_backup_dir(root):
    """A fresh, UNIQUE backup dir. _ts() is 1-second granular, so two ops in the
    same second would otherwise share a dir and rollback would undo BOTH; a numeric
    suffix guarantees one op per dir so rollback_last undoes exactly one op."""
    base = os.path.join(_backups(root), _ts())
    d, n = base, 1
    while True:
        try:
            os.makedirs(d)          # exist_ok=False -> collision-safe
            return d
        except FileExistsError:
            d = "%s-%d" % (base, n)
            n += 1


# ---------------------------------------------------------------------------
# project.json section patching (by node id, title fallback).
# ---------------------------------------------------------------------------


def _find_node(nodes, node_id=None, title=None):
    for n in nodes:
        if node_id and n.get("id") == node_id:
            return n
        if title and not node_id and n.get("title") == title:
            return n
        hit = _find_node(n.get("children", []), node_id, title)
        if hit:
            return hit
    return None


def _count_title_matches(nodes, title):
    """How many sections carry ``title`` (recursively). Used to warn when a
    title-addressed op is ambiguous -- it patches only the FIRST match."""
    if not title:
        return 0
    total = 0
    for n in nodes:
        if n.get("title") == title:
            total += 1
        total += _count_title_matches(n.get("children", []), title)
    return total


def _apply_ops(project, ops):
    log = []
    for op in ops or []:
        kind = op.get("op")
        node = _find_node(project.get("outline", []),
                          op.get("node_id"), op.get("title"))
        if node is None:
            log.append("  ! op %s: node not found (%s/%s) -- skipped"
                       % (kind, op.get("node_id"), op.get("title")))
            continue
        # Ambiguity guard: a title-addressed op with several same-titled sections
        # silently hit the first one before. Warn so the bundle author can switch
        # to node_id (or rename) instead of guessing.
        if not op.get("node_id") and op.get("title"):
            m = _count_title_matches(project.get("outline", []), op["title"])
            if m > 1:
                log.append("  ! op %s: title '%s' matches %d sections -- patched the FIRST"
                           % (kind, op["title"], m))
        if kind == "set_blocks":
            node["blocks"] = op.get("blocks", [])
            log.append("  ~ set blocks of '%s'" % node.get("title", ""))
        elif kind == "set_title":
            node["title"] = op.get("value", node.get("title"))
            log.append("  ~ set title -> '%s'" % node["title"])
        elif kind == "set_children":
            # Replace the matched node's child sub-tree wholesale. Each entry is a
            # full node dict (id/title/blocks/children/...). Lets a bundle add or
            # restructure sub-sections, which set_blocks/set_title cannot.
            node["children"] = op.get("children", [])
            log.append("  ~ set %d child section(s) of '%s'"
                       % (len(node["children"]), node.get("title", "")))
        else:
            log.append("  ! unknown op '%s' -- skipped" % kind)
    return log


# ---------------------------------------------------------------------------
# Apply.
# ---------------------------------------------------------------------------


def _pick_bundle(root, arg):
    if arg:
        return os.path.abspath(arg)
    up = _updates(root)
    if os.path.isdir(up):
        zips = [os.path.join(up, f) for f in os.listdir(up)
                if f.lower().endswith(".zip")]
        if zips:
            return max(zips, key=os.path.getmtime)
    return None


def read_bundle(root, bundle_path):
    """Return (manifest_or_None, actions). Each action is (kind, rel, payload):
    kind in {replace, patch}; payload is bytes for replace, an ops list for patch."""
    zf = zipfile.ZipFile(bundle_path)
    names = zf.namelist()
    manifest = None
    if "update.json" in names:
        manifest = json.loads(zf.read("update.json").decode("utf-8"))
    actions = []
    if manifest:
        for rel in manifest.get("files", []):
            r = _safe_rel(rel)
            if r and rel in names:
                actions.append(("replace", r, zf.read(rel)))
        for pdir, spec in (manifest.get("projects") or {}).items():
            r = _safe_rel(pdir + "/project.json")
            if not r:
                continue
            if spec.get("mode") == "patch":
                actions.append(("patch", r, spec.get("ops", [])))
            else:
                member = pdir + "/project.json"
                if member in names:
                    actions.append(("replace", r, zf.read(member)))
    else:
        for name in names:
            if name == "update.json":
                continue
            r = _safe_rel(name)
            if r:
                actions.append(("replace", r, zf.read(name)))
    return manifest, actions


def plan_actions(root, actions):
    """Annotate each action with target/exists/verb/warn. Returns (plan, state)."""
    state = _load_state(root)
    plan = []
    for kind, rel, payload in actions:
        tgt = os.path.join(root, rel)
        exists = os.path.isfile(tgt)
        warn = False
        if kind == "replace" and exists:
            cur = _sha(_read(tgt))
            if state.get(rel) and state[rel] != cur and _sha(payload) != cur:
                warn = True
        verb = {"replace": "replace" if exists else "create", "patch": "patch"}[kind]
        plan.append({"kind": kind, "rel": rel, "tgt": tgt, "payload": payload,
                     "exists": exists, "verb": verb, "warn": warn})
    return plan, state


def run_plan(root, plan, state, on_log=None):
    """Back up + write every planned action. Returns (backup_dir, log_lines).

    Each item is isolated in try/except so one malformed target does not abort
    the rest of the bundle, and the applied-state is saved AFTER EACH item so a
    mid-bundle failure leaves ``.update_state.json`` consistent with what was
    actually written (never half a step behind). A failed item is annotated with
    ``it["error"]`` and logged so the summary can report a partial apply."""
    bdir = _new_backup_dir(root)   # unique per op so rollback undoes exactly one op
    logs = []
    created = []
    for it in plan:
        try:
            if it["exists"]:
                dst = os.path.join(bdir, it["rel"])
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.copy2(it["tgt"], dst)
            else:
                created.append(it["rel"].replace("\\", "/"))
            if it["kind"] == "replace":
                _atomic_write(it["tgt"], it["payload"])
                state[it["rel"]] = _sha(it["payload"])
            else:
                base = _read(it["tgt"]) if it["exists"] else b"{}"
                proj = json.loads(base.decode("utf-8"))
                for line in _apply_ops(proj, it["payload"]):
                    logs.append(line)
                    if on_log:
                        on_log(line)
                out = json.dumps(proj, ensure_ascii=False, indent=2).encode("utf-8")
                _atomic_write(it["tgt"], out)
                state[it["rel"]] = _sha(out)
            _save_state(root, state)   # persist after each item (partial-safe)
        except Exception as ex:
            it["error"] = str(ex)
            msg = "  ! %s %s FAILED: %s: %s" % (
                it["verb"], it["rel"], type(ex).__name__, ex)
            logs.append(msg)
            if on_log:
                on_log(msg)
    _write_created(bdir, created)
    return bdir, logs


def record_replace(root, rel, new_bytes, backup=True):
    """Back up root/rel (if present) into a fresh _backups/<ts>/ dir, write
    new_bytes atomically, and update the applied-state sha.

    Shared by the GUI paste-import so a full-file replace lands in the SAME
    rollback history as apply_bundle (``apply_update.py --rollback`` restores it
    too). ``rel`` is a root-relative path (OS separators). Returns
    {"backup": <bdir or "">, "existed": bool, "rel": rel}."""
    tgt = os.path.join(root, rel)
    existed = os.path.isfile(tgt)
    # ALWAYS create the per-op backup dir so rollback_last targets THIS op. For a
    # created file there is no pre-image; a .op_created marker records it so rollback
    # deletes it rather than reverting an older, unrelated op.
    bdir = _new_backup_dir(root)
    if backup and existed:
        dst = os.path.join(bdir, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(tgt, dst)
    elif not existed:
        _write_created(bdir, [rel.replace("\\", "/")])
    _atomic_write(tgt, new_bytes)
    st = _load_state(root)
    st[rel] = _sha(new_bytes)
    _save_state(root, st)
    return {"backup": bdir, "existed": existed, "rel": rel}


_REFRESH_NOTE = ("Applied. In the GUI: make sure the report isn't open with "
                 "unsaved edits, then hard-refresh (Ctrl+Shift+R) and reopen it.")


def apply_bundle(root, bundle_path, dry=False, on_log=None):
    """Programmatic entry (used by the GUI server). Returns a JSON-able summary
    with per-item ``error`` fields + a ``failed`` list (partial applies) and a
    ``refresh`` hint the GUI shows so a stale open tab doesn't autosave the
    pre-patch state back over what was just applied."""
    manifest, actions = read_bundle(root, bundle_path)
    plan, state = plan_actions(root, actions)
    note = (manifest or {}).get("note", "")
    if not plan or dry:
        return {"note": note,
                "actions": [{"verb": p["verb"], "rel": p["rel"].replace("\\", "/"),
                             "warn": p["warn"]} for p in plan],
                "backup": "", "logs": [], "failed": [], "refresh": _REFRESH_NOTE}
    bdir, logs = run_plan(root, plan, state, on_log)
    acts, failed = [], []
    for p in plan:
        a = {"verb": p["verb"], "rel": p["rel"].replace("\\", "/"), "warn": p["warn"]}
        if p.get("error"):
            a["error"] = p["error"]
            failed.append({"rel": a["rel"], "error": p["error"]})
        acts.append(a)
    return {"note": note, "actions": acts, "backup": bdir, "logs": logs,
            "failed": failed, "refresh": _REFRESH_NOTE}


def cmd_apply(root, arg, dry, yes):
    bundle = _pick_bundle(root, arg)
    if not bundle or not os.path.isfile(bundle):
        print("error: no bundle. Pass a path, or drop a .zip in %s" % _updates(root))
        return 2
    print("root:   %s" % root)
    print("bundle: %s" % bundle)
    manifest, actions = read_bundle(root, bundle)
    if manifest and manifest.get("note"):
        print("note:   %s" % manifest["note"])
    plan, state = plan_actions(root, actions)
    if not plan:
        print("nothing to apply (empty / unrecognized bundle).")
        return 1
    for p in plan:
        tail = "  <-- changed locally since last apply (will be backed up)" if p["warn"] else ""
        print("  %-8s %s%s" % (p["verb"], p["rel"], tail))
    if dry:
        print("\n[dry-run] nothing written.")
        return 0
    if not yes:
        ans = input("\nApply these %d change(s)? [y/N] " % len(plan)).strip().lower()
        if ans not in ("y", "yes"):
            print("aborted.")
            return 1
    bdir, logs = run_plan(root, plan, state)
    for line in logs:
        print(line)
    print("\nOK. Backed up to: %s" % bdir)
    print("Now in the GUI: make sure the report isn't open-with-unsaved-edits,")
    print("then hard-refresh (Ctrl+Shift+R) and reopen it.")
    return 0


# ---------------------------------------------------------------------------
# Snapshot / rollback / list.
# ---------------------------------------------------------------------------


def cmd_snapshot(root):
    proj_dirs = []
    for name in sorted(os.listdir(root)):
        if name in RESERVED or name == "templates":
            continue
        if os.path.isfile(os.path.join(root, name, "project.json")):
            proj_dirs.append(name)
    if not proj_dirs:
        print("no project.json found under %s" % root)
        return 1
    os.makedirs(_outbox(root), exist_ok=True)
    out = os.path.join(_outbox(root), "to_send_%s.zip" % _ts())
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for d in proj_dirs:
            z.write(os.path.join(root, d, "project.json"), d + "/project.json")
    print("packaged %d project.json (images excluded):" % len(proj_dirs))
    for d in proj_dirs:
        print("  -", d)
    print("-> %s" % out)
    return 0


def _latest_backup(root):
    b = _backups(root)
    if not os.path.isdir(b):
        return None
    subs = [os.path.join(b, d) for d in os.listdir(b)
            if os.path.isdir(os.path.join(b, d))]
    return max(subs, key=os.path.getmtime) if subs else None


def rollback_last(root):
    """Programmatic rollback of the most recent backup (used by the GUI's
    'Undo last apply' button -- no input() prompt). The current state is snapshot
    to a ``-pre-rollback`` backup first. Returns a JSON-able summary:
    {ok, restored:[rel...], from, pre} or {ok:False, error}."""
    bdir = _latest_backup(root)
    if not bdir:
        return {"ok": False, "error": "no backups to roll back to"}
    # created files (undo = delete them), read from the marker and excluded from the
    # restore walk.
    created = []
    cmark = os.path.join(bdir, _CREATED_MARK)
    if os.path.isfile(cmark):
        created = [ln for ln in _read(cmark).decode("utf-8").splitlines() if ln.strip()]
    files = [(os.path.join(dp, f), os.path.relpath(os.path.join(dp, f), bdir))
             for dp, _dn, fn in os.walk(bdir) for f in fn if f != _CREATED_MARK]
    pre = os.path.join(_backups(root), _ts() + "-pre-rollback")
    restored, deleted = [], []
    for full, rel in files:
        tgt = os.path.join(root, rel)
        if os.path.isfile(tgt):
            dst = os.path.join(pre, rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(tgt, dst)
        _atomic_write(tgt, _read(full))
        restored.append(rel.replace("\\", "/"))
    for rel in created:   # undo a creation = remove the file (snapshot it first)
        tgt = os.path.join(root, *rel.split("/"))
        if os.path.isfile(tgt):
            dst = os.path.join(pre, *rel.split("/"))
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(tgt, dst)
            os.remove(tgt)
            deleted.append(rel)
    return {"ok": True, "restored": restored, "deleted": deleted,
            "from": bdir.replace("\\", "/"), "pre": pre.replace("\\", "/")}


def cmd_rollback(root, yes):
    bdir = _latest_backup(root)
    if not bdir:
        print("no backups to roll back to.")
        return 1
    files = [os.path.relpath(os.path.join(dp, f), bdir)
             for dp, _dn, fn in os.walk(bdir) for f in fn]
    print("restore from: %s" % bdir)
    for rel in files:
        print("  restore", rel)
    if not yes:
        ans = input("\nRestore these %d file(s)? [y/N] " % len(files)).strip().lower()
        if ans not in ("y", "yes"):
            print("aborted.")
            return 1
    res = rollback_last(root)
    if not res.get("ok"):
        print("error:", res.get("error"))
        return 1
    print("\nOK. Restored. (Current state saved to %s first.)" % res["pre"])
    return 0


def cmd_list(root):
    print("root: %s" % root)
    b = _backups(root)
    if os.path.isdir(b):
        subs = sorted(os.listdir(b))
        print("backups (%d):" % len(subs))
        for s in subs[-10:]:
            print("  ", s)
    else:
        print("backups: none")
    st = _load_state(root)
    if st:
        print("last-applied files (%d):" % len(st))
        for k in sorted(st):
            print("  ", k)
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="Apply report update bundles.")
    ap.add_argument("bundle", nargs="?", help="bundle .zip (default: newest in <root>/_updates/)")
    ap.add_argument("--root", help="reports root (default: ./local next to this script)")
    ap.add_argument("--dry-run", action="store_true", help="preview, write nothing")
    ap.add_argument("--yes", action="store_true", help="skip confirmation")
    ap.add_argument("--snapshot", action="store_true", help="package current project.json to hand back")
    ap.add_argument("--rollback", action="store_true", help="restore the most recent backup")
    ap.add_argument("--list", action="store_true", help="list backups / applied files")
    a = ap.parse_args(argv)
    root = resolve_root(a.root)
    if a.snapshot:
        return cmd_snapshot(root)
    if a.rollback:
        return cmd_rollback(root, a.yes)
    if a.list:
        return cmd_list(root)
    return cmd_apply(root, a.bundle, a.dry_run, a.yes)


if __name__ == "__main__":
    sys.exit(main())
