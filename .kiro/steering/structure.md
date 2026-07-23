# Structure & conventions

This repo is a **monorepo**:
- `agent/` — the deployed Python AgentCore runtime (Cloud Bill Analyst) + its docs
  (`agent/AGENTCORE_INTEGRATION.md`, `agent/README.md`). **Do not modify** when
  building the web app; treat it as an external service defined by its contract.
- `app/` — **this** Next.js web app (scaffolded and under active development;
  App Router, TypeScript, pnpm, Auth.js v5).

## `app/` layout (App Router)
> Established structure + iteration-2 targets. Match existing files/paths already
> in `app/` rather than recreating them.
```
app/
  app/
    (auth)/login/           register/            # public auth pages
    (app)/                                        # authenticated shell (guarded)
      dashboard/                                  # overview + anomaly flags + accounts
      chat/[threadId]/                            # agentic chat (disabled w/o an account)
      accounts/                                   # connect / manage AWS accounts (wizard)
    api/
      chat/route.ts                               # SSE relay -> AgentCore (Node runtime)
      report-url/route.ts                         # presign an S3 report key (download)
      conversations/route.ts                      # GET list (by user) + POST create
      conversations/[id]/route.ts                 # GET messages + PATCH rename + DELETE
      conversations/[id]/title/route.ts           # POST: AI-generate a title from the first prompt
      accounts/route.ts  accounts/test/route.ts   # create/list + test-connection
      auth/[...nextauth]/route.ts                 # Auth.js
  components/
    ui/                                           # shadcn (Base UI) generated primitives
    chat/                                         # message-list, activity-timeline, report-card,
                                                  #   chart-inline, composer, suggestions, agent-intro
    accounts/                                     # wizard steps, cfn-template, test-connection
    dashboard/
  lib/
    auth.ts                                       # Auth.js config (Drizzle adapter)
    db/ index.ts  schema.ts  migrations/          # Drizzle + Postgres (auth + accounts ONLY)
    history/ conversations.ts  messages.ts        # DynamoDB data layer (chat history)
    aws/ agentcore.ts  s3.ts  sts.ts  dynamo.ts  bedrock.ts   # invoke/relay, presign, conn test, DDB doc client, title Converse
    crypto.ts                                     # encrypt/decrypt external_id at rest
    session-id.ts                                 # stable 33-128 char runtime session ids
  drizzle.config.ts
  .env.example                                    # committed (placeholders)
  .env                                            # git-ignored (real deployed values)
```

## Conventions
- **Server-only** modules for anything touching AWS or secrets (`lib/aws/*`,
  `lib/crypto.ts`); never import them into client components.
- Route handlers that stream must run on the **Node runtime** (`export const
  runtime = "nodejs"`), not edge.
- Validate all route inputs with **zod**. Return typed errors.
- One Drizzle **schema.ts** for **auth + connected accounts only**; generate SQL
  migrations, never hand-edit the DB.
- **Chat history lives in DynamoDB, not Postgres.** Use a single-table design
  (see the spec) via `@aws-sdk/lib-dynamodb` `DynamoDBDocumentClient`; authorize
  every read/write by the signed-in user's id. `lib/aws/dynamo.ts` owns the
  client, `lib/history/*` owns the conversation/message access patterns.
- Keep chat rendering components pure/presentational; do event parsing in a hook
  (e.g. `useAgentStream`) that maps SSE events to UI state.
- Env files: add every new var to **`.env.example`** (placeholder) at the same
  time; real values live only in the git-ignored `.env`.
