"""Chart tool (Task 5): render labeled, currency-aware charts via the managed
Code Interpreter (which has NO network) and return a small file reference.

Flow: build matplotlib code -> run in CI -> code prints the PNG as base64 to
stdout -> we decode it in the container and write a PNG to the per-session
artifact dir -> return {chart_id, path, ...} to the model (NOT the base64, to
avoid bloating the model context). The report skills (Task 8) embed the file.
"""
from __future__ import annotations

import base64
import json
import logging
import os
import uuid
from typing import Any, Callable, List, Optional

from ..config import Config
from ..runtime_context import RuntimeContext
from .artifacts import artifact_dir

log = logging.getLogger("cba.tools.charts")

VALID_CHART_TYPES = {"bar", "hbar", "line", "pie"}
_B64_START = "B64START"
_B64_END = "B64END"

# Plain (non-f) template; references a `spec` dict injected as a JSON literal.
# Style mirrors skills/report_common.py (editorial indigo). Runs in the isolated
# Code Interpreter, so the palette is embedded (it cannot import our modules).
_CHART_BODY = r'''
import io, base64
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.ticker import FuncFormatter

INK = "#0B1220"; MUTED = "#6B7280"; HAIR = "#E9ECF2"; ACCENT = "#4F46E5"
MUTE = "#C7D2FE"
RAMP = ["#312E81", "#4338CA", "#4F46E5", "#6366F1", "#818CF8", "#A5B4FC", "#C7D2FE", "#DDE1F3"]

plt.rcParams.update({
    "font.size": 11, "text.color": INK, "axes.edgecolor": HAIR,
    "axes.labelcolor": MUTED, "xtick.color": MUTED, "ytick.color": MUTED,
    "axes.titlesize": 14.5, "axes.titleweight": "bold", "figure.dpi": 200,
})

labels = [str(x) for x in spec["labels"]]
values = [float(x) for x in spec["values"]]
ctype = spec.get("chart_type", "bar")
title = spec.get("title", "")
currency = spec.get("currency", "")

def _sym(c):
    return {"USD": "$", "IDR": "Rp", "EUR": "\u20ac", "GBP": "\u00a3",
            "JPY": "\u00a5"}.get((c or "").upper(), (c or ""))

def _num(v, short=True):
    a = abs(v)
    if a >= 1e12: return "%.1fT" % (v / 1e12)
    if a >= 1e9: return "%.1fB" % (v / 1e9)
    if a >= 1e6: return "%.1fM" % (v / 1e6)
    if a >= 1e3: return "%.1fK" % (v / 1e3) if short else format(v, ",.0f")
    return format(v, ",.0f") if a >= 100 else ("%.2f" % v)

def _lab(v):
    s = _sym(currency); sp = " " if s[-1:].isalpha() else ""
    return (s + sp + _num(v)) if s else _num(v)

def _clean(ax, keep):
    for sp in ("top", "right", "left", "bottom"):
        ax.spines[sp].set_visible(sp == keep)
    if keep:
        ax.spines[keep].set_color(HAIR)
    ax.tick_params(length=0)
    ax.set_axisbelow(True)

fig, ax = plt.subplots(figsize=(8.6, 4.8))

if ctype == "pie":
    cols = [RAMP[i % len(RAMP)] for i in range(len(values))]
    wedges, _t = ax.pie(values, colors=cols, startangle=90, counterclock=False,
                        wedgeprops=dict(width=0.40, edgecolor="white", linewidth=2))
    ax.axis("equal")
    tot = sum(values) or 1.0
    ax.text(0, 0.08, _lab(tot), ha="center", va="center", fontsize=15,
            fontweight="bold", color=INK)
    ax.text(0, -0.16, "TOTAL", ha="center", va="center", fontsize=8.5, color=MUTED)
    leg = ["%s  %.0f%%" % (lab, (v / tot * 100)) for lab, v in zip(labels, values)]
    ax.legend(wedges, leg, loc="center left", bbox_to_anchor=(1.0, 0.5),
              frameon=False, fontsize=9.5)
    ax.set_title(title, loc="left", pad=14, color=INK)

elif ctype == "line":
    x = list(range(len(labels)))
    ax.plot(x, values, color=ACCENT, linewidth=2.4, marker="o", markersize=5,
            markerfacecolor="white", markeredgecolor=ACCENT, markeredgewidth=1.6, zorder=3)
    ax.fill_between(x, values, color=ACCENT, alpha=0.08, zorder=2)
    ax.set_xticks(x); ax.set_xticklabels(labels)
    ax.yaxis.grid(True, color=HAIR, linewidth=1, zorder=0)
    _clean(ax, "bottom")
    ax.yaxis.set_major_formatter(FuncFormatter(lambda v, p: _num(v)))
    for t in ax.get_xticklabels():
        t.set_rotation(18); t.set_ha("right"); t.set_fontsize(10)
    ax.margins(y=0.16)
    ax.set_title(title, loc="left", pad=14, color=INK)

elif ctype == "hbar":
    y = list(range(len(labels)))
    mx = max(values) if values else 0
    cols = [ACCENT if v >= mx else MUTE for v in values]
    bars = ax.barh(y, values, color=cols, height=0.62, zorder=3)
    ax.set_yticks(y); ax.set_yticklabels(labels); ax.invert_yaxis()
    ax.xaxis.grid(True, color=HAIR, linewidth=1, zorder=0)
    _clean(ax, "left")
    ax.xaxis.set_major_formatter(FuncFormatter(lambda v, p: _num(v)))
    for rect, v in zip(bars, values):
        ax.annotate(_lab(v), (v, rect.get_y() + rect.get_height() / 2),
                    xytext=(5, 0), textcoords="offset points", va="center", ha="left",
                    fontsize=9, color=INK, fontweight="bold")
    ax.margins(x=0.16)
    ax.set_title(title, loc="left", pad=14, color=INK)

else:  # bar
    x = list(range(len(labels)))
    mx = max(values) if values else 0
    cols = [ACCENT if v >= mx else MUTE for v in values]
    bars = ax.bar(x, values, color=cols, width=0.66, zorder=3)
    ax.set_xticks(x); ax.set_xticklabels(labels)
    ax.yaxis.grid(True, color=HAIR, linewidth=1, zorder=0)
    _clean(ax, "bottom")
    ax.yaxis.set_major_formatter(FuncFormatter(lambda v, p: _num(v)))
    for rect, v in zip(bars, values):
        ax.annotate(_lab(v), (rect.get_x() + rect.get_width() / 2, v),
                    xytext=(0, 4), textcoords="offset points", ha="center", va="bottom",
                    fontsize=9, color=INK, fontweight="bold")
    for t in ax.get_xticklabels():
        t.set_rotation(18); t.set_ha("right"); t.set_fontsize(10)
    ax.margins(y=0.18)
    ax.set_title(title, loc="left", pad=14, color=INK)

buf = io.BytesIO()
fig.savefig(buf, format="png", dpi=200, bbox_inches="tight", pad_inches=0.28, facecolor="white")
plt.close(fig)
print("B64START" + base64.b64encode(buf.getvalue()).decode() + "B64END")
'''


