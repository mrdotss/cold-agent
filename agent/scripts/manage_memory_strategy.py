#!/usr/bin/env python3
"""Manage the Cloud Bill Analyst user-preference memory strategy on the shared
memory resource (MRMemory-AgcOp32p44).

  list   : print current strategies (raw dicts)
  add    : add the USER_PREFERENCE strategy if absent (idempotent), wait ACTIVE
  delete : remove a strategy by id (rollback)

The strategy is app-scoped (distinct name + namespace) so it does not collide
with anything else on the shared memory. Raw 30-day events are untouched.

Usage:
  python scripts/manage_memory_strategy.py list
  python scripts/manage_memory_strategy.py add
  python scripts/manage_memory_strategy.py delete --strategy-id <id>
"""
import argparse
import json
import os
import sys

from bedrock_agentcore.memory import MemoryClient

MEMORY_ID = os.environ.get("AWS_MEMORY_ID", "MRMemory-AgcOp32p44")
REGION = os.environ.get("AWS_REGION", "us-east-1")
STRATEGY_NAME = os.environ.get("CBA_PREF_STRATEGY_NAME", "CloudBillAnalystUserPreferences")
NAMESPACE = os.environ.get("CBA_PREF_NAMESPACE", "cba/preferences/{actorId}")
DESCRIPTION = ("Cloud Bill Analyst per-user preferences: display currency, cost "
              "granularity, favorite report format, default top-N, and similar.")


def _strategies(mc):
    return mc.get_memory_strategies(MEMORY_ID)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("action", choices=["list", "add", "delete"])
    ap.add_argument("--strategy-id")
    ap.add_argument("--region", default=REGION)
    ap.add_argument("--memory-id", default=MEMORY_ID)
    args = ap.parse_args()

    mc = MemoryClient(region_name=args.region)

    if args.action == "list":
        for s in _strategies(mc):
            print(json.dumps(s, default=str))
        return

    if args.action == "delete":
        if not args.strategy_id:
            print("--strategy-id required for delete", file=sys.stderr)
            sys.exit(2)
        mc.delete_strategy(args.memory_id, args.strategy_id)
        print(f"deleted strategy {args.strategy_id}")
        return

    # add (idempotent)
    existing = [s for s in _strategies(mc) if s.get("name") == STRATEGY_NAME]
    if existing:
        print("STRATEGY ALREADY PRESENT:")
        print(json.dumps(existing[0], default=str))
        return
    print(f"adding USER_PREFERENCE strategy '{STRATEGY_NAME}' namespace='{NAMESPACE}' ...")
    res = mc.add_user_preference_strategy_and_wait(
        args.memory_id, name=STRATEGY_NAME, description=DESCRIPTION, namespaces=[NAMESPACE])
    print("ADD RESULT:", json.dumps(res, default=str)[:1500])
    print("\nCURRENT STRATEGIES:")
    for s in _strategies(mc):
        print(json.dumps(s, default=str))


if __name__ == "__main__":
    main()
