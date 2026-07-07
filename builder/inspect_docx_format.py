# -*- coding: utf-8 -*-
"""Probe a .docx and dump per-RUN formatting so an exact look can be reproduced.

The earlier text dumps lost run colours. This resolves each run's EFFECTIVE colour
(direct run -> character/paragraph style chain -> theme colour -> auto) plus
bold / italic / font / size, and for tables the column widths, per-cell shading
(fill) and per-cell run formatting. Output is plain text you copy-paste back.

Usage (on the machine that has the .docx):
    python inspect_docx_format.py <file.docx> ["section title substring"]

  - With a section substring, dumps ONLY that heading's block (until the next
    heading of the same-or-higher level) -- e.g.  a "Conclusion" heading.
  - Without it, dumps the whole document (can be long).

Needs python-docx:  pip install python-docx
"""
import sys
from docx import Document
from docx.oxml.ns import qn

A = "http://schemas.openxmlformats.org/drawingml/2006/main"
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"

# w:themeColor value -> theme clrScheme child name
THEME_ALIAS = {
    "dark1": "dk1", "text1": "dk1", "light1": "lt1", "background1": "lt1",
    "dark2": "dk2", "text2": "dk2", "light2": "lt2", "background2": "lt2",
    "accent1": "accent1", "accent2": "accent2", "accent3": "accent3",
    "accent4": "accent4", "accent5": "accent5", "accent6": "accent6",
    "hyperlink": "hlink", "followedHyperlink": "folHlink",
}


def theme_map(doc):
    """theme colour name (dk1/lt1/accent1/...) -> hex, from the theme part."""
    m = {}
    try:
        for rel in doc.part.rels.values():
            if "theme" in rel.reltype:
                scheme = rel.target_part._element.find(".//{%s}clrScheme" % A)
                if scheme is None:
                    continue
                for ch in scheme:
                    name = ch.tag.split("}")[-1]
                    srgb = ch.find("{%s}srgbClr" % A)
                    sysc = ch.find("{%s}sysClr" % A)
                    hx = (srgb.get("val") if srgb is not None
                          else (sysc.get("lastClr") if sysc is not None else None))
                    if hx:
                        m[name] = hx.upper()
    except Exception:
        pass
    return m


def _rpr_props(rpr):
    """Pull (color_hex, theme_name, bold, italic, font, size_pt) from an rPr (any None if absent)."""
    if rpr is None:
        return {}
    out = {}
    c = rpr.find(qn("w:color"))
    if c is not None:
        v = c.get(qn("w:val"))
        if v:
            out["color"] = "auto" if v == "auto" else v.upper()
        t = c.get(qn("w:themeColor"))
        if t:
            out["theme"] = t
    for tag, key in (("w:b", "bold"), ("w:i", "italic")):
        e = rpr.find(qn(tag))
        if e is not None:
            v = e.get(qn("w:val"))
            out[key] = (v not in ("0", "false", "none"))  # present with no val = on
    rf = rpr.find(qn("w:rFonts"))
    if rf is not None:
        out["font"] = rf.get(qn("w:ascii")) or rf.get(qn("w:hAnsi")) or rf.get(qn("w:eastAsia"))
    sz = rpr.find(qn("w:sz"))
    if sz is not None and sz.get(qn("w:val")):
        out["size"] = int(sz.get(qn("w:val"))) / 2.0
    return out


def style_index(doc):
    """styleId -> style element, plus a resolver that follows basedOn."""
    by_id = {}
    for s in doc.styles.element.findall(qn("w:style")):
        sid = s.get(qn("w:styleId"))
        if sid:
            by_id[sid] = s

    def props(sid, seen=None):
        seen = seen or set()
        if not sid or sid in seen or sid not in by_id:
            return {}
        seen.add(sid)
        s = by_id[sid]
        p = dict(_rpr_props(s.find(qn("w:rPr"))))
        based = s.find(qn("w:basedOn"))
        if based is not None:
            parent = props(based.get(qn("w:val")), seen)
            for k, v in parent.items():
                p.setdefault(k, v)   # child overrides parent
        return p
    return props


def effective(run_rpr, para_style_id, char_style_id, sprops):
    """Merge run-direct -> char style -> para style for the resolved run look."""
    eff = {}
    for src in (sprops(para_style_id), sprops(char_style_id), _rpr_props(run_rpr)):
        eff.update({k: v for k, v in src.items() if v is not None})
    return eff


def fmt_color(eff, tmap):
    if eff.get("color") and eff["color"] != "auto":
        return "#" + eff["color"]
    if eff.get("theme"):
        nm = THEME_ALIAS.get(eff["theme"], eff["theme"])
        hx = tmap.get(nm)
        return "theme:%s(#%s)" % (eff["theme"], hx) if hx else "theme:%s" % eff["theme"]
    return "auto/black"


