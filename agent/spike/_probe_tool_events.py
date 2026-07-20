#!/usr/bin/env python3
"""Probe the shape of Strands stream_async TOOL-USE events (for SSE tool events).

Registers a trivial tool and forces a tool call, printing current_tool_use /
message shapes so app.py can emit reliable tool_start / tool_end events.
Live Bedrock (Kimi K2.5).
"""
import asyncio
import os

from strands import Agent, tool
from strands.models import BedrockModel

MODEL_ID = os.environ.get("MODEL_ID", "moonshotai.kimi-k2.5")
REGION = os.environ.get("AWS_REGION", "us-east-1")


@tool
def add(a: int, b: int) -> int:
    """Add two integers a and b."""
    return a + b


async def main():
    model = BedrockModel(model_id=MODEL_ID, region_name=REGION, streaming=True,
                         temperature=0.0, max_tokens=256)
    agent = Agent(model=model, system_prompt="Use tools when asked. Be concise.", tools=[add])
    keys_seen = []
    ctu_ids = []
    async for ev in agent.stream_async("Use the add tool to compute 2 + 3, then state the result."):
        if not isinstance(ev, dict):
            continue
        for k in ev.keys():
            if k not in keys_seen:
                keys_seen.append(k)
        ctu = ev.get("current_tool_use")
        if ctu:
            tid = ctu.get("toolUseId") if isinstance(ctu, dict) else None
            if tid not in ctu_ids:
                ctu_ids.append(tid)
                print("CTU-NEW:", {k: ctu.get(k) for k in ("toolUseId", "name", "input")} if isinstance(ctu, dict) else ctu)
        msg = ev.get("message")
        if isinstance(msg, dict):
            blocks = []
            for b in (msg.get("content") or []):
                blocks.append(list(b.keys())[0] if isinstance(b, dict) else type(b).__name__)
            print("MSG role=", msg.get("role"), "blocks=", blocks)
    print("\nKEYS SEEN:", keys_seen)
    print("TOOL-USE IDS:", ctu_ids)


if __name__ == "__main__":
    asyncio.run(main())
