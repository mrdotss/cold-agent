"""Reporting pipeline (Task 8): build a report file via an in-container skill,
upload it to the application's own report storage, and manage the single
[REPORT_FILE] marker.

Security / design:
  * Uses a dedicated create_report tool (not a general shell tool) so the agent
    never gets arbitrary shell access - it is a read-only cost analyst whose only
    write is saving report files to the app bucket.
  * Upload uses the APPLICATION's credentials (the runtime execution role), NOT
    the customer's assumed role. The report bucket is app-owned storage.
  * Key layout: {prefix}{actor_id}/{YYYYMMDD}-{slug}.{ext}, with object metadata
    owner-actor-id=<actor_id>. No public ACL is set (bucket stays private).
  * The [REPORT_FILE: <key>] marker is emitted authoritatively by the app after a
    confirmed upload (app.py), exactly once per uploaded key; model-emitted
    markers are stripped from the stream.
"""
from __future__ import annotations

import datetime
import json
import logging
import os
import re
import subprocess
import sys
import uuid
from typing import Any, Callable, List, Optional

import boto3

from .config import Config
from .runtime_context import RuntimeContext
from .tools.artifacts import artifact_dir

log = logging.getLogger("cba.reporting")

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKILLS_DIR = os.environ.get("CBA_SKILLS_DIR") or os.path.join(REPO_ROOT, "skills")

_SKILL_SCRIPT = {
    "xlsx": os.path.join("minimax_xlsx", "build_xlsx.py"),
    "pdf": os.path.join("minimax_pdf", "build_pdf.py"),
}
_CONTENT_TYPE = {
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "pdf": "application/pdf",
}
REPORT_FILE_RE = re.compile(r"\[REPORT_FILE:[^\]]*\]")


def strip_report_markers(text: Optional[str]) -> str:
    """Remove any model-emitted [REPORT_FILE: ...] markers (app is authoritative)."""
    if not text:
        return text or ""
    return REPORT_FILE_RE.sub("", text)


def _slug(s: Optional[str]) -> str:
    s = re.sub(r"[^A-Za-z0-9]+", "-", (s or "").strip().lower()).strip("-")
    return s[:60]


def _today_str(tz: Optional[str]) -> str:
    try:
        from zoneinfo import ZoneInfo
        return datetime.datetime.now(ZoneInfo(tz or "UTC")).strftime("%Y%m%d")
    except Exception:  # noqa: BLE001
        return datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d")


def build_key(context: RuntimeContext, ext: str, description: str) -> str:
    prefix = context.report_prefix or "reports/"
    if not prefix.endswith("/"):
        prefix += "/"
    return f"{prefix}{context.actor_id}/{_today_str(context.timezone)}-{_slug(description) or 'report'}.{ext}"


def build_report_spec(*, title, description, output_path, subtitle=None, period=None,
                      currency=None, rows=None, total=None, chart_paths=None, notes=None) -> dict:
    rows = list(rows or [])
    rate = (currency or {}).get("usd_rate")
    if rate:
        for r in rows:
            if r.get("display") is None and r.get("usd") is not None:
                r["display"] = round(float(r["usd"]) * float(rate))
    total = dict(total or {})
    if rate and total.get("display") is None and total.get("usd") is not None:
        total["display"] = round(float(total["usd"]) * float(rate))
    return {
        "title": title,
        "subtitle": subtitle,
        "period": period,
        "currency": currency,
        "rows": rows,
        "total": total,
        "charts": [p for p in (chart_paths or []) if p],
        "notes": notes or [],
        "output_path": output_path,
    }


