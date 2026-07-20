"""Offline unit tests for memory wiring (no AWS)."""
from cloud_bill_analyst import memory as m
from cloud_bill_analyst.config import Config
from cloud_bill_analyst.runtime_context import RuntimeContext


def test_pref_retrieval_config_from_env(monkeypatch):
    m._pref_cache.clear()
    monkeypatch.setenv("CBA_PREF_NAMESPACE", "cba/preferences/{actorId}")
    monkeypatch.setenv("CBA_PREF_STRATEGY_ID", "CloudBillAnalystUserPreferences-ofYTKQ4wec")
    rc = m._pref_retrieval_config(Config.from_env())
    assert "cba/preferences/{actorId}" in rc
    cfg = rc["cba/preferences/{actorId}"]
    assert getattr(cfg, "strategy_id", None) == "CloudBillAnalystUserPreferences-ofYTKQ4wec"
    m._pref_cache.clear()


def test_memory_disabled(monkeypatch):
    monkeypatch.setenv("CBA_DISABLE_MEMORY", "1")
    ctx = RuntimeContext(actor_id="u", session_id="s")
    assert m.maybe_build_session_manager(Config.from_env(), ctx) is None


def test_memory_unconfigured(monkeypatch):
    monkeypatch.delenv("CBA_DISABLE_MEMORY", raising=False)
    monkeypatch.delenv("AWS_MEMORY_ARN", raising=False)
    monkeypatch.delenv("AWS_MEMORY_ID", raising=False)
    ctx = RuntimeContext(actor_id="u", session_id="s")
    assert m.maybe_build_session_manager(Config.from_env(), ctx) is None
