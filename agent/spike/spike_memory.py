#!/usr/bin/env python3
"""
Task 1b validation spike: AgentCore Memory read/write on MRMemory-AgcOp32p44.

Validates the short-term (raw event) store used for conversation history:
  1. memory_write   - create_event writes conversational turns.
  2. memory_read    - list_events reads them back with payloads.
  3. memory_cleanup - delete_event removes the test events (leave no trace).

Uses clearly-namespaced throwaway actor/session IDs; events also auto-expire in
30 days. No memory strategy required here (semantic strategy is Task 9).

Env:
  AWS_REGION     default us-east-1
  AWS_MEMORY_ID  default MRMemory-AgcOp32p44
"""
import datetime
import os
import sys
import time
import uuid

import boto3
from botocore.config import Config

REGION = os.environ.get("AWS_REGION", "us-east-1")
MEMORY_ID = os.environ.get("AWS_MEMORY_ID", "MRMemory-AgcOp32p44")

dp = boto3.client(
    "bedrock-agentcore", region_name=REGION,
    config=Config(retries={"max_attempts": 3, "mode": "adaptive"}, read_timeout=60),
)

ACTOR_ID = "spike-actor-" + uuid.uuid4().hex[:8]
SESSION_ID = "spike-session-" + uuid.uuid4().hex[:8]

results = {}


def check(name, ok, detail=""):
    results[name] = (bool(ok), detail)
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" :: {detail}" if detail else ""))


# ---- client-side introspection of the exact conversational shape / role enum ----
sm = dp.meta.service_model
conv_shape = sm.operation_model("CreateEvent").input_shape.members["payload"].member.members["conversational"]
content_members = list(getattr(conv_shape.members["content"], "members", {}).keys())
role_enum = getattr(conv_shape.members["role"], "enum", None)
print(f"conversational.content members = {content_members}")
print(f"conversational.role enum       = {role_enum}")
print(f"actorId={ACTOR_ID} sessionId={SESSION_ID} memoryId={MEMORY_ID}")

created = []


def write_turn(role, text):
    resp = dp.create_event(
        memoryId=MEMORY_ID,
        actorId=ACTOR_ID,
        sessionId=SESSION_ID,
        eventTimestamp=datetime.datetime.now(datetime.timezone.utc),
        payload=[{"conversational": {"role": role, "content": {"text": text}}}],
    )
    event = resp.get("event", resp)
    eid = event.get("eventId")
    created.append(eid)
    return eid


def test_write():
    e1 = write_turn("USER", "spike: my preferred display currency is IDR")
    e2 = write_turn("ASSISTANT", "spike: understood, I will present amounts in IDR from now on")
    check("memory_write", bool(e1) and bool(e2), f"eventIds={created}")


def test_read():
    time.sleep(2)  # allow for read-after-write consistency
    resp = dp.list_events(
        memoryId=MEMORY_ID, sessionId=SESSION_ID, actorId=ACTOR_ID,
        includePayloads=True, maxResults=20,
    )
    events = resp.get("events", [])
    pairs = []
    for ev in events:
        for p in ev.get("payload", []) or []:
            conv = p.get("conversational")
            if conv:
                pairs.append((conv.get("role"), (conv.get("content") or {}).get("text")))
    ok = len(events) >= 2 and any("IDR" in (t or "") for _, t in pairs)
    check("memory_read", ok, f"events={len(events)} sample={pairs[:2]}")


def cleanup():
    ids = [e for e in created if e]
    deleted = 0
    for eid in ids:
        try:
            dp.delete_event(memoryId=MEMORY_ID, sessionId=SESSION_ID, actorId=ACTOR_ID, eventId=eid)
            deleted += 1
        except Exception as e:
            print(f"  cleanup delete failed for {eid}: {type(e).__name__}: {e}")
    check("memory_cleanup", deleted == len(ids) and len(ids) > 0, f"deleted={deleted}/{len(ids)}")


def main():
    print(f"== Memory spike :: region={REGION} ==")
    try:
        test_write()
    except Exception as e:
        check("memory_write", False, f"{type(e).__name__}: {e}")
    try:
        test_read()
    except Exception as e:
        check("memory_read", False, f"{type(e).__name__}: {e}")
    try:
        cleanup()
    except Exception as e:
        check("memory_cleanup", False, f"{type(e).__name__}: {e}")

    print("\n== SUMMARY ==")
    for k, (ok, _) in results.items():
        print(f"  {k}: {'PASS' if ok else 'FAIL'}")
    failed = [k for k, (ok, _) in results.items() if not ok]
    if failed:
        print(f"\nFAILED: {failed}")
        sys.exit(1)
    print("\nALL PASS")


if __name__ == "__main__":
    main()
