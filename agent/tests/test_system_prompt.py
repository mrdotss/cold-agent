"""Deterministic guardrail checks on the system prompt content."""
from cloud_bill_analyst.system_prompt import SYSTEM_PROMPT

P = SYSTEM_PROMPT.lower()


def test_mentions_all_real_tools():
    for tool in ("get_cost_and_usage", "get_exchange_rate", "create_chart", "create_report"):
        assert tool in SYSTEM_PROMPT


def test_defaults_and_readonly():
    assert "last full calendar month" in P
    assert "service" in P  # default grouping
    assert "read-only" in P


def test_presentation_rules():
    assert "idr" in P
    assert "rp 12.345.678" in P and "$1,234.56" in P


def test_marker_is_app_owned():
    assert "[REPORT_FILE:" in SYSTEM_PROMPT
    # model must NOT write the marker itself
    assert "do not write that marker" in P


def test_no_shell_tool_and_creds_hidden():
    assert "no shell" in P
    # non-disclosure of secrets
    assert "never reveal" in P
    assert "external id" in P


def test_decline_out_of_scope():
    assert "decline" in P
