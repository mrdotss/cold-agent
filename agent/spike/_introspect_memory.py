#!/usr/bin/env python3
"""Introspect the bedrock-agentcore (data plane) Memory API shapes from the
installed botocore model, so the read/write spike uses exact parameter names.
Client-side only: makes no AWS calls."""
import sys

import boto3

REGION = "us-east-1"


def describe_shape(shape, depth=0, seen=None):
    seen = set() if seen is None else seen
    pad = "  " * depth
    if shape is None:
        print(f"{pad}(none)")
        return
    tn = shape.type_name
    if tn == "structure":
        req = set(getattr(shape, "required_members", []) or [])
        for name, member in shape.members.items():
            star = "*" if name in req else ""
            print(f"{pad}{name}{star}: {member.type_name}")
            if depth < 3 and member.type_name in ("structure", "list", "map") and id(member) not in seen:
                seen.add(id(member))
                describe_shape(member, depth + 1, seen)
    elif tn == "list":
        print(f"{pad}[list of {shape.member.type_name}]")
        if depth < 3 and id(shape.member) not in seen:
            seen.add(id(shape.member))
            describe_shape(shape.member, depth + 1, seen)
    elif tn == "map":
        print(f"{pad}{{map {shape.key.type_name} -> {shape.value.type_name}}}")
        if depth < 3 and id(shape.value) not in seen:
            seen.add(id(shape.value))
            describe_shape(shape.value, depth + 1, seen)


try:
    c = boto3.client("bedrock-agentcore", region_name=REGION)
except Exception as e:
    print("CLIENT ERROR:", type(e).__name__, e)
    sys.exit(2)

ops = list(c.meta.service_model.operation_names)
print("SERVICE:", c.meta.service_model.service_name)
print("OPERATIONS:", sorted(ops))

for op in ["CreateEvent", "ListEvents", "GetEvent", "RetrieveMemoryRecords",
           "ListMemoryRecords", "GetMemoryRecord", "ListSessions", "ListActors",
           "DeleteEvent"]:
    if op in ops:
        print(f"\n==== {op} :: INPUT ====")
        describe_shape(c.meta.service_model.operation_model(op).input_shape)
