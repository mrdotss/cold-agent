#!/usr/bin/env python3
"""Live Task 5 probe: render a real chart via the managed Code Interpreter and
verify a valid PNG lands in the container artifact dir."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from cloud_bill_analyst.config import Config  # noqa: E402
from cloud_bill_analyst.runtime_context import RuntimeContext  # noqa: E402
from cloud_bill_analyst.tools.charts import run_chart  # noqa: E402


def main():
    cfg = Config.from_env()
    ctx = RuntimeContext(actor_id="probe-user", session_id="probe-sess")
    spec = {
        "title": "AWS Spend by Service - June 2026",
        "labels": ["Claude Opus 4.8", "Tax", "Claude Sonnet 4.6", "Claude Sonnet 4.5"],
        "values": [112.66, 14.74, 11.90, 7.68],
        "chart_type": "bar",
        "currency": "USD",
    }
    res = run_chart(ctx, cfg, spec)
    print("RESULT:", {k: v for k, v in res.items() if k != "detail"})
    assert "error" not in res, res
    assert os.path.isfile(res["path"]), "chart file missing"
    with open(res["path"], "rb") as f:
        raw = f.read()
    assert raw[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG"
    print(f"\nCHART PROBE OK  path={res['path']}  bytes={len(raw)}")


if __name__ == "__main__":
    main()
