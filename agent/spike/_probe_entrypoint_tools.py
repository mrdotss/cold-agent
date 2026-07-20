#!/usr/bin/env python3
"""Local end-to-end of the entrypoint WITH tools, to verify the new `tool`
(activity) SSE events + `report_file` fire correctly - before redeploying.

Reads the test connected-account creds from agent/.env (git-ignored):
    CBA_TEST_ROLE_ARN, CBA_TEST_EXTERNAL_ID
so no secret is hardcoded. Live: Bedrock (Kimi), AssumeRole, Cost Explorer,
(maybe) Code Interpreter, S3.
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


async def main():
    if not (ROLE and EXT):
        sys.exit("Set CBA_TEST_ROLE_ARN and CBA_TEST_EXTERNAL_ID (e.g. in agent/.env).")
    payload = {
        "prompt": "Analyze last month's AWS spend by service, then generate a PDF report. Keep it brief.",
        "context": {
            "actor_id": "probe-tool-events",
            "role_arn": ROLE,
            "external_id": EXT,
            "account_alias": "self",
            "report_bucket": "mr-harness",
            "report_prefix": "cloud-bill-analyst/reports/",
            "display_currency": "IDR",
        },
    }
    ctx = types.SimpleNamespace(session_id="probe-tool-events-session-0000000001", request_headers={})

    types_seen, text, tools, reports = [], "", [], []
    async for ev in invoke(payload, ctx):
        if not isinstance(ev, dict):
            continue
        t = ev.get("type")
        types_seen.append(t)
        if t == "tool":
            tools.append((ev.get("phase"), ev.get("name"), ev.get("label"), ev.get("status")))
            print(f"TOOL {ev.get('phase'):5s} {ev.get('name'):20s} label={ev.get('label')!r} status={ev.get('status')!r}")
        elif t == "delta":
            text += ev.get("text", "")
        elif t == "report_file":
            reports.append(ev.get("key"))
            print("REPORT_FILE:", ev.get("key"), "bucket=", ev.get("bucket"))
        elif t == "error":
            print("ERROR:", ev.get("message"))

    print("\n--- ANSWER (first 400 chars) ---\n" + text[:400])
    starts = [x for x in tools if x[0] == "start"]
    ends = [x for x in tools if x[0] == "end"]
    print("\nSUMMARY")
    print("  tool starts:", [x[1] for x in starts])
    print("  tool ends  :", [x[1] for x in ends])
    print("  reports    :", reports)
    print("  ended with :", types_seen[-1] if types_seen else None)
    assert starts, "no tool start events - activity timeline would be empty"
    assert types_seen and types_seen[-1] == "done", "did not end with done"
    print("\nENTRYPOINT TOOL-EVENT PROBE OK")


if __name__ == "__main__":
    asyncio.run(main())
