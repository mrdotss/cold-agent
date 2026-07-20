# Cloud Bill Analyst — AgentCore Integration Guide

How to call the deployed **Cloud Bill Analyst** AgentCore Runtime from an app
backend (e.g. Next.js). This is the invocation **contract** + a reference
integration. For build/deploy see `README.md`.

> **Runtime ARN comes from an env var** — don't hardcode it:
> `CBA_RUNTIME_ARN=arn:aws:bedrock-agentcore:<REGION>:<ACCOUNT_ID>:runtime/<RUNTIME_ID>`
> Find it with `aws bedrock-agentcore-control list-agent-runtimes --region <REGION>`.

---

## 1. Endpoint & auth
- Data-plane API: **`InvokeAgentRuntime`** (AWS service `bedrock-agentcore`).
- Call it from your **backend** (it needs AWS credentials). **Never call it from
  the browser** — the browser has no AWS creds and must never hold
  `role_arn` / `external_id`.
- Region: `<REGION>` (same region as the runtime).

Minimum IAM for the calling backend identity:
```json
{
  "Effect": "Allow",
  "Action": "bedrock-agentcore:InvokeAgentRuntime",
  "Resource": "arn:aws:bedrock-agentcore:<REGION>:<ACCOUNT_ID>:runtime/<RUNTIME_ID>*"
}
```

---

## 2. Request

| Field | Required | Notes |
|---|:--:|---|
| `agentRuntimeArn` | ✅ | the runtime ARN (from `CBA_RUNTIME_ARN`) |
| `runtimeSessionId` | ✅ | **33–128 chars**; reuse the same id across turns for memory continuity; a new id starts a fresh conversation |
| `payload` | ✅ | JSON bytes (schema below) |
| `contentType` | ✅ | `application/json` |
| `accept` | ✅ | `text/event-stream` (streaming) |
| `runtimeUserId` | optional | app user id, for tracing |

### Payload schema
```json
{
  "prompt": "What did I spend last month by service?",
  "context": {
    "actor_id": "user-abc",
    "role_arn": "arn:aws:iam::<CUSTOMER_ACCOUNT>:role/CloudBillAnalystReadOnly",
    "external_id": "<per-customer secret>",
    "account_alias": "prod",
    "display_currency": "IDR",
    "timezone": "Asia/Jakarta"
  }
}
```
- **`actor_id` is required** (used for memory + the report folder key).
- `role_arn` + `external_id` are required for **billing** questions and are
  **secrets**: look them up server-side per connected account, never accept them
  from the browser. The runtime consumes them server-side and never logs/echoes them.
- `display_currency` defaults to `IDR`; `timezone` defaults to `Asia/Jakarta`.

---

## 3. Response — Server-Sent Events

With `accept: text/event-stream` the body is a stream of `data: <json>\n\n` lines:

| Event | Handling |
|---|---|
| `{"type":"delta","text":"…"}` | append `text` in order (the streamed answer) |
| `{"type":"report_file","key":"…","bucket":"…"}` | a report was saved — mint a presigned URL for `key` |
| `{"type":"error","message":"…"}` | handled/redacted error — surface to the user |
| `{"type":"done"}` | end of the turn |

`[REPORT_FILE: <key>]` is also appended to the assistant text (authoritative,
exactly once per file) — but prefer the structured `report_file` event in code.

---

## 4. Next.js (App Router) reference

Install: `npm i @aws-sdk/client-bedrock-agentcore @aws-sdk/client-s3 @aws-sdk/s3-request-presigner`

