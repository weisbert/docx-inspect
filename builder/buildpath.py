"""Register every builder/<layer>/ directory on sys.path.

The modules under builder/ use flat imports (``import tables``) and several of
them double as standalone command-line entry points. A package-relative import
scheme (``from . import tables``) would break those CLIs, so instead of turning
the layers into packages, each entry point imports this module once and every
layer directory becomes importable by its plain module name.

Usage from an entry point, e.g. ``builder/web/server.py``::

    import os, sys
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    import buildpath  # noqa: E402,F401  (side effect: registers the layers)

Layer dependency runs one way: web -> store/sync/docx_io -> core.
"""

import os
import sys

_ROOT = os.path.dirname(os.path.abspath(__file__))

# Order is irrelevant (module names do not collide across layers), but keep it
# in dependency order for readability.
LAYERS = ("core", "docx_io", "store", "sync", "web")


def setup():
    """Idempotently put each layer directory at the front of sys.path."""
    for name in LAYERS:
        path = os.path.join(_ROOT, name)
        if os.path.isdir(path) and path not in sys.path:
            sys.path.insert(0, path)


setup()
