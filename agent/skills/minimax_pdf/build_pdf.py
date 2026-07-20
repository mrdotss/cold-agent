#!/usr/bin/env python3
"""minimax-pdf skill: build a .pdf AWS cost report (reportlab).

In-container invocation (subprocess, by the reporting tool):
    python skills/minimax_pdf/build_pdf.py --spec /path/spec.json
Writes spec["output_path"] and prints the absolute path on stdout.

Same spec schema as the minimax-xlsx skill. Registers a bundled DejaVuSans TTF
when present (broad glyph coverage incl. currency symbols); otherwise falls back
to Helvetica.
"""
from __future__ import annotations

import argparse
import json
import os

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    Image as RLImage,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

_FONT = "Helvetica"
_FONT_B = "Helvetica-Bold"
for _reg, _bold in (("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
                     "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),):
    if os.path.isfile(_reg):
        try:
            pdfmetrics.registerFont(TTFont("DejaVuSans", _reg))
            _FONT = "DejaVuSans"
            if os.path.isfile(_bold):
                pdfmetrics.registerFont(TTFont("DejaVuSans-Bold", _bold))
                _FONT_B = "DejaVuSans-Bold"
            else:
                _FONT_B = "DejaVuSans"
        except Exception:  # noqa: BLE001
            pass
        break


def _img_dims(path: str, max_w: float):
    try:
        from PIL import Image as PImage
        with PImage.open(path) as im:
            w, h = im.size
        if w <= 0:
            return max_w, max_w * 0.5
        return max_w, max_w * (h / w)
    except Exception:  # noqa: BLE001
        return max_w, max_w * 0.5


def build_pdf(spec: dict) -> str:
    out = spec["output_path"]
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)

    display = (spec.get("currency") or {}).get("display") or "USD"
    show_display = display.upper() != "USD"
    rows = spec.get("rows") or []

    styles = getSampleStyleSheet()
    title_s = ParagraphStyle("t", parent=styles["Title"], fontName=_FONT_B)
    sub_s = ParagraphStyle("s", parent=styles["Normal"], fontName=_FONT, fontSize=9,
                           textColor=colors.HexColor("#6B7280"))
    body_s = ParagraphStyle("b", parent=styles["Normal"], fontName=_FONT, fontSize=9)
    bold_s = ParagraphStyle("bb", parent=body_s, fontName=_FONT_B)

    doc = SimpleDocTemplate(out, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm,
                            topMargin=18 * mm, bottomMargin=18 * mm,
                            title=spec.get("title") or "AWS Cost Report")
    story = [Paragraph(spec.get("title") or "AWS Cost Report", title_s)]
    if spec.get("subtitle"):
        story.append(Paragraph(spec["subtitle"], sub_s))

    period = spec.get("period") or {}
    cur = spec.get("currency") or {}
    meta = []
    if period.get("start"):
        meta.append(f"Period: {period['start']} to {period.get('end', '')} (end exclusive)")
    if cur.get("usd_rate"):
        meta.append(f"FX: 1 USD = {float(cur['usd_rate']):,.2f} {display} "
                    f"(as of {cur.get('as_of', '')}, open.er-api.com)")
    if meta:
        story.append(Paragraph("   |   ".join(meta), sub_s))
    story.append(Spacer(1, 8))

    header = ["Service", "Amount (USD)"] + ([f"Amount ({display})"] if show_display else [])
    data = [header]
    for row in rows:
        line = [str(row.get("service", "")), f"{float(row.get('usd', 0) or 0):,.2f}"]
        if show_display:
            dv = row.get("display")
            line.append(f"{float(dv):,.0f}" if dv is not None else "")
        data.append(line)
    total = spec.get("total") or {}
    if total:
        tline = ["Total", f"{float(total.get('usd', 0) or 0):,.2f}"]
        if show_display:
            dv = total.get("display")
            tline.append(f"{float(dv):,.0f}" if dv is not None else "")
        data.append(tline)

    col_w = [85 * mm, 35 * mm] + ([40 * mm] if show_display else [])
    tbl = Table(data, colWidths=col_w, repeatRows=1)
    style = [
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1F2937")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), _FONT_B),
        ("FONTNAME", (0, 1), (-1, -1), _FONT),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#D1D5DB")),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F9FAFB")]),
    ]
    if total:
        style.append(("FONTNAME", (0, -1), (-1, -1), _FONT_B))
        style.append(("LINEABOVE", (0, -1), (-1, -1), 1, colors.HexColor("#1F2937")))
    tbl.setStyle(TableStyle(style))
    story.append(tbl)

    for p in [c for c in (spec.get("charts") or []) if c and os.path.isfile(c)]:
        story.append(Spacer(1, 10))
        w, h = _img_dims(p, 170 * mm)
        story.append(RLImage(p, width=w, height=h))

    notes = spec.get("notes") or []
    if notes:
        story.append(Spacer(1, 10))
        story.append(Paragraph("Notes", bold_s))
        for n in notes:
            story.append(Paragraph("- " + str(n), body_s))

    doc.build(story)
    return os.path.abspath(out)


def main():
    ap = argparse.ArgumentParser(description="Build a .pdf cost report")
    ap.add_argument("--spec", required=True, help="path to spec JSON")
    args = ap.parse_args()
    with open(args.spec, encoding="utf-8") as f:
        spec = json.load(f)
    print(build_pdf(spec))


if __name__ == "__main__":
    main()
