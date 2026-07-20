# Cloud Bill Analyst

An AI agent that analyzes AWS spending for authenticated users, running on a
**self-managed Amazon Bedrock AgentCore Runtime** (Strands + `BedrockAgentCoreApp`)
orchestrated by **Kimi K2.5** (pluggable via `MODEL_ID`). It answers billing
questions strictly from live tool data, converts currencies, builds charts, and
generates downloadable PDF/XLSX reports.

## What it does
- **Cost analysis** — read-only AWS Cost Explorer via a cross-account role
  (STS AssumeRole + external-id). Never invents numbers.
- **FX** — live USD rates from `open.er-api.com` (cached per session).
- **Charts** — rendered in the sandboxed Code Interpreter (no network).
- **Reports** — `.xlsx`/`.pdf` built in-container, uploaded to S3; the app emits
  exactly one `[REPORT_FILE: <key>]` marker per file.
- **Memory** — short-term conversation + a user-preference strategy (recall
  currency / format / granularity across sessions).
- **Guardrails** — read-only, declines out-of-scope requests, and never reveals
  the role ARN / external-id (redaction guard + system prompt).

## Architecture
- Streaming SSE entrypoint (`app.py`) → Strands `Agent` (Kimi via Bedrock
  Converse) with a 150-message sliding window.
- Tools are bound per-invocation with credentials held **server-side** — secrets
  never enter the model context.
- ARM64 container → private ECR → AgentCore Runtime (`networkMode PUBLIC`).

## Repository layout
```
agent/
  cloud_bill_analyst/       # application package
    app.py                  # BedrockAgentCoreApp entrypoint (SSE streaming)
    agent.py                # model + tools + sliding-window assembly
    config.py               # env-driven configuration
    runtime_context.py      # per-invocation context + secret non-disclosure guard
    system_prompt.py        # the system prompt  (edit to change behavior)
    memory.py               # AgentCore Memory + preference recall
    reporting.py            # create_report tool (skill -> S3 upload + marker)
    presentation.py         # money formatting (IDR / USD)
    tools/                  # cost.py, fx.py, charts.py, artifacts.py
  skills/                   # in-container report builders (minimax_xlsx / minimax_pdf)
  tests/                    # unit + golden tests
  deploy/                   # IAM / ECR / runtime JSON payloads for deployment
  scripts/                  # ops helpers (e.g. memory-strategy management)
  Dockerfile                # multi-stage ARM64 image (appbase + skill toolchain)
  buildspec.yml             # CodeBuild -> ECR (ARM64)
  requirements*.txt         # runtime / skills / dev dependencies
```

## Prerequisites
- Python 3.12+ and AWS credentials for your target region.
- A Bedrock model you can invoke (default `moonshotai.kimi-k2.5`; must support
  Converse tool-use + streaming).
- An AgentCore **Memory** resource, a **private ECR** repo, and an **S3 bucket**
  for reports.
- Docker is optional (local image checks); the ARM64 image is built in CodeBuild.

## Local setup & tests
```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements-dev.txt     # Windows
# .venv/bin/pip install -r requirements-dev.txt                 # macOS / Linux
.venv/Scripts/python -m pytest tests -q                         # unit tests (offline)
```
Optional live behavioral tests (need a test role + external-id):
```bash
python spike/_run_golden.py <ROLE_ARN> <EXTERNAL_ID>
```

## Configuration — parameters to change
Runtime behavior is env-driven (set on the runtime; see `deploy/runtime.json`).
Adjust these for your environment:

| Variable | Purpose | Example |
|---|---|---|
| `MODEL_ID` | orchestrator model | `moonshotai.kimi-k2.5` |
| `AWS_REGION` | region | `us-east-1` |
| `AWS_MEMORY_ARN` | AgentCore Memory ARN | `arn:aws:bedrock-agentcore:<REGION>:<ACCOUNT_ID>:memory/<MEMORY_ID>` |
| `AWS_TRUNCATION_MESSAGES_COUNT` | sliding-window size | `150` |
| `REPORT_BUCKET` / `REPORT_PREFIX` | report storage | `<BUCKET>` / `cloud-bill-analyst/reports/` |
| `CBA_PREF_STRATEGY_ID` / `CBA_PREF_NAMESPACE` | preference recall | `<STRATEGY_ID>` / `cba/preferences/{actorId}` |
| `MODEL_TEMPERATURE` / `MODEL_MAX_TOKENS` | inference tuning | `0.2` / `4096` |
| `FX_FETCH_MODE` | `http` (default) or `browser` | `http` |

