"""Shared helpers for the report skills (minimax_pdf / minimax_xlsx).

Stdlib-only so it is cheap to import from either skill subprocess and from tests.
Provides the report palette, currency / percent formatting, derived insight
computation (nothing is fabricated - every number is derived from the spec rows),
KPI-card content, and discovery of the bundled premium font files.

Both build scripts add the parent ``skills/`` directory to ``sys.path`` and then
``import report_common``.
"""
from __future__ import annotations

import os
from typing import Any, Dict, List, Optional, Tuple

# --- Palette: editorial "soft structuralism" - white ground, indigo accent -----
INK = "#0B1220"          # near-black, headings / big numbers
BODY = "#1F2937"         # body text
MUTED = "#6B7280"        # secondary labels
FAINT = "#9CA3AF"        # tertiary / footer
HAIRLINE = "#E5E7EB"     # thin rules / separators
PANEL = "#F7F8FA"        # card ground
ZEBRA = "#FAFBFC"        # subtle banding
ACCENT = "#4F46E5"       # indigo-600
ACCENT_DK = "#3730A3"    # indigo-800
ACCENT_TINT = "#EEF2FF"  # indigo-50 (insight panel ground)
POSITIVE = "#059669"     # emerald (savings)
CRITICAL = "#E11D48"     # rose (spikes)

# A cohesive indigo->violet->slate ramp for chart series (dark = larger).
CHART_RAMP = ["#312E81", "#4338CA", "#4F46E5", "#6366F1", "#818CF8",
              "#A5B4FC", "#C7D2FE", "#DDE1F3"]

FONT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "fonts")
_FONT_FILES = {
    "regular": "PlusJakartaSans-Regular.ttf",
    "medium": "PlusJakartaSans-Medium.ttf",
    "semibold": "PlusJakartaSans-SemiBold.ttf",
    "bold": "PlusJakartaSans-Bold.ttf",
    "extrabold": "PlusJakartaSans-ExtraBold.ttf",
}

_SYM = {"USD": "$", "IDR": "Rp", "EUR": "\u20ac", "GBP": "\u00a3",
        "JPY": "\u00a5", "AUD": "A$", "SGD": "S$", "INR": "\u20b9"}


def font_files() -> Dict[str, str]:
    """Return {weight: abspath} for bundled premium fonts that actually exist."""
    out: Dict[str, str] = {}
    for w, fn in _FONT_FILES.items():
        p = os.path.join(FONT_DIR, fn)
        if os.path.isfile(p):
            out[w] = p
    return out


def _f(x: Any) -> float:
    try:
        return float(x)
    except (TypeError, ValueError):
        return 0.0


def _sym(code: Optional[str]) -> str:
    return _SYM.get((code or "USD").upper(), (code or "").upper())


def money(v: Any, code: str = "USD", decimals: Optional[int] = None) -> str:
    """Grouped number, no symbol. USD -> 2 decimals, others -> 0 by default."""
    if decimals is None:
        decimals = 2 if (code or "USD").upper() == "USD" else 0
    return f"{_f(v):,.{decimals}f}"


def money_sym(v: Any, code: str = "USD", decimals: Optional[int] = None) -> str:
    s = _sym(code)
    body = money(v, code, decimals)
    return f"{s} {body}" if s[-1:].isalpha() else f"{s}{body}"


def compact(v: Any, code: str = "USD") -> str:
    """Short currency form for headline KPIs, e.g. Rp 22.2M / $1.4K."""
    v = _f(v)
    s = _sym(code)
    a = abs(v)
    num = None
    for div, suf in ((1e12, "T"), (1e9, "B"), (1e6, "M"), (1e3, "K")):
        if a >= div:
            num = f"{v / div:.1f}{suf}"
            break
    if num is None:
        num = f"{v:,.{2 if (code or 'USD').upper() == 'USD' else 0}f}"
    return f"{s} {num}" if s[-1:].isalpha() else f"{s}{num}"


def pct(x: Any, digits: Optional[int] = None) -> str:
    p = _f(x) * 100
    if digits is None:
        digits = 1 if abs(p) < 10 else 0
    return f"{p:.{digits}f}%"


