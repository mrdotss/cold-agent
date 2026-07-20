# Cloud Bill Analyst — AgentCore Runtime Integration Guide

Self-managed Amazon Bedrock AgentCore Runtime that replaces the harness-generated
runtime `harness_MR_Harness-eHHJCx922H`. It analyzes AWS spend for authenticated
app users via a read-only cross-account cost tool, live FX, charts, and generated
report files, orchestrated by **Kimi K2.5** (`moonshotai.kimi-k2.5`) on
**Strands + BedrockAgentCoreApp**.

> The harness runtime is left untouched. This runs in parallel.

---

## 1. Deployed resources (us-east-1, account 279199663312)

| Resource | Identifier |
|---|---|
| **Runtime** | `arn:aws:bedrock-agentcore:us-east-1:279199663312:runtime/cloud_bill_analyst-Dn7a652NZj` |
| Runtime name | `cloud_bill_analyst` |
| Execution role | `arn:aws:iam::279199663312:role/CloudBillAnalystRuntimeRole` |
| Container image | `279199663312.dkr.ecr.us-east-1.amazonaws.com/cloud-bill-analyst:latest` (ARM64) |
| ECR repo | `cloud-bill-analyst` (private, scan-on-push) |
| CodeBuild project | `cloud-bill-analyst-build` (source: GitHub `mrdotss/cold-agent`, ARM64) |
| Memory | `MRMemory-AgcOp32p44` (shared; 30-day short-term events) |
| Preference strategy | `CloudBillAnalystUserPreferences-ofYTKQ4wec` (USER_PREFERENCE, ns `cba/preferences/{actorId}`) |
| Report storage | `s3://mr-harness/cloud-bill-analyst/reports/` |
| Log group | `/aws/bedrock-agentcore/runtimes/cloud_bill_analyst-Dn7a652NZj-DEFAULT` |

Runtime settings mirror the harness: `networkMode=PUBLIC`, idle `900s` /
maxLifetime `28800s`, `requireMMDSV2=true`, `serverProtocol=HTTP`.

---

## 2. Invocation contract

Call the data-plane `InvokeAgentRuntime`. The container serves a streaming
(SSE) endpoint.

### Request
- `agentRuntimeArn` — the runtime ARN above.
- `runtimeSessionId` — **33–128 chars**. Use one id per conversation; reuse the
  **same id across turns** to get conversation continuity (short-term memory is
  restored per session). Use a **new** id to start a fresh conversation.
- `runtimeUserId` *(optional)* — the authenticated app user; useful for tracing.
- `contentType` = `application/json`, `accept` = `text/event-stream`.
- `payload` — JSON bytes (see schema below).

### Payload schema
```json
{
  "prompt": "What did I spend last month by service?",
  "context": {
    "actor_id": "user-abc123",              // REQUIRED - the authenticated app user (memory + report-folder key)
    "role_arn": "arn:aws:iam::<CUST>:role/CloudBillAnalystReadOnly", // customer role to assume (secret)
    "external_id": "<agreed external id>",   // sts ExternalId (secret)
    "account_alias": "prod-account",         // human name shown to the user
    "display_currency": "IDR",               // optional; default IDR
    "timezone": "Asia/Jakarta",              // optional IANA tz; default Asia/Jakarta
    "report_bucket": "mr-harness",           // optional; defaults from runtime env
    "report_prefix": "cloud-bill-analyst/reports/" // optional; defaults from runtime env
  }
}
```

- **`actor_id` is required.** Everything else is optional; billing questions
  need `role_arn` + `external_id` (otherwise the cost tool returns a clear error).
- **`role_arn` and `external_id` are secrets.** They are consumed server-side
  (bound into the cost tool), never placed in the model context, and never
  logged or echoed. The runtime also has a defense-in-depth redactor that
  scrubs them from any output.

---

## 3. Response — SSE event stream

`accept: text/event-stream` returns `data: <json>\n\n` lines. Event shapes:

