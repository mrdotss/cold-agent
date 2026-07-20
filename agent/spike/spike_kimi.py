#!/usr/bin/env python3
"""
Task 1a validation spike: Kimi K2.5 (moonshotai.kimi-k2.5) on Amazon Bedrock.

Validates, against the LIVE Bedrock Converse API, the capabilities the Cloud
Bill Analyst architecture depends on:

  1. basic_converse        - model reachable + invoke permissions.
  2. tool_use_single_turn  - model emits a well-formed toolUse block.
  3. tool_use_roundtrip    - model consumes a toolResult and answers.
  4. streaming_text        - ConverseStream yields incremental text deltas.
  5. streaming_tool_use    - toolUse (name + partial-JSON input) surfaces via
                             the event stream and the assembled input parses.

Read-only: creates no resources. Exits non-zero if any check fails.

Env:
  MODEL_ID    default moonshotai.kimi-k2.5
  AWS_REGION  default us-east-1
"""
import json
import os
import sys

import boto3
from botocore.config import Config

MODEL_ID = os.environ.get("MODEL_ID", "moonshotai.kimi-k2.5")
REGION = os.environ.get("AWS_REGION", "us-east-1")

client = boto3.client(
    "bedrock-runtime",
    region_name=REGION,
    config=Config(retries={"max_attempts": 3, "mode": "adaptive"}, read_timeout=120),
)

# Mock cost tool mirroring the real GetCostAndUsage-backed tool built in Task 3.
COST_TOOL = {
    "toolSpec": {
        "name": "get_cost_and_usage",
        "description": (
            "Retrieve AWS cost and usage for a connected account over a time "
            "period, optionally grouped by a dimension such as SERVICE. "
            "Call this whenever the user asks about spending."
        ),
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {
                    "start_date": {"type": "string", "description": "YYYY-MM-DD inclusive"},
                    "end_date": {"type": "string", "description": "YYYY-MM-DD exclusive"},
                    "granularity": {"type": "string", "enum": ["DAILY", "MONTHLY"]},
                    "group_by": {"type": "string", "description": "dimension, e.g. SERVICE"},
                },
                "required": ["start_date", "end_date"],
            }
        },
    }
}
TOOL_CONFIG = {"tools": [COST_TOOL]}
SYSTEM = [{"text": (
    "You are a cost analysis assistant. When the user asks about spending, "
    "you MUST call the get_cost_and_usage tool rather than guessing. "
    "Never invent numbers."
)}]
INFER = {"maxTokens": 1024, "temperature": 0.2}

results = {}


def check(name, ok, detail=""):
    results[name] = (bool(ok), detail)
    tag = "PASS" if ok else "FAIL"
    print(f"[{tag}] {name}" + (f" :: {detail}" if detail else ""))


def _text(blocks):
    return "".join(b.get("text", "") for b in blocks)


def check_basic():
    resp = client.converse(
        modelId=MODEL_ID,
        messages=[{"role": "user", "content": [{"text": "Reply with exactly the single word: PONG"}]}],
        inferenceConfig=INFER,
    )
    text = _text(resp["output"]["message"]["content"])
    check("basic_converse", "PONG" in text.upper(), f"stopReason={resp.get('stopReason')} text={text!r}")


def check_tool_use():
    messages = [{"role": "user", "content": [
        {"text": "How much did I spend last month, broken down by service?"}]}]
    resp = client.converse(
        modelId=MODEL_ID, messages=messages, system=SYSTEM,
        toolConfig=TOOL_CONFIG, inferenceConfig=INFER,
    )
    stop = resp.get("stopReason")
    blocks = resp["output"]["message"]["content"]
    tool_use = next((b["toolUse"] for b in blocks if "toolUse" in b), None)
    ok = stop == "tool_use" and tool_use is not None and tool_use.get("name") == "get_cost_and_usage"
    check("tool_use_single_turn", ok,
          f"stopReason={stop} toolUse={json.dumps(tool_use) if tool_use else None}")
    return messages, resp, tool_use