Before deploying, also replace the placeholders in `deploy/*.json` and the
commands below for your own account: **`<ACCOUNT_ID>`**, `<REGION>`, the ECR repo
name, the runtime name, and your Memory / S3 identifiers.

## Deploy
1. **Private ECR repo**
   ```bash
   aws ecr create-repository --repository-name cloud-bill-analyst --region <REGION> \
     --image-scanning-configuration scanOnPush=true
   ```
2. **IAM roles + ECR policy** (edit ARNs/account in `deploy/*.json` first)
   ```bash
   aws iam create-role --role-name CloudBillAnalystCodeBuildRole --assume-role-policy-document file://deploy/codebuild-trust.json
   aws iam put-role-policy --role-name CloudBillAnalystCodeBuildRole --policy-name CloudBillAnalystCodeBuildPolicy --policy-document file://deploy/codebuild-policy.json
   aws iam create-role --role-name CloudBillAnalystRuntimeRole --assume-role-policy-document file://deploy/runtime-trust.json
   aws iam put-role-policy --role-name CloudBillAnalystRuntimeRole --policy-name CloudBillAnalystRuntimePolicy --policy-document file://deploy/runtime-policy.json
   aws ecr set-repository-policy --repository-name cloud-bill-analyst --policy-text file://deploy/ecr-repo-policy.json --region <REGION>
   ```
3. **Build the ARM64 image** (CodeBuild; source = your Git repo)
   Create the project from `deploy/codebuild-project.json`, then:
   `aws codebuild start-build --project-name cloud-bill-analyst-build --region <REGION>`
4. **Add the memory preference strategy**
   `python scripts/manage_memory_strategy.py add`
5. **Create the runtime** (edit `deploy/runtime.json`: image URI, role ARN, env)
   `aws bedrock-agentcore-control create-agent-runtime --cli-input-json file://deploy/runtime.json --region <REGION>`
6. **Wait for READY**
   `aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id <RUNTIME_ID> --region <REGION>`

## Invoke
```python
import boto3, json
dp = boto3.client("bedrock-agentcore", region_name="<REGION>")
resp = dp.invoke_agent_runtime(
    agentRuntimeArn="arn:aws:bedrock-agentcore:<REGION>:<ACCOUNT_ID>:runtime/<RUNTIME_ID>",
    runtimeSessionId="a-stable-session-id-at-least-33-characters",   # 33-128 chars; reuse per conversation
    payload=json.dumps({
        "prompt": "What did I spend last month by service?",
        "context": {
            "actor_id": "user-123",                                   # REQUIRED
            "role_arn": "arn:aws:iam::<CUSTOMER_ACCOUNT>:role/CloudBillAnalystReadOnly",
            "external_id": "<per-customer external id>",
            "display_currency": "IDR"
        }
    }).encode(),
    contentType="application/json", accept="text/event-stream",
)
for line in resp["response"].read().decode().splitlines():
    if line.startswith("data:"):
        print(line)
```
SSE events: `{"type":"delta","text":...}`, `{"type":"report_file","key":...}`,
`{"type":"error",...}`, `{"type":"done"}`. `actor_id` is required;
`role_arn`/`external_id` are needed for billing queries and are treated as secrets.

## Changing the model or system prompt
- **Another Bedrock model** (incl. GPT-OSS on Bedrock): change the `MODEL_ID` env
  and re-apply with `update-agent-runtime` — **no image rebuild**.
- **System prompt**: edit `cloud_bill_analyst/system_prompt.py`, then **rebuild**
  (CodeBuild) and `update-agent-runtime`.
- **Non-Bedrock provider** (OpenAI/Anthropic API): change `build_model()` in
  `agent.py` and `requirements.txt`, then rebuild.

`update-agent-runtime` is a full-config call; `deploy/runtime-update.json` is a
ready template (edit the full `environmentVariables` map — it is replaced wholesale).

## Customer onboarding (cross-account, read-only)
Each connected account creates a role the runtime assumes:
- **Trust:** principal = the runtime execution role ARN; condition `sts:ExternalId`
  = a per-customer secret.
- **Permissions:** `ce:GetCostAndUsage`, `ce:GetDimensionValues`, `ce:GetCostForecast`.

Store `{role_arn, external_id, alias}` per customer and pass them in the
invocation `context`.

## Security notes
- Read-only to customer accounts (Cost Explorer reads only); the sole write is
  saving report files to the app's own bucket.
- `role_arn` / `external_id` never enter the model context or logs (redaction guard).
- The report bucket is private; downloads use short-lived presigned URLs.
