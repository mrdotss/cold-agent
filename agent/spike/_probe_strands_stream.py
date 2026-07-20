#!/usr/bin/env python3
"""Probe the shape of Strands Agent.stream_async events with Kimi K2.5.
Confirms Strands drives moonshotai.kimi-k2.5 and shows how text deltas / tool
events are surfaced, so the entrypoint extracts the right fields. Live Bedrock."""
import asyncio
import os

from strands import Agent
from strands.models import BedrockModel

MODEL_ID = os.environ.get("MODEL_ID", "moonshotai.kimi-k2.5")
REGION = os.environ.get("AWS_REGION", "us-east-1")


async def main():
    model = BedrockModel(model_id=MODEL_ID, region_name=REGION, streaming=True,
                         temperature=0.2, max_tokens=256)
    agent = Agent(model=model, system_prompt="You are concise. No preamble.")
    key_counts = {}
    n = 0
    async for ev in agent.stream_async("List exactly three AWS service names, comma separated."):
        n += 1
        if isinstance(ev, dict):
            for k in ev.keys():
                key_counts[k] = key_counts.get(k, 0) + 1
            if "data" in ev:
                print("DATA:", repr(ev["data"])[:100])
            if "event" in ev and n <= 3:
                print("EVENT(raw):", repr(ev["event"])[:200])
            if "result" in ev:
                print("RESULT event present; type:", type(ev["result"]).__name__)
        else:
            print("non-dict:", type(ev).__name__, repr(ev)[:120])
    print("\nTOTAL EVENTS:", n)
    print("KEY COUNTS:", key_counts)


if __name__ == "__main__":
    asyncio.run(main())
