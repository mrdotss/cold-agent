"""Offline unit tests for the cost tool - no AWS calls (fake CE client)."""
import datetime as dt

from cloud_bill_analyst.config import Config
from cloud_bill_analyst.runtime_context import RuntimeContext
from cloud_bill_analyst.tools.cost import (
    build_request,
    last_full_month,
    parse_results,
    run_cost_query,
)

ROLE = "arn:aws:iam::111122223333:role/CustomerReadOnly"
EXT = "ext-secret-xyz"

GROUPED = {"ResultsByTime": [{
    "TimePeriod": {"Start": "2026-06-01", "End": "2026-07-01"},
    "Total": {},
    "Groups": [
        {"Keys": ["Amazon EC2"], "Metrics": {"UnblendedCost": {"Amount": "800.00", "Unit": "USD"}}},
        {"Keys": ["Amazon S3"], "Metrics": {"UnblendedCost": {"Amount": "434.56", "Unit": "USD"}}},
    ],
    "Estimated": False,
}]}
UNGROUPED = {"ResultsByTime": [{
    "TimePeriod": {"Start": "2026-06-01", "End": "2026-07-01"},
    "Total": {"UnblendedCost": {"Amount": "1234.56", "Unit": "USD"}},
    "Groups": [],
}]}


class FakeCE:
    def __init__(self, resp):
        self.resp = resp
        self.last = None

    def get_cost_and_usage(self, **kw):
        self.last = kw
        return self.resp


class RaisingCE:
    def __init__(self, msg):
        self.msg = msg

    def get_cost_and_usage(self, **kw):
        raise RuntimeError(self.msg)


def _ctx(with_creds=True):
    return RuntimeContext(
        actor_id="u", session_id="s",
        role_arn=ROLE if with_creds else None,
        external_id=EXT if with_creds else None,
    )


def _cfg():
    return Config.from_env()


def test_last_full_month_boundaries():
    assert last_full_month(dt.date(2026, 7, 19)) == ("2026-06-01", "2026-07-01")
    assert last_full_month(dt.date(2026, 1, 15)) == ("2025-12-01", "2026-01-01")
    assert last_full_month(dt.date(2026, 3, 1)) == ("2026-02-01", "2026-03-01")


def test_build_request_shapes():
    r = build_request("2026-06-01", "2026-07-01", "MONTHLY", "SERVICE", "UnblendedCost")
    assert r["GroupBy"] == [{"Type": "DIMENSION", "Key": "SERVICE"}]
    assert r["Metrics"] == ["UnblendedCost"]
    r2 = build_request("2026-06-01", "2026-07-01", "DAILY", None, "UnblendedCost")
    assert "GroupBy" not in r2


def test_parse_results_grouped():
    total, unit, groups = parse_results(GROUPED, "UnblendedCost")
    assert total == 1234.56 and unit == "USD"
    assert groups[0] == {"service": "Amazon EC2", "amount": 800.0}
    assert groups[1] == {"service": "Amazon S3", "amount": 434.56}


def test_run_cost_query_defaults_and_period():
    fake = FakeCE(GROUPED)
    res = run_cost_query(_ctx(), _cfg(), ce_client=fake)
    assert res["total"] == 1234.56
    assert res["currency"] == "USD"
    assert res["group_by"] == "SERVICE"
    s, e = last_full_month()
    assert fake.last["TimePeriod"] == {"Start": s, "End": e}
    assert fake.last["GroupBy"] == [{"Type": "DIMENSION", "Key": "SERVICE"}]
    assert fake.last["Metrics"] == ["UnblendedCost"]


def test_run_cost_query_no_creds():
    res = run_cost_query(_ctx(with_creds=False), _cfg(), ce_client=FakeCE(GROUPED))
    assert "error" in res and "credentials" in res["error"].lower()


def test_run_cost_query_invalid_granularity():
    res = run_cost_query(_ctx(), _cfg(), granularity="WEEKLY", ce_client=FakeCE(GROUPED))
    assert "error" in res


def test_run_cost_query_invalid_metric():
    res = run_cost_query(_ctx(), _cfg(), metric="MagicCost", ce_client=FakeCE(GROUPED))
    assert "error" in res


def test_group_by_none_uses_total():
    fake = FakeCE(UNGROUPED)
    res = run_cost_query(_ctx(), _cfg(), group_by="NONE", ce_client=fake)
    assert "GroupBy" not in fake.last
    assert res["group_by"] is None
    assert res["total"] == 1234.56


def test_error_is_redacted():
    ce = RaisingCE(f"AccessDenied assuming {ROLE} with external id {EXT}")
    res = run_cost_query(_ctx(), _cfg(), ce_client=ce)
    assert "error" in res
    assert ROLE not in res["error"] and EXT not in res["error"]
    assert "[redacted]" in res["error"]