| Event | Meaning |
|---|---|
| `{"type":"delta","text":"..."}` | incremental assistant text — concatenate in order |
| `{"type":"report_file","key":"...","bucket":"..."}` | a report was saved (authoritative) |
| `{"type":"error","message":"..."}` | a handled error (redacted) |
| `{"type":"done"}` | end of turn |

The `[REPORT_FILE: <key>]` marker is appended to the text **by the runtime**
(exactly once per uploaded file, only after a confirmed upload). The model is
instructed not to emit it, and any model-emitted marker is stripped — so the
`report_file` event and the marker are always authoritative.

---

## 4. `[REPORT_FILE]` → presigned download recipe

Report objects are private (bucket is not public). When you receive a
`report_file` event (or parse `[REPORT_FILE: <key>]`), mint a short-lived
presigned GET on the server and hand the URL to the browser:

```python
import boto3
s3 = boto3.client("s3", region_name="us-east-1")
url = s3.generate_presigned_url(
    "get_object",
    Params={"Bucket": "mr-harness", "Key": key},   # key from the event
    ExpiresIn=300,
)
# return {url} to the client; the object carries Metadata owner-actor-id=<actor_id>
```

Verified in e2e: object present with `owner-actor-id` metadata, presigned GET
downloads a valid PDF/XLSX.

---

## 5. Reference: Next.js relay (App Router)

`app/api/chat/route.ts` — invoke the runtime and relay SSE to the browser:

```ts
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore";

const client = new BedrockAgentCoreClient({ region: "us-east-1" });
const RUNTIME_ARN =
  "arn:aws:bedrock-agentcore:us-east-1:279199663312:runtime/cloud_bill_analyst-Dn7a652NZj";

export async function POST(req: Request) {
  const { prompt, sessionId, actorId, connectedAccount } = await req.json();

  // role_arn / external_id are looked up server-side per connected account -
  // NEVER accept them from the browser.
  const ctx = {
    actor_id: actorId,
    role_arn: connectedAccount.roleArn,
    external_id: connectedAccount.externalId,
    account_alias: connectedAccount.alias,
    display_currency: "IDR",
  };

  const res = await client.send(new InvokeAgentRuntimeCommand({
    agentRuntimeArn: RUNTIME_ARN,
    runtimeSessionId: sessionId,          // 33-128 chars, stable per conversation
    contentType: "application/json",
    accept: "text/event-stream",
    payload: new TextEncoder().encode(JSON.stringify({ prompt, context: ctx })),
  }));

  // res.response is an async iterable of bytes - pass the SSE through unchanged.
  const upstream = res.response as AsyncIterable<Uint8Array>;
  const stream = new ReadableStream({
    async start(controller) {
      for await (const chunk of upstream) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}
```

Client: read the SSE, JSON-parse each `data:` line, append `delta.text`, and on
`report_file` call a `/api/report-url?key=...` route that returns the presigned URL.

---

## 6. Customer onboarding (cross-account trust)

Each connected customer account creates a **read-only** role the runtime assumes.
Reference pattern (validated end-to-end): role `CloudBillAnalystReadOnly` with

**Trust policy** (in the customer account) — allow the runtime's execution role
and require the agreed external id:
```json
{
  "Effect": "Allow",
  "Principal": { "AWS": "arn:aws:iam::279199663312:role/CloudBillAnalystRuntimeRole" },
  "Action": "sts:AssumeRole",
  "Condition": { "StringEquals": { "sts:ExternalId": "<per-customer external id>" } }
}
```
**Permissions** (read-only Cost Explorer):
```json
{ "Effect": "Allow",
  "Action": ["ce:GetCostAndUsage", "ce:GetDimensionValues", "ce:GetCostForecast"],
  "Resource": "*" }
```
Store `{role_arn, external_id, alias}` per customer in the app; pass them in the
invocation `context`. Rotate the external id per customer; treat it as a secret.

---

