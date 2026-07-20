#!/usr/bin/env python3
"""Live Task 3 probe: exercise the cost tool against a real assumed role.
  1. run_cost_query direct (assume + GetCostAndUsage + defaults + parse).
  2. make_cost_tool object sanity.
  3. optional --agent: let Kimi actually call the tool and answer.

Secrets are passed as args (never hardcoded) and never printed.
"""
import argparse
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from cloud_bill_analyst.config import Config  # noqa: E402
from cloud_bill_analyst.runtime_context import RuntimeContext  # noqa: E402
from cloud_bill_analyst.tools.cost import make_cost_tool, run_cost_query  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--role-arn", default=os.environ.get("ROLE_ARN"))
    ap.add_argument("--external-id", default=os.environ.get("EXTERNAL_ID"))
    ap.add_argument("--agent", action="store_true")
    args = ap.parse_args()
    assert args.role_arn and args.external_id, "need --role-arn and --external-id"

    cfg = Config.from_env()
    ctx = RuntimeContext(actor_id="probe-user", session_id="probe-sess",
                         role_arn=args.role_arn, external_id=args.external_id,
                         account_alias="probe-account")

    res = run_cost_query(ctx, cfg)
    summary = {k: res[k] for k in ("period", "granularity", "metric", "group_by", "currency", "total") if k in res}
    print("DIRECT:", json.dumps(summary, indent=2))
    print("top5:", res.get("groups", [])[:5])
    assert "error" not in res, res
    assert res["total"] > 0, "expected non-zero spend"

    tool = make_cost_tool(ctx, cfg)
    print("tool name:", getattr(tool, "tool_name", getattr(tool, "__name__", "?")))

    if args.agent:
        from strands import Agent
        from strands.models import BedrockModel
        model = BedrockModel(model_id=cfg.model_id, region_name=cfg.region,
                             streaming=True, temperature=0.2, max_tokens=1024)
        agent = Agent(
            model=model, tools=[tool],
            system_prompt=("You are a cost analyst. Use the get_cost_and_usage tool for billing "
                           "questions; group by SERVICE by default. Be concise; show a short table."),
        )

        async def run():
            text = ""
            async for ev in agent.stream_async("What did I spend last month? Show the top 3 services."):
                if isinstance(ev, dict) and isinstance(ev.get("data"), str):
                    text += ev["data"]
            print("\nAGENT ANSWER:\n", text[:1000])
            assert text.strip(), "no agent text"

        asyncio.run(run())

    print("\nCOST PROBE OK")


if __name__ == "__main__":
    main()
