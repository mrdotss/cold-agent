# Tech stack & setup

## Stack
- **Next.js** (App Router, TypeScript) — fullstack.
- **PostgreSQL** + **Drizzle ORM** (migrations via drizzle-kit).
- **Auth.js** (email/password / credentials), sessions in Postgres via the
  Drizzle adapter; passwords hashed with argon2 (or bcrypt).
- **shadcn (Base UI variant)** for components (see `design-system.md`).
- **pnpm** as the package manager.
- AWS SDK v3: `@aws-sdk/client-bedrock-agentcore`, `@aws-sdk/client-s3`,
  `@aws-sdk/s3-request-presigner`, `@aws-sdk/client-sts`.

## First-time setup
```bash
# from app/
pnpm dlx shadcn@latest init --preset b5AMdfnOzw --template next
pnpm add drizzle-orm pg @auth/drizzle-adapter next-auth zod argon2 \
  @aws-sdk/client-bedrock-agentcore @aws-sdk/client-s3 @aws-sdk/s3-request-presigner @aws-sdk/client-sts
pnpm add -D drizzle-kit @types/pg
```
Add shadcn Base UI chat primitives from the registry as needed (e.g. `Message`,
`Message Scroller`, plus `Sidebar`, `Sheet`, `Dialog`, `Form`, `Input`, `Popover`).

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
| `CBA_REPORT_BUCKET` | report bucket for presign | `mr-harness` |
| AWS credentials | server identity to call the runtime + S3 | env / profile / task role |

> The deployed values (runtime id `cloud_bill_analyst-Dn7a652NZj`, region
> `us-east-1`, bucket `mr-harness`) go in the git-ignored `.env`. **Never hardcode
> the ARN** — read `process.env.CBA_RUNTIME_ARN`.

## Guardrails
- All AWS SDK calls and all secret access happen **server-side only**.
- The SSE relay route is **Node runtime** with buffering disabled so events flush
  promptly (`Content-Type: text/event-stream`, `Cache-Control: no-cache`).
- The minimum backend IAM is `bedrock-agentcore:InvokeAgentRuntime` on the runtime
  ARN + `s3:GetObject` on the report bucket (for presign).
- Report generation can take ~30–60s: keep the stream open and show the live
  activity timeline until `done`.
