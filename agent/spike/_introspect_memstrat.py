#!/usr/bin/env python3
"""Introspect AgentCore Memory strategy management APIs (high + low level)."""
import inspect

from bedrock_agentcore.memory import MemoryClient, MemoryControlPlaneClient

for cls in (MemoryClient, MemoryControlPlaneClient):
    print(f"\n== {cls.__name__} public methods ==")
    print([m for m in dir(cls) if not m.startswith("_")])

print("\n== MemoryClient strategy/retrieve method signatures ==")
for m in ("add_semantic_strategy", "add_user_preference_strategy", "add_summary_strategy",
          "add_strategy", "add_strategies", "update_memory_strategies",
          "get_memory_strategies", "list_memory_strategies",
          "retrieve_memories", "retrieve_memory_records", "create_memory_and_wait"):
    f = getattr(MemoryClient, m, None)
    if f:
        try:
            print(f"  {m}{inspect.signature(f)}")
        except Exception as e:  # noqa: BLE001
            print(f"  {m}: sig n/a ({e})")

print("\n== MemoryControlPlaneClient strategy method signatures ==")
for m in ("add_strategy", "add_semantic_strategy", "add_user_preference_strategy",
          "update_memory_strategies", "modify_strategies", "get_memory", "update_memory"):
    f = getattr(MemoryControlPlaneClient, m, None)
    if f:
        try:
            print(f"  {m}{inspect.signature(f)}")
        except Exception as e:  # noqa: BLE001
            print(f"  {m}: sig n/a ({e})")

for path in ("bedrock_agentcore.memory.constants",):
    try:
        mod = __import__(path, fromlist=["*"])
        names = [a for a in dir(mod) if not a.startswith("_")]
        print(f"\n== {path} ==", names)
        for n in ("StrategyType", "MemoryStrategyTypeEnum", "Role", "MessageRole"):
            obj = getattr(mod, n, None)
            if obj is not None and hasattr(obj, "__members__"):
                print(f"  {n}:", list(obj.__members__))
    except Exception as e:  # noqa: BLE001
        print(f"{path}: {e}")
