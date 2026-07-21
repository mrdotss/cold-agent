# Implementation Plan: Cloud Bill Analyst (Web)

## Overview

This plan builds the Next.js App Router (TypeScript) front end to the already-deployed
AgentCore runtime, incrementally, so each step builds on the previous and everything
is wired together with no orphaned code. It follows the hard boundary that all AWS SDK
calls and secret access happen in server-only modules, and per-account secrets
(`role_arn`, `external_id`) never reach the browser.

Build order: scaffold and tooling → pure-logic core (validation, crypto, redaction,
SSE parsing, ids, CFN, anomaly, suggestions, stream reducer, state machines) with
property tests → persistence (Drizzle schema) → auth → server-only AWS integration →
account wizard → threads/messages → chat SSE relay → client stream hook and chat UI →
reports → dashboard and anomalies → message actions, suggestions, confirmation gate →
auth pages and guarded shell → design system/theming/accessibility → env and static
guards → final integration.

Property-based tests use **fast-check + Vitest**, a minimum of 100 iterations each,
one test per correctness property, each tagged
`// Feature: cloud-bill-analyst-web, Property {n}: {property_text}`.

## Tasks

- [x] 1. Scaffold app, tooling, and environment configuration
  - [x] 1.1 Initialize the Next.js app with the shadcn "Sera" preset and dependencies
    - From `app/`, run `pnpm dlx shadcn@latest init --preset b5AMdfnOzw --template next`
    - Add runtime deps: `drizzle-orm pg @auth/drizzle-adapter next-auth zod argon2 @aws-sdk/client-bedrock-agentcore @aws-sdk/client-s3 @aws-sdk/s3-request-presigner @aws-sdk/client-sts server-only`
    - Add dev deps: `drizzle-kit @types/pg`
    - Add `package.json` scripts: `dev`, `build`, `start`, `db:generate`, `db:migrate`, `db:push`, `lint`, `typecheck`
    - Create the App Router folder skeleton per structure steering (`app/(auth)`, `app/(app)`, `app/api`, `components/`, `lib/`)
    - _Requirements: 20.1_
  - [x] 1.2 Add committed `.env.example` and confirm `.env` is git-ignored
    - Write `.env.example` with exactly one non-secret placeholder for each of the seven vars: `DATABASE_URL`, `AUTH_SECRET`, `APP_ENCRYPTION_KEY`, `AWS_REGION`, `CBA_RUNTIME_ARN`, `CBA_RUNTIME_ROLE_ARN`, `CBA_REPORT_BUCKET`
    - Ensure `.env` is listed in `.gitignore`
    - Add a server-only `lib/env.ts` helper that reads required vars at request time and throws a typed error naming a missing/empty variable (no values in the message)
    - _Requirements: 19.1, 19.2, 19.3, 19.4, 19.5_
  - [x] 1.3 Configure Vitest + fast-check test harness
    - Add Vitest config and a `test` script; wire fast-check as a dev dependency
    - Add a shared property-test setup asserting >= 100 iterations default
    - _Requirements: (tooling for all property tests)_