def check_tool_roundtrip(messages, resp, tool_use):
    if not tool_use:
        check("tool_use_roundtrip", False, "skipped: no toolUse from previous step")
        return
    messages.append(resp["output"]["message"])
    messages.append({"role": "user", "content": [{
        "toolResult": {
            "toolUseId": tool_use["toolUseId"],
            "content": [{"json": {
                "total_usd": 1234.56,
                "groups": [
                    {"service": "Amazon EC2", "usd": 800.00},
                    {"service": "Amazon S3", "usd": 434.56},
                ],
            }}],
            "status": "success",
        }
    }]})
    resp2 = client.converse(
        modelId=MODEL_ID, messages=messages, system=SYSTEM,
        toolConfig=TOOL_CONFIG, inferenceConfig=INFER,
    )
    text = _text(resp2["output"]["message"]["content"])
    hay = text.replace(",", "")
    ok = resp2.get("stopReason") in ("end_turn", "stop_sequence", "max_tokens") and (
        "1234" in hay or "EC2" in text or "S3" in text)
    check("tool_use_roundtrip", ok, f"stopReason={resp2.get('stopReason')} text={text[:200]!r}")


def check_streaming():
    resp = client.converse_stream(
        modelId=MODEL_ID,
        messages=[{"role": "user", "content": [
            {"text": "Count from 1 to 5, separated by single spaces."}]}],
        inferenceConfig=INFER,
    )
    chunks, text, stop = 0, "", None
    for event in resp["stream"]:
        if "contentBlockDelta" in event:
            d = event["contentBlockDelta"]["delta"]
            if "text" in d:
                text += d["text"]
                chunks += 1
        elif "messageStop" in event:
            stop = event["messageStop"].get("stopReason")
    check("streaming_text", chunks >= 2 and "5" in text,
          f"chunks={chunks} stop={stop} text={text[:120]!r}")


def check_streaming_tool_use():
    resp = client.converse_stream(
        modelId=MODEL_ID,
        messages=[{"role": "user", "content": [
            {"text": "What was my total AWS cost for last month? Use your tool."}]}],
        system=SYSTEM, toolConfig=TOOL_CONFIG, inferenceConfig=INFER,
    )
    tool_name, input_json, stop = None, "", None
    for event in resp["stream"]:
        if "contentBlockStart" in event:
            start = event["contentBlockStart"]["start"]
            if "toolUse" in start:
                tool_name = start["toolUse"]["name"]
        elif "contentBlockDelta" in event:
            d = event["contentBlockDelta"]["delta"]
            if "toolUse" in d:
                input_json += d["toolUse"].get("input", "")
        elif "messageStop" in event:
            stop = event["messageStop"].get("stopReason")
    parses = True
    if input_json:
        try:
            json.loads(input_json)
        except Exception:
            parses = False
    ok = tool_name == "get_cost_and_usage" and stop == "tool_use" and parses
    check("streaming_tool_use", ok,
          f"tool={tool_name} stop={stop} parses={parses} input={input_json[:160]!r}")


def main():
    print(f"== Kimi spike :: model={MODEL_ID} region={REGION} ==")
    messages = resp = tool_use = None
    try:
        check_basic()
    except Exception as e:
        check("basic_converse", False, f"{type(e).__name__}: {e}")
    try:
        messages, resp, tool_use = check_tool_use()
    except Exception as e:
        check("tool_use_single_turn", False, f"{type(e).__name__}: {e}")
    if messages is not None:
        try:
            check_tool_roundtrip(messages, resp, tool_use)
        except Exception as e:
            check("tool_use_roundtrip", False, f"{type(e).__name__}: {e}")
    try:
        check_streaming()
    except Exception as e:
        check("streaming_text", False, f"{type(e).__name__}: {e}")
    try:
        check_streaming_tool_use()
    except Exception as e:
        check("streaming_tool_use", False, f"{type(e).__name__}: {e}")

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
