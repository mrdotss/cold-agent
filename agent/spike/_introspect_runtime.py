#!/usr/bin/env python3
"""Dump the CreateAgentRuntime input shape so the deploy payload is exact."""
import boto3


def describe(shape, depth=0, seen=None):
    seen = set() if seen is None else seen
    pad = "  " * depth
    tn = shape.type_name
    if tn == "structure":
        req = set(getattr(shape, "required_members", []) or [])
        for name, m in shape.members.items():
            star = "*" if name in req else ""
            enum = getattr(m, "enum", None)
            extra = f" enum={enum}" if enum else ""
            print(f"{pad}{name}{star}: {m.type_name}{extra}")
            if depth < 4 and m.type_name in ("structure", "list", "map") and id(m) not in seen:
                seen.add(id(m))
                describe(m, depth + 1, seen)
    elif tn == "list":
        print(f"{pad}[list of {shape.member.type_name}]")
        if depth < 4 and id(shape.member) not in seen:
            seen.add(id(shape.member))
            describe(shape.member, depth + 1, seen)
    elif tn == "map":
        print(f"{pad}{{map {shape.key.type_name} -> {shape.value.type_name}}}")
        if depth < 4 and id(shape.value) not in seen:
            seen.add(id(shape.value))
            describe(shape.value, depth + 1, seen)


c = boto3.client("bedrock-agentcore-control", region_name="us-east-1")
op = c.meta.service_model.operation_model("CreateAgentRuntime")
print("== CreateAgentRuntime INPUT ==")
describe(op.input_shape)