def run_desc(run, para_style_id, sprops, tmap):
    rpr = run.find(qn("w:rPr"))
    cs = None
    if rpr is not None:
        rs = rpr.find(qn("w:rStyle"))
        if rs is not None:
            cs = rs.get(qn("w:val"))
    eff = effective(rpr, para_style_id, cs, sprops)
    bits = ["color=" + fmt_color(eff, tmap)]
    if eff.get("bold"):
        bits.append("BOLD")
    if eff.get("italic"):
        bits.append("ITALIC")
    if eff.get("font"):
        bits.append("font=" + str(eff["font"]))
    if eff.get("size"):
        bits.append("%.0fpt" % eff["size"])
    return " ".join(bits)


def para_style_id(p):
    ppr = p.find(qn("w:pPr"))
    if ppr is None:
        return None
    ps = ppr.find(qn("w:pStyle"))
    return ps.get(qn("w:val")) if ps is not None else None


def para_level(p):
    ppr = p.find(qn("w:pPr"))
    if ppr is None:
        return None
    npr = ppr.find(qn("w:numPr"))
    if npr is None:
        return None
    ilvl = npr.find(qn("w:ilvl"))
    return int(ilvl.get(qn("w:val"))) if ilvl is not None else 0


def dump_para(p, sprops, tmap):
    sid = para_style_id(p)
    lvl = para_level(p)
    runs = p.findall(qn("w:r"))
    text = "".join((r.find(qn("w:t")).text or "") for r in runs if r.find(qn("w:t")) is not None)
    tag = "  PARA style=%s%s" % (sid or "-", (" listlvl=%d" % lvl) if lvl is not None else "")
    print(tag + " | " + (text[:120] if text else "(empty)"))
    for r in runs:
        t = r.find(qn("w:t"))
        if t is None or not (t.text or "").strip():
            continue
        print("      run [%s]  %r" % (run_desc(r, sid, sprops, tmap), (t.text or "")[:60]))


def dump_table(tbl, sprops, tmap):
    grid = tbl.find(qn("w:tblGrid"))
    widths = []
    if grid is not None:
        for gc in grid.findall(qn("w:gridCol")):
            w = gc.get(qn("w:w"))
            widths.append("%.2fcm" % (int(w) / 567.0) if w else "?")
    rows = tbl.findall(qn("w:tr"))
    print("  TABLE %d rows x %d cols  col_w=%s" % (len(rows), len(widths), widths))
    for ri, tr in enumerate(rows):
        for ci, tc in enumerate(tr.findall(qn("w:tc"))):
            tcpr = tc.find(qn("w:tcPr"))
            fill = None
            if tcpr is not None:
                shd = tcpr.find(qn("w:shd"))
                if shd is not None:
                    fill = shd.get(qn("w:fill"))
            txt = "".join((t.text or "") for t in tc.iter(qn("w:t")))
            # first run look in the cell
            look = ""
            for p in tc.findall(qn("w:p")):
                for r in p.findall(qn("w:r")):
                    if (r.find(qn("w:t")) is not None) and (r.find(qn("w:t")).text or "").strip():
                        look = run_desc(r, para_style_id(p), sprops, tmap)
                        break
                if look:
                    break
            fills = ("fill=#%s " % fill) if fill and fill != "auto" else ""
            print("    cell[%d,%d] %s%s | %r" % (ri, ci, fills, look, txt[:50]))


def heading_level(sid):
    if sid and sid.lower().startswith("heading"):
        d = "".join(ch for ch in sid if ch.isdigit())
        return int(d) if d else 1
    return None


def main():
    if len(sys.argv) < 2:
        print("usage: python inspect_docx_format.py <file.docx> [section substring]")
        return 1
    doc = Document(sys.argv[1])
    want = sys.argv[2] if len(sys.argv) > 2 else None
    tmap = theme_map(doc)
    sprops = style_index(doc)
    print("== theme colours ==", {k: "#" + v for k, v in tmap.items()})
    body = doc.element.body
    active = (want is None)
    start_lvl = None
    for child in body:
        if child.tag == qn("w:p"):
            sid = para_style_id(child)
            hl = heading_level(sid)
            txt = "".join((t.text or "") for t in child.iter(qn("w:t")))
            if want is not None:
                if not active and hl and want in txt:
                    active = True
                    start_lvl = hl
                    print("\n===== SECTION: %s =====" % txt.strip())
                    continue
                elif active and hl and start_lvl is not None and hl <= start_lvl and want not in txt:
                    break
            if active:
                dump_para(child, sprops, tmap)
        elif child.tag == qn("w:tbl") and active:
            dump_table(child, sprops, tmap)
    if want is not None and not active:
        print("!! section %r not found. Run without a section arg to see all headings." % want)
    return 0


if __name__ == "__main__":
    sys.exit(main())
