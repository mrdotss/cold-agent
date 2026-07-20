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

### TL;DR — do I rebuild the image?

| What you change | Edit | Rebuild image? | How to apply |
|---|---|:--:|---|
| Model → another **Bedrock** model (Claude, Nova, **GPT-OSS on Bedrock**, …) | `MODEL_ID` env | **No** | `update-agent-runtime` |
| Temperature / max tokens | `MODEL_TEMPERATURE` / `MODEL_MAX_TOKENS` env | **No** | `update-agent-runtime` |
| FX channel | `FX_FETCH_MODE` env (`http`/`browser`) | **No** | `update-agent-runtime` |
| **System prompt** | `cloud_bill_analyst/system_prompt.py` | **Yes** | rebuild → `update-agent-runtime` |
| Model → **non-Bedrock** API (real OpenAI/Anthropic) | `cloud_bill_analyst/agent.py` `build_model()` + `requirements.txt` | **Yes** | rebuild → `update-agent-runtime` |

**Why:** `MODEL_ID`, temperature, etc. are read from **environment variables** at
startup (`config.py`), so changing them is just a runtime update — the image is
untouched. The **system prompt** is a Python constant baked into the image
(`system_prompt.py`), so changing it requires a rebuild.

`update-agent-runtime` is a **full-config** call — it creates a new runtime version
and rolls the endpoint onto it (other runtimes are unaffected). Use the ready
template **`deploy/runtime-update.json`**. ⚠️ `environmentVariables` are replaced
**wholesale** — edit the full map in that file, never just one key.

### A) Swap the model, Bedrock → Bedrock (e.g. Kimi → Claude / GPT-OSS) — no rebuild
1. **Confirm the new model supports Converse tool-use + streaming** (the agent needs both):
   ```bash
   aws bedrock get-foundation-model --model-identifier <NEW_MODEL_ID> --region <REGION>
   ```
   (want `responseStreamingSupported: true`). To also confirm tool-use, run the
   existing spike against it (it exercises tool-use + streaming):
   ```bash
   MODEL_ID=<NEW_MODEL_ID> python spike/spike_kimi.py
   ```
   All checks should pass before you deploy.
2. Edit **`deploy/runtime-update.json`** → set `environmentVariables.MODEL_ID` to
   `<NEW_MODEL_ID>` (keep the rest of the env map intact).
3. Apply (zero-downtime, new version):
   ```bash
   aws bedrock-agentcore-control update-agent-runtime --cli-input-json file://deploy/runtime-update.json --region <REGION>
   ```
4. Verify (`status: READY`, `environmentVariables.MODEL_ID` = new id):
   ```bash
   aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id <RUNTIME_ID> --region <REGION>
   ```
5. Smoke-test the live runtime:
   ```bash
   python spike/_e2e_runtime.py --role-arn <ROLE_ARN> --external-id <EXTERNAL_ID>
   ```

**No IAM change needed** — the execution role already allows `bedrock:InvokeModel*`
on `foundation-model/*`. **"GPT" note:** GPT-OSS *on Bedrock* (`openai.gpt-oss-*`)
uses this path; the *real* OpenAI API (not Bedrock) is path **C**.

### B) Change the system prompt — rebuild required
1. Edit **`cloud_bill_analyst/system_prompt.py`** (`SYSTEM_PROMPT`).
2. Test locally:
   ```bash
   python -m pytest tests -q
   python spike/_run_golden.py <ROLE_ARN> <EXTERNAL_ID>
   ```
3. Commit + push to `main` (CodeBuild builds from your Git repo):
   ```bash
   git add cloud_bill_analyst/system_prompt.py
   git commit -m "update system prompt"
   git push origin main
   ```
4. Rebuild the ARM64 image and wait for `SUCCEEDED`:
   ```bash
   aws codebuild start-build --project-name cloud-bill-analyst-build --region <REGION>
   aws codebuild batch-get-builds --ids <BUILD_ID> --region <REGION>
   ```
5. Roll the runtime onto the fresh image (`:latest` now points to the new build;
   the update creates a new version that re-pulls it):
   ```bash
   aws bedrock-agentcore-control update-agent-runtime --cli-input-json file://deploy/runtime-update.json --region <REGION>
   ```
6. Verify + smoke-test (as in A-4 / A-5).

> Tip: if you'll tweak the prompt often, the app can be changed to read
> `SYSTEM_PROMPT` from an env var or an S3 object — that turns prompt edits into an
> env-only `update-agent-runtime` (no rebuild).

### C) Swap to a non-Bedrock provider (real OpenAI / Anthropic API) — rebuild required
Only needed for providers **outside** Bedrock. Bedrock-hosted GPT/Claude use path A.
1. In `cloud_bill_analyst/agent.py`, change `build_model()` from `BedrockModel` to
   the matching Strands provider, e.g.:
   ```python
   from strands.models.openai import OpenAIModel
   def build_model(config):
       return OpenAIModel(
           model_id=config.model_id,
           params={"temperature": config.temperature, "max_tokens": config.max_tokens},
       )
   ```
2. Add the provider extra to `requirements.txt` (e.g. `strands-agents[openai]`).
3. Provide the API key **without baking it into the image**: store it in AWS Secrets
   Manager (grant the runtime role `secretsmanager:GetSecretValue`) or pass it as an
   env var, and read it in `build_model()`. Never commit keys.
4. Commit/push → rebuild (CodeBuild) → `update-agent-runtime` (as in B 3–6).

### Rollback
- **Runtime:** re-run `update-agent-runtime` pointing `containerUri` at the previous
  image **digest**, or pick a prior version in the console **Versions** tab.
- **Find the previous image:** `aws ecr describe-images --repository-name cloud-bill-analyst --region <REGION>`
- **Prompt/model tweaks** are just another `update-agent-runtime`, so rollback = apply the old value again.

> Deployment-specific IDs (runtime id, model id, CodeBuild project) for your own
> environment live in your local `.env` (git-ignored).

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
