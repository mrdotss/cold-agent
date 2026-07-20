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
_CHART_BODY = r'''
import io, base64
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.ticker import FuncFormatter

labels = [str(x) for x in spec["labels"]]
values = [float(x) for x in spec["values"]]
ctype = spec.get("chart_type", "bar")
title = spec.get("title", "")
currency = spec.get("currency", "")
xlabel = spec.get("x_label") or ""
ylabel = spec.get("y_label") or (("Amount (" + currency + ")") if currency else "Amount")

fig, ax = plt.subplots(figsize=(8, 4.5))
if ctype == "pie":
    ax.pie(values, labels=labels, autopct="%1.1f%%", startangle=90)
    ax.axis("equal")
    ax.set_title(title)
elif ctype == "line":
    ax.plot(labels, values, marker="o")
    ax.set_title(title); ax.set_xlabel(xlabel); ax.set_ylabel(ylabel)
    ax.grid(True, alpha=0.3)
    for t in ax.get_xticklabels():
        t.set_rotation(30); t.set_ha("right")
elif ctype == "hbar":
    ax.barh(labels, values); ax.invert_yaxis()
    ax.set_title(title); ax.set_xlabel(ylabel); ax.set_ylabel(xlabel)
else:
    ax.bar(labels, values)
    ax.set_title(title); ax.set_xlabel(xlabel); ax.set_ylabel(ylabel)
    for t in ax.get_xticklabels():
        t.set_rotation(30); t.set_ha("right")

if currency and ctype in ("bar", "hbar", "line"):
    axis = ax.xaxis if ctype == "hbar" else ax.yaxis
    axis.set_major_formatter(FuncFormatter(lambda v, pos: format(v, ",.0f")))

fig.tight_layout()
buf = io.BytesIO()
fig.savefig(buf, format="png", dpi=130)
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
                    executor: Optional[Callable[[str], str]] = None) -> Callable:
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
        spec = {
            "title": title,
            "labels": labels,
            "values": values,
            "chart_type": (chart_type or "bar").lower(),
            "currency": currency or "",
            "x_label": x_label,
            "y_label": y_label,
        }
        return run_chart(context, config, spec, executor=executor)

    return create_chart
