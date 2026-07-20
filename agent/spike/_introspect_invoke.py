#!/usr/bin/env python3
"""Dump InvokeAgentRuntime input/output shapes for the e2e client."""
import boto3


def describe(shape, depth=0, seen=None):
    seen = set() if seen is None else seen
    pad = "  " * depth
    if shape is None:
        print(f"{pad}(none)")
        return
    tn = shape.type_name
    if tn == "structure":
        req = set(getattr(shape, "required_members", []) or [])
        for name, m in shape.members.items():
            star = "*" if name in req else ""
            print(f"{pad}{name}{star}: {m.type_name}")
            if depth < 3 and m.type_name in ("structure", "list", "map") and id(m) not in seen:
                seen.add(id(m))
                describe(m, depth + 1, seen)
    else:
        print(f"{pad}<{tn}>")


c = boto3.client("bedrock-agentcore", region_name="us-east-1")
sm = c.meta.service_model
op = sm.operation_model("InvokeAgentRuntime")
print("== InvokeAgentRuntime INPUT ==")
describe(op.input_shape)
print("\n== InvokeAgentRuntime OUTPUT ==")
describe(op.output_shape)
