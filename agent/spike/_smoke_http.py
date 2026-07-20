#!/usr/bin/env python3
"""Task 2 smoke test (HTTP/SSE): exercise the full BedrockAgentCoreApp server
path in-process via Starlette TestClient - routing, async-gen bridging, and SSE
formatting - exactly as the container will serve it. Live Bedrock (Kimi K2.5)."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("CBA_DISABLE_MEMORY", "1")

from starlette.testclient import TestClient  # noqa: E402

from cloud_bill_analyst.app import app  # noqa: E402

client = TestClient(app)

r = client.get("/ping")
print("PING:", r.status_code, r.json())
assert r.status_code == 200

payload = {
    "prompt": "Hi! In one short sentence, what can you help me with?",
    "context": {"actor_id": "smoke-user"},
}
r = client.post(
    "/invocations",
    json=payload,
    headers={"X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": "smoke-http-sess"},
)
print("INVOKE:", r.status_code, "content-type:", r.headers.get("content-type"))
assert r.status_code == 200

types_seen, text = [], ""
for line in r.text.splitlines():
    if line.startswith("data: "):
        obj = json.loads(line[len("data: "):])
        if isinstance(obj, dict):
            types_seen.append(obj.get("type"))
            if obj.get("type") == "delta":
                text += obj.get("text", "")
            elif obj.get("type") == "error":
                print("ERROR EVENT:", obj)

print("TYPES:", types_seen)
print("TEXT:", text[:240])
assert "text/event-stream" in (r.headers.get("content-type") or "")
assert "delta" in types_seen and "done" in types_seen
assert text.strip()
print("\nHTTP SMOKE OK")
