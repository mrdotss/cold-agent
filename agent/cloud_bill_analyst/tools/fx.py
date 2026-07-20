"""FX tool (Task 4): USD-based exchange rates from open.er-api.com.

Only open.er-api.com is ever contacted (host-allowlisted). The fetched rate
table is cached in a closure and reused for the whole session, so a rate fetched
once is not re-fetched.

Fetch channel is pluggable via FX_FETCH_MODE:
  * "http" (default): direct HTTPS GET. Reliable for a single trusted JSON
    endpoint; allowed because the runtime networkMode is PUBLIC.
  * "browser": drive the managed AgentCore Browser (Playwright over CDP) to the
    URL and read the JSON from the page body - honours the "FX via Browser"
    design when strict egress-through-Browser governance is required. Requires
    the `playwright` package (client-only; connects to the remote browser).
"""
from __future__ import annotations

import json
import logging
import os
import urllib.parse
import urllib.request
from typing import Any, Callable, Optional

from ..config import Config
from ..runtime_context import RuntimeContext

log = logging.getLogger("cba.tools.fx")

FX_URL = "https://open.er-api.com/v6/latest/USD"
ALLOWED_HOST = "open.er-api.com"


def parse_fx(obj: dict, target: str) -> dict:
    """Extract a single USD->target rate from an open.er-api.com response."""
    if not isinstance(obj, dict) or "rates" not in obj:
        raise ValueError("unexpected FX response (no 'rates')")
    if obj.get("result") not in (None, "success"):
        raise ValueError(f"FX provider returned result={obj.get('result')!r}")
    rates = obj.get("rates") or {}
    base = obj.get("base_code") or obj.get("base") or "USD"
    tgt = (target or "").upper()
    if tgt not in rates:
        raise ValueError(f"currency {tgt!r} not available from the FX provider")
    return {
        "base": base,
        "target": tgt,
        "rate": float(rates[tgt]),
        "as_of": obj.get("time_last_update_utc"),
        "source": ALLOWED_HOST,
    }


def _check_host(url: str) -> None:
    host = urllib.parse.urlparse(url).hostname
    if host != ALLOWED_HOST:
        raise ValueError(f"FX fetch blocked: host {host!r} is not allowlisted")


def fetch_http(url: str = FX_URL, timeout: int = 15) -> dict:
    _check_host(url)
    req = urllib.request.Request(url, headers={"User-Agent": "cloud-bill-analyst/1.0 (+fx)"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # nosec B310 - https + allowlisted host
        if getattr(resp, "status", 200) != 200:
            raise ValueError(f"FX HTTP status {resp.status}")
        return json.loads(resp.read().decode("utf-8"))


def fetch_browser(url: str = FX_URL, region: str = "us-east-1") -> dict:
    """Fetch via the managed AgentCore Browser (Playwright over CDP)."""
    _check_host(url)
    from bedrock_agentcore.tools.browser_client import browser_session
    from playwright.sync_api import sync_playwright

    with browser_session(region) as client:
        ws_url, headers = client.generate_ws_headers()
        with sync_playwright() as p:
            browser = p.chromium.connect_over_cdp(ws_url, headers=headers)
            try:
                bctx = browser.contexts[0] if browser.contexts else browser.new_context()
                page = bctx.pages[0] if bctx.pages else bctx.new_page()
                page.goto(url, wait_until="domcontentloaded", timeout=30000)
                body = page.evaluate("() => document.body.innerText")
            finally:
                browser.close()
    return json.loads(body)


def default_fetcher(config: Config) -> Callable[[], dict]:
    mode = (os.environ.get("FX_FETCH_MODE") or "http").strip().lower()
    if mode == "browser":
        log.info("FX fetch mode: managed browser")
        return lambda: fetch_browser(FX_URL, config.region)
    log.info("FX fetch mode: https")
    return lambda: fetch_http(FX_URL)


def resolve_rate(context: RuntimeContext, target: Optional[str], fetch: Callable[[], dict], cache: dict) -> dict:
    """Core (testable): return a rate dict, fetching once and caching for reuse."""
    tgt = (target or getattr(context, "display_currency", None) or "IDR").upper()
    try:
        obj = cache.get("obj")
        if obj is None:
            obj = fetch()
            cache["obj"] = obj
        return parse_fx(obj, tgt)
    except Exception as e:  # noqa: BLE001
        return {"error": context.redact(f"could not fetch exchange rate: {type(e).__name__}: {e}")}


def make_fx_tool(context: RuntimeContext, config: Config, fetcher: Optional[Callable[[], dict]] = None) -> Callable:
    from strands import tool

    fetch = fetcher or default_fetcher(config)
    cache: dict[str, Any] = {}

    @tool
    def get_exchange_rate(target_currency: Optional[str] = None) -> dict:
        """Get the current exchange rate from USD to another currency (default IDR).

        Source: open.er-api.com. The fetched rate table is reused for the entire
        session - call this once and reuse the returned rate; do not re-fetch.

        Args:
            target_currency: ISO 4217 code to convert USD into (e.g. IDR, EUR, SGD).
                Defaults to the user's display currency.

        Returns {base, target, rate, as_of, source} or {error}.
        """
        return resolve_rate(context, target_currency, fetch, cache)

    return get_exchange_rate
