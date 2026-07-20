#!/usr/bin/env python3
"""Live Task 4 probe: fetch open.er-api.com over HTTPS, parse USD->IDR, and
verify session caching via resolve_rate. (Browser mode is validated on the
deployed runtime in Task 13.)"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from cloud_bill_analyst.runtime_context import RuntimeContext  # noqa: E402
from cloud_bill_analyst.tools.fx import fetch_http, parse_fx, resolve_rate  # noqa: E402


def main():
    obj = fetch_http()
    idr = parse_fx(obj, "IDR")
    print("USD->IDR:", idr)
    assert idr["base"] == "USD" and idr["target"] == "IDR" and idr["rate"] > 0
    assert idr["as_of"]

    calls = {"n": 0}

    def f():
        calls["n"] += 1
        return obj

    ctx = RuntimeContext(actor_id="p", session_id="s", display_currency="IDR")
    cache = {}
    r1 = resolve_rate(ctx, None, f, cache)
    r2 = resolve_rate(ctx, None, f, cache)
    assert calls["n"] == 1, "rate should be fetched once and cached"
    assert r1["target"] == "IDR"
    print(f"\nFX PROBE OK  rate={r1['rate']}  as_of={r1['as_of']}  (cached calls={calls['n']})")


if __name__ == "__main__":
    main()
