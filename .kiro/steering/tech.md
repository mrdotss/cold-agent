# Tech stack & setup

## Stack
- **Next.js** (App Router, TypeScript) — fullstack.
- **PostgreSQL** + **Drizzle ORM** (migrations via drizzle-kit) — **auth only**:
  users, sessions, and connected AWS accounts (relational + encrypted secrets).
- **Amazon DynamoDB** (NoSQL) — **chat history**: conversations + messages
  (high-write, fast key/GSI reads). Single-table design (see `structure.md`).
- **Auth.js v5** (`next-auth@beta`) — email/password via the **Credentials**
  provider, sessions in Postgres via the `@auth/drizzle-adapter`; passwords hashed
  with argon2 (or bcrypt). Use the v5 API (`handlers`, `auth`, `signIn`, `signOut`).
  Note: Credentials + **database** sessions is not natively supported in Auth.js
  (v4 or v5) — implement the custom "create a session row + manage the cookie in
  the authorize/session callbacks" flow (the app already does this).
- **shadcn (Base UI variant)** for components (see `design-system.md`).
- **pnpm** as the package manager.
- AWS SDK v3: `@aws-sdk/client-bedrock-agentcore`, `@aws-sdk/client-s3`,
  `@aws-sdk/s3-request-presigner`, `@aws-sdk/client-sts`,
  `@aws-sdk/client-dynamodb` + `@aws-sdk/lib-dynamodb` (chat history), and
  `@aws-sdk/client-bedrock-runtime` (AI conversation titles — a direct Converse
  call, NOT the Cloud Bill Analyst agent runtime).

## First-time setup (already run — kept for reference / fresh clones)
```bash
# from app/
pnpm dlx shadcn@latest init --preset b5AMdfnOzw --template next
pnpm add drizzle-orm pg @auth/drizzle-adapter next-auth@beta zod argon2 \
  @aws-sdk/client-bedrock-agentcore @aws-sdk/client-s3 @aws-sdk/s3-request-presigner @aws-sdk/client-sts \
  @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb @aws-sdk/client-bedrock-runtime
pnpm add -D drizzle-kit @types/pg
```
Add shadcn Base UI chat primitives from the registry as needed (e.g. `Message`,
`Message Scroller`, plus `Sidebar`, `Sheet`, `Dialog`, `Form`, `Input`, `Popover`).
Add the shadcn **`chart`** component (Base UI variant) for inline chat charts —
`pnpm dlx shadcn@latest add chart` pulls the Chart components + **Recharts**.

## Scripts (package.json)
`dev`, `build`, `start`, `db:generate` (drizzle-kit generate), `db:migrate`,
`db:push`, `lint`, `typecheck`.

## Environment variables
Backend/server-only unless noted. Commit **`.env.example`** with placeholders;
put real deployed values only in the git-ignored **`.env`**.

| Var | Purpose | Example |
|---|---|---|
| `DATABASE_URL` | Postgres connection | `postgres://user:pass@host:5432/cba` |
| `AUTH_SECRET` | Auth.js session/JWT secret | (random 32+ bytes) |
| `APP_ENCRYPTION_KEY` | encrypt `external_id` at rest | (random 32 bytes, base64) |
| `AWS_REGION` | runtime + S3 region | `us-east-1` |
| `CBA_RUNTIME_ARN` | AgentCore runtime ARN | `arn:aws:bedrock-agentcore:us-east-1:<ACCOUNT_ID>:runtime/cloud_bill_analyst-Dn7a652NZj` |
| `CBA_REPORT_BUCKET` | report + chart bucket for presign | `mr-harness` |
| `CBA_HISTORY_TABLE` | DynamoDB table for conversations + messages | `cba-chat-history` |
| `CBA_TITLE_MODEL_ID` | Bedrock model for AI conversation titles (fast/cheap) | `moonshotai.kimi-k2.5` |
| AWS credentials | server identity: runtime + S3 + DynamoDB + Bedrock | env / profile / task role |

> The deployed values (runtime id `cloud_bill_analyst-Dn7a652NZj`, region
> `us-east-1`, bucket `mr-harness`) go in the git-ignored `.env`. **Never hardcode
> the ARN** — read `process.env.CBA_RUNTIME_ARN`.

## Guardrails
- All AWS SDK calls and all secret access happen **server-side only**.
- The SSE relay route is **Node runtime** with buffering disabled so events flush
  promptly (`Content-Type: text/event-stream`, `Cache-Control: no-cache`).
- The minimum backend IAM is `bedrock-agentcore:InvokeAgentRuntime` on the runtime
  ARN, `s3:GetObject` on the report bucket (presign report keys),
  `dynamodb:GetItem/PutItem/UpdateItem/DeleteItem/Query` on `CBA_HISTORY_TABLE`
  (+ its GSI), and `bedrock:InvokeModel` on `CBA_TITLE_MODEL_ID` (title summaries).
  (Inline chat charts are client-rendered from `chart` event data — no S3/presign.)
- Report generation can take ~30–60s: keep the stream open and show the live
  activity timeline until `done`.