def _subprocess_skill_runner(fmt: str, spec: dict, timeout: int = 180) -> str:
    """Run the vendored skill as an isolated subprocess; return the output path."""
    script = os.path.join(SKILLS_DIR, _SKILL_SCRIPT[fmt])
    specfile = spec["output_path"] + ".spec.json"
    os.makedirs(os.path.dirname(os.path.abspath(specfile)), exist_ok=True)
    with open(specfile, "w", encoding="utf-8") as f:
        json.dump(spec, f)
    proc = subprocess.run([sys.executable, script, "--spec", specfile],
                          capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        raise RuntimeError(f"skill '{fmt}' failed (rc={proc.returncode}): {proc.stderr.strip()[-500:]}")
    out = (proc.stdout.strip().splitlines() or [""])[-1].strip() or spec["output_path"]
    if not os.path.isfile(out):
        raise RuntimeError(f"skill '{fmt}' did not produce an output file")
    return out


def upload_report(context: RuntimeContext, config: Config, local_path: str, ext: str,
                  description: str, s3_client: Any = None) -> dict:
    if not context.report_bucket:
        return {"error": "no report storage configured in the runtime context"}
    key = build_key(context, ext, description)
    s3 = s3_client or boto3.client("s3", region_name=config.region)
    with open(local_path, "rb") as f:
        body = f.read()
    s3.put_object(
        Bucket=context.report_bucket,
        Key=key,
        Body=body,
        Metadata={"owner-actor-id": str(context.actor_id)},
        ContentType=_CONTENT_TYPE.get(ext, "application/octet-stream"),
    )
    log.info("report uploaded: bucket=%s key=%s size=%d", context.report_bucket, key, len(body))
    return {"uploaded": True, "key": key, "bucket": context.report_bucket, "size": len(body)}


def generate_and_upload(context: RuntimeContext, config: Config, *, report_format: str,
                        title: str, description: str, subtitle=None, period=None,
                        currency=None, rows=None, total=None, chart_paths=None, notes=None,
                        s3_client: Any = None, skill_runner: Optional[Callable] = None,
                        registry: Optional[List[dict]] = None) -> dict:
    fmt = (report_format or "").lower()
    if fmt not in _SKILL_SCRIPT:
        return {"error": "report_format must be 'xlsx' or 'pdf'"}
    if not context.report_bucket:
        return {"error": "no report storage configured in the runtime context"}

    out_dir = artifact_dir(context)
    output_path = os.path.join(out_dir, f"{uuid.uuid4().hex[:12]}-{_slug(description) or 'report'}.{fmt}")
    spec = build_report_spec(title=title, description=description, output_path=output_path,
                             subtitle=subtitle, period=period, currency=currency,
                             rows=rows, total=total, chart_paths=chart_paths, notes=notes)
    runner = skill_runner or _subprocess_skill_runner
    try:
        local = runner(fmt, spec)
    except Exception as e:  # noqa: BLE001
        return {"error": context.redact(f"report build failed: {type(e).__name__}: {e}")}
    try:
        up = upload_report(context, config, local, fmt, description, s3_client=s3_client)
    except Exception as e:  # noqa: BLE001
        return {"error": context.redact(f"report upload failed: {type(e).__name__}: {e}")}
    if "error" in up:
        return up
    if registry is not None:
        registry.append({"key": up["key"], "bucket": up["bucket"], "format": fmt})
    return {
        "uploaded": True,
        "key": up["key"],
        "bucket": up["bucket"],
        "format": fmt,
        "size": up.get("size"),
        "note": "Upload confirmed. The application appends the [REPORT_FILE] marker automatically - do NOT add it yourself.",
    }


def make_report_tool(context: RuntimeContext, config: Config, registry: Optional[List[dict]] = None,
                     s3_client: Any = None, skill_runner: Optional[Callable] = None) -> Callable:
    from strands import tool

    @tool
    def create_report(
        report_format: str,
        title: str,
        description: str,
        rows: List[dict],
        total_usd: float,
        subtitle: Optional[str] = None,
        period_start: Optional[str] = None,
        period_end: Optional[str] = None,
        display_currency: Optional[str] = None,
        usd_rate: Optional[float] = None,
        fx_as_of: Optional[str] = None,
        total_display: Optional[float] = None,
        chart_paths: Optional[List[str]] = None,
        notes: Optional[List[str]] = None,
    ) -> dict:
        """Build a cost report file (.xlsx or .pdf) from cost data and save it to
        the user's report storage. Use figures you obtained from the cost tool and
        chart paths from create_chart - never invent numbers.

        Args:
            report_format: "xlsx" or "pdf".
            title: Report title.
            description: Short slug used in the filename (e.g. "june-2026-by-service").
            rows: [{"service": str, "usd": float, "display": float?}] largest first.
            total_usd: Total spend in USD.
            subtitle: Optional subtitle (e.g. the account alias + period).
            period_start / period_end: YYYY-MM-DD of the reported period.
            display_currency: e.g. "IDR" (adds a converted column).
            usd_rate: USD->display_currency rate (from get_exchange_rate).
            fx_as_of: FX timestamp string.
            total_display: Total in display currency (auto-computed from usd_rate if omitted).
            chart_paths: Paths returned by create_chart to embed.
            notes: Extra note lines.

        Returns {uploaded, key, bucket, format} on success or {error}. Do not emit
        the [REPORT_FILE] marker yourself; the app adds it after a confirmed upload.
        """
        period = {"start": period_start, "end": period_end} if period_start or period_end else None
        currency = {"display": display_currency, "usd_rate": usd_rate, "as_of": fx_as_of} if display_currency else None
        total = {"usd": total_usd, "display": total_display}
        return generate_and_upload(
            context, config, report_format=report_format, title=title, description=description,
            subtitle=subtitle, period=period, currency=currency, rows=rows, total=total,
            chart_paths=chart_paths, notes=notes,
            s3_client=s3_client, skill_runner=skill_runner, registry=registry,
        )

    return create_report
