#!/usr/bin/env python3
"""Design-review harness: render the redesigned .pdf and .xlsx cost reports with
realistic SAMPLE data and upload them to S3 for visual review.

Charts are produced by the *production* chart code (cloud_bill_analyst.tools.charts)
run locally through a subprocess executor, so what you review matches what the
deployed Code Interpreter renders. Sample figures are illustrative only.

Usage (from the agent/ dir):
    .venv\\Scripts\\python.exe spike\\_probe_report_design.py [--bucket mr-harness]
"""
from __future__ import annotations

import argparse
import copy
import datetime
import importlib.util
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # agent/
sys.path.insert(0, ROOT)
SKILLS = os.path.join(ROOT, "skills")

from cloud_bill_analyst.config import Config          # noqa: E402
from cloud_bill_analyst.runtime_context import RuntimeContext  # noqa: E402
from cloud_bill_analyst.tools.charts import run_chart  # noqa: E402
from cloud_bill_analyst import reporting               # noqa: E402

REGION = "us-east-1"
PREFIX = "cloud-bill-analyst/reports/_design-review/"
CT = {
    "pdf": "application/pdf",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}


def _load(rel, name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(SKILLS, rel))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def local_executor(code: str) -> str:
    """Run generated chart code with the local interpreter (mimics the CI)."""
    f = tempfile.NamedTemporaryFile("w", suffix=".py", delete=False, encoding="utf-8")
    f.write(code)
    f.close()
    try:
        p = subprocess.run([sys.executable, f.name], capture_output=True, text=True, timeout=180)
        return p.stdout if p.returncode == 0 else (p.stdout + "\n" + p.stderr)
    finally:
        os.unlink(f.name)


def sample():
    rate = 16250.0
    rows = [
        {"service": "Amazon EC2", "usd": 4820.55},
        {"service": "Amazon RDS", "usd": 2110.40},
        {"service": "Amazon S3", "usd": 1340.12},
        {"service": "Tax", "usd": 812.00},
        {"service": "AWS Lambda", "usd": 642.88},
        {"service": "Amazon CloudFront", "usd": 455.30},
        {"service": "Amazon Bedrock", "usd": 388.75},
        {"service": "Amazon OpenSearch Service", "usd": 201.10},
        {"service": "AWS Key Management Service", "usd": 24.60},
    ]
    total = round(sum(r["usd"] for r in rows), 2)
    return rate, rows, total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bucket", default="mr-harness")
    ap.add_argument("--no-upload", action="store_true")
    args = ap.parse_args()

    out_dir = os.path.join(tempfile.gettempdir(), "cba-design-review")
    os.environ["CBA_ARTIFACT_DIR"] = out_dir
    os.makedirs(out_dir, exist_ok=True)

    ctx = RuntimeContext(actor_id="design-review", session_id="review-session-000000001",
                         role_arn="arn:aws:iam::1:role/X", external_id="ext")
    cfg = Config.from_env()

    rate, rows, total = sample()
    top = rows[:8]

    print("Rendering charts via production chart code (local executor)...")
    charts = []
    for spec in (
        {"title": "Cost by service", "labels": [r["service"] for r in top],
         "values": [r["usd"] for r in top], "chart_type": "hbar", "currency": "USD"},
        {"title": "Cost composition", "labels": [r["service"] for r in top],
         "values": [r["usd"] for r in top], "chart_type": "pie", "currency": "USD"},
        {"title": "Monthly spend trend", "labels": ["Feb", "Mar", "Apr", "May", "Jun", "Jul"],
         "values": [8120, 8890, 9450, 10120, 10510, 10795], "chart_type": "line", "currency": "USD"},
    ):
        res = run_chart(ctx, cfg, spec, executor=local_executor)
        if "error" in res:
            print("  CHART ERROR:", res)
            sys.exit(1)
        print(f"  ok  {spec['chart_type']:5s} -> {os.path.basename(res['path'])}")
        charts.append(res["path"])

    base = reporting.build_report_spec(
        title="AWS Cost Report",
        description="modern-sample",
        output_path=os.path.join(out_dir, "report.pdf"),
        subtitle="Production account  \u00b7  June 2026  (sample data)",
        period={"start": "2026-06-01", "end": "2026-07-01"},
        currency={"display": "IDR", "usd_rate": rate,
                  "as_of": "Sun, 19 Jul 2026 00:02:31 +0000"},
        rows=copy.deepcopy(rows),
        total={"usd": total},
        chart_paths=charts,
        notes=["Figures from AWS Cost Explorer (UnblendedCost).",
               "Sample data for design review - not a real bill."],
    )

    bp = _load("minimax_pdf/build_pdf.py", "build_pdf_mod")
    bx = _load("minimax_xlsx/build_xlsx.py", "build_xlsx_mod")

    pdf_spec = copy.deepcopy(base)
    pdf_spec["output_path"] = os.path.join(out_dir, "cost-report.pdf")
    xlsx_spec = copy.deepcopy(base)
    xlsx_spec["output_path"] = os.path.join(out_dir, "cost-report.xlsx")

    pdf_path = bp.build_pdf(pdf_spec)
    xlsx_path = bx.build_xlsx(xlsx_spec)
    print(f"\nBuilt:\n  PDF  {pdf_path} ({os.path.getsize(pdf_path):,} bytes)"
          f"\n  XLSX {xlsx_path} ({os.path.getsize(xlsx_path):,} bytes)")

    if args.no_upload:
        return

    import boto3
    s3 = boto3.client("s3", region_name=REGION)
    day = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d")
    print("\nUploading to s3://%s/%s ..." % (args.bucket, PREFIX))
    for path, ext in ((pdf_path, "pdf"), (xlsx_path, "xlsx")):
        key = f"{PREFIX}{day}-modern-sample.{ext}"
        with open(path, "rb") as fh:
            s3.put_object(Bucket=args.bucket, Key=key, Body=fh.read(),
                          ContentType=CT[ext], Metadata={"owner-actor-id": "design-review"})
        url = s3.generate_presigned_url("get_object",
                                        Params={"Bucket": args.bucket, "Key": key},
                                        ExpiresIn=3600)
        print(f"\n[{ext.upper()}] s3://{args.bucket}/{key}")
        print("  download (1h): " + url)

    print("\nDone. Open the presigned links above to review the design.")


if __name__ == "__main__":
    main()