- [x] 2. Implement pure validation and id/masking helpers
  - [x] 2.1 Implement `lib/validation/*` zod schemas and helpers
    - `emailSchema` (trimmed, <=254, `local@domain`), `passwordSchema` (8..128), `roleArnSchema` (`arn:aws:iam::<12-digit>:role/<name>`), `aliasSchema` (trimmed 1..100), `currencySchema` (ISO 4217), `timezoneSchema` (valid IANA)
    - `normalizeEmail` (trim + lowercase), `maskAccountId` (reveal last 4), `accountIdFromRoleArn`
    - _Requirements: 1.3, 1.4, 3.4, 3.6, 3.7, 5.3, 17.2, 17.3, 18.6_
  - [x] 2.2 Implement `lib/session-id.ts` and `lib/external-id.ts`
    - `sessionIdForThread(threadId)` deterministic 33..128 chars, stable per thread; `newSessionId()` one-shot in [33,128]
    - `newExternalId()` cryptographically random, length in [16,1224]
    - _Requirements: 3.1, 7.9, 8.3, 8.4_
  - [x] 2.3 Write property test for email validation
    - **Property 3: Email validation**
    - **Validates: Requirements 1.3**
  - [x] 2.4 Write property test for password length validation
    - **Property 4: Password length validation**
    - **Validates: Requirements 1.4**
  - [x] 2.5 Write property test for email normalization equivalence
    - **Property 2: Email normalization equivalence**
    - **Validates: Requirements 1.2**
  - [x] 2.6 Write property test for account alias validation
    - **Property 8: Account alias validation**
    - **Validates: Requirements 3.4, 3.7**
  - [x] 2.7 Write property test for role ARN validation
    - **Property 9: Role ARN validation**
    - **Validates: Requirements 3.6**
  - [x] 2.8 Write property test for currency and timezone validation
    - **Property 30: Currency and timezone validation**
    - **Validates: Requirements 17.2, 17.3**
  - [x] 2.9 Write property test for account-id masking
    - **Property 14: Account-id masking**
    - **Validates: Requirements 5.3**
  - [x] 2.10 Write property test for External_Id generation bounds and uniqueness
    - **Property 6: External_Id generation bounds and uniqueness**
    - **Validates: Requirements 3.1**
  - [x] 2.11 Write property test for runtime session id generation
    - **Property 17: Runtime session id generation**
    - **Validates: Requirements 7.9, 8.3, 8.4**

- [x] 3. Implement crypto, redaction, and SSE parsing (server-only pure core)
  - [x] 3.1 Implement `lib/crypto.ts`
    - AES-256-GCM `encryptSecret`/`decryptSecret` using `APP_ENCRYPTION_KEY`; `server-only` import
    - _Requirements: 4.4, 4.6, 18.5_
  - [x] 3.2 Implement `lib/aws/sse.ts` parsing, filtering, and redaction
    - `SseEvent` union + `parseSseChunk` (split on `\n\n`, parse `data:` JSON, return `{events, rest}`)
    - `toKnownEvent` keeps only `delta|tool|report_file|error|done`, returns null otherwise
    - `redactForBrowser` strips `role_arn`/`external_id`/AWS creds from any object graph, idempotent
    - _Requirements: 4.5, 4.6, 5.9, 7.4, 7.7, 18.2_
  - [x] 3.3 Write property test for External_Id encryption round-trip
    - **Property 11: External_Id encryption round-trip**
    - **Validates: Requirements 4.4, 4.6, 18.5**
  - [x] 3.4 Write property test for secret redaction of browser-bound output
    - **Property 12: Secret redaction for all browser-bound output**
    - **Validates: Requirements 4.5, 4.6, 5.9, 7.4, 18.2**
  - [x] 3.5 Write property test for SSE relay filtering and ordering
    - **Property 16: SSE relay filtering and ordering**
    - **Validates: Requirements 7.6, 7.7**

- [x] 4. Implement CFN template, anomaly classifier, and suggestions (pure)
  - [x] 4.1 Implement `lib/aws/cfn-template.ts`
    - `buildCfnTemplate(runtimeRoleArn, externalId)` granting exactly `ce:GetCostAndUsage`, `ce:GetDimensionValues`, `ce:GetCostForecast`; trust principal = runtime role ARN; condition `sts:ExternalId == externalId`
    - `launchStackUrl(templateUrl, region)` console deep link
    - _Requirements: 3.2, 3.3_
  - [x] 4.2 Implement `lib/anomaly.ts` classifier
    - `classifyAnomalies(series)`: spike (latest daily >= 1.5 x trailing-7-day avg), new_service (current>0 && prev==0), large_mom_delta ((current-prev)/prev >= 0.25); exactly one kind per anomaly
    - _Requirements: 13.1, 13.4, 13.5, 13.6_
  - [x] 4.3 Implement `lib/suggestions.ts`
    - `generateSuggestions(ctx, previous)` returns 3-6 chips (1..120 chars); >= half differ from previous render; returns `[]` when < 3 valid chips
    - _Requirements: 16.1, 16.3, 16.4_
  - [x] 4.4 Write property test for CloudFormation template correctness
    - **Property 7: CloudFormation template correctness**
    - **Validates: Requirements 3.2**
  - [x] 4.5 Write property test for anomaly classification
    - **Property 25: Anomaly classification**
    - **Validates: Requirements 13.1, 13.4, 13.5, 13.6**
  - [x] 4.6 Write property test for suggestion chip bounds
    - **Property 28: Suggestion chip bounds**
    - **Validates: Requirements 16.1**
  - [x] 4.7 Write property test for suggestion variability
    - **Property 29: Suggestion variability**
    - **Validates: Requirements 16.3**

