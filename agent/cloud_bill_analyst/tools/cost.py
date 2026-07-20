"""Read-only cross-account cost tool (Task 3).

The model calls ``get_cost_and_usage(...)`` WITHOUT any credentials. The
role_arn / external_id are captured server-side from the RuntimeContext via a
closure, so the customer's trust secrets never enter the model's context and
cannot be echoed.

Behaviour mirroring the plan:
  * Default period = last full calendar month, computed from the REAL system
    clock (never the model's sense of "today", which the spike showed is stale).
  * Default grouping = SERVICE. Default metric = UnblendedCost.
  * Strictly read-only: only ce:GetCostAndUsage is ever called.
  * Errors are passed through the non-disclosure guard before being returned.
"""
from __future__ import annotations

import datetime as dt
import logging
import re
from typing import Any, Callable, Optional

import boto3
from botocore.config import Config as BotoConfig

from ..config import Config
from ..runtime_context import RuntimeContext

log = logging.getLogger("cba.tools.cost")

VALID_GRANULARITY = {"DAILY", "MONTHLY", "HOURLY"}
VALID_METRICS = {
    "UnblendedCost", "BlendedCost", "AmortizedCost",
    "NetUnblendedCost", "NetAmortizedCost", "UsageQuantity",
}
_EMPTY_GROUP = {"", "none", "total", "no", "all"}


def last_full_month(today: Optional[dt.date] = None) -> tuple[str, str]:
    """(start, end) YYYY-MM-DD for the last full calendar month.
    Start inclusive, End exclusive (Cost Explorer semantics)."""
    today = today or dt.date.today()
    first_this = today.replace(day=1)          # exclusive End
    first_prev = (first_this - dt.timedelta(days=1)).replace(day=1)  # inclusive Start
    return first_prev.isoformat(), first_this.isoformat()


def _session_name(actor_id: str) -> str:
    return re.sub(r"[^\w+=,.@-]", "-", f"cba-{actor_id}")[:64]


def assume_ce_client(context: RuntimeContext, region: str):
    """AssumeRole(role_arn, external_id) -> Cost Explorer client from temp creds."""
    sts = boto3.client("sts", region_name=region)
    creds = sts.assume_role(
        RoleArn=context.role_arn,
        RoleSessionName=_session_name(context.actor_id),
        ExternalId=context.external_id,
        DurationSeconds=900,
    )["Credentials"]
    return boto3.client(
        "ce", region_name=region,
        aws_access_key_id=creds["AccessKeyId"],
        aws_secret_access_key=creds["SecretAccessKey"],
        aws_session_token=creds["SessionToken"],
        config=BotoConfig(retries={"max_attempts": 3, "mode": "adaptive"}),
    )


def build_request(start: str, end: str, granularity: str, group_by: Optional[str], metric: str) -> dict:
    req = {
        "TimePeriod": {"Start": start, "End": end},
        "Granularity": granularity,
        "Metrics": [metric],
    }
    if group_by:
        req["GroupBy"] = [{"Type": "DIMENSION", "Key": group_by}]
    return req


def parse_results(resp: dict, metric: str) -> tuple[float, str, list]:
    """Aggregate grouped amounts across all returned periods; return
    (total, currency, groups[{service, amount}] sorted desc)."""
    agg: dict[str, float] = {}
    total_ungrouped = 0.0
    unit = "USD"
    for rbt in resp.get("ResultsByTime", []) or []:
        groups = rbt.get("Groups") or []
        for g in groups:
            m = g.get("Metrics", {}).get(metric)
            if not m:
                continue
            unit = m.get("Unit", unit)
            key = (g.get("Keys") or ["(unknown)"])[0]
            agg[key] = agg.get(key, 0.0) + float(m["Amount"])
        if not groups:
            m = rbt.get("Total", {}).get(metric)
            if m:
                unit = m.get("Unit", unit)
                total_ungrouped += float(m["Amount"])
    groups_out = sorted(
        ({"service": k, "amount": round(v, 2)} for k, v in agg.items()),
        key=lambda r: r["amount"], reverse=True,
    )
    total = round(sum(agg.values()), 2) if agg else round(total_ungrouped, 2)
    return total, unit, groups_out


