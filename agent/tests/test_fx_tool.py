"""Offline unit tests for the FX tool - no network (fetcher injected)."""
import pytest

from cloud_bill_analyst.config import Config
from cloud_bill_analyst.runtime_context import RuntimeContext
from cloud_bill_analyst.tools.fx import fetch_http, parse_fx, resolve_rate

SAMPLE = {
    "result": "success",
    "base_code": "USD",
    "time_last_update_utc": "Sun, 19 Jul 2026 00:02:31 +0000",
    "rates": {"USD": 1, "IDR": 17958.447005, "EUR": 0.874488},
}
ROLE = "arn:aws:iam::111122223333:role/X"
EXT = "ext-secret"


def _ctx(cur="IDR"):
    return RuntimeContext(actor_id="u", session_id="s", display_currency=cur,
                          role_arn=ROLE, external_id=EXT)


def test_parse_fx_idr():
    r = parse_fx(SAMPLE, "IDR")
    assert r["base"] == "USD" and r["target"] == "IDR"
    assert r["rate"] == 17958.447005
    assert r["as_of"].startswith("Sun, 19 Jul 2026")
    assert r["source"] == "open.er-api.com"


def test_parse_fx_unknown_currency():
    with pytest.raises(ValueError):
        parse_fx(SAMPLE, "ZZZ")


def test_parse_fx_bad_result():
    with pytest.raises(ValueError):
        parse_fx({"result": "error", "rates": {"IDR": 1}}, "IDR")


def test_fetch_http_host_allowlist():
    with pytest.raises(ValueError):
        fetch_http("https://evil.example.com/v6/latest/USD")


def test_resolve_rate_caches():
    calls = {"n": 0}

    def fake():
        calls["n"] += 1
        return SAMPLE

    cache = {}
    r1 = resolve_rate(_ctx(), "IDR", fake, cache)
    r2 = resolve_rate(_ctx(), "IDR", fake, cache)
    assert calls["n"] == 1  # fetched once, reused for the session
    assert r1["rate"] == r2["rate"] == 17958.447005


def test_resolve_rate_default_currency_from_context():
    r = resolve_rate(_ctx(cur="EUR"), None, lambda: SAMPLE, {})
    assert r["target"] == "EUR" and r["rate"] == 0.874488


def test_resolve_rate_error_redacted():
    def boom():
        raise RuntimeError(f"network blew up leaking {ROLE} and {EXT}")

    r = resolve_rate(_ctx(), "IDR", boom, {})
    assert "error" in r
    assert ROLE not in r["error"] and EXT not in r["error"]
    assert "[redacted]" in r["error"]
