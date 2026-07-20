#!/usr/bin/env python3
"""Introspect BedrockConfig keys, AgentCore Memory<->Strands integration, runtime source path."""
import importlib
import pkgutil

from strands.models.bedrock import BedrockModel
cfg = getattr(BedrockModel, "BedrockConfig", None)
print("BedrockConfig annotations:", dict(getattr(cfg, "__annotations__", {})))

import bedrock_agentcore.memory as m
print("\nmemory __file__:", m.__file__)

# Discover any Strands integration for AgentCore Memory
try:
    import bedrock_agentcore.memory.integrations as integ
    print("integrations __path__:", list(integ.__path__))
    for mi in pkgutil.walk_packages(integ.__path__, prefix="bedrock_agentcore.memory.integrations."):
        print("  submodule:", mi.name)
except Exception as e:
    print("integrations walk:", type(e).__name__, e)

for modname in [
    "bedrock_agentcore.memory.integrations.strands.session_manager",
    "bedrock_agentcore.memory.integrations.strands.config",
]:
    try:
        mod = importlib.import_module(modname)
        print(f"\n{modname} exports:", [a for a in dir(mod) if not a.startswith("_")])
    except Exception as e:
        print(f"{modname}: {type(e).__name__} {e}")

import bedrock_agentcore.runtime as rt
print("\nruntime __path__:", list(rt.__path__))

for modname in ["strands.session.session_manager"]:
    try:
        mod = importlib.import_module(modname)
        print(f"\n{modname}:", [a for a in dir(mod) if not a.startswith("_")])
    except Exception as e:
        print(f"{modname}: {e}")
