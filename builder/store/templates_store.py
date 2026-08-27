#!/usr/bin/env python3
"""Template library store for the document builder.

A thin, dependency-free helper layer that owns the on-disk template library
under ``reports_root/templates/``. Each template lives in its own directory:

    reports_root/templates/<id>/
        config.json     engine template config (carries "id", "name", "logo")
        skeleton.json   the skeleton outline tree
        logo.png        the template logo, if the source docx had one

This module imports nothing from ``server`` (avoids an import cycle); the server
reads ``CFG.reports_root`` and passes it in, and passes in its own
``atomic_write`` / ``_sanitize_name`` so there is a single definition of each.

Standard-library only. The source, comments and default strings are intentionally
English and neutral; any company / domain text only ever flows through as DATA
read from the user's docx (via ``derive_template``) or from stored JSON.
"""

import json
import os
import shutil


# ---------------------------------------------------------------------------
# Path safety / containment (mirrors server.resolve_project_dir).
# ---------------------------------------------------------------------------


def templates_root(reports_root):
    """Return the absolute ``reports_root/templates`` path, or None if unset."""
    if not reports_root:
        return None
    return os.path.join(os.path.abspath(reports_root), "templates")


def _contained(child_abs, parent_abs):
    """True iff ``child_abs`` is inside ``parent_abs`` (case/sep-robust).

    Uses the same commonpath/normcase pattern as ``resolve_project_dir`` and is
    safe across drives (a ValueError from commonpath means "not contained").
    """
    try:
        common = os.path.commonpath([parent_abs, child_abs])
    except ValueError:
        return False
    return os.path.normcase(common) == os.path.normcase(parent_abs)


def template_dir(reports_root, tid, create=False):
    """Resolve ``reports_root/templates/<tid>/`` with a traversal guard.

    Raises ValueError if no reports_root is configured, the id is missing, or the
    id escapes (or collapses to) the templates root.
    """
    troot = templates_root(reports_root)
    if not troot:
        raise ValueError("no reports_root configured")
    if not tid or not isinstance(tid, str):
        raise ValueError("missing template id")
    troot_abs = os.path.abspath(troot)
    target = os.path.abspath(os.path.join(troot_abs, tid))
    if not _contained(target, troot_abs) or (
        os.path.normcase(target) == os.path.normcase(troot_abs)
    ):
        raise ValueError("template id escapes templates root")
    if create:
        os.makedirs(target, exist_ok=True)
    return target


# ---------------------------------------------------------------------------
# Id allocation (reuses server._sanitize_name passed in as ``sanitize``).
# ---------------------------------------------------------------------------


def make_template_id(reports_root, name, sanitize):
    """Allocate a unique template id from ``name``.

    Lowercased ``sanitize(name)``, made unique under ``templates/`` with a
    ``-2`` / ``-3`` ... suffix on collision. Falls back to ``"template"`` when
    the name sanitizes to empty. ``sanitize`` is ``server._sanitize_name``.
    """
    base = (sanitize(name or "") or "template").lower()
    troot = templates_root(reports_root)
    if not troot:
        raise ValueError("no reports_root configured")
    cand = base
    n = 2
    while os.path.isdir(os.path.join(troot, cand)):
        cand = "%s-%d" % (base, n)
        n += 1
    return cand


# ---------------------------------------------------------------------------
# CRUD.
# ---------------------------------------------------------------------------


def list_templates(reports_root):
    """Return ``[{"id","name"}, ...]`` scanning ``templates/*/config.json``.

    Skips unreadable dirs; sorted by id. Returns ``[]`` when the templates root
    is missing or absent.
    """
    troot = templates_root(reports_root)
    if not troot or not os.path.isdir(troot):
        return []
    out = []
    for entry in sorted(os.listdir(troot)):
        cfg_path = os.path.join(troot, entry, "config.json")
        if not os.path.isfile(cfg_path):
            continue
        try:
            with open(cfg_path, "r", encoding="utf-8") as fh:
                cfg = json.load(fh)
        except Exception:
            continue
        out.append({"id": entry, "name": cfg.get("name") or cfg.get("id") or entry})
    return out


