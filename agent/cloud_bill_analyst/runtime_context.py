"""Per-invocation Runtime context + non-disclosure guard.

The Runtime context carries the caller-supplied, security-sensitive values that
drive cross-account access and report storage:
  - role_arn / external_id  -> assumed to read the customer's Cost Explorer data
  - actor_id / session_id   -> identify the user + conversation (memory keys)
  - report_bucket / prefix  -> where report files are written
  - timezone / display_currency -> presentation defaults

Security invariants enforced here:
  * role_arn and external_id are treated as secrets: never logged, echoed, or
    written to files. RuntimeContext.__repr__ masks them; safe_dict() masks them.
  * register_secrets() feeds a logging filter that scrubs secrets from ALL log
    output as a defense-in-depth net; redact_text()/RuntimeContext.redact()
    scrub outgoing model text before it leaves the process.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Optional

SECRET_PLACEHOLDER = "[redacted]"

# Process-wide registry of secret substrings to scrub from logs (defense in depth).
_ACTIVE_SECRETS: set[str] = set()


def register_secrets(values) -> None:
    for v in values or []:
        if v and isinstance(v, str):
            _ACTIVE_SECRETS.add(v)


def redact_text(text: Optional[str]) -> Optional[str]:
    if not text:
        return text
    out = text
    for s in _ACTIVE_SECRETS:
        if s:
            out = out.replace(s, SECRET_PLACEHOLDER)
    return out


def _mask(v: Optional[str]) -> Optional[str]:
    """Presence-only view of a secret; reveals no characters."""
    return None if not v else f"<set:{len(v)}chars>"


class SecretRedactingFilter(logging.Filter):
    """Logging filter that scrubs any registered secret from emitted records."""

    def filter(self, record: logging.LogRecord) -> bool:  # noqa: A003
        try:
            msg = record.getMessage()
        except Exception:
            return True
        red = redact_text(msg)
        if red != msg:
            record.msg = red
            record.args = ()
        return True


def install_log_redaction() -> None:
    """Attach the redaction filter to the root logger and its handlers (idempotent)."""
    root = logging.getLogger()
    if not any(isinstance(f, SecretRedactingFilter) for f in root.filters):
        root.addFilter(SecretRedactingFilter())
    for h in root.handlers:
        if not any(isinstance(f, SecretRedactingFilter) for f in h.filters):
            h.addFilter(SecretRedactingFilter())


@dataclass
class RuntimeContext:
    actor_id: str
    session_id: str
    account_alias: Optional[str] = None
    role_arn: Optional[str] = None        # SECRET
    external_id: Optional[str] = None     # SECRET
    report_bucket: Optional[str] = None
    report_prefix: str = "reports/"
    timezone: str = "Asia/Jakarta"
    display_currency: str = "IDR"
    extra: dict = field(default_factory=dict)

    def secret_values(self) -> list[str]:
        return [v for v in (self.role_arn, self.external_id) if v]

    def redact(self, text: Optional[str]) -> Optional[str]:
        if not text:
            return text
        out = text
        for s in self.secret_values():
            out = out.replace(s, SECRET_PLACEHOLDER)
        return out

    def safe_dict(self) -> dict:
        return {
            "actor_id": self.actor_id,
            "session_id": self.session_id,
            "account_alias": self.account_alias,
            "role_arn": _mask(self.role_arn),
            "external_id": _mask(self.external_id),
            "report_bucket": self.report_bucket,
            "report_prefix": self.report_prefix,
            "timezone": self.timezone,
            "display_currency": self.display_currency,
        }

    def __repr__(self) -> str:
        return "RuntimeContext(" + ", ".join(f"{k}={v!r}" for k, v in self.safe_dict().items()) + ")"

    __str__ = __repr__


def parse_runtime_context(payload: dict, request_context: Any = None, config: Any = None):
    """Return (prompt, RuntimeContext) parsed from an invocation payload.

    Contract:
      payload = {"prompt": "<text>", "context": { actor_id, role_arn, external_id,
                 account_alias, report_bucket, report_prefix, timezone,
                 display_currency, [session_id] }}
    session_id resolves from context, else RequestContext.session_id, else auto.
    Raises ValueError on missing required fields (prompt, actor_id).
    Registers secrets for log redaction as a side effect.
    """
    if not isinstance(payload, dict):
        raise ValueError("payload must be a JSON object")

    prompt = payload.get("prompt")
    if prompt is None and isinstance(payload.get("input"), str):
        prompt = payload.get("input")
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("payload.prompt (non-empty string) is required")

    ctx = payload.get("context") or payload.get("runtime_context") or {}
    if not isinstance(ctx, dict):
        raise ValueError("payload.context must be an object")

    session_id = None
    headers: dict = {}
    if request_context is not None:
        session_id = getattr(request_context, "session_id", None)
        headers = getattr(request_context, "request_headers", None) or {}
    # header lookups are case-insensitive
    lower_headers = {str(k).lower(): v for k, v in headers.items()}

    session_id = ctx.get("session_id") or session_id
    actor_id = ctx.get("actor_id") or lower_headers.get("x-actor-id")
    if not actor_id:
        raise ValueError("context.actor_id is required")
    if not session_id:
        session_id = f"auto-{actor_id}"

    d_bucket = getattr(config, "default_report_bucket", None) if config else None
    d_prefix = getattr(config, "default_report_prefix", "reports/") if config else "reports/"
    d_tz = getattr(config, "default_timezone", "Asia/Jakarta") if config else "Asia/Jakarta"
    d_cur = getattr(config, "default_display_currency", "IDR") if config else "IDR"

    rc = RuntimeContext(
        actor_id=str(actor_id),
        session_id=str(session_id),
        account_alias=ctx.get("account_alias"),
        role_arn=ctx.get("role_arn"),
        external_id=ctx.get("external_id"),
        report_bucket=ctx.get("report_bucket") or d_bucket,
        report_prefix=ctx.get("report_prefix") or d_prefix,
        timezone=ctx.get("timezone") or d_tz,
        display_currency=ctx.get("display_currency") or d_cur,
        extra={k: v for k, v in ctx.items() if k not in {
            "actor_id", "session_id", "account_alias", "role_arn", "external_id",
            "report_bucket", "report_prefix", "timezone", "display_currency"}},
    )
    register_secrets(rc.secret_values())
    return prompt, rc
