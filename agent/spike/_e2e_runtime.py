#!/usr/bin/env python3
"""Task 13 - AgentCore-only e2e tests against the DEPLOYED runtime.

Invokes cloud_bill_analyst via InvokeAgentRuntime and validates:
  A. payload + streaming (basic)
  B. cost tool + dual-currency presentation (cross-account assume from runtime)
  C. session memory across two invocations in one session
  D. report -> [REPORT_FILE] marker -> S3 object + owner metadata + presigned download

Usage: python spike/_e2e_runtime.py --role-arn <arn> --external-id <id>
Secrets passed as args; never printed.
"""
import argparse
import json
import os
import sys
import time
import urllib.request
import uuid

import boto3
from botocore.config import Config as BotoConfig

REGION = "us-east-1"
RUNTIME_ARN = os.environ.get(
    "CBA_RUNTIME_ARN",
    "arn:aws:bedrock-agentcore:us-east-1:279199663312:runtime/cloud_bill_analyst-Dn7a652NZj",
)
REPORT_BUCKET = "mr-harness"

dp = boto3.client("bedrock-agentcore", region_name=REGION,
                  config=BotoConfig(read_timeout=300, retries={"max_attempts": 1}))
s3 = boto3.client("s3", region_name=REGION)

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(f"[{'PASS' if ok else 'FAIL'}] {name} :: {str(detail)[:300]}")


def new_session():
    return "cba-e2e-" + uuid.uuid4().hex + uuid.uuid4().hex  # >= 33 chars


def invoke(prompt, context, session_id):
    payload = json.dumps({"prompt": prompt, "context": context}).encode("utf-8")
    resp = dp.invoke_agent_runtime(
        agentRuntimeArn=RUNTIME_ARN,
        runtimeSessionId=session_id,
        payload=payload,
        contentType="application/json",
        accept="text/event-stream",
    )
    body = resp["response"].read()
    if isinstance(body, (bytes, bytearray)):
        body = body.decode("utf-8", "replace")
    text, events, report_keys = "", [], []
    for line in body.splitlines():
        line = line.strip()
        if not line.startswith("data:"):
            continue
        raw = line[len("data:"):].strip()
        try:
            obj = json.loads(raw)
        except Exception:
            continue
        events.append(obj)
        if isinstance(obj, dict):
            if obj.get("type") == "delta":
                text += obj.get("text", "")
            elif obj.get("type") == "report_file" and obj.get("key"):
                report_keys.append(obj["key"])
    return text, events, report_keys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--role-arn", default=os.environ.get("ROLE_ARN"))
    ap.add_argument("--external-id", default=os.environ.get("EXTERNAL_ID"))
    args = ap.parse_args()
    role, ext = args.role_arn, args.external_id
    assert role and ext, "need --role-arn and --external-id"
    print(f"runtime = {RUNTIME_ARN}")

    # A. basic streaming
    try:
        t, evs, _ = invoke("Hello! In one sentence, what can you help me with?",
                           {"actor_id": "e2e-basic"}, new_session())
        types = [e.get("type") for e in evs]
        check("A_basic_stream", "delta" in types and types[-1:] == ["done"] and bool(t.strip()),
              f"types={types[:3]}..{types[-1:]} text={t[:100]}")
    except Exception as e:
        check("A_basic_stream", False, f"{type(e).__name__}: {e}")

    # B. cost tool + dual currency
    try:
        t, evs, _ = invoke("What did I spend last month? Show the top 3 services in USD and IDR.",
                           {"actor_id": "e2e-cost", "role_arn": role, "external_id": ext,
                            "display_currency": "IDR", "account_alias": "e2e-acct"}, new_session())
        ok = ("$" in t) and ("Rp" in t or "IDR" in t)
        check("B_cost_dualcurrency", ok, t[:220])
        # non-disclosure: secrets must not appear
        check("B_no_secret_leak", role not in t and ext not in t, "checked ARN/external-id absent")
    except Exception as e:
        check("B_cost_dualcurrency", False, f"{type(e).__name__}: {e}")

    # C. session memory across two invocations (same session id)
    try:
        sid = new_session()
        actor = "e2e-mem-" + uuid.uuid4().hex[:8]
        invoke("Please remember this exact code for later: COSTCTR-7788. Just acknowledge briefly.",
               {"actor_id": actor}, sid)
        time.sleep(3)
        t2, _, _ = invoke("What is the exact code I asked you to remember a moment ago?",
                          {"actor_id": actor}, sid)
        check("C_session_memory", "7788" in t2, f"turn2={t2[:150]}")
    except Exception as e:
        check("C_session_memory", False, f"{type(e).__name__}: {e}")

    # D. report -> marker -> S3 object + metadata + presigned download
    try:
        actor = "e2e-report"
        t, evs, keys = invoke(
            "Generate a PDF report of last month's spending, top 5 services. Title it E2E Test Report.",
            {"actor_id": actor, "role_arn": role, "external_id": ext,
             "display_currency": "IDR", "account_alias": "e2e-acct"}, new_session())
        marker = "[REPORT_FILE:" in t
        key = keys[0] if keys else None
        check("D_report_marker", bool(key) and marker, f"keys={keys} marker_in_text={marker} text_tail={t[-160:]}")
        if key:
            head = s3.head_object(Bucket=REPORT_BUCKET, Key=key)
            meta = head.get("Metadata", {})
            check("D_s3_object", head.get("ContentLength", 0) > 0, f"key={key} len={head.get('ContentLength')}")
            check("D_owner_metadata", meta.get("owner-actor-id") == actor, f"metadata={meta}")
            url = s3.generate_presigned_url("get_object",
                                            Params={"Bucket": REPORT_BUCKET, "Key": key}, ExpiresIn=300)
            data = urllib.request.urlopen(url, timeout=30).read()
            check("D_presigned_download", data[:5] == b"%PDF-", f"bytes={len(data)} magic={data[:8]}")
            print(f"   report S3 key: {key}")
    except Exception as e:
        check("D_report_pipeline", False, f"{type(e).__name__}: {e}")

    print("\n== E2E SUMMARY ==")
    for n, ok in results:
        print(f"  {n}: {'PASS' if ok else 'FAIL'}")
    failed = [n for n, ok in results if not ok]
    if failed:
        print(f"\nFAILED: {failed}")
        sys.exit(1)
    print("\nALL E2E PASS")


if __name__ == "__main__":
    main()