- [x] 5. Implement the client stream reducer and interaction state machines (pure)
  - [x] 5.1 Implement `streamReducer` and `StreamState` in `hooks/useAgentStream.ts` (reducer portion)
    - `tool start` new id -> append `running` step; existing id -> update label/status in place; `tool end` matching id -> `done`; non-matching -> ignore; `delta` -> append text in order (never discard on malformed markdown); `report_file` -> record key; `done` -> collapse + ordered summary; `error` -> running steps become `stopped`; unknown -> ignored; maintain `liveRegion` text
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 10.1, 10.7_
  - [x] 5.2 Implement pure feedback and confirmation-gate state machines
    - Feedback: at most one value stored; submit replaces; activating current value clears; displayed state reflects stored value
    - Confirmation gate: invoked exactly once iff one approve; blocked while unanswered; reject/no-answer -> zero invocations
    - _Requirements: 14.5, 14.6, 14.8, 15.1, 15.2, 15.3, 15.4, 15.5_
  - [x] 5.3 Write property test for activity-timeline step invariants
    - **Property 20: Activity-timeline step invariants**
    - **Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5, 9.7**
  - [x] 5.4 Write property test for done-summary ordering
    - **Property 21: Done-summary ordering**
    - **Validates: Requirements 9.6**
  - [x] 5.5 Write property test for delta accumulation preserving content and order
    - **Property 22: Delta accumulation preserves content and order**
    - **Validates: Requirements 10.1, 10.7**
  - [x] 5.6 Write property test for message-feedback state machine
    - **Property 26: Message-feedback state machine**
    - **Validates: Requirements 14.5, 14.6, 14.8**
  - [x] 5.7 Write property test for confirmation-gate state machine
    - **Property 27: Confirmation-gate state machine**
    - **Validates: Requirements 15.1, 15.2, 15.3, 15.4, 15.5**

- [x] 6. Checkpoint - pure core complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Implement persistence layer (Drizzle + Postgres)
  - [x] 7.1 Define `lib/db/schema.ts` and `lib/db/index.ts`
    - Tables: `users`, `sessions`, `connected_accounts`, `active_account`, `threads`, `messages`, `message_feedback`, `login_attempts` per the data model
    - Configure `drizzle.config.ts`; create the Postgres client in `lib/db/index.ts`
    - _Requirements: 1.5, 2.6, 4.4, 4.5, 5.1, 8.3, 14.5, 2.9_
  - [x] 7.2 Generate and apply the initial migration
    - Run `db:generate` to produce SQL migrations (never hand-edited) and `db:migrate`
    - Add browser-safe `ConnectedAccountView` projection helper (excludes `role_arn`, `external_id_enc`)
    - _Requirements: 5.9, 18.2_
  - [x] 7.3 Write unit test for `ConnectedAccountView` projection
    - Assert the projection contains `maskedAccountId` and omits `role_arn`/`external_id_enc`
    - _Requirements: 5.9, 18.2_

