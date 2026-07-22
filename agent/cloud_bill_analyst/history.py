"""Repair a restored conversation history so tool-call blocks are valid for the
Bedrock Converse API before the agent replays it.

Bedrock requires that for consecutive (assistant -> user) turns, every `toolUse`
block in the assistant turn has exactly one matching `toolResult` (same
`toolUseId`) in the following user turn, and vice-versa. AgentCore Memory
restoration - especially of parallel tool calls, or after an interrupted or
duplicate turn on the same session - can leave orphaned `toolResult` blocks or
dangling `toolUse` blocks. Replaying that history fails ConverseStream with:

    ValidationException: The number of toolResult blocks at messages.N.content
    exceeds the number of toolUse blocks of previous turn.

`sanitize_messages` drops those orphans so the replayed history is always valid.
It is pure and defensive: it never raises, only ever removes already-invalid
tool blocks (never text), and passes unknown block types through untouched.
"""
from __future__ import annotations

from typing import Any, List


def _content(m: Any) -> list:
    if isinstance(m, dict) and isinstance(m.get("content"), list):
        return m["content"]
    return []


def _role(m: Any) -> Any:
    return m.get("role") if isinstance(m, dict) else None


def _tool_use_id(block: Any):
    if isinstance(block, dict) and isinstance(block.get("toolUse"), dict):
        return block["toolUse"].get("toolUseId")
    return None


def _tool_result_id(block: Any):
    if isinstance(block, dict) and isinstance(block.get("toolResult"), dict):
        return block["toolResult"].get("toolUseId")
    return None


def sanitize_messages(messages: List[Any]) -> List[Any]:
    """Return a copy of `messages` with orphaned tool blocks removed so the
    history is valid for Bedrock Converse. Returns the input unchanged when it is
    not a non-empty list."""
    if not isinstance(messages, list) or not messages:
        return messages

    # shallow-copy each message so we can rewrite its content list without
    # mutating the caller's objects until we're done.
    msgs = [dict(m) if isinstance(m, dict) else m for m in messages]
    n = len(msgs)

    # Pass 1: drop assistant `toolUse` blocks with no matching `toolResult`
    # in the immediately following user turn (dangling tool use).
    for i in range(n):
        m = msgs[i]
        if _role(m) != "assistant":
            continue
        if not any(_tool_use_id(b) for b in _content(m)):
            continue
        result_ids = set()
        if i + 1 < n and _role(msgs[i + 1]) == "user":
            result_ids = {rid for rid in (_tool_result_id(b) for b in _content(msgs[i + 1])) if rid}
        kept = [b for b in _content(m)
                if not (_tool_use_id(b) and _tool_use_id(b) not in result_ids)]
        if len(kept) != len(_content(m)):
            m["content"] = kept

    # Pass 2: drop user `toolResult` blocks with no matching `toolUse` in the
    # immediately preceding assistant turn (orphaned tool result - the reported case).
    for i in range(n):
        m = msgs[i]
        if _role(m) != "user":
            continue
        if not any(_tool_result_id(b) for b in _content(m)):
            continue
        use_ids = set()
        if i - 1 >= 0 and _role(msgs[i - 1]) == "assistant":
            use_ids = {uid for uid in (_tool_use_id(b) for b in _content(msgs[i - 1])) if uid}
        kept = [b for b in _content(m)
                if not (_tool_result_id(b) and _tool_result_id(b) not in use_ids)]
        if len(kept) != len(_content(m)):
            m["content"] = kept

    # Pass 3: drop messages whose content became empty.
    return [m for m in msgs if not isinstance(m, dict) or _content(m)]
