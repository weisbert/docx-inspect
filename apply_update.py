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


def _canon(obj):
    """Deterministic JSON bytes (sorted keys, no whitespace) for stable hashing,
    so a baseline fingerprint matches across machines regardless of key order."""
    return json.dumps(obj, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":")).encode("utf-8")


def _baseline_path(root, rel):
    """Sibling of a project.json: ``<project dir>/_baseline.json``. Records the
    last fully-synced project state so the GUI's "Copy diff" can emit only what
    changed since the assistant and the work machine were last in agreement."""
    return os.path.join(os.path.dirname(os.path.join(root, rel)), "_baseline.json")


def _stamp_baseline(root, rel, project_bytes):
    """Refresh _baseline.json after a sync event (apply bundle / paste-import /
    text-diff apply / rollback). No-op for non-project.json targets. Best-effort:
    the baseline is an optimization, never worth failing an apply over."""
    if os.path.basename(rel.replace("\\", "/")) != "project.json":
        return
    try:
        _atomic_write(_baseline_path(root, rel), project_bytes)
    except OSError:
        pass


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
        elif kind == "patch_node":
            # Replace the node's OWN fields (title/blocks/fixed_body/...) wholesale
            # but never its children -- structure travels via set_children /
            # set_outline. Emitted by the upstream text-diff (Copy diff) so an
            # edited section carries only its own content; symmetric with
            # set_blocks+set_title but covers any node key in one op.
            fields = op.get("fields") or {}
            for k, v in fields.items():
                if k != "children":
                    node[k] = v
            for k in op.get("remove_fields") or []:
                if k not in ("children", "id"):
                    node.pop(k, None)
            log.append("  ~ patch node '%s' (%s)"
                       % (node.get("title", ""),
                          ", ".join(sorted(fields)) or "no-op"))
        else:
            log.append("  ! unknown op '%s' -- skipped" % kind)
    return log


# ---------------------------------------------------------------------------
# Upstream text-diff (GUI "Copy diff"): baseline project.json -> current, as a
# compact op list the assistant applies. Only CHANGED sections travel (their own
# fields wholesale); unchanged prose / images / tables never cross the channel.
# The op vocabulary is the same one _apply_ops speaks, so the applier is shared.
# ---------------------------------------------------------------------------


def _node_own(n):
    """A node's own fields (everything but ``children``) -- the unit patch_node
    addresses."""
    return {k: v for k, v in n.items() if k != "children"}


def _child_key(n):
    """Stable identity of a child for structure comparison: id when present, else
    ('t', title). A section added in the editor gets a fresh id, so it simply
    won't match at its level -> that level is resent wholesale (correct, coarser)."""
    cid = n.get("id")
    return ("id", cid) if cid else ("t", n.get("title", ""))


def _same_structure(a, b):
    """True when two child lists carry the same identities in the same order, so a
    per-child recursive diff is valid. Otherwise the level is resent wholesale."""
    if len(a) != len(b):
        return False
    return [_child_key(n) for n in a] == [_child_key(n) for n in b]


def _diff_node(base, cur, ops):
    """Append ops describing base->cur for one matched node pair (already matched
    by the parent's structure check, so their identities line up)."""
    b_own, c_own = _node_own(base), _node_own(cur)
    if b_own != c_own:
        changed = {k: v for k, v in c_own.items() if base.get(k) != v}
        removed = [k for k in b_own if k not in c_own]
        op = {"op": "patch_node", "node_id": cur.get("id"),
              "title": cur.get("title"), "fields": changed}
        if removed:
            op["remove_fields"] = removed
        ops.append(op)
    bch, cch = base.get("children") or [], cur.get("children") or []
    if _same_structure(bch, cch):
        for bc, cc in zip(bch, cch):
            _diff_node(bc, cc, ops)
    elif bch != cch:
        # structure changed at this level -> resend this node's whole subtree.
        ops.append({"op": "set_children", "node_id": cur.get("id"),
                    "title": cur.get("title"), "children": cch})


