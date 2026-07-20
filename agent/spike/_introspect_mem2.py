#!/usr/bin/env python3
"""Introspect AgentCore Memory <-> Strands session manager config shapes."""
import inspect

from bedrock_agentcore.memory.integrations.strands.session_manager import (
    AgentCoreMemorySessionManager,
)
from bedrock_agentcore.memory.integrations.strands.config import (
    AgentCoreMemoryConfig, RetrievalConfig,
)
try:
    from bedrock_agentcore.memory.integrations.strands.config import PersistenceMode
except Exception:
    PersistenceMode = None


def show(o, n):
    print(f"\n== {n} ==")
    try:
        print("sig:", inspect.signature(o))
    except Exception as e:
        print("sig n/a", e)
    d = (inspect.getdoc(o) or "")[:400]
    if d:
        print(d)


show(AgentCoreMemorySessionManager.__init__, "AgentCoreMemorySessionManager.__init__")

for cls in (AgentCoreMemoryConfig, RetrievalConfig):
    print(f"\n== {cls.__name__} fields ==")
    mf = getattr(cls, "model_fields", None)
    if mf:
        for k, v in mf.items():
            print(f"  {k}: required={v.is_required()} default={v.default!r} type={v.annotation}")
    else:
        print("  annotations:", getattr(cls, "__annotations__", {}))

if PersistenceMode is not None:
    print("\nPersistenceMode:", [x for x in dir(PersistenceMode) if not x.startswith("_")])