- [x] 8. Implement authentication (Auth.js credentials, argon2, DB sessions)
  - [x] 8.1 Implement `lib/auth.ts` with Drizzle adapter and DB-backed sessions
    - Credentials provider with a custom authorize flow that creates a `sessions` row on success and 30-day `expires`; expired rows treated as unauthenticated; `actor_id` = user id
    - _Requirements: 1.6, 2.1, 2.5, 2.6, 2.7, 2.8_
  - [x] 8.2 Implement `registerUser` server action
    - Validate email/password, normalize email, reject duplicate (case-insensitive), argon2-hash, create user + session; store no plaintext password
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_
  - [x] 8.3 Implement login, sign-out, and rate limiting
    - Login validates fields, generic invalid-credentials message, retains email; sign-out deletes session; record login attempts; lock an email after 5 failures within 15 minutes for 15 minutes
    - _Requirements: 2.2, 2.3, 2.5, 2.9_
  - [x] 8.4 Add the `app/api/auth/[...nextauth]/route.ts` handler
    - Wire Auth.js route (Node runtime)
    - _Requirements: 2.1, 2.4_
  - [x] 8.5 Write property test for password hash verification round-trip
    - **Property 1: Password hash verification round-trip**
    - **Validates: Requirements 1.1, 1.5**
  - [x] 8.6 Write property test for login rate-limit lockout
    - **Property 5: Login rate-limit lockout**
    - **Validates: Requirements 2.9**
  - [x] 8.7 Write integration tests for session lifecycle
    - Session creation/deletion/lifetime with mocked clock/DB
    - _Requirements: 1.6, 2.1, 2.5, 2.7, 2.8_

- [x] 9. Implement server-only AWS integration modules
  - [x] 9.1 Implement `lib/aws/agentcore.ts`
    - `invokeAgentRuntime` reads `process.env.CBA_RUNTIME_ARN` at call time; throws `MissingRuntimeConfigError` if unset/empty; returns upstream SSE async iterable; `accept: text/event-stream`
    - _Requirements: 7.1, 18.3, 18.4_
  - [x] 9.2 Implement `lib/aws/sts.ts` and `lib/aws/cost-explorer.ts`
    - `assumeReadOnlyRole(roleArn, externalId)`; `testConnection` (validate input first, then AssumeRole + 1-day DAILY single-metric `GetCostAndUsage` within 30s, categorized failure); `getCostAndUsage` for reads
    - _Requirements: 4.1, 4.2, 4.3, 4.5_
  - [x] 9.3 Implement `lib/aws/s3.ts` report presign
    - `keyBelongsToActor` and `reportFileType` pure helpers; `presignReport` authorizes actor prefix then mints presigned GET on `CBA_REPORT_BUCKET` with expiry in [1,300]s; errors on missing key/bucket or presign failure
    - _Requirements: 11.1, 11.2, 11.3, 11.4_
  - [x] 9.4 Write property test for connection-test input rejection before assume-role
    - **Property 10: Connection test rejects invalid input before any assume-role**
    - **Validates: Requirements 4.2**
  - [x] 9.5 Write property test for report key authorization
    - **Property 23: Report key authorization**
    - **Validates: Requirements 11.3**
  - [x] 9.6 Write property test for report file-type indicator
    - **Property 24: Report file-type indicator**
    - **Validates: Requirements 11.6**
  - [x] 9.7 Write integration tests for AWS wiring (mocked clients)
    - Invocation accept/ARN/context wiring; connection-test happy path and timeout; presign happy path and failure
    - _Requirements: 7.1, 7.2, 7.3, 4.1, 4.3, 11.1, 11.2, 11.4_

