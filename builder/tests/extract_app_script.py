#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Extract the largest inline <script> block from app.html.

app.html is a single file; the app logic lives in one big inline <script>. This
pulls it out so it can be fed to `node --check` (syntax) or a DOM harness. Prints
to stdout by default, or writes to a path.

    python builder/tests/extract_app_script.py            # -> stdout
    python builder/tests/extract_app_script.py out.js     # -> file
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
APP_HTML = os.path.abspath(os.path.join(HERE, "..", "app.html"))


def extract(html):
    blocks = re.findall(
        r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", html, re.DOTALL | re.IGNORECASE)
    blocks.sort(key=len)
    return blocks[-1] if blocks else ""


def main(argv=None):
    argv = argv if argv is not None else sys.argv[1:]
    with open(APP_HTML, encoding="utf-8") as fh:
        script = extract(fh.read())
    if not script:
        sys.stderr.write("no inline <script> block found in app.html\n")
        return 1
    if argv:
        with open(argv[0], "w", encoding="utf-8", newline="\n") as fh:
            fh.write(script)
        sys.stderr.write("wrote %d chars -> %s\n" % (len(script), argv[0]))
    else:
        sys.stdout.write(script)
    return 0


if __name__ == "__main__":
    sys.exit(main())
