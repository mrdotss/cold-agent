# syntax=docker/dockerfile:1.7
# Cloud Bill Analyst - self-managed Bedrock AgentCore Runtime image.
#
# Target platform is linux/arm64 (AgentCore Runtime requirement). Built in
# CodeBuild on native arm64 (Task 11):
#   docker buildx build --platform linux/arm64 -t <ecr>/cloud-bill-analyst:<tag> --push .
#
# Local app-layer sanity check (native amd64, fast - skips heavy toolchain):
#   docker build --target appbase --platform linux/amd64 -t cba-appbase .
#   docker run --rm -p 8080:8080 -e CBA_DISABLE_MEMORY=1 cba-appbase   # then GET /ping

ARG PYTHON_VERSION=3.12

# =========================================================================
# Task 6 - base runtime: serves /invocations + /ping on :8080 (text-only path)
# =========================================================================
FROM python:${PYTHON_VERSION}-slim-bookworm AS appbase
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    DOCKER_CONTAINER=1 \
    AWS_REGION=us-east-1 \
    PORT=8080
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY cloud_bill_analyst/ ./cloud_bill_analyst/
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8080/ping || exit 1
CMD ["python", "-m", "cloud_bill_analyst.app"]

# =========================================================================
# Task 7 - full runtime: bake report-skill toolchain + vendored skills.
#   Node 18 (Debian bookworm) + Playwright/Chromium, LibreOffice, fonts,
#   and the Python report libs (reportlab/openpyxl/pypdf/pandas/lxml).
# =========================================================================
FROM appbase AS runtime
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
    HOME=/root
RUN apt-get update && apt-get install -y --no-install-recommends \
        nodejs npm \
        libreoffice-calc libreoffice-writer \
        fonts-dejavu-core fonts-liberation2 fonts-noto-core \
    && rm -rf /var/lib/apt/lists/*
# Python report-skill deps
COPY requirements-skills.txt ./
RUN pip install --no-cache-dir -r requirements-skills.txt
# Node Playwright + Chromium (installs matching OS deps via --with-deps)
RUN npm install -g playwright@1.48.0 \
    && npx --yes playwright@1.48.0 install --with-deps chromium
# Vendored in-container skills
COPY skills/ ./skills/
# Build-time smoke: skill deps import and skills produce files (fail fast).
RUN python -c "import openpyxl, reportlab, pypdf, pandas, lxml; print('skill deps ok')" \
    && python skills/demo.py /tmp/cba-build-smoke \
    && rm -rf /tmp/cba-build-smoke
CMD ["python", "-m", "cloud_bill_analyst.app"]
