"""Shared per-session artifact directory for generated files (charts, reports).

Chart PNGs (Task 5) and report files (Task 8) are written here in the container
so the report skills can embed/upload them. Isolated per actor+session.
Base dir: CBA_ARTIFACT_DIR env, else <tempdir>/cba-artifacts.
"""
from __future__ import annotations

import os
import re
import tempfile


def _safe(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", str(s))[:80] or "x"


def artifact_dir(context) -> str:
    base = os.environ.get("CBA_ARTIFACT_DIR") or os.path.join(tempfile.gettempdir(), "cba-artifacts")
    path = os.path.join(base, _safe(context.actor_id), _safe(context.session_id))
    os.makedirs(path, exist_ok=True)
    return path