### `app/api/chat/route.ts` — invoke + relay the SSE to the browser
```ts
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore";

const client = new BedrockAgentCoreClient({ region: process.env.AWS_REGION });
const RUNTIME_ARN = process.env.CBA_RUNTIME_ARN!;

export const runtime = "nodejs";

export async function POST(req: Request) {
  const { prompt, sessionId, actorId, accountId } = await req.json();

  // Look up the connected account's role/external-id SERVER-SIDE.
  // Never accept role_arn / external_id from the browser.
  const acct = await getConnectedAccount(actorId, accountId); // your data layer

  const res = await client.send(new InvokeAgentRuntimeCommand({
    agentRuntimeArn: RUNTIME_ARN,
    runtimeSessionId: sessionId,            // 33-128 chars, stable per conversation
    contentType: "application/json",
    accept: "text/event-stream",
    payload: new TextEncoder().encode(JSON.stringify({
      prompt,
      context: {
        actor_id: actorId,
        role_arn: acct.roleArn,
        external_id: acct.externalId,
        account_alias: acct.alias,
        display_currency: "IDR",
      },
    })),
  }));

  // res.response is an async iterable of bytes — pass the SSE through unchanged.
  const upstream = res.response as AsyncIterable<Uint8Array>;
  const stream = new ReadableStream({
    async start(controller) {
      for await (const chunk of upstream) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
}
```

### `app/api/report-url/route.ts` — presigned download for a report key
```ts
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({ region: process.env.AWS_REGION });
const BUCKET = process.env.CBA_REPORT_BUCKET!; // e.g. your report bucket

export async function GET(req: Request) {
  const key = new URL(req.url).searchParams.get("key")!;
  // (authorize: ensure the key belongs to this user's actor_id prefix)
  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: 300 });
  return Response.json({ url });
}
```

### Client — consume the SSE and handle events
```ts
async function ask(prompt: string, sessionId: string, actorId: string) {
  const res = await fetch("/api/chat", {
    method: "POST",
    body: JSON.stringify({ prompt, sessionId, actorId }),
  });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const ev = JSON.parse(line.slice(5).trim());
      if (ev.type === "delta") appendToUI(ev.text);
      else if (ev.type === "report_file") {
        const { url } = await (await fetch(`/api/report-url?key=${encodeURIComponent(ev.key)}`)).json();
        showDownload(url);
      } else if (ev.type === "error") showError(ev.message);
      // ev.type === "done" -> finished
    }
  }
}
```

---

## 5. `[REPORT_FILE]` → presigned download (recipe)
On a `report_file` event (or parsing `[REPORT_FILE: <key>]`), mint a short-lived
presigned GET server-side and hand the URL to the browser (see the route above).
Report objects are private and carry `Metadata: owner-actor-id=<actor_id>`.

---

## 6. Customer onboarding (server-side, per connected account)
Each connected AWS account creates a **read-only** role the runtime assumes:
- **Trust policy** — principal = the runtime execution role ARN; condition
  `sts:ExternalId` = a per-customer secret.
- **Permissions** — `ce:GetCostAndUsage`, `ce:GetDimensionValues`, `ce:GetCostForecast`.

Store `{ role_arn, external_id, alias }` per customer in your app DB and pass them
in the invocation `context`. Treat `external_id` as a secret; rotate per customer.

---

## 7. Backend environment variables (Next.js)
| Var | Example |
|---|---|
| `CBA_RUNTIME_ARN` | `arn:aws:bedrock-agentcore:<REGION>:<ACCOUNT_ID>:runtime/<RUNTIME_ID>` |
| `CBA_REPORT_BUCKET` | your report bucket |
| `AWS_REGION` | `<REGION>` |
| AWS credentials | via task role / instance profile / env (server-side only) |

---

## 8. Notes & edge cases
- **Session id** must be 33–128 chars; keep it stable for a conversation to get
  memory continuity, rotate it for a new conversation.
- **Latency:** report generation (cost query → chart → skill → S3) can take
  ~30–60s; keep the client stream open and show a spinner until `done`.
- **Errors** arrive as `{"type":"error"}` and are already redacted — safe to show.
- **Streaming host:** run the relay on a Node runtime (not edge) and disable
  response buffering so SSE flushes promptly.