def get_template(reports_root, tid):
    """Return ``{"id","name","config":<full>,"skeleton":<tree>}`` for ``tid``.

    Raises FileNotFoundError if ``config.json`` is missing. A missing
    ``skeleton.json`` degrades to ``skeleton: []``.
    """
    tdir = template_dir(reports_root, tid)
    cfg_path = os.path.join(tdir, "config.json")
    if not os.path.isfile(cfg_path):
        raise FileNotFoundError("template not found: %s" % tid)
    with open(cfg_path, "r", encoding="utf-8") as fh:
        config = json.load(fh)
    skeleton = []
    skel_path = os.path.join(tdir, "skeleton.json")
    if os.path.isfile(skel_path):
        try:
            with open(skel_path, "r", encoding="utf-8") as fh:
                skeleton = json.load(fh)
        except Exception:
            skeleton = []
    return {
        "id": tid,
        "name": config.get("name") or config.get("id") or tid,
        "config": config,
        "skeleton": skeleton,
    }


def save_template(reports_root, tid, name, config, skeleton, atomic_write):
    """Atomic-write ``config.json`` (with id+name injected) and ``skeleton.json``.

    Writes into an existing-or-created template dir. ``atomic_write`` is
    ``server.atomic_write``. Returns the resolved id. Always forces
    ``config['id'] = tid`` and ``config['name'] = name``.
    """
    tdir = template_dir(reports_root, tid, create=True)
    if not isinstance(config, dict):
        raise ValueError("config must be a JSON object")
    config = dict(config)
    config["id"] = tid
    config["name"] = name
    if skeleton is None:
        skeleton = []
    cfg_bytes = json.dumps(config, ensure_ascii=False, indent=2).encode("utf-8")
    skel_bytes = json.dumps(skeleton, ensure_ascii=False, indent=2).encode("utf-8")
    atomic_write(os.path.join(tdir, "config.json"), cfg_bytes)
    atomic_write(os.path.join(tdir, "skeleton.json"), skel_bytes)
    return tid


def delete_template(reports_root, tid):
    """Remove the template dir (guarded). Raises FileNotFoundError if absent."""
    tdir = template_dir(reports_root, tid)
    if not os.path.isdir(tdir):
        raise FileNotFoundError("template not found: %s" % tid)
    shutil.rmtree(tdir)


def template_config_path(reports_root, tid):
    """Return ``templates/<tid>/config.json`` if it exists, else None.

    Never raises on a bad tid (returns None) so config resolution degrades
    gracefully when a project is bound to a since-deleted template.
    """
    if not reports_root or not tid:
        return None
    try:
        tdir = template_dir(reports_root, tid)
    except ValueError:
        return None
    cfg_path = os.path.join(tdir, "config.json")
    return cfg_path if os.path.isfile(cfg_path) else None


# ---------------------------------------------------------------------------
# Import save helper (template-mode import + report-mode dead-end fallback).
# ---------------------------------------------------------------------------


def save_derived_template(
    reports_root, name, derived, atomic_write, sanitize, logo_dir=None, warn=None
):
    """Persist a ``derive_template()`` result as a NEW template.

    ``derived`` is ``{"config":..., "skeleton":..., optional "_warnings"}``. The
    template name is the explicit ``name``, else ``config.cover.company_line``,
    else the config's ``name``/``id``, else ``"template"``. A unique id is
    allocated, the dir created, a ``logo.png`` copied in from ``logo_dir`` if one
    was extracted, and config + skeleton written. Returns ``(tid, resolved_name)``.
    """
    warn = warn or (lambda _m: None)
    config = derived.get("config") or {}
    skeleton = derived.get("skeleton") or []

    resolved_name = (
        name
        or (config.get("cover") or {}).get("company_line")
        or config.get("name")
        or config.get("id")
        or "template"
    )

    tid = make_template_id(reports_root, resolved_name, sanitize)
    tdir = template_dir(reports_root, tid, create=True)

    # Copy the extracted logo in, if any, so config["logo"] ("logo.png") resolves.
    if logo_dir:
        src_logo = os.path.join(logo_dir, "logo.png")
        if os.path.isfile(src_logo):
            try:
                shutil.copyfile(src_logo, os.path.join(tdir, "logo.png"))
            except Exception as ex:  # pragma: no cover - defensive
                warn("logo copy failed (%r)" % (ex,))

    save_template(reports_root, tid, resolved_name, config, skeleton, atomic_write)
    return tid, resolved_name
