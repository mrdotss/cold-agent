# AgentCore integration (how the web app talks to the agent)

The deployed **Cloud Bill Analyst** runtime is the app's backend brain. The full,
authoritative contract (request/response, reference Next.js routes, onboarding) is:

#[[file:agent/AGENTCORE_INTEGRATION.md]]

Read that file. The essentials the app must honor:

## Invocation
- Call **`InvokeAgentRuntime`** (`@aws-sdk/client-bedrock-agentcore`) from the
  **server only** — the browser has no AWS creds and must never hold secrets.
- ARN comes from **`process.env.CBA_RUNTIME_ARN`** (never hardcode).
- `runtimeSessionId`: **33–128 chars**, **stable per chat thread** (persist a
  `threadId → sessionId` mapping) for memory continuity; a new thread = new id.
- `accept: text/event-stream`; relay the SSE through a **Node-runtime** route.

## Payload `context`
- `actor_id` (**required**) = the signed-in app user id (drives memory + report
  folder key).
- `role_arn` + `external_id` = **secrets**, looked up **server-side** for the
  selected connected account; never accepted from or exposed to the browser.
- `display_currency` (default `IDR`), `timezone` (default `Asia/Jakarta`),
  `account_alias`.

## SSE events → UI
| Event | UI |
|---|---|
| `delta {text}` | append to the assistant message (markdown, tables, code chips) |
| `tool {phase:"start", id,name,label,status}` | add a step to the live activity timeline; show `status` + `label`, spinner |
| `tool {phase:"end", id,name}` | mark that step (match `id`) complete |
| `report_file {key,bucket}` | presign `key` server-side → render a **download card** when the URL is ready |
| `error {message}` | show an error (already redacted) |
| `done` | end the turn; collapse the activity timeline into a summary |

Tool `name`s: `get_cost_and_usage`, `get_exchange_rate`, `create_chart`,
`create_report`. Ignore unknown future event types gracefully.

## Reports
Report objects are **private** (`Metadata: owner-actor-id=<actor_id>`). Mint a
short-lived presigned GET **server-side** (`@aws-sdk/s3-request-presigner`,
`CBA_REPORT_BUCKET`); authorize that the key's actor prefix matches the user.

## Connecting an AWS account (onboarding wizard)
Each account is a **read-only cross-account role**:
- **Trust:** principal = the runtime's execution role ARN; condition
  `sts:ExternalId` = a per-account secret the app generates.
- **Permissions:** `ce:GetCostAndUsage`, `ce:GetDimensionValues`,
  `ce:GetCostForecast` (read-only).
Wizard flow: generate `external_id` → show a **CloudFormation template** (or
console steps) the user runs in *their* account → user pastes back the created
role ARN → **Test connection** (assume the role + a tiny cost query) → store
`{ alias, role_arn, external_id (encrypted with APP_ENCRYPTION_KEY) }`.
**Never collect AWS access keys.**

## Deployed values (put in the git-ignored `.env`)
`CBA_RUNTIME_ARN=…:runtime/cloud_bill_analyst-Dn7a652NZj` · `AWS_REGION=us-east-1`
· `CBA_REPORT_BUCKET=mr-harness`. Commit only placeholders to `.env.example`.
