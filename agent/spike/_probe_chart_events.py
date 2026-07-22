#!/usr/bin/env python3
"""Verify the entrypoint emits a `chart` SSE event carrying structured spec data
when the agent creates a chart. Live (Bedrock/CE); reads test creds from .env.
"""
import asyncio
import os
import sys
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(ROOT, ".env"))
except Exception:  # noqa: BLE001
    pass
os.environ.setdefault("CBA_DISABLE_MEMORY", "1")

from cloud_bill_analyst.app import invoke  # noqa: E402

ROLE = os.environ.get("CBA_TEST_ROLE_ARN")
EXT = os.environ.get("CBA_TEST_EXTERNAL_ID")
VALID = {"bar", "hbar", "line", "pie"}


async def main():
    if not (ROLE and EXT):
        sys.exit("Set CBA_TEST_ROLE_ARN and CBA_TEST_EXTERNAL_ID (e.g. in agent/.env).")
    payload = {
        "prompt": "Show my top 5 services by cost for last month as a bar chart.",
        "context": {
            "actor_id": "probe-chart-events",
            "role_arn": ROLE,
            "external_id": EXT,
            "display_currency": "USD",
        },
    }
    ctx = types.SimpleNamespace(session_id="probe-chart-events-session-000000001", request_headers={})

    charts, types_seen = [], []
    async for ev in invoke(payload, ctx):
        if not isinstance(ev, dict):
            continue
        t = ev.get("type")
        types_seen.append(t)
        if t == "chart":
            spec = ev.get("spec") or {}
            charts.append(spec)
            print(f"CHART: type={spec.get('chart_type')} title={spec.get('title')!r} "
                  f"labels={len(spec.get('labels') or [])} values={len(spec.get('values') or [])} "
                  f"currency={spec.get('currency')!r}")
        elif t == "error":
            print("ERROR:", ev.get("message"))

    print("\nevent types (last 5):", types_seen[-5:])
    assert charts, "no `chart` event emitted"
    c = charts[0]
    assert c.get("chart_type") in VALID, f"bad chart_type {c.get('chart_type')!r}"
    labels, values = c.get("labels") or [], c.get("values") or []
    assert labels and values and len(labels) == len(values), "labels/values missing or misaligned"
    assert all(isinstance(v, (int, float)) for v in values), "values must be numeric"
    assert types_seen and types_seen[-1] == "done", "did not end with done"
    print("\nCHART EVENT PROBE OK")


if __name__ == "__main__":
    asyncio.run(main())
