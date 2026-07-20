"""AgentCore Memory integration (short-term session persistence).

Task 2 wires short-term conversation persistence via the first-party
AgentCoreMemorySessionManager. Task 9 extends this with a user-preference /
semantic strategy (retrieval_config with strategy_id) and preference recall.

Memory can be disabled locally with CBA_DISABLE_MEMORY=1 (e.g. for smoke tests
that should not touch AWS), or when no memory id is configured.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Optional

from .config import Config
from .runtime_context import RuntimeContext

log = logging.getLogger("cba.memory")


def memory_enabled(config: Config) -> bool:
    if (os.environ.get("CBA_DISABLE_MEMORY") or "").strip().lower() in ("1", "true", "yes"):
        return False
    return bool(config.memory_id)


_PREF_STRATEGY_NAME = os.environ.get("CBA_PREF_STRATEGY_NAME", "CloudBillAnalystUserPreferences")
_pref_cache: dict = {}


def _pref_retrieval_config(config: Config):
    """Build {namespace: RetrievalConfig} for the user-preference strategy so the
    session manager recalls the user's saved preferences each turn.

    Resolution order: CBA_PREF_NAMESPACE + CBA_PREF_STRATEGY_ID env (set on the
    deployed runtime, avoids an API call), else discover by strategy name via
    get_memory_strategies. Result cached per process. Returns {} if unavailable.
    """
    if "rc" in _pref_cache:
        return _pref_cache["rc"]
    namespace = os.environ.get("CBA_PREF_NAMESPACE")
    strategy_id = os.environ.get("CBA_PREF_STRATEGY_ID")
    if not (namespace and strategy_id) and config.memory_id:
        try:
            from bedrock_agentcore.memory import MemoryClient
            mc = MemoryClient(region_name=config.region)
            for s in mc.get_memory_strategies(config.memory_id):
                if s.get("name") == _PREF_STRATEGY_NAME:
                    strategy_id = s.get("strategyId") or s.get("memoryStrategyId")
                    nss = s.get("namespaces") or s.get("namespaceTemplates") or []
                    namespace = nss[0] if nss else namespace
                    break
        except Exception as e:  # noqa: BLE001
            log.warning("preference strategy discovery failed: %s: %s", type(e).__name__, e)
    rc = {}
    if namespace and strategy_id:
        try:
            from bedrock_agentcore.memory.integrations.strands.config import RetrievalConfig
            rc = {namespace: RetrievalConfig(top_k=5, relevance_score=0.2, strategy_id=strategy_id)}
        except Exception as e:  # noqa: BLE001
            log.warning("RetrievalConfig unavailable: %s: %s", type(e).__name__, e)
    _pref_cache["rc"] = rc
    return rc


def maybe_build_session_manager(config: Config, context: RuntimeContext) -> Optional[Any]:
    """Return an AgentCoreMemorySessionManager bound to (memory_id, actor_id,
    session_id), or None when memory is disabled/unconfigured/unavailable."""
    if not memory_enabled(config):
        log.info("memory disabled or unconfigured; running without session persistence")
        return None
    try:
        from bedrock_agentcore.memory.integrations.strands.config import AgentCoreMemoryConfig
        from bedrock_agentcore.memory.integrations.strands.session_manager import (
            AgentCoreMemorySessionManager,
        )
    except Exception as e:  # pragma: no cover - integration always present in image
        log.warning("AgentCore memory integration unavailable: %s: %s", type(e).__name__, e)
        return None

    retrieval = _pref_retrieval_config(config)
    mem_cfg = AgentCoreMemoryConfig(
        memory_id=config.memory_id,
        session_id=context.session_id,
        actor_id=context.actor_id,
        retrieval_config=retrieval or None,
    )
    log.info("attaching AgentCore memory session manager (actor=%s, preference_recall=%s)",
             context.actor_id, bool(retrieval))
    return AgentCoreMemorySessionManager(agentcore_memory_config=mem_cfg, region_name=config.region)