def make_text_diff(base, cur, dir_name=""):
    """Compact base->cur delta for the upstream channel. Returns a dict:
    ``{_reportdiff, dir, base_sha, [meta], [top], [removed_top], [outline]|[ops]}``.
    meta / top-level keys are resent WHOLE when changed (they are small); outline
    edits ride node ops, unless the TOP-LEVEL section structure changed (then the
    whole outline is included -- rare). An empty result (no meta/top/outline/ops)
    means the two projects are structurally identical."""
    base = base if isinstance(base, dict) else {}
    cur = cur if isinstance(cur, dict) else {}
    diff = {"_reportdiff": 1, "dir": dir_name, "base_sha": _sha(_canon(base))}
    if (base.get("meta") or {}) != (cur.get("meta") or {}):
        diff["meta"] = cur.get("meta") or {}
    skip = {"meta", "outline", "schema_version"}
    top, removed_top = {}, []
    for k in set(base) | set(cur):
        if k in skip or base.get(k) == cur.get(k):
            continue
        if k in cur:
            top[k] = cur[k]
        else:
            removed_top.append(k)
    if top:
        diff["top"] = top
    if removed_top:
        diff["removed_top"] = removed_top
    b_out, c_out = base.get("outline") or [], cur.get("outline") or []
    if _same_structure(b_out, c_out):
        ops = []
        for bc, cc in zip(b_out, c_out):
            _diff_node(bc, cc, ops)
        if ops:
            diff["ops"] = ops
    elif b_out != c_out:
        diff["outline"] = c_out    # top-level structure changed -> full outline
    return diff


def diff_is_empty(diff):
    """True when a make_text_diff() result conveys no change."""
    return not any(k in diff for k in
                   ("meta", "top", "removed_top", "outline", "ops"))


def diff_summary(diff):
    """One-line-per-change human summary of a text-diff (for the GUI preview and
    the CLI). Reports which sections/keys changed, never their full text."""
    lines = []
    if "meta" in diff:
        lines.append("meta: replaced")
    for k in (diff.get("top") or {}):
        lines.append("top-level '%s': replaced" % k)
    for k in diff.get("removed_top") or []:
        lines.append("top-level '%s': removed" % k)
    if "outline" in diff:
        lines.append("outline: top-level structure changed -> %d section(s) resent"
                     % len(diff["outline"]))
    for op in diff.get("ops") or []:
        title = op.get("title") or op.get("node_id") or "?"
        if op.get("op") == "patch_node":
            fields = ", ".join(sorted((op.get("fields") or {}))) or "-"
            lines.append("section '%s': %s" % (title, fields))
        elif op.get("op") == "set_children":
            lines.append("section '%s': sub-structure changed -> %d child(ren) resent"
                         % (title, len(op.get("children") or [])))
        else:
            lines.append("section '%s': %s" % (title, op.get("op")))
    return lines


def _apply_text_diff_into(project, diff):
    """Mutate ``project`` by a make_text_diff() delta. Returns log lines. meta /
    top-level keys replace wholesale; outline changes ride node ops, or a full
    ``outline`` when the top-level structure changed."""
    logs = []
    if "meta" in diff:
        project["meta"] = diff["meta"]
        logs.append("  ~ meta replaced")
    for k, v in (diff.get("top") or {}).items():
        project[k] = v
        logs.append("  ~ top-level '%s' set" % k)
    for k in diff.get("removed_top") or []:
        project.pop(k, None)
        logs.append("  ~ top-level '%s' removed" % k)
    if "outline" in diff:
        project["outline"] = diff["outline"]
        logs.append("  ~ outline replaced (%d top section(s))"
                    % len(diff["outline"]))
    else:
        logs += _apply_ops(project, diff.get("ops"))
    return logs


