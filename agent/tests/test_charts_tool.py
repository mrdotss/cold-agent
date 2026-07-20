"""Offline unit tests for the chart tool - no CI (executor injected)."""
import base64
import os

from cloud_bill_analyst.config import Config
from cloud_bill_analyst.runtime_context import RuntimeContext
from cloud_bill_analyst.tools.charts import (
    build_chart_code,
    extract_image,
    extract_stdout,
    run_chart,
)

# 1x1 PNG
TINY_PNG_B64 = ("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk"
                "+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")


def _ctx():
    return RuntimeContext(actor_id="chart-user", session_id="sess-1",
                          role_arn="arn:aws:iam::1:role/X", external_id="ext")


def _cfg():
    return Config.from_env()


def test_build_chart_code_has_markers_and_spec():
    code = build_chart_code({"title": "My Costs", "labels": ["EC2"], "values": [800],
                             "chart_type": "bar", "currency": "USD"})
    assert "B64START" in code and "B64END" in code
    assert "spec = json.loads(" in code
    assert "My Costs" in code and "EC2" in code  # embedded via json literal


def test_extract_image_roundtrip():
    stdout = f"noise\nB64START{TINY_PNG_B64}B64END\nmore"
    assert extract_image(stdout) == TINY_PNG_B64
    assert extract_image("no markers here") is None


def test_extract_stdout_ci_shape():
    res = {"stream": [
        {"result": {"content": [{"type": "text", "text": "hello"}, {"type": "text", "text": "world"}]}},
        {"result": {"structuredContent": {"stdout": "extra"}}},
    ]}
    out = extract_stdout(res)
    assert "hello" in out and "world" in out and "extra" in out


def test_run_chart_writes_png(tmp_path, monkeypatch):
    monkeypatch.setenv("CBA_ARTIFACT_DIR", str(tmp_path))

    def fake_executor(code):
        assert "B64START" in code  # got real chart code
        return f"B64START{TINY_PNG_B64}B64END"

    res = run_chart(_ctx(), _cfg(),
                    {"title": "t", "labels": ["EC2", "S3"], "values": [800, 434.56],
                     "chart_type": "bar", "currency": "USD"},
                    executor=fake_executor)
    assert "error" not in res, res
    assert res["media_type"] == "image/png" and res["points"] == 2
    assert os.path.isfile(res["path"])
    with open(res["path"], "rb") as f:
        raw = f.read()
    assert raw[:8] == b"\x89PNG\r\n\x1a\n"
    assert raw == base64.b64decode(TINY_PNG_B64)


def test_run_chart_mismatched_lengths():
    res = run_chart(_ctx(), _cfg(),
                    {"title": "t", "labels": ["a", "b"], "values": [1]},
                    executor=lambda c: "")
    assert "error" in res


def test_run_chart_no_image(tmp_path, monkeypatch):
    monkeypatch.setenv("CBA_ARTIFACT_DIR", str(tmp_path))
    res = run_chart(_ctx(), _cfg(),
                    {"title": "t", "labels": ["a"], "values": [1]},
                    executor=lambda c: "boom, no image")
    assert "error" in res
