#!/usr/bin/env python3
"""Verify sanitize_messages repairs malformed tool histories to Bedrock-valid form."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from cloud_bill_analyst.history import sanitize_messages  # noqa: E402


def use(i):
    return {"toolUse": {"toolUseId": i, "name": "t", "input": {}}}


def res(i):
    return {"toolResult": {"toolUseId": i, "content": [{"text": "ok"}], "status": "success"}}


def txt(s):
    return {"text": s}


def is_valid(msgs):
    for i, m in enumerate(msgs):
        c = m.get("content", [])
        if not c:
            return False, f"empty content at {i}"
        if m.get("role") == "user":
            rids = [b["toolResult"]["toolUseId"] for b in c if "toolResult" in b]
            if rids:
                prev = msgs[i - 1] if i - 1 >= 0 else {}
                uids = ([b["toolUse"]["toolUseId"] for b in prev.get("content", []) if "toolUse" in b]
                        if prev.get("role") == "assistant" else [])
                for r in rids:
                    if r not in uids:
                        return False, f"orphan toolResult {r} at msg {i}"
        if m.get("role") == "assistant":
            uids = [b["toolUse"]["toolUseId"] for b in c if "toolUse" in b]
            if uids:
                nxt = msgs[i + 1] if i + 1 < len(msgs) else {}
                rids = ([b["toolResult"]["toolUseId"] for b in nxt.get("content", []) if "toolResult" in b]
                        if nxt.get("role") == "user" else [])
                for u in uids:
                    if u not in rids:
                        return False, f"dangling toolUse {u} at msg {i}"
    return True, "ok"


CASES = {
    "A excess toolResult (reported)": [
        {"role": "assistant", "content": [use("A")]},
        {"role": "user", "content": [res("A"), res("B")]},
    ],
    "B dangling toolUse": [
        {"role": "assistant", "content": [txt("calling"), use("A"), use("C")]},
        {"role": "user", "content": [res("A")]},
    ],
    "C trailing dangling use": [
        {"role": "user", "content": [txt("hi")]},
        {"role": "assistant", "content": [use("A")]},
    ],
    "D valid unchanged": [
        {"role": "user", "content": [txt("q")]},
        {"role": "assistant", "content": [use("A")]},
        {"role": "user", "content": [res("A")]},
        {"role": "assistant", "content": [txt("answer")]},
    ],
    "E leading orphan result": [
        {"role": "user", "content": [res("X")]},
        {"role": "assistant", "content": [txt("hello")]},
    ],
    "F parallel with extra": [
        {"role": "user", "content": [txt("q")]},
        {"role": "assistant", "content": [use("A"), use("B")]},
        {"role": "user", "content": [res("A"), res("B"), res("C")]},
        {"role": "assistant", "content": [txt("done")]},
    ],
}

fail = 0
for name, hist in CASES.items():
    original = [dict(m) for m in hist]
    out = sanitize_messages(hist)
    ok, why = is_valid(out)
    unchanged_note = " (unchanged)" if out == original else ""
    print(f"[{'PASS' if ok else 'FAIL'}] {name}: {len(hist)}->{len(out)} msgs valid={ok} {why}{unchanged_note}")
    if not ok:
        fail += 1
    # original must not be mutated
    if hist != original:
        print(f"   !! MUTATED INPUT for {name}")
        fail += 1

# D must be unchanged
if sanitize_messages(CASES["D valid unchanged"]) != CASES["D valid unchanged"]:
    print("   !! case D was modified but should be untouched")
    fail += 1

print("\n" + ("ALL SANITIZE CASES PASS" if fail == 0 else f"{fail} FAILURE(S)"))
sys.exit(1 if fail else 0)
