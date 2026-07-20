#!/usr/bin/env python3
"""Dump UpdateAgentRuntime input shape (required fields for redeploy commands)."""
import boto3


def describe(shape, depth=0, seen=None):
    seen = set() if seen is None else seen
    pad = "  " * depth
    tn = shape.type_name
    if tn == "structure":
        req = set(getattr(shape, "required_members", []) or [])
        for name, m in shape.members.items():
            print(f"{pad}{name}{'*' if name in req else ''}: {m.type_name}")
            if depth < 2 and m.type_name in ("structure", "list", "map") and id(m) not in seen:
                seen.add(id(m))
                describe(m, depth + 1, seen)


c = boto3.client("bedrock-agentcore-control", region_name="us-east-1")
op = c.meta.service_model.operation_model("UpdateAgentRuntime")
print("== UpdateAgentRuntime INPUT ==")
describe(op.input_shape)
