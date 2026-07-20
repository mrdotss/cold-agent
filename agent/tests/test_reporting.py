"""Offline unit tests for the reporting pipeline (fake S3 + injected skill runner)."""
from cloud_bill_analyst import reporting
from cloud_bill_analyst.config import Config
from cloud_bill_analyst.runtime_context import RuntimeContext


def _ctx(bucket="cba-reports"):
    return RuntimeContext(
        actor_id="user-42", session_id="s", report_bucket=bucket, report_prefix="reports/",
        timezone="Asia/Jakarta", display_currency="IDR",
        role_arn="arn:aws:iam::1:role/X", external_id="ext-secret",
    )


class FakeS3:
    def __init__(self):
        self.calls = []

    def put_object(self, **kw):
        self.calls.append(kw)
        return {"ETag": "e"}


def _fake_runner(fmt, spec):
    p = spec["output_path"]
    with open(p, "wb") as f:
        f.write(b"%PDF-DATA" if fmt == "pdf" else b"XLSXDATA")
    return p


def test_strip_report_markers():
    assert reporting.strip_report_markers("ok [REPORT_FILE: reports/x.pdf] end") == "ok  end"
    assert reporting.strip_report_markers(None) == ""


def test_build_key_format():
    key = reporting.build_key(_ctx(), "xlsx", "June 2026 by Service!")
    assert key.startswith("reports/user-42/")
    assert key.endswith("-june-2026-by-service.xlsx")


def test_build_report_spec_computes_display():
    spec = reporting.build_report_spec(
        title="t", description="d", output_path="/tmp/x.xlsx",
        currency={"display": "IDR", "usd_rate": 1000},
        rows=[{"service": "EC2", "usd": 2}], total={"usd": 2})
    assert spec["rows"][0]["display"] == 2000
    assert spec["total"]["display"] == 2000


def test_upload_report_metadata_and_key(tmp_path):
    f = tmp_path / "r.xlsx"
    f.write_bytes(b"data")
    s3 = FakeS3()
    up = reporting.upload_report(_ctx(), Config.from_env(), str(f), "xlsx", "my report", s3_client=s3)
    assert up["uploaded"] and up["key"].endswith("-my-report.xlsx")
    call = s3.calls[0]
    assert call["Bucket"] == "cba-reports"
    assert call["Metadata"] == {"owner-actor-id": "user-42"}
    assert call["ContentType"].endswith("spreadsheetml.sheet")


def test_generate_and_upload_registry(tmp_path, monkeypatch):
    monkeypatch.setenv("CBA_ARTIFACT_DIR", str(tmp_path))
    s3 = FakeS3()
    reg = []
    res = reporting.generate_and_upload(
        _ctx(), Config.from_env(), report_format="pdf", title="T", description="june",
        rows=[{"service": "EC2", "usd": 800}], total={"usd": 800},
        currency={"display": "IDR", "usd_rate": 1000},
        s3_client=s3, skill_runner=_fake_runner, registry=reg)
    assert res["uploaded"] and res["format"] == "pdf"
    assert reg and reg[0]["key"].endswith("-june.pdf")
    assert s3.calls[0]["Metadata"]["owner-actor-id"] == "user-42"


def test_generate_and_upload_no_bucket():
    res = reporting.generate_and_upload(
        _ctx(bucket=None), Config.from_env(), report_format="xlsx", title="T",
        description="d", rows=[], total={"usd": 0}, skill_runner=_fake_runner)
    assert "error" in res


def test_generate_and_upload_bad_format():
    res = reporting.generate_and_upload(
        _ctx(), Config.from_env(), report_format="docx", title="T", description="d",
        rows=[], total={"usd": 0}, skill_runner=_fake_runner)
    assert "error" in res