- [x] 10. Implement account wizard (routes, actions, and UI)
  - [x] 10.1 Implement account server actions and routes
    - `createConnectedAccount` (enforce 1..10 count, encrypt External_Id, store defaults `IDR`/`Asia/Jakarta`, associate to user, store nothing on failure), `deleteConnectedAccount`, `updateAccountSettings`, `setActiveAccount`
    - `app/api/accounts/route.ts` (POST create / GET list with secrets stripped) and `app/api/accounts/test/route.ts` (POST test) on Node runtime, zod-validated
    - _Requirements: 3.1, 3.4, 3.8, 4.4, 4.5, 4.6, 4.7, 5.1, 5.2, 5.5, 5.6, 5.7, 5.8, 5.9, 17.2, 18.6, 18.7_
  - [x] 10.2 Build wizard UI components in `components/accounts/`
    - External_Id generation step, CFN template (copyable inline + downloadable) + Launch Stack link, ARN/alias inputs with field-level validation, Test connection, redacted error display
    - _Requirements: 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 4.2, 4.5_
  - [x] 10.3 Build `/accounts` page with list, switcher, settings, and removal
    - List alias + masked account id; empty-state; account switcher persisting active selection; per-account currency/timezone settings; confirm removal; clear active on removal of active account
    - _Requirements: 5.3, 5.4, 5.5, 5.6, 5.7, 17.1, 17.2, 17.3_
  - [x] 10.4 Write property test for connected-account count bound
    - **Property 13: Connected-account count bound**
    - **Validates: Requirements 5.1, 5.2**
  - [x] 10.5 Write unit tests for wizard and account CRUD flows
    - No-keys schema, happy-path store with defaults, CRUD and active-selection transitions, template presentation + Launch Stack link
    - _Requirements: 3.3, 3.5, 4.4, 5.4, 5.5, 5.6, 5.7, 5.8_

- [x] 11. Implement threads and messages
  - [x] 11.1 Implement thread/message server actions and reads
    - `createThread({connectedAccountId})` pins account + generates/persists sessionId (reject with zero accounts); ownership-checked message reads ordered by `created_at` asc; empty-thread handling; thread list scoped to user
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 8.9_
  - [x] 11.2 Implement currency/timezone resolution helper for invocation context
    - Resolve `display_currency`/`timezone` from pinned account, substituting `IDR`/`Asia/Jakarta` for unset values
    - _Requirements: 7.5, 17.4, 17.5_
  - [x] 11.3 Write property test for message ordering
    - **Property 19: Message ordering**
    - **Validates: Requirements 8.5**
  - [x] 11.4 Write property test for currency and timezone resolution with defaults
    - **Property 18: Currency and timezone resolution with defaults**
    - **Validates: Requirements 7.5, 17.5**
  - [x] 11.5 Write unit tests for thread pin/ownership/empty-thread guards
    - _Requirements: 8.1, 8.2, 8.6, 8.7, 8.9_

- [x] 12. Implement the chat SSE relay route
  - [x] 12.1 Implement `app/api/chat/route.ts` (Node runtime SSE relay)
    - Assert authenticated session (else reject, no invoke); load thread with owner check + pinned account (reject if missing/zero accounts, preserving message text semantics); resolve `role_arn` + decrypted external_id server-side; set `context.actor_id`, currency/timezone; set stable `runtimeSessionId`
    - Respond `text/event-stream`, `Cache-Control: no-cache`, buffering disabled, flush each event <1s; forward `delta|tool|report_file|error|done` in order; drop unknown; keep open until done/error or 120s stall; emit exactly one redacted `error` on invoke-start failure; pass every outgoing chunk through `redactForBrowser`
    - _Requirements: 6.5, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10, 7.11, 18.4_
  - [x] 12.2 Implement `regenerate` re-invocation wiring
    - Re-invoke using preceding user prompt + existing session id; disable when no preceding prompt
    - _Requirements: 14.3, 14.4_
  - [x] 12.3 Write property test for input validation gating side effects
    - **Property 31: Input validation gates side effects**
    - **Validates: Requirements 18.6, 18.7**
  - [x] 12.4 Write integration tests for relay wiring and error/guard paths
    - Accept/ARN/context wiring, invoke-start error event, session/account guards
    - _Requirements: 7.1, 7.2, 7.3, 7.8, 7.10, 7.11_

- [x] 13. Implement report presign route
  - [x] 13.1 Implement `app/api/report-url/route.ts`
    - Node runtime; authorize actor prefix; call `presignReport`; return typed error on missing key/bucket or presign failure; never return partial URL
    - _Requirements: 11.1, 11.2, 11.3, 11.4_

