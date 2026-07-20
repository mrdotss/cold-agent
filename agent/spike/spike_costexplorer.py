#!/usr/bin/env python3
"""
Task 1c validation spike: cross-account AssumeRole -> Cost Explorer.

Mirrors the real cost tool (Task 3):
  1. sts.assume_role(RoleArn=<customer role>, ExternalId=<external id>) using
     THIS environment's credentials as the calling principal.
  2. Build a Cost Explorer ('ce') client from the returned temp credentials.
  3. GetCostAndUsage for the DEFAULT period = last full calendar month, computed
     from the REAL system clock (never the model's sense of 'today'), MONTHLY
     granularity, grouped by SERVICE, metric UnblendedCost. READ-ONLY.
  4. Print totals + top groups.

Security: the role ARN and external id are treated as secrets — they are never
printed/logged/echoed.

Inputs (CLI flag or env):
  --role-arn / ROLE_ARN
  --external-id / EXTERNAL_ID
  --region / AWS_REGION  (default us-east-1)

With no role/external id this performs a DRY RUN: prints the computed period and
the exact GetCostAndUsage request it WOULD send, and makes no AWS calls.
"""
import argparse
import datetime as dt
import json
import os
import sys

import boto3
from botocore.config import Config


def last_full_month(today=None):
    """(start, end) as YYYY-MM-DD for the last full calendar month.
    Start inclusive, End exclusive (Cost Explorer semantics)."""
    today = today or dt.date.today()
    first_of_this_month = today.replace(day=1)   # exclusive End
    prev_day = first_of_this_month - dt.timedelta(days=1)
    first_of_prev_month = prev_day.replace(day=1)  # inclusive Start
    return first_of_prev_month.isoformat(), first_of_this_month.isoformat()


def build_request(start, end, granularity="MONTHLY", group_key="SERVICE",
                  metric="UnblendedCost"):
    return {
        "TimePeriod": {"Start": start, "End": end},
        "Granularity": granularity,
        "Metrics": [metric],
        "GroupBy": [{"Type": "DIMENSION", "Key": group_key}],
    }


def parse_results(resp, metric="UnblendedCost"):
    rows, total, unit = [], 0.0, "USD"
    for rbt in resp.get("ResultsByTime", []):
        for g in rbt.get("Groups", []):
            amt = g["Metrics"][metric]
            val = float(amt["Amount"])
            unit = amt.get("Unit", unit)
            rows.append((g["Keys"][0], val))
            total += val
        if not rbt.get("Groups") and rbt.get("Total", {}).get(metric):
            amt = rbt["Total"][metric]
            total += float(amt["Amount"])
            unit = amt.get("Unit", unit)
    rows.sort(key=lambda r: r[1], reverse=True)
    return total, unit, rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--role-arn", default=os.environ.get("ROLE_ARN"))
    ap.add_argument("--external-id", default=os.environ.get("EXTERNAL_ID"))
    ap.add_argument("--region", default=os.environ.get("AWS_REGION", "us-east-1"))
    args = ap.parse_args()

    start, end = last_full_month()
    req = build_request(start, end)
    print("== Cost Explorer spike ==")
    print(f"real clock today = {dt.date.today().isoformat()}")
    print(f"default period (last full month) = {start} .. {end}  (Start incl, End excl)")
    print("GetCostAndUsage request:")
    print(json.dumps(req, indent=2))

    if not args.role_arn or not args.external_id:
        print("\n[DRY RUN] No ROLE_ARN / EXTERNAL_ID supplied — no AWS calls made.")
        print("Supply --role-arn and --external-id (or env) to run the live cross-account test.")
        return

    sts = boto3.client("sts", region_name=args.region)
    print("\nAssuming customer role (arn + external id redacted) ...")
    try:
        creds = sts.assume_role(
            RoleArn=args.role_arn,
            RoleSessionName="cba-spike-costexplorer",
            ExternalId=args.external_id,
            DurationSeconds=900,
        )["Credentials"]
    except Exception as e:
        # Redact: do not surface the role arn / external id even on failure.
        print(f"[FAIL] assume_role :: {type(e).__name__}: {str(e).replace(args.role_arn, '<ROLE_ARN>')}")
        sys.exit(1)

    ce = boto3.client(
        "ce", region_name=args.region,
        aws_access_key_id=creds["AccessKeyId"],
        aws_secret_access_key=creds["SecretAccessKey"],
        aws_session_token=creds["SessionToken"],
        config=Config(retries={"max_attempts": 3, "mode": "adaptive"}),
    )
    try:
        resp = ce.get_cost_and_usage(**req)
    except Exception as e:
        print(f"[FAIL] get_cost_and_usage :: {type(e).__name__}: {e}")
        sys.exit(1)

    total, unit, rows = parse_results(resp)
    print(f"\n[PASS] cross_account_cost_explorer :: total={total:.2f} {unit} groups={len(rows)}")
    print("top services:")
    for name, val in rows[:10]:
        print(f"  {name}: {val:.2f} {unit}")


if __name__ == "__main__":
    main()
