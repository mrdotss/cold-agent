#!/usr/bin/env python3
"""minimax-pdf skill: build a high-end .pdf AWS cost report (reportlab).

In-container invocation (subprocess, by the reporting tool):
    python skills/minimax_pdf/build_pdf.py --spec /path/spec.json
Writes spec["output_path"] and prints the absolute path on stdout.

Design: editorial "soft structuralism" - white ground, indigo accent, heavy
whitespace, a KPI card band, a derived-insight panel, framed charts and a clean
hairline breakdown table. Same spec schema as the minimax-xlsx skill.

Fonts: bundled Plus Jakarta Sans (skills/assets/fonts) when present, else system
DejaVuSans, else Helvetica. Never fails on a missing font.
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import sys

from reportlab.lib.colors import HexColor
from reportlab.lib.enums import TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    Image as RLImage,
    KeepTogether,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)
from reportlab.platypus.flowables import Flowable, HRFlowable

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import report_common as rc  # noqa: E402


# --------------------------------------------------------------------------- #
# Fonts
# --------------------------------------------------------------------------- #
def _register_fonts() -> dict:
    """Register the best available family; return role -> registered font name."""
    ff = rc.font_files()
    reg: dict = {}
    for weight, name in (("regular", "PJS"), ("medium", "PJS-Md"),
                         ("semibold", "PJS-Sb"), ("bold", "PJS-Bd"),
                         ("extrabold", "PJS-Xb")):
        p = ff.get(weight)
        if p:
            try:
                pdfmetrics.registerFont(TTFont(name, p))
                reg[weight] = name
            except Exception:  # noqa: BLE001
                pass
    if reg:
        body = reg.get("regular", "Helvetica")
        med = reg.get("medium", body)
        sb = reg.get("semibold", reg.get("bold", med))
        bold = reg.get("bold", sb)
        xb = reg.get("extrabold", bold)
        return dict(body=body, med=med, sb=sb, bold=bold, xb=xb)

    dv = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
    dvb = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
    if os.path.isfile(dv):
        try:
            pdfmetrics.registerFont(TTFont("DJV", dv))
            b = "DJV"
            if os.path.isfile(dvb):
                pdfmetrics.registerFont(TTFont("DJV-B", dvb))
                b = "DJV-B"
            return dict(body="DJV", med="DJV", sb=b, bold=b, xb=b)
        except Exception:  # noqa: BLE001
            pass
    return dict(body="Helvetica", med="Helvetica", sb="Helvetica-Bold",
                bold="Helvetica-Bold", xb="Helvetica-Bold")


def _track(s: str, spacer: str = "\u2009") -> str:
    """Letter-spaced uppercase for eyebrow labels."""
    return spacer.join(list(str(s).upper()))


def _fit(canvas, text: str, font: str, size: float, maxw: float) -> str:
    if canvas.stringWidth(text, font, size) <= maxw:
        return text
    ell = "\u2026"
    while text and canvas.stringWidth(text + ell, font, size) > maxw:
        text = text[:-1]
    return (text + ell) if text else ell


# --------------------------------------------------------------------------- #
# KPI card band (custom flowable drawn with rounded rectangles)
# --------------------------------------------------------------------------- #
class Cards(Flowable):
    def __init__(self, items, fonts, gap=9.0, height=84.0, radius=10.0):
        super().__init__()
        self.items = items or []
        self.f = fonts
        self.gap = gap
        self.h = height
        self.r = radius
        self.width = 0.0

    def wrap(self, avail_w, avail_h):
        self.width = avail_w
        return avail_w, self.h

    def draw(self):
        c = self.canv
        n = len(self.items) or 1
        cw = (self.width - self.gap * (n - 1)) / n
        pad = 13.0
        for i, it in enumerate(self.items):
            x = i * (cw + self.gap)
            accent = bool(it.get("accent"))
            c.setFillColor(HexColor(rc.ACCENT_TINT if accent else rc.PANEL))
            c.setStrokeColor(HexColor("#DFE3FB" if accent else rc.HAIRLINE))
            c.setLineWidth(0.8)
            c.roundRect(x, 0, cw, self.h, self.r, stroke=1, fill=1)
            # accent tick
            c.setFillColor(HexColor(rc.ACCENT if accent else rc.FAINT))
            c.roundRect(x + pad, self.h - pad - 2, 18, 3, 1.5, stroke=0, fill=1)
            # label
            c.setFillColor(HexColor(rc.MUTED))
            c.setFont(self.f["med"], 7.2)
            c.drawString(x + pad, self.h - pad - 16, str(it["label"]).upper())
            # value
            vsize = float(it.get("size", 16.5))
            c.setFillColor(HexColor(rc.ACCENT_DK if accent else rc.INK))
            c.setFont(self.f["xb"], vsize)
            val = _fit(c, str(it["value"]), self.f["xb"], vsize, cw - 2 * pad)
            c.drawString(x + pad, self.h - pad - 20 - vsize, val)
            # sub
            if it.get("sub"):
                c.setFillColor(HexColor(rc.MUTED))
                c.setFont(self.f["body"], 7.8)
                sub = _fit(c, str(it["sub"]), self.f["body"], 7.8, cw - 2 * pad)
                c.drawString(x + pad, 12, sub)


def _img_dims(path: str, max_w: float, max_h: float):
    try:
        from PIL import Image as PImage
        with PImage.open(path) as im:
            w, h = im.size
        if w <= 0 or h <= 0:
            return max_w, max_w * 0.5
        ratio = h / w
        out_w, out_h = max_w, max_w * ratio
        if out_h > max_h:
            out_h, out_w = max_h, max_h / ratio
        return out_w, out_h
    except Exception:  # noqa: BLE001
        return max_w, max_w * 0.5


# --------------------------------------------------------------------------- #
# Build
# --------------------------------------------------------------------------- #
def build_pdf(spec: dict) -> str:
    out = spec["output_path"]
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    fonts = _register_fonts()

    cur = spec.get("currency") or {}
    display = (cur.get("display") or "USD")
    show_display = display.upper() != "USD"
    rate = cur.get("usd_rate")
    rows = rc.sorted_rows(spec.get("rows"))
    total = spec.get("total") or {}
    metrics = rc.compute_insights(rows, total, display, show_display, rate)
    tot_usd = metrics["total_usd"]

    lm = rm = 17 * mm
    doc = SimpleDocTemplate(
        out, pagesize=A4, leftMargin=lm, rightMargin=rm,
        topMargin=20 * mm, bottomMargin=18 * mm,
        title=spec.get("title") or "AWS Cost Report", author="Cloud Bill Analyst")
    content_w = doc.width

    eyebrow = ParagraphStyle("eyebrow", fontName=fonts["sb"], fontSize=7.5,
                             textColor=HexColor(rc.ACCENT), leading=10, spaceAfter=5)
    title_s = ParagraphStyle("title", fontName=fonts["xb"], fontSize=25,
                             textColor=HexColor(rc.INK), leading=28, spaceAfter=1)
    sub_s = ParagraphStyle("sub", fontName=fonts["med"], fontSize=11.5,
                           textColor=HexColor(rc.MUTED), leading=15)
    meta_s = ParagraphStyle("meta", fontName=fonts["body"], fontSize=8.3,
                            textColor=HexColor(rc.FAINT), leading=12)
    sec_s = ParagraphStyle("sec", fontName=fonts["sb"], fontSize=7.5,
                           textColor=HexColor(rc.ACCENT), leading=11, spaceAfter=6)
    ins_lead = ParagraphStyle("inslead", fontName=fonts["sb"], fontSize=8,
                              textColor=HexColor(rc.ACCENT_DK), leading=11, spaceAfter=5)
    ins_s = ParagraphStyle("ins", fontName=fonts["body"], fontSize=9.4,
                           textColor=HexColor(rc.BODY), leading=14.5, spaceAfter=3,
                           leftIndent=13, firstLineIndent=-13)
    th = ParagraphStyle("th", fontName=fonts["sb"], fontSize=8.4,
                        textColor=HexColor(rc.INK), leading=11)
    th_r = ParagraphStyle("thr", parent=th, alignment=TA_RIGHT)
    td = ParagraphStyle("td", fontName=fonts["body"], fontSize=9, textColor=HexColor(rc.BODY), leading=12)
    td_r = ParagraphStyle("tdr", parent=td, alignment=TA_RIGHT)
    td_rb = ParagraphStyle("tdrb", parent=td_r, fontName=fonts["sb"], textColor=HexColor(rc.INK))
    td_b = ParagraphStyle("tdb", parent=td, fontName=fonts["sb"], textColor=HexColor(rc.INK))
    note_s = ParagraphStyle("note", fontName=fonts["body"], fontSize=8,
                            textColor=HexColor(rc.MUTED), leading=12.5,
                            leftIndent=11, firstLineIndent=-11)

    story = []
    story.append(Paragraph(_track("AWS Cost Intelligence"), eyebrow))
    story.append(Paragraph(spec.get("title") or "AWS Cost Report", title_s))
    if spec.get("subtitle"):
        story.append(Paragraph(str(spec["subtitle"]), sub_s))
    story.append(HRFlowable(width=64, thickness=2.4, color=HexColor(rc.ACCENT),
                            spaceBefore=9, spaceAfter=9, lineCap="round", hAlign="LEFT"))

    period = spec.get("period") or {}
    chips = []
    if period.get("start"):
        chips.append(f"Period {period['start']} \u2192 {period.get('end', '')} (end exclusive)")
    if rate:
        chips.append(f"FX 1 USD = {rc.money(rate, display, 2)} {display} "
                     f"(as of {cur.get('as_of', '')}, open.er-api.com)")
    chips.append("Generated " + datetime.datetime.now(datetime.timezone.utc).strftime("%d %b %Y"))
    story.append(Paragraph("&nbsp;&nbsp;\u00b7&nbsp;&nbsp;".join(chips), meta_s))
    story.append(Spacer(1, 15))

    story.append(Cards(rc.kpi_cards(metrics, total, display, show_display), fonts))
    story.append(Spacer(1, 17))

    # Insight panel
    if metrics["bullets"]:
        inner = [Paragraph(_track("Key insights"), ins_lead)]
        for b in metrics["bullets"]:
            inner.append(Paragraph(f'<font color="{rc.ACCENT}">\u25b8</font>  {b}', ins_s))
        panel = Table([[inner]], colWidths=[content_w])
        panel.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), HexColor(rc.ACCENT_TINT)),
            ("LINEBEFORE", (0, 0), (0, -1), 3, HexColor(rc.ACCENT)),
            ("ROUNDEDCORNERS", [9, 9, 9, 9]),
            ("LEFTPADDING", (0, 0), (-1, -1), 16),
            ("RIGHTPADDING", (0, 0), (-1, -1), 16),
            ("TOPPADDING", (0, 0), (-1, -1), 13),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 11),
        ]))
        story.append(panel)
        story.append(Spacer(1, 17))

    # Charts (framed)
    chart_paths = [c for c in (spec.get("charts") or []) if c and os.path.isfile(c)]
    for idx, p in enumerate(chart_paths):
        w, h = _img_dims(p, content_w - 20, 96 * mm)
        frame = Table([[RLImage(p, width=w, height=h)]], colWidths=[content_w])
        frame.setStyle(TableStyle([
            ("BOX", (0, 0), (-1, -1), 0.8, HexColor(rc.HAIRLINE)),
            ("ROUNDEDCORNERS", [10, 10, 10, 10]),
            ("ALIGN", (0, 0), (-1, -1), "CENTER"),
            ("TOPPADDING", (0, 0), (-1, -1), 10),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
            ("LEFTPADDING", (0, 0), (-1, -1), 10),
            ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ]))
        cap = Paragraph(_track("Visualization" if len(chart_paths) == 1
                               else f"Visualization {idx + 1}"), sec_s)
        story.append(KeepTogether([cap, frame]))
        story.append(Spacer(1, 15))

    # Breakdown table
    story.append(Paragraph(_track("Detailed breakdown"), sec_s))
    header = [Paragraph("Service", th), Paragraph("Amount (USD)", th_r)]
    if show_display:
        header.append(Paragraph(f"Amount ({display})", th_r))
    header.append(Paragraph("Share", th_r))
    data = [header]
    for r in rows:
        usd = rc._f(r.get("usd"))
        line = [Paragraph(str(r.get("service", "")), td), Paragraph(rc.money(usd, "USD"), td_r)]
        if show_display:
            dv = r.get("display")
            line.append(Paragraph(rc.money(dv, display) if dv is not None else "", td_r))
        line.append(Paragraph(rc.pct(usd / tot_usd if tot_usd else 0), td_r))
        data.append(line)
    trow = [Paragraph("Total", td_b), Paragraph(rc.money(total.get("usd", tot_usd), "USD"), td_rb)]
    if show_display:
        trow.append(Paragraph(rc.money(total.get("display"), display)
                              if total.get("display") is not None else "", td_rb))
    trow.append(Paragraph("100%", td_rb))
    data.append(trow)

    if show_display:
        col_w = [content_w * 0.40, content_w * 0.19, content_w * 0.26, content_w * 0.15]
    else:
        col_w = [content_w * 0.56, content_w * 0.28, content_w * 0.16]
    tbl = Table(data, colWidths=col_w, repeatRows=1)
    tstyle = [
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 2),
        ("RIGHTPADDING", (0, 0), (-1, -1), 2),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
        ("LINEBELOW", (0, 0), (-1, 0), 1.2, HexColor(rc.INK)),          # header rule
        ("LINEBELOW", (0, 1), (-1, -2), 0.5, HexColor("#EEF1F5")),      # row hairlines
        ("LINEABOVE", (0, -1), (-1, -1), 1.0, HexColor(rc.INK)),        # total rule
        ("TOPPADDING", (0, -1), (-1, -1), 9),
    ]
    tbl.setStyle(TableStyle(tstyle))
    story.append(tbl)

    # Notes
    notes = list(spec.get("notes") or [])
    if not any("Cost Explorer" in str(n) for n in notes):
        notes.append("Figures from AWS Cost Explorer (UnblendedCost).")
    story.append(Spacer(1, 16))
    story.append(Paragraph(_track("Notes & methodology"), sec_s))
    for n in notes:
        story.append(Paragraph("\u2013\u2002" + str(n), note_s))

    def _decorate(canvas, _doc):
        canvas.saveState()
        w, h = _doc.pagesize
        canvas.setFillColor(HexColor(rc.ACCENT))
        canvas.roundRect(_doc.leftMargin, h - _doc.topMargin + 16, 28, 3, 1.5, stroke=0, fill=1)
        canvas.setStrokeColor(HexColor(rc.HAIRLINE))
        canvas.setLineWidth(0.6)
        canvas.line(_doc.leftMargin, _doc.bottomMargin - 10, w - _doc.rightMargin, _doc.bottomMargin - 10)
        canvas.setFont(fonts["body"], 7.5)
        canvas.setFillColor(HexColor(rc.FAINT))
        canvas.drawString(_doc.leftMargin, _doc.bottomMargin - 22,
                          "Cloud Bill Analyst  \u00b7  automated cost report")
        canvas.drawRightString(w - _doc.rightMargin, _doc.bottomMargin - 22,
                               f"Page {canvas.getPageNumber()}")
        canvas.restoreState()

    doc.build(story, onFirstPage=_decorate, onLaterPages=_decorate)
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
