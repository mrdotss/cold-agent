#!/usr/bin/env bash
# Task 7 acceptance: build sample .xlsx + .pdf via the skills and round-trip the
# .xlsx. Runs inside the container image (or any env with skill deps installed).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-/tmp/cba-skill-demo}"
echo "== minimax skills demo -> ${OUT} =="
python3 "${HERE}/demo.py" "${OUT}"
echo "== artifacts =="
ls -la "${OUT}"
