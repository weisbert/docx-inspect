#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
extract_media.py — pull every embedded image out of a .docx.

A .docx is a zip; its pictures live in word/media/. This dumps them all to a
folder so you can grab e.g. a cover logo straight from the source document
(authentic, no web download / watermark / wrong-logo risk).

Usage:
    python extract_media.py file.docx [out_dir]
    Default out_dir: "<docx>_media"

No third-party dependencies (uses only the standard library).
"""

import sys
import os
import zipfile


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    path = sys.argv[1]
    if not os.path.isfile(path):
        print("File not found:", path)
        sys.exit(1)

    out_dir = sys.argv[2] if len(sys.argv) > 2 else os.path.splitext(path)[0] + "_media"
    os.makedirs(out_dir, exist_ok=True)

    n = 0
    with zipfile.ZipFile(path) as z:
        media = [m for m in z.namelist() if m.startswith("word/media/")]
        if not media:
            print("(no embedded media found)")
            return
        # natural sort: image1, image2, ... image10
        def key(name):
            base = os.path.basename(name)
            digits = "".join(c for c in base if c.isdigit())
            return (int(digits) if digits else 0, base)
        for m in sorted(media, key=key):
            data = z.read(m)
            base = os.path.basename(m)
            dest = os.path.join(out_dir, base)
            with open(dest, "wb") as f:
                f.write(data)
            n += 1
            print(f"  {base:20}  {len(data)/1024:8.1f} KB")

    print(f"\n{n} images -> {os.path.abspath(out_dir)}")
    print("The most relevant image is usually an early, near-square one. Crop as needed and reuse it.")


if __name__ == "__main__":
    main()