def run_cost_query(
    context: RuntimeContext,
    config: Config,
    *,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    granularity: str = "MONTHLY",
    group_by: Optional[str] = "SERVICE",
    metric: str = "UnblendedCost",
    ce_client: Any = None,
) -> dict:
    """Core cost query (unit-testable). Returns a model-friendly dict or {error}."""
    if not context.role_arn or not context.external_id:
        return {"error": "No connected-account credentials in the runtime context; cannot read cost data."}

    gran = (granularity or "MONTHLY").upper()
    if gran not in VALID_GRANULARITY:
        return {"error": f"invalid granularity {granularity!r}; use one of {sorted(VALID_GRANULARITY)}"}
    met = metric or "UnblendedCost"
    if met not in VALID_METRICS:
        return {"error": f"invalid metric {metric!r}; use one of {sorted(VALID_METRICS)}"}

    gb: Optional[str] = None if (group_by or "").strip().lower() in _EMPTY_GROUP else group_by.strip().upper()

    if not start_date or not end_date:
        start_date, end_date = last_full_month()

    req = build_request(start_date, end_date, gran, gb, met)

    if ce_client is None:
        try:
            ce_client = assume_ce_client(context, config.region)
        except Exception as e:  # noqa: BLE001
            log.warning("assume_role failed: %s", type(e).__name__)
            return {"error": context.redact(f"could not access the connected account: {type(e).__name__}: {e}")}
    try:
        resp = ce_client.get_cost_and_usage(**req)
    except Exception as e:  # noqa: BLE001
        log.warning("get_cost_and_usage failed: %s", type(e).__name__)
        return {"error": context.redact(f"cost query failed: {type(e).__name__}: {e}")}

    total, unit, groups = parse_results(resp, met)
    return {
        "period": {"start": start_date, "end": end_date, "note": "start inclusive, end exclusive"},
        "granularity": gran,
        "metric": met,
        "group_by": gb,
        "currency": unit,
        "total": total,
        "groups": groups,
        "source": "AWS Cost Explorer GetCostAndUsage (read-only)",
    }


def make_cost_tool(context: RuntimeContext, config: Config) -> Callable:
    """Build the Strands @tool bound to this invocation's RuntimeContext.
    Caches the assumed-role CE client across calls within the invocation."""
    from strands import tool

    cache: dict[str, Any] = {}

    def _client():
        c = cache.get("ce")
        if c is None:
            c = assume_ce_client(context, config.region)
            cache["ce"] = c
        return c

    @tool
    def get_cost_and_usage(
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
        granularity: str = "MONTHLY",
        group_by: str = "SERVICE",
        metric: str = "UnblendedCost",
    ) -> dict:
        """Retrieve AWS cost & usage for the user's connected account. READ-ONLY.

        Use this for ALL billing questions - it is the only source of cost data.
        Credentials for the connected account are handled automatically; do not
        ask for or pass any account id, role, or credential.

        Args:
            start_date: Inclusive start date YYYY-MM-DD. Omit for the last full calendar month.
            end_date: Exclusive end date YYYY-MM-DD. Omit for the last full calendar month.
            granularity: DAILY or MONTHLY. Defaults to MONTHLY.
            group_by: Cost dimension to break down by (SERVICE, REGION, USAGE_TYPE,
                LINKED_ACCOUNT, INSTANCE_TYPE, ...). Defaults to SERVICE. Pass "NONE" for the total only.
            metric: UnblendedCost (default), AmortizedCost, BlendedCost, NetUnblendedCost, or UsageQuantity.

        Returns a dict: {period, granularity, metric, group_by, currency, total,
        groups:[{service, amount} largest first], source}. On failure: {error}.
        """
        try:
            client = _client()
        except Exception as e:  # noqa: BLE001
            log.warning("assume_role failed: %s", type(e).__name__)
            return {"error": context.redact(f"could not access the connected account: {type(e).__name__}: {e}")}
        return run_cost_query(
            context, config,
            start_date=start_date, end_date=end_date,
            granularity=granularity, group_by=group_by, metric=metric,
            ce_client=client,
        )

    return get_cost_and_usage
