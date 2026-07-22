"""Strands agent assembly for Cloud Bill Analyst.

- Orchestrator model: BedrockModel(model_id=MODEL_ID, streaming=True).
- Conversation window: SlidingWindowConversationManager(window_size=150) mirroring
  the harness AWS_TRUNCATION_MESSAGES_COUNT / sliding_window settings.
- Tools and session_manager are injected per-invocation so secrets (role_arn,
  external_id) stay bound server-side in tool closures and never enter the model.
"""
from __future__ import annotations

import logging
from typing import Any, Optional

from strands import Agent
from strands.agent.conversation_manager import SlidingWindowConversationManager
from strands.models import BedrockModel

from .config import Config
from .runtime_context import RuntimeContext
from .system_prompt import SYSTEM_PROMPT

log = logging.getLogger("cba.agent")


def build_model(config: Config) -> BedrockModel:
    return BedrockModel(
        model_id=config.model_id,
        region_name=config.region,
        streaming=True,
        temperature=config.temperature,
        max_tokens=config.max_tokens,
    )


def build_conversation_manager(config: Config) -> SlidingWindowConversationManager:
    # window_size mirrors AWS_TRUNCATION_MESSAGES_COUNT (default 150);
    # should_truncate_results trims oversized tool results to fit context.
    return SlidingWindowConversationManager(
        window_size=config.conversation_window,
        should_truncate_results=True,
    )


def build_agent(
    config: Config,
    context: RuntimeContext,
    *,
    tools: Optional[list] = None,
    session_manager: Any = None,
    model: Optional[BedrockModel] = None,
) -> Agent:
    """Construct a per-invocation Agent. Tools should already be bound to the
    RuntimeContext (secrets captured in closures, not passed by the model)."""
    return Agent(
        model=model or build_model(config),
        system_prompt=SYSTEM_PROMPT,
        tools=tools or [],
        conversation_manager=build_conversation_manager(config),
        session_manager=session_manager,
        agent_id="cloud-bill-analyst",
        name="Cloud Bill Analyst",
    )


def extract_text_delta(event: Any) -> Optional[str]:
    """Pull the incremental assistant text from a Strands stream event.

    Strands surfaces assembled text deltas under event['data'] (str). Lifecycle
    events (init/start/result/message/etc.) carry no 'data' and are ignored here.
    """
    if isinstance(event, dict):
        data = event.get("data")
        if isinstance(data, str) and data:
            return data
    return None



def build_tools(config: Config, context: RuntimeContext, *, report_registry=None,
                chart_registry=None) -> list:
    """Assemble all agent tools bound to this invocation's RuntimeContext.

    Secrets (role_arn/external_id) stay captured in each tool's closure. Report
    uploads append to report_registry so the app can emit authoritative
    [REPORT_FILE] markers; created charts append their client-render spec to
    chart_registry so the app can emit inline `chart` events.
    """
    from .reporting import make_report_tool
    from .tools.charts import make_chart_tool
    from .tools.cost import make_cost_tool
    from .tools.fx import make_fx_tool

    return [
        make_cost_tool(context, config),
        make_fx_tool(context, config),
        make_chart_tool(context, config, registry=chart_registry),
        make_report_tool(context, config, registry=report_registry),
    ]