## 7. Runtime environment variables

| Var | Value | Purpose |
|---|---|---|
| `MODEL_ID` | `moonshotai.kimi-k2.5` | orchestrator model (pluggable) |
| `AWS_MEMORY_ARN` | `...:memory/MRMemory-AgcOp32p44` | AgentCore Memory |
| `AWS_TRUNCATION_MESSAGES_COUNT` | `150` | sliding-window size |
| `AWS_TRUNCATION_STRATEGY` | `sliding_window` | conversation manager |
| `REPORT_BUCKET` / `REPORT_PREFIX` | `mr-harness` / `cloud-bill-analyst/reports/` | report storage |
| `CBA_PREF_STRATEGY_ID` / `CBA_PREF_NAMESPACE` | `CloudBillAnalystUserPreferences-ofYTKQ4wec` / `cba/preferences/{actorId}` | preference recall |
| `FX_FETCH_MODE` | *(unset → `http`)* | `http` (direct) or `browser` (managed Browser) |
| `AWS_STAGE` | `prod` | stage |

---

## 8. Rebuild / redeploy / rollback

**Rebuild image** (on GitHub push to `main`):
```
aws codebuild start-build --project-name cloud-bill-analyst-build --region us-east-1
```
**Point the runtime at the new image** (new version, zero-downtime):
```
aws bedrock-agentcore-control update-agent-runtime --agent-runtime-id cloud_bill_analyst-Dn7a652NZj \
  --agent-runtime-artifact '{"containerConfiguration":{"containerUri":"279199663312.dkr.ecr.us-east-1.amazonaws.com/cloud-bill-analyst:latest"}}' \
  --region us-east-1   # (also re-supply role/network/protocol as required by the API)
```
**Rollback the preference memory strategy** (if ever needed):
```
python scripts/manage_memory_strategy.py delete --strategy-id CloudBillAnalystUserPreferences-ofYTKQ4wec
```

---

## 9. Observability

- **Logs:** CloudWatch `/aws/bedrock-agentcore/runtimes/cloud_bill_analyst-Dn7a652NZj-DEFAULT`
  (structured JSON with `requestId` + `sessionId`, plus app logs). Secrets are redacted.
- **Traces/metrics:** the execution role grants X-Ray + `cloudwatch:PutMetricData`
  (namespace `bedrock-agentcore`); AgentCore auto-instruments. View under the
  CloudWatch **GenAI Observability** console. (Enabling account-level CloudWatch
  Transaction Search unlocks full trace search — it is a shared account setting,
  so coordinate before toggling.)

---

## 10. Implementation notes / decisions

- **FX** defaults to a direct HTTPS GET of the allowlisted `open.er-api.com`
  (validated live); the managed-Browser path is available via `FX_FETCH_MODE=browser`.
- **Report skills** (`minimax_xlsx`, `minimax_pdf`) are in-container equivalents
  built on the specified toolchain (openpyxl / reportlab / pypdf; Node+Playwright+
  LibreOffice bundled). Swap in the originals by replacing `skills/`.
- **No general shell tool** is exposed — reporting is a dedicated `create_report`
  tool, keeping the agent read-only apart from writing report files.
- **Model access:** the runtime invokes Kimi via standard `bedrock-runtime`
  Converse (`bedrock:InvokeModel*`), not the harness's `bedrock-mantle` path.

---

## 11. Validation performed

- Spike: Kimi tool-use+streaming, Memory R/W, cross-account Cost Explorer (live).
- Unit: 55 tests (runtime-context/guard, cost, fx, charts, reporting, skills,
  memory, presentation, system-prompt) + 3 live golden tests.
- CodeBuild: ARM64 image built + in-build skill smoke + `/ping` boot check.
- **Deployed e2e (8/8):** streaming, cost + dual-currency, no-secret-leak,
  cross-invocation session memory, report → `[REPORT_FILE]` → S3 object +
  `owner-actor-id` metadata + presigned PDF download.
