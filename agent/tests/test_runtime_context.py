"""Unit tests for runtime-context parsing and the non-disclosure guard.
Pure Python - no AWS calls."""
import logging
import types

import pytest

from cloud_bill_analyst.config import Config
from cloud_bill_analyst.runtime_context import (
    RuntimeContext,
    SecretRedactingFilter,
    parse_runtime_context,
    redact_text,
    register_secrets,
)

ROLE = "arn:aws:iam::111122223333:role/CustomerCostReadOnly"
EXT = "super-secret-external-id-abc123"


def _reqctx(session_id=None, headers=None):
    return types.SimpleNamespace(session_id=session_id, request_headers=headers or {})


def _cfg():
    return Config.from_env()


def test_parse_happy_path():
    payload = {
        "prompt": "What did I spend last month?",
        "context": {
            "actor_id": "user-1",
            "account_alias": "prod",
            "role_arn": ROLE,
            "external_id": EXT,
            "report_bucket": "b",
            "report_prefix": "r/",
            "timezone": "Asia/Jakarta",
            "display_currency": "IDR",
        },
    }
    prompt, rc = parse_runtime_context(payload, _reqctx(session_id="sess-9"), _cfg())
    assert prompt == "What did I spend last month?"
    assert rc.actor_id == "user-1"
    assert rc.session_id == "sess-9"
    assert rc.role_arn == ROLE and rc.external_id == EXT
    assert rc.report_bucket == "b" and rc.report_prefix == "r/"


def test_prompt_required():
    with pytest.raises(ValueError):
        parse_runtime_context({"context": {"actor_id": "u"}}, _reqctx())
    with pytest.raises(ValueError):
        parse_runtime_context({"prompt": "   ", "context": {"actor_id": "u"}}, _reqctx())


def test_actor_id_required():
    with pytest.raises(ValueError):
        parse_runtime_context({"prompt": "hi", "context": {}}, _reqctx())


def test_session_id_from_request_context():
    prompt, rc = parse_runtime_context(
        {"prompt": "hi", "context": {"actor_id": "u"}}, _reqctx(session_id="from-header"))
    assert rc.session_id == "from-header"


def test_session_id_autofallback():
    prompt, rc = parse_runtime_context({"prompt": "hi", "context": {"actor_id": "u"}}, _reqctx())
    assert rc.session_id == "auto-u"


def test_actor_id_from_header():
    prompt, rc = parse_runtime_context(
        {"prompt": "hi", "context": {}}, _reqctx(headers={"X-Actor-Id": "hdr-user"}))
    assert rc.actor_id == "hdr-user"


def test_redact_replaces_secrets():
    rc = RuntimeContext(actor_id="u", session_id="s", role_arn=ROLE, external_id=EXT)
    leaked = f"role is {ROLE} and ext {EXT} ok"
    red = rc.redact(leaked)
    assert ROLE not in red and EXT not in red
    assert "[redacted]" in red


def test_repr_and_safe_dict_mask_secrets():
    rc = RuntimeContext(actor_id="u", session_id="s", role_arn=ROLE, external_id=EXT)
    r = repr(rc)
    assert ROLE not in r and EXT not in r
    sd = rc.safe_dict()
    assert ROLE not in str(sd) and EXT not in str(sd)
    # presence indicated
    assert sd["role_arn"] and "set:" in sd["role_arn"]


def test_log_redaction_filter(caplog):
    register_secrets([ROLE, EXT])
    assert redact_text(f"leak {EXT}") == "leak [redacted]"
    logger = logging.getLogger("cba.test")
    logger.addFilter(SecretRedactingFilter())
    with caplog.at_level(logging.INFO, logger="cba.test"):
        logger.info("dumping %s here", EXT)
    joined = " ".join(r.getMessage() for r in caplog.records)
    assert EXT not in joined
    assert "[redacted]" in joined


def test_parse_registers_secrets_for_redaction():
    payload = {"prompt": "hi", "context": {"actor_id": "u2", "role_arn": ROLE, "external_id": EXT}}
    parse_runtime_context(payload, _reqctx())
    # after parsing, the global redactor knows the secrets
    assert redact_text(f"x {ROLE} y") == "x [redacted] y"
