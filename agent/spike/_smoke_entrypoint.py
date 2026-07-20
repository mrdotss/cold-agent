#!/usr/bin/env python3
"""Task 2 smoke test (direct): iterate the app entrypoint async generator with a
fake payload/context (no HTTP, no memory). Validates parse -> agent -> stream ->
SSE-event logic against live Bedrock (Kimi K2.5)."""
import asyncio
import os
import sys
import types

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("CBA_DISABLE_MEMORY", "1")  # no AWS memory in this smoke

from cloud_bill_analyst.app import invoke  # noqa: E402


async def main():
    payload = {
        "prompt": "Hi! In one short sentence, what can you help me with?",
        "context": {"actor_id": "smoke-user", "account_alias": "demo"},
    }
    ctx = types.SimpleNamespace(session_id="smoke-session", request_headers={})
    types_seen, text = [], ""
    async for ev in invoke(payload, ctx):
        if isinstance(ev, dict):
            types_seen.append(ev.get("type"))
            if ev.get("type") == "delta":
                text += ev.get("text", "")
            elif ev.get("type") == "error":
                print("ERROR EVENT:", ev)
    print("TYPES:", types_seen[:3], "...", types_seen[-1:] if types_seen else [])
    print("TEXT:", text[:240])
    assert "delta" in types_seen, "no delta events"
    assert types_seen and types_seen[-1] == "done", "did not end with done"
    assert text.strip(), "no streamed text"
    print("\nDIRECT SMOKE OK")


if __name__ == "__main__":
    asyncio.run(main())
