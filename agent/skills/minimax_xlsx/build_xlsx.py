#!/usr/bin/env python3
"""minimax-xlsx skill: build a formatted .xlsx AWS cost report (openpyxl).

In-container invocation (subprocess, by the reporting tool):
    python skills/minimax_xlsx/build_xlsx.py --spec /path/spec.json
Writes spec["output_path"] and prints the absolute path on stdout.

Also importable for tests: build_xlsx(spec: dict) -> output_path.

Spec schema (output_path + rows required; rest optional):
{
  "title": str, "subtitle": str,
  "period":   {"start": "YYYY-MM-DD", "end": "YYYY-MM-DD"},
  "currency": {"display": "IDR", "usd_rate": float, "as_of": str},
  "rows":     [{"service": str, "usd": float, "display": float?}],
  "total":    {"usd": float, "display": float?},
  "charts":   ["/abs/chart.png", ...],
  "notes":    [str, ...],
  "output_path": "/abs/out.xlsx"
}
"""
from __future__ import annotations

import argparse
import json
import os
import sys

from openpyxl import Workbook
from openpyxl.drawing.image import Image as XLImage
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side

_HEADER_FILL = PatternFill("solid", fgColor="1F2937")
_HEADER_FONT = Font(bold=True, color="FFFFFF")
_TITLE_FONT = Font(bold=True, size=16)
_SUB_FONT = Font(size=10, color="6B7280")
_BOLD = Font(bold=True)
_THIN = Side(style="thin", color="D1D5DB")
_BORDER = Border(left=_THIN, right=_THIN, top=_THIN, bottom=_THIN)


def build_xlsx(spec: dict) -> str:
    display = (spec.get("currency") or {}).get("display") or "USD"
    show_display = display.upper() != "USD"
    rows = spec.get("rows") or []

    wb = Workbook()
    ws = wb.active
    ws.title = "Cost Report"

    ws["A1"] = spec.get("title") or "AWS Cost Report"
    ws["A1"].font = _TITLE_FONT
    if spec.get("subtitle"):
        ws["A2"] = spec["subtitle"]
        ws["A2"].font = _SUB_FONT

    period = spec.get("period") or {}
    cur = spec.get("currency") or {}
    meta = []
    if period.get("start"):
        meta.append(f"Period: {period['start']} to {period.get('end', '')} (end exclusive)")
    if cur.get("usd_rate"):
        meta.append(f"FX: 1 USD = {float(cur['usd_rate']):,.2f} {display} "
                    f"(as of {cur.get('as_of', '')}, open.er-api.com)")
    if meta:
        ws["A3"] = "   |   ".join(meta)
        ws["A3"].font = _SUB_FONT

    hdr = 5
    headers = ["Service", "Amount (USD)"] + ([f"Amount ({display})"] if show_display else [])
    for c, h in enumerate(headers, start=1):
        cell = ws.cell(row=hdr, column=c, value=h)
        cell.fill = _HEADER_FILL
        cell.font = _HEADER_FONT
        cell.alignment = Alignment(horizontal="center")
        cell.border = _BORDER

    r = hdr + 1
    for row in rows:
        ws.cell(row=r, column=1, value=row.get("service")).border = _BORDER
        c2 = ws.cell(row=r, column=2, value=float(row.get("usd", 0) or 0))
        c2.number_format = "#,##0.00"
        c2.border = _BORDER
        if show_display:
            dv = row.get("display")
            c3 = ws.cell(row=r, column=3, value=float(dv) if dv is not None else None)
            c3.number_format = "#,##0"
            c3.border = _BORDER
        r += 1

    total = spec.get("total") or {}
    if total:
        t1 = ws.cell(row=r, column=1, value="Total")
        t1.font = _BOLD
        t1.border = _BORDER
        t2 = ws.cell(row=r, column=2, value=float(total.get("usd", 0) or 0))
        t2.number_format = "#,##0.00"
        t2.font = _BOLD
        t2.border = _BORDER
        if show_display and total.get("display") is not None:
            t3 = ws.cell(row=r, column=3, value=float(total["display"]))
            t3.number_format = "#,##0"
            t3.font = _BOLD
            t3.border = _BORDER
        r += 1

    ws.column_dimensions["A"].width = 42
    ws.column_dimensions["B"].width = 16
    if show_display:
        ws.column_dimensions["C"].width = 22

    charts = [p for p in (spec.get("charts") or []) if p and os.path.isfile(p)]
    if charts:
        cs = wb.create_sheet("Charts")
        anchor = 1
        for p in charts:
            try:
                cs.add_image(XLImage(p), f"A{anchor}")
                anchor += 24
            except Exception as e:  # noqa: BLE001
                print(f"warn: could not embed chart {p}: {e}", file=sys.stderr)

    notes = spec.get("notes") or []
    if notes:
        r += 1
        ws.cell(row=r, column=1, value="Notes").font = _BOLD
        r += 1
        for n in notes:
            ws.cell(row=r, column=1, value=f"- {n}")
            r += 1

    out = spec["output_path"]
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    wb.save(out)
    return os.path.abspath(out)


def main():
    ap = argparse.ArgumentParser(description="Build an .xlsx cost report")
    ap.add_argument("--spec", required=True, help="path to spec JSON")
    args = ap.parse_args()
    with open(args.spec, encoding="utf-8") as f:
        spec = json.load(f)
    print(build_xlsx(spec))


if __name__ == "__main__":
    main()
