#!/usr/bin/env python3
"""Live Task 5 probe: learn the managed Code Interpreter execute_code result
schema and confirm matplotlib/numpy/pandas are available in the sandbox, plus a
matplotlib savefig -> base64 round-trip. Managed CI session (auto start/stop)."""
import inspect
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bedrock_agentcore.tools.code_interpreter_client import CodeInterpreter, code_session  # noqa: E402

for m in ("execute_code", "execute_command", "invoke", "install_packages"):
    f = getattr(CodeInterpreter, m, None)
    if f:
        try:
            print(f"{m} sig: {inspect.signature(f)}")
        except Exception as e:
            print(f"{m} sig n/a: {e}")

CODE = r'''
import sys
print("PYVER", sys.version.split()[0])
mods = {}
for m in ["matplotlib", "numpy", "pandas", "openpyxl"]:
    try:
        mod = __import__(m)
        mods[m] = getattr(mod, "__version__", "?")
    except Exception as e:
        mods[m] = "MISSING:" + type(e).__name__
print("MODS", mods)
try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt, io, base64
    fig, ax = plt.subplots(figsize=(5,3))
    ax.bar(["EC2", "S3"], [800.0, 434.56])
    ax.set_title("Demo"); ax.set_ylabel("Cost (USD)")
    buf = io.BytesIO(); fig.savefig(buf, format="png", dpi=120); plt.close(fig)
    b64 = base64.b64encode(buf.getvalue()).decode()
    print("B64START" + b64 + "B64END")
    print("B64LEN", len(b64))
except Exception as e:
    print("CHART_ERR", type(e).__name__, e)
'''

def walk_text(obj, acc):
    """Collect all string values found anywhere in the nested event structure."""
    if isinstance(obj, str):
        acc.append(obj)
    elif isinstance(obj, dict):
        for v in obj.values():
            walk_text(v, acc)
    elif isinstance(obj, (list, tuple)):
        for v in obj:
            walk_text(v, acc)


region = os.environ.get("AWS_REGION", "us-east-1")
print(f"\n-- starting managed code interpreter in {region} --")
try:
    with code_session(region) as ci:
        res = ci.execute_code(CODE)
        print("RESULT KEYS:", list(res.keys()))
        stream = res.get("stream")
        events = []
        if stream is not None:
            for event in stream:
                events.append(event)
            print("STREAM EVENTS:", len(events))
            for e in events[:12]:
                print("EVENT:", json.dumps(e, default=str)[:1200])
        strings = []
        walk_text(events if events else res, strings)
        joined = "\n".join(strings)
        for marker in ("PYVER", "MODS", "B64LEN", "CHART_ERR"):
            for line in joined.splitlines():
                if marker in line:
                    print("FOUND:", line[:200])
                    break
        if "B64START" in joined and "B64END" in joined:
            b64 = joined.split("B64START", 1)[1].split("B64END", 1)[0]
            print("EXTRACTED B64 length:", len(b64))
            import base64 as _b
            raw = _b.b64decode(b64)
            print("PNG magic ok:", raw[:8] == b"\x89PNG\r\n\x1a\n", "bytes:", len(raw))
except Exception as e:
    import traceback
    print("LIVE CI ERROR:", type(e).__name__, e)
    traceback.print_exc()