def truncate(s: Any, n: int = 22) -> str:
    s = str(s or "")
    return s if len(s) <= n else s[: max(1, n - 1)].rstrip() + "\u2026"


def sorted_rows(rows: Optional[List[dict]]) -> List[dict]:
    """Rows sorted by USD desc (defensive - the tool is asked for largest-first)."""
    return sorted(list(rows or []), key=lambda r: _f(r.get("usd")), reverse=True)


def compute_insights(rows: Optional[List[dict]], total: Optional[dict],
                     display_code: str = "USD", show_display: bool = False,
                     usd_rate: Optional[float] = None) -> Dict[str, Any]:
    """Derive headline metrics + human-readable bullets from the spec rows.

    All figures are computed from the provided USD amounts; nothing is invented.
    """
    pairs: List[Tuple[str, float]] = [(str(r.get("service", "")), _f(r.get("usd")))
                                      for r in (rows or [])]
    pairs.sort(key=lambda p: p[1], reverse=True)
    n = len(pairs)
    tot = _f((total or {}).get("usd")) or sum(v for _, v in pairs) or 1e-9
    top_name, top_usd = pairs[0] if pairs else ("-", 0.0)
    top_share = top_usd / tot
    top3 = sum(v for _, v in pairs[:3]) / tot
    top5 = sum(v for _, v in pairs[:5]) / tot
    tail_n = max(0, n - 5)
    tail_share = max(0.0, 1.0 - top5)
    avg = tot / n if n else 0.0

    metrics: Dict[str, Any] = dict(
        n=n, total_usd=tot, top_name=top_name, top_usd=top_usd, top_share=top_share,
        top3_share=top3, top5_share=top5, tail_n=tail_n, tail_share=tail_share, avg=avg,
    )

    bullets: List[str] = []
    if pairs:
        bullets.append(
            f"{truncate(top_name, 42)} is the single largest cost at "
            f"{money_sym(top_usd)} ({pct(top_share)} of total spend).")
        if n >= 3:
            tail = (f", leaving {tail_n} smaller services at {pct(tail_share)}."
                    if tail_n > 0 else ".")
            bullets.append(f"The top 3 services drive {pct(top3)} of the bill{tail}")
        if top_share >= 0.5:
            bullets.append(
                "Spend is highly concentrated - one service alone exceeds half of "
                "total cost, so Savings Plans or Reserved capacity there return the most.")
        elif n > 1:
            bullets.append(
                f"Spend is spread across {n} services (average {money_sym(avg)} each) "
                "with no single runaway driver.")
        if show_display and usd_rate:
            bullets.append(
                f"Figures are reported in {display_code.upper()} at "
                f"1 USD = {money(usd_rate, display_code, 2)} {display_code.upper()}.")
    metrics["bullets"] = bullets[:5]
    return metrics


def kpi_cards(metrics: Dict[str, Any], total: Optional[dict],
              display_code: str = "USD", show_display: bool = False) -> List[Dict[str, Any]]:
    """Four headline KPI cards as pure data (rendered by both PDF and XLSX)."""
    n = metrics["n"]
    tot = metrics["total_usd"]
    disp_tot = _f((total or {}).get("display"))
    cards: List[Dict[str, Any]] = []
    if show_display and disp_tot:
        cards.append(dict(label="Total spend", value=compact(disp_tot, display_code),
                          sub=f"~ {money_sym(tot)}", accent=True))
    else:
        cards.append(dict(label="Total spend", value=money_sym(tot),
                          sub=f"{n} services tracked", accent=True))
    cards.append(dict(label="Top service", value=truncate(metrics["top_name"], 16),
                      sub=f"{pct(metrics['top_share'])} · {money_sym(metrics['top_usd'])}",
                      size=13.0))
    cards.append(dict(label="Top-3 share", value=pct(metrics["top3_share"]),
                      sub=f"of {n} services"))
    cards.append(dict(label="Services", value=str(n), sub="line items"))
    return cards
