#!/usr/bin/env python3
"""Run the live golden tests with env set in-process (shell-agnostic).
Usage: python spike/_run_golden.py <ROLE_ARN> <EXTERNAL_ID>"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["CBA_LIVE_GOLDEN"] = "1"
os.environ["CBA_DISABLE_MEMORY"] = "1"
if len(sys.argv) >= 3:
    os.environ["ROLE_ARN"] = sys.argv[1]
    os.environ["EXTERNAL_ID"] = sys.argv[2]

import pytest  # noqa: E402

sys.exit(pytest.main(["tests/test_golden.py", "-q", "-s"]))