- [x] 14. Implement the client stream hook wiring and chat UI
  - [x] 14.1 Complete `hooks/useAgentStream.ts` network wiring
    - Wire `fetch("/api/chat")` to `streamReducer`; expose `state` + `send(prompt)`; feed presign for `report_file` keys
    - _Requirements: 7.6, 9.x, 10.1, 11.5_
  - [x] 14.2 Build core chat components in `components/chat/`
    - `MessageList` (right-aligned user bubbles, left-aligned assistant prose, GitHub-flavored markdown tables + inline code chips, anchored auto-scroll that stops when user scrolls away), `ActivityTimeline` (spinner/check/stopped, collapse/expand on done, `aria-live="polite"`), `AgentIntro` empty state, `Composer` (disabled with connect-account CTA when zero accounts)
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 9.1-9.8, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7_
  - [x] 14.3 Build `app/(app)/chat/[threadId]` page and wire components + hook together
    - Compose message list, timeline, composer, and suggestions on the page; enforce composer enablement from account count
    - _Requirements: 6.1, 6.2, 6.3, 6.4_
  - [x] 14.4 Write property test for composer enablement
    - **Property 15: Composer enablement**
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.4**
  - [x] 14.5 Write unit/snapshot tests for chat rendering
    - Markdown table + code-chip rendering, message alignment, aria-live updates
    - _Requirements: 9.8, 10.2, 10.4, 10.5, 20.7_

- [x] 15. Implement report card, message actions, suggestions, and confirmation gate UI
  - [x] 15.1 Build `ReportCard` wired to the presign route
    - Render only once presigned URL resolves; PDF/XLSX file-type indicator + download control
    - _Requirements: 11.5, 11.6_
  - [x] 15.2 Build `MessageActions` and feedback persistence
    - Copy with confirmation (>=2s) and copy-failed handling; regenerate; thumbs up/down via `setMessageFeedback` server action with error retention of prior state
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7, 14.8_
  - [x] 15.3 Build `Suggestions` and `ConfirmationGate` components
    - Chips replace composer contents + focus without submit; fallback to no chips; inline approve/reject gate blocking invocation until answered
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 16.1, 16.2, 16.3, 16.4_
  - [x] 15.4 Write unit tests for actions, chips, and gate interactions
    - Copy/regenerate flows, chip interaction and fallback, gate approve/reject
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 16.2, 16.4_

- [x] 16. Implement dashboard and anomaly display
  - [x] 16.1 Build `app/(app)/dashboard` with server-side Cost Explorer query
    - Query CE via active account's assumed role (most recent selection, default first); current-month-to-date total in display currency within 10s; loading state; zero-account CTA (no CE query); redacted error state with retry
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6_
  - [x] 16.2 Wire anomaly detection into dashboard badges and inline chat callouts
    - Run `Anomaly_Detector` server-side; render one badge per anomaly with classification; inline rose (spike) / amber (new service, large MoM) callouts; zero anomalies on CE failure
    - _Requirements: 13.1, 13.2, 13.3, 13.7_
  - [x] 16.3 Write integration tests for dashboard CE states
    - Success, loading, zero-account, and failure/timeout retry states with mocked CE
    - _Requirements: 12.1, 12.2, 12.3, 12.5, 12.6_
  - [x] 16.4 Write snapshot tests for anomaly badge/callout accent mapping
    - _Requirements: 13.2, 13.3_

- [x] 17. Implement auth pages and guarded shell
  - [x] 17.1 Build `(auth)/login` and `(auth)/register` pages
    - Forms wired to auth actions; field-level and generic error messages; retain email on failure
    - _Requirements: 1.1, 1.3, 1.4, 2.2, 2.3_
  - [x] 17.2 Build the guarded `(app)` layout, sidebar, and redirects
    - Redirect unauthenticated requests to `/login`; sidebar with account switcher + thread list; sign-out control
    - _Requirements: 2.4, 2.5, 5.4, 8.9_