def build_chart_code(spec: dict) -> str:
    """Generate self-contained matplotlib code. The spec is injected as a JSON
    string literal (repr) so labels/titles cannot inject code."""
    spec_literal = repr(json.dumps(spec))
    return f"import json\nspec = json.loads({spec_literal})\n" + _CHART_BODY


def extract_stdout(res: Any) -> str:
    """Concatenate text output from a CI execute_code result (or event list)."""
    parts: List[str] = []
    stream = res.get("stream") if isinstance(res, dict) else res
    if stream is None:
        return ""
    for event in stream:
        if not isinstance(event, dict):
            continue
        result = event.get("result") or {}
        for item in result.get("content", []) or []:
            if isinstance(item, dict) and item.get("type") == "text" and "text" in item:
                parts.append(item["text"])
        sc = result.get("structuredContent") or {}
        if isinstance(sc, dict) and sc.get("stdout"):
            parts.append(str(sc["stdout"]))
    return "\n".join(parts)


def extract_image(stdout: str) -> Optional[str]:
    if not stdout or _B64_START not in stdout or _B64_END not in stdout:
        return None
    return stdout.split(_B64_START, 1)[1].split(_B64_END, 1)[0].strip()


def default_executor(config: Config) -> Callable[[str], str]:
    def run(code: str) -> str:
        from bedrock_agentcore.tools.code_interpreter_client import code_session
        with code_session(config.region) as ci:
            res = ci.execute_code(code)
            return extract_stdout(res)
    return run


