"""Turn Strands stream events into user-facing "activity" (tool) SSE events.

The entrypoint emits, alongside the usual text `delta`s:
    {"type":"tool","phase":"start","id":<toolUseId>,"name":<tool>,
     "label":<short label>,"status":<friendly, variative phrase>}
    {"type":"tool","phase":"end","id":<toolUseId>,"name":<tool>}
so the web UI can render a live, human-readable step timeline (the
"chain-of-thought"/activity strip in the chat).

Event shapes this maps (verified against Strands + Kimi K2.5):
  * tool START: event["current_tool_use"] == {"toolUseId","name","input"}
    (appears repeatedly as the tool input streams; we emit once per toolUseId).
  * tool END:  event["message"] with role=="user" and a "toolResult" content
    block carrying the finished tool's toolUseId.

Status text is intentionally *variative* - a friendly phrase is chosen per step
so the chat feels alive rather than robotic. It contains NO user data or secrets
(fixed phrase pools keyed only by the tool name).
"""
from __future__ import annotations

import random
from typing import Any, Dict, Iterator, List, Optional

# Stable label + rotating friendly phrasings per tool.
_TOOLS: Dict[str, Dict[str, Any]] = {
    "get_cost_and_usage": {
        "label": "Cost Explorer",
        "phrases": [
            "Querying AWS Cost Explorer\u2026",
            "Pulling your cost & usage\u2026",
            "Crunching the numbers from Cost Explorer\u2026",
            "Analyzing your spend\u2026",
        ],
    },
    "get_exchange_rate": {
        "label": "Exchange rate",
        "phrases": [
            "Fetching today's exchange rate\u2026",
            "Converting to your currency\u2026",
            "Checking the latest USD rate\u2026",
        ],
    },
    "create_chart": {
        "label": "Chart",
        "phrases": [
            "Rendering the chart\u2026",
            "Drawing the breakdown\u2026",
            "Visualizing the numbers\u2026",
        ],
    },
    "create_report": {
        "label": "Report",
        "phrases": [
            "Assembling your report\u2026",
            "Formatting the document\u2026",
            "Packaging the file\u2026",
            "Building your PDF / Excel\u2026",
        ],
    },
}
_DEFAULT = {"label": "Working", "phrases": ["Working\u2026", "Processing\u2026", "One moment\u2026"]}


def tool_label(name: str) -> str:
    return _TOOLS.get(name, _DEFAULT)["label"]


def tool_status(name: str, rng: Optional[random.Random] = None) -> str:
    phrases = _TOOLS.get(name, _DEFAULT)["phrases"]
    return (rng or random).choice(phrases)


def tool_result_ids(message: Any) -> List[str]:
    """toolUseIds of any finished tools reported in a role=user tool-result message."""
    ids: List[str] = []
    if isinstance(message, dict) and message.get("role") == "user":
        for block in (message.get("content") or []):
            if isinstance(block, dict) and isinstance(block.get("toolResult"), dict):
                tid = block["toolResult"].get("toolUseId")
                if tid:
                    ids.append(tid)
    return ids


class ActivityTracker:
    """Stateful mapper: feed each Strands stream event, yield tool SSE dicts."""

    def __init__(self, rng: Optional[random.Random] = None):
        self._names: Dict[str, str] = {}   # toolUseId -> name (started)
        self._ended: set = set()
        self._rng = rng

    def events(self, event: Any) -> Iterator[dict]:
        if not isinstance(event, dict):
            return
        ctu = event.get("current_tool_use")
        if isinstance(ctu, dict):
            tid, name = ctu.get("toolUseId"), ctu.get("name")
            if tid and name and tid not in self._names:
                self._names[tid] = name
                yield {"type": "tool", "phase": "start", "id": tid, "name": name,
                       "label": tool_label(name), "status": tool_status(name, self._rng)}
        for tid in tool_result_ids(event.get("message")):
            if tid in self._names and tid not in self._ended:
                self._ended.add(tid)
                yield {"type": "tool", "phase": "end", "id": tid, "name": self._names[tid]}

    def close(self) -> Iterator[dict]:
        """End any started-but-unfinished tools (safety net at stream end)."""
        for tid, name in self._names.items():
            if tid not in self._ended:
                self._ended.add(tid)
                yield {"type": "tool", "phase": "end", "id": tid, "name": name}
