"""BedrockAgentCoreApp entrypoint for Cloud Bill Analyst.

Streaming contract (SSE): the entrypoint is an async generator, so the AgentCore
runtime serves each yielded object as `data: <json>\\n\\n`. Event shapes:
  {"type": "delta", "text": "<incremental assistant text>"}
  {"type": "tool", "phase": "start", "id","name","label","status"}  # activity step begins
  {"type": "tool", "phase": "end", "id","name"}                     # activity step finished
  {"type": "chart", "spec": {...}}                                  # inline chart data (client-rendered)
  {"type": "report_file", "key": "<s3 key>", "bucket": "<bucket>"}  # a report was saved
  {"type": "error", "message": "<message>"}
  {"type": "done"}
The `tool` events power the web UI's live "activity"/step timeline; `status`
carries a friendly, variative phrase for the current step (no user data/secrets).
All outgoing text is passed through the RuntimeContext non-disclosure guard so
role_arn / external_id can never leak, even accidentally.

Invocation payload:
  {"prompt": "<user text>",
   "context": {"actor_id","role_arn","external_id","account_alias",
               "report_bucket","report_prefix","timezone","display_currency"}}
session_id is taken from the AgentCore runtime session header (RequestContext).
"""
from __future__ import annotations

import logging

from bedrock_agentcore.runtime import BedrockAgentCoreApp

from .agent import build_agent, build_tools, extract_text_delta
from .activity import ActivityTracker
from .config import Config
from .history import sanitize_messages
from .memory import maybe_build_session_manager
from .reporting import strip_report_markers
from .runtime_context import install_log_redaction, parse_runtime_context

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("cba.app")

CONFIG = Config.from_env()
install_log_redaction()

app = BedrockAgentCoreApp()


@app.entrypoint
async def invoke(payload, context):
    """Main streaming entrypoint. Yields SSE event dicts."""
    try:
        prompt, rc = parse_runtime_context(payload, context, CONFIG)
    except ValueError as e:
        log.warning("bad request: %s", e)
        yield {"type": "error", "message": f"bad request: {e}"}
        return

    # Re-install after any handler-added log handlers; ensures secrets are scrubbed.
    install_log_redaction()
    log.info("invocation actor=%s session=%s context=%s", rc.actor_id, rc.session_id, rc.safe_dict())

    report_registry: list = []
    chart_registry: list = []
    try:
        session_manager = maybe_build_session_manager(CONFIG, rc)
        tools = build_tools(CONFIG, rc, report_registry=report_registry, chart_registry=chart_registry)
        agent = build_agent(CONFIG, rc, tools=tools, session_manager=session_manager)
    except Exception as e:  # noqa: BLE001
        log.exception("agent initialization failed")
        yield {"type": "error", "message": rc.redact(f"agent initialization failed: {e}")}
        return

    # Defense-in-depth: repair any restored conversation history so tool-use /
    # tool-result blocks are validly paired before Bedrock Converse sees them.
    # AgentCore Memory can restore orphaned toolResult / dangling toolUse blocks
    # (e.g. after a duplicate/interrupted turn on the same session), which would
    # otherwise fail ConverseStream with a ValidationException.
    try:
        restored = getattr(agent, "messages", None)
        if isinstance(restored, list) and restored:
            repaired = sanitize_messages(restored)
            if repaired != restored:
                log.info("history sanitize: %d -> %d messages", len(restored), len(repaired))
                agent.messages[:] = repaired
    except Exception:  # noqa: BLE001
        log.exception("history sanitize failed; continuing with restored history")

    tracker = ActivityTracker()
    charts_emitted = 0
    try:
        async for event in agent.stream_async(prompt):
            # Live activity (tool start/end) -> the UI renders a step timeline.
            for tev in tracker.events(event):
                yield tev
            # Inline charts: emit each created chart's spec as soon as it appears
            # so the web UI renders it live (client-side; no image/S3/presign).
            while charts_emitted < len(chart_registry):
                yield {"type": "chart", "spec": chart_registry[charts_emitted]}
                charts_emitted += 1
            delta = extract_text_delta(event)
            if delta:
                # Non-disclosure guard + strip any model-emitted report markers
                # (the app appends the authoritative one below).
                clean = rc.redact(strip_report_markers(delta))
                if clean:
                    yield {"type": "delta", "text": clean}
        # Close out any activity steps that never reported a result.
        for tev in tracker.close():
            yield tev
        # Drain any charts registered right at the end of the turn.
        while charts_emitted < len(chart_registry):
            yield {"type": "chart", "spec": chart_registry[charts_emitted]}
            charts_emitted += 1
        # Authoritative [REPORT_FILE] markers: exactly one per uploaded key.
        seen = set()
        for entry in report_registry:
            key = entry.get("key")
            if key and key not in seen:
                seen.add(key)
                yield {"type": "report_file", "key": key, "bucket": entry.get("bucket")}
                yield {"type": "delta", "text": f"\n[REPORT_FILE: {key}]"}
        yield {"type": "done"}
    except Exception as e:  # noqa: BLE001
        log.exception("streaming failed")
        yield {"type": "error", "message": rc.redact(f"streaming error: {e}")}


if __name__ == "__main__":
    app.run()