def run_chart(context: RuntimeContext, config: Config, spec: dict,
              executor: Optional[Callable[[str], str]] = None) -> dict:
    labels = spec.get("labels") or []
    values = spec.get("values") or []
    if not labels or not values or len(labels) != len(values):
        return {"error": "chart needs equal-length, non-empty labels and values"}
    if spec.get("chart_type", "bar") not in VALID_CHART_TYPES:
        return {"error": f"invalid chart_type; use one of {sorted(VALID_CHART_TYPES)}"}

    code = build_chart_code(spec)
    ex = executor or default_executor(config)
    try:
        stdout = ex(code)
    except Exception as e:  # noqa: BLE001
        return {"error": context.redact(f"chart execution failed: {type(e).__name__}: {e}")}

    b64 = extract_image(stdout)
    if not b64:
        return {"error": "chart generation produced no image", "detail": (stdout or "")[-400:]}
    try:
        raw = base64.b64decode(b64)
    except Exception as e:  # noqa: BLE001
        return {"error": f"invalid chart image data: {e}"}

    chart_id = uuid.uuid4().hex[:12]
    path = os.path.join(artifact_dir(context), f"chart-{chart_id}.png")
    with open(path, "wb") as f:
        f.write(raw)
    log.info("chart written: %s (%d bytes)", os.path.basename(path), len(raw))
    return {
        "chart_id": chart_id,
        "path": path,
        "media_type": "image/png",
        "title": spec.get("title"),
        "chart_type": spec.get("chart_type", "bar"),
        "points": len(labels),
        "note": "Pass this path to the report tool to embed the chart. Do not paste image data into your reply.",
    }


def make_chart_tool(context: RuntimeContext, config: Config,
                    executor: Optional[Callable[[str], str]] = None,
                    registry: Optional[list] = None) -> Callable:
    from strands import tool

    @tool
    def create_chart(
        title: str,
        labels: List[str],
        values: List[float],
        chart_type: str = "bar",
        currency: str = "USD",
        x_label: Optional[str] = None,
        y_label: Optional[str] = None,
    ) -> dict:
        """Render a labeled chart image from numeric data using the sandboxed code
        interpreter, and return a file reference to embed in reports.

        Always give a clear title; the currency is shown in the value-axis labels.
        Use this to visualize cost breakdowns (bar/hbar/pie) or trends (line).

        Args:
            title: Chart title (required, descriptive).
            labels: Category labels (e.g. service names or dates).
            values: Numeric values aligned 1:1 with labels (e.g. costs).
            chart_type: bar (default), hbar, line, or pie.
            currency: Currency code shown in axis labels (e.g. USD, IDR). Use "" for none/pie.
            x_label: Optional x-axis label.
            y_label: Optional y-axis label (defaults to "Amount (<currency>)").

        Returns {chart_id, path, media_type, title, chart_type, points} or {error}.
        The returned path is a container file to hand to the report tool - do not
        paste image bytes into your reply.
        """
        ctype = (chart_type or "bar").lower()
        spec = {
            "title": title,
            "labels": labels,
            "values": values,
            "chart_type": ctype,
            "currency": currency or "",
            "x_label": x_label,
            "y_label": y_label,
        }
        # Register a client-render spec so the web UI can draw this chart INLINE
        # (interactive, themed) from data - independent of the PNG render, which is
        # only needed to embed static charts into PDF/XLSX reports.
        if registry is not None:
            try:
                if labels and values and len(labels) == len(values) and ctype in VALID_CHART_TYPES:
                    registry.append({
                        "id": uuid.uuid4().hex[:12],
                        "chart_type": ctype,
                        "title": title,
                        "currency": currency or "",
                        "labels": [str(x) for x in labels],
                        "values": [float(x) for x in values],
                    })
            except Exception:  # noqa: BLE001
                log.warning("could not register inline chart spec", exc_info=True)
        return run_chart(context, config, spec, executor=executor)

    return create_chart