def apply_text_diff(root, diff, dir_name=None, backup=True):
    """Apply an upstream "Copy diff" delta to a local project.json. Backs the
    target into the shared rollback history, writes atomically, re-stamps the
    baseline. Returns {ok, backup, logs, rel, base_match} (base_match is None when
    the diff carried no fingerprint, else whether the local file matched it).
    Raises FileNotFoundError if the target project.json is absent."""
    dname = dir_name or diff.get("dir")
    if not dname:
        raise ValueError("diff has no project dir; pass dir_name")
    rel = os.path.join(dname, "project.json")
    tgt = os.path.join(root, rel)
    if not os.path.isfile(tgt):
        raise FileNotFoundError("no project.json at %s" % tgt)
    project = json.loads(_read(tgt).decode("utf-8"))
    base_match = None
    if diff.get("base_sha"):
        base_match = (diff["base_sha"] == _sha(_canon(project)))
    logs = _apply_text_diff_into(project, diff)
    new_bytes = json.dumps(project, ensure_ascii=False, indent=2).encode("utf-8")
    bdir = _new_backup_dir(root)
    if backup:
        dst = os.path.join(bdir, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(tgt, dst)
    _atomic_write(tgt, new_bytes)
    st = _load_state(root)
    st[rel] = _sha(new_bytes)
    _save_state(root, st)
    _stamp_baseline(root, rel, new_bytes)
    return {"ok": True, "backup": bdir.replace("\\", "/"), "logs": logs,
            "rel": rel.replace("\\", "/"), "base_match": base_match}


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
                final_bytes = it["payload"]
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
                final_bytes = out
            # Applying a bundle IS a sync event on the work machine: refresh the
            # baseline so the next "Copy diff" measures from what was just applied.
            _stamp_baseline(root, it["rel"], final_bytes)
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
    _stamp_baseline(root, rel, new_bytes)   # full paste-import is a sync event too
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


def cmd_apply_diff(root, path, dir_name, yes):
    """Apply an upstream text-diff JSON (from the GUI's "Copy diff") to a local
    project.json -- the small-payload counterpart of a full paste-import. The
    diff is a make_text_diff() object; the work machine pastes it to the assistant
    who saves it to a file and runs this."""
    try:
        with open(path, encoding="utf-8") as fh:
            diff = json.load(fh)
    except Exception as ex:
        print("error: could not read diff %s: %s" % (path, ex))
        return 2
    if not isinstance(diff, dict) or diff.get("_reportdiff") != 1:
        print("error: not a report text-diff (missing _reportdiff:1).")
        return 2
    dname = dir_name or diff.get("dir")
    if not dname:
        print("error: diff has no project dir; pass --dir NAME.")
        return 2
    print("root: %s" % root)
    print("dir:  %s" % dname)
    if diff_is_empty(diff):
        print("diff is empty -- nothing to apply.")
        return 0
    for line in diff_summary(diff):
        print("  * " + line)
    tgt = os.path.join(root, dname, "project.json")
    if not os.path.isfile(tgt):
        print("error: no project.json at %s" % tgt)
        return 2
    if not yes:
        ans = input("\nApply this diff to %s? [y/N] " % dname).strip().lower()
        if ans not in ("y", "yes"):
            print("aborted.")
            return 1
    res = apply_text_diff(root, diff, dir_name=dir_name)
    for line in res["logs"]:
        print(line)
    if res.get("base_match") is False:
        print("  ! WARNING: local project.json differs from the diff's baseline "
              "(base_sha mismatch). Changed sections were applied wholesale, but "
              "any section you never edited on the work machine keeps the local "
              "version -- verify if you have out-of-band edits here.")
    print("\nOK. Backed up to: %s" % res["backup"])
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
        data = _read(full)
        _atomic_write(tgt, data)
        _stamp_baseline(root, rel, data)   # baseline follows the restored state
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
    ap.add_argument("--apply-diff", metavar="FILE",
                    help="apply an upstream text-diff JSON (from the GUI 'Copy diff')")
    ap.add_argument("--dir", help="target project dir for --apply-diff (default: from the diff)")
    a = ap.parse_args(argv)
    root = resolve_root(a.root)
    if a.snapshot:
        return cmd_snapshot(root)
    if a.rollback:
        return cmd_rollback(root, a.yes)
    if a.list:
        return cmd_list(root)
    if a.apply_diff:
        return cmd_apply_diff(root, a.apply_diff, a.dir, a.yes)
    return cmd_apply(root, a.bundle, a.dry_run, a.yes)


if __name__ == "__main__":
    sys.exit(main())
