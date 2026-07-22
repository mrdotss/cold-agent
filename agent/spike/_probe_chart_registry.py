#!/usr/bin/env python3
"""Offline: prove make_chart_tool registers a client-render chart spec into the
registry (the data app.py emits as a `chart` event). No AWS/CI needed - the
executor is stubbed, and registration happens before any render."""
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ["CBA_ARTIFACT_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("CBA_DISABLE_MEMORY", "1")

from cloud_bill_analyst.config import Config  # noqa: E402
from cloud_bill_analyst.runtime_context import RuntimeContext  # noqa: E402
from cloud_bill_analyst.tools.charts import make_chart_tool  # noqa: E402


def call(tool, **kw):
    """Invoke a Strands @tool's underlying function directly (offline)."""
    fn = getattr(tool, "__wrapped__", None)
    if callable(fn):
        return fn(**kw)
    for attr in ("func", "original_function", "_tool_func", "_func"):
        f = getattr(tool, attr, None)
        if callable(f):
            return f(**kw)
    return tool(**kw)


ctx = RuntimeContext(actor_id="t", session_id="s")
cfg = Config.from_env()

# Valid data -> registered.
reg = []
tool = make_chart_tool(ctx, cfg, executor=lambda code: "", registry=reg)
call(tool, title="Top 5 services by cost", labels=["Amazon EC2", "Amazon RDS", "Amazon S3"],
     values=[4820.55, 2110.40, 1340.12], chart_type="bar", currency="USD")
assert len(reg) == 1, f"expected 1 registered spec, got {len(reg)}"
c = reg[0]
print("REGISTERED:", c)
assert c["chart_type"] == "bar"
assert c["labels"] == ["Amazon EC2", "Amazon RDS", "Amazon S3"]
assert c["values"] == [4820.55, 2110.40, 1340.12]
assert c["currency"] == "USD"
assert c["title"] == "Top 5 services by cost"
assert isinstance(c.get("id"), str) and c["id"]

# Mismatched labels/values -> NOT registered (client can't render it).
reg2 = []
bad = make_chart_tool(ctx, cfg, executor=lambda code: "", registry=reg2)
call(bad, title="bad", labels=["a", "b"], values=[1.0], chart_type="bar")
assert reg2 == [], "mismatched data must not register"

# No registry -> no error, tool still works (report-only path).
none_tool = make_chart_tool(ctx, cfg, executor=lambda code: "")
call(none_tool, title="ok", labels=["a"], values=[1.0], chart_type="pie")

print("\nCHART REGISTRY PROBE OK")
