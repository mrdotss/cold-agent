# Structure & conventions

This repo is a **monorepo**:
- `agent/` — the deployed Python AgentCore runtime (Cloud Bill Analyst) + its docs
  (`agent/AGENTCORE_INTEGRATION.md`, `agent/README.md`). **Do not modify** when
  building the web app; treat it as an external service defined by its contract.
- `app/` — **this** Next.js web app (currently empty; scaffold here).

## Proposed `app/` layout (App Router)
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
      report-url/route.ts                         # presign an S3 report key
      accounts/route.ts  accounts/test/route.ts   # create/list + test-connection
      auth/[...nextauth]/route.ts                 # Auth.js
  components/
    ui/                                           # shadcn (Base UI) generated primitives
    chat/                                         # message-list, activity-timeline, report-card,
                                                  #   composer, suggestions, agent-intro
    accounts/                                     # wizard steps, cfn-template, test-connection
    dashboard/
  lib/
    auth.ts                                       # Auth.js config (Drizzle adapter)
    db/ index.ts  schema.ts  migrations/          # Drizzle + Postgres
    aws/ agentcore.ts  s3.ts  sts.ts              # invoke/relay, presign, connection test
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
- One Drizzle **schema.ts**; generate SQL migrations, never hand-edit the DB.
- Keep chat rendering components pure/presentational; do event parsing in a hook
  (e.g. `useAgentStream`) that maps SSE events to UI state.
- Env files: add every new var to **`.env.example`** (placeholder) at the same
  time; real values live only in the git-ignored `.env`.