- [x] 18. Implement design system, theming, and accessibility compliance
  - [x] 18.1 Apply Sera tokens, theming, and reduced-motion handling
    - Noto Serif headings, Lora body, Violet accent, Zinc neutrals, 0 radius, HugeIcons, flat surfaces; light/dark with OS-preference default and in-session persistence; suppress non-essential motion under `prefers-reduced-motion`; Sera tokens win on conflict
    - _Requirements: 20.1, 20.2, 20.3, 20.4, 20.8_
  - [x] 18.2 Ensure keyboard traversal, focus indicators, and contrast
    - Composer, message actions, account switcher, thread list Tab-reachable and Enter/Space-activatable with visible focus; verify 4.5:1 / 3:1 contrast in both themes
    - _Requirements: 20.5, 20.6_
  - [x] 18.3 Write accessibility/snapshot tests
    - Sera tokens, theme light/dark + OS preference + persistence, reduced motion, keyboard traversal/focus, axe contrast checks in both themes
    - _Requirements: 20.1, 20.2, 20.3, 20.4, 20.5, 20.6, 20.8_

- [x] 19. Add environment and secret-boundary static guards
  - [x] 19.1 Write static tests for boundaries and env
    - Assert `lib/aws/*` and `lib/crypto.ts` use `server-only`; no runtime-ARN literal (`arn:aws:bedrock-agentcore:*`) in source; `.env.example` has exactly the seven placeholders; `.env` is git-ignored
    - _Requirements: 18.1, 18.3, 19.2, 19.3_
  - [x] 19.2 Write unit tests for env error handling
    - Missing/empty var yields server error + exactly one log entry naming the variable, no values leaked
    - _Requirements: 18.4, 19.4, 19.5_

- [x] 20. Final checkpoint - full integration
  - Run `typecheck`, `lint`, `build`, and the full test suite; ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional (tests) and can be skipped for a faster MVP, but each maps to specific requirements/properties for traceability.
- Each of the 31 correctness properties is implemented by exactly one property-based test (fast-check + Vitest, >= 100 iterations, tagged with its property number).
- Property tests are placed next to the pure logic they validate so errors surface early; unit/integration/snapshot tests cover auth, CRUD, AWS wiring, rendering, theming, and accessibility.
- Checkpoints (tasks 6 and 20) provide incremental validation points.
- The Python agent in `agent/` is treated as an external service and is never modified.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "2.1", "2.2", "3.1", "3.2", "4.1", "4.2", "4.3", "5.1", "5.2"] },
    { "id": 2, "tasks": ["2.3", "2.4", "2.5", "2.6", "2.7", "2.8", "2.9", "2.10", "2.11", "3.3", "3.4", "3.5", "4.4", "4.5", "4.6", "4.7", "5.3", "5.4", "5.5", "5.6", "5.7", "7.1"] },
    { "id": 3, "tasks": ["7.2", "8.1", "9.1", "9.2", "9.3"] },
    { "id": 4, "tasks": ["7.3", "8.2", "8.3", "8.4", "9.4", "9.5", "9.6", "9.7", "11.1", "11.2"] },
    { "id": 5, "tasks": ["8.5", "8.6", "8.7", "10.1", "11.3", "11.4", "11.5"] },
    { "id": 6, "tasks": ["10.2", "10.3", "12.1", "13.1"] },
    { "id": 7, "tasks": ["10.4", "10.5", "12.2", "14.1"] },
    { "id": 8, "tasks": ["12.3", "12.4", "14.2", "16.1"] },
    { "id": 9, "tasks": ["14.3", "15.1", "15.2", "15.3", "16.2", "17.1", "17.2"] },
    { "id": 10, "tasks": ["14.4", "14.5", "15.4", "16.3", "16.4", "18.1", "18.2"] },
    { "id": 11, "tasks": ["18.3", "19.1", "19.2"] }
  ]
}
```
