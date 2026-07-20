#!/usr/bin/env python3
"""Live Task 9 probe: confirm the preference strategy is discovered from the real
memory and that the session manager builds with preference recall wired. No
writes (no pollution). End-to-end recall is exercised in Task 13."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("AWS_MEMORY_ID", "MRMemory-AgcOp32p44")
os.environ.pop("CBA_DISABLE_MEMORY", None)

from cloud_bill_analyst import memory as m  # noqa: E402
from cloud_bill_analyst.config import Config  # noqa: E402
from cloud_bill_analyst.runtime_context import RuntimeContext  # noqa: E402

m._pref_cache.clear()
cfg = Config.from_env()
print("memory_id:", cfg.memory_id)
rc = m._pref_retrieval_config(cfg)
print("retrieval_config namespaces:", list(rc.keys()))
for ns, c in rc.items():
    print("  ", ns, "strategy_id=", getattr(c, "strategy_id", None), "top_k=", getattr(c, "top_k", None))
assert rc, "expected preference retrieval config discovered from the live strategy"

sm = m.maybe_build_session_manager(cfg, RuntimeContext(actor_id="probe-user", session_id="probe-sess"))
print("session manager:", type(sm).__name__ if sm else None)
assert sm is not None, "session manager should build when memory + strategy present"
print("\nMEMORY PREF PROBE OK")
