#!/usr/bin/env python3
"""Introspect installed Strands + bedrock-agentcore APIs (no network)."""
import inspect


def show(obj, name):
    print(f"\n==== {name} ====")
    try:
        print("sig:", inspect.signature(obj))
    except Exception as e:
        print("sig: (n/a)", e)
    doc = (inspect.getdoc(obj) or "").strip()
    if doc:
        print("doc:", doc[:400])


import bedrock_agentcore
print("bedrock_agentcore:", getattr(bedrock_agentcore, "__version__", "?"))
from bedrock_agentcore.runtime import BedrockAgentCoreApp
print("App public attrs:", [a for a in dir(BedrockAgentCoreApp) if not a.startswith("_")])
show(BedrockAgentCoreApp.__init__, "BedrockAgentCoreApp.__init__")
for m in ("entrypoint", "run", "async_task", "ping"):
    if hasattr(BedrockAgentCoreApp, m):
        show(getattr(BedrockAgentCoreApp, m), f"App.{m}")

for path in ("bedrock_agentcore.runtime", "bedrock_agentcore.runtime.context"):
    try:
        mod = __import__(path, fromlist=["*"])
        rc = getattr(mod, "RequestContext", None)
        if rc:
            print(f"\n{path}.RequestContext fields:", [a for a in dir(rc) if not a.startswith("_")])
            try:
                print("  annotations:", getattr(rc, "__annotations__", {}))
            except Exception:
                pass
    except Exception as e:
        print(f"{path}:", e)

# memory helpers
for path in ("bedrock_agentcore.memory", "bedrock_agentcore.memory.client"):
    try:
        mod = __import__(path, fromlist=["*"])
        print(f"\n{path} exports:", [a for a in dir(mod) if not a.startswith("_")][:40])
    except Exception as e:
        print(f"{path}:", e)

import strands
print("\n\nstrands:", getattr(strands, "__version__", "?"))
from strands import Agent
show(Agent.__init__, "strands.Agent.__init__")
print("Agent public methods:", [a for a in dir(Agent) if not a.startswith("_")])
from strands.models import BedrockModel
show(BedrockModel.__init__, "strands.models.BedrockModel.__init__")
try:
    from strands.agent.conversation_manager import SlidingWindowConversationManager
    show(SlidingWindowConversationManager.__init__, "SlidingWindowConversationManager.__init__")
except Exception as e:
    print("SlidingWindow:", e)
try:
    from strands import tool
    print("\nstrands.tool:", tool, type(tool))
except Exception as e:
    print("strands.tool:", e)
for meth in ("stream_async", "invoke_async", "__call__"):
    if hasattr(Agent, meth):
        show(getattr(Agent, meth), f"Agent.{meth}")
