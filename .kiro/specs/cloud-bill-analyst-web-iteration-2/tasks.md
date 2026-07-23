# Implementation Plan: Cloud Bill Analyst (Web) — Iteration 2

## Overview

This plan implements iteration 2 in the existing Next.js App Router app under
`app/` (TypeScript, pnpm, Vitest + fast-check). It builds strictly on the
iteration-1 primitives (`lib/aws/sse.ts`, `hooks/useAgentStream.ts`,
`app/api/chat/route.ts`, `lib/session-id.ts`, the chat components, and the app
shell) and does not recreate them.

The work proceeds from the pure, testable cores outward: extend the SSE
vocabulary and the stream reducer for the new `chart` event (and rename the client
contract to `conversationId`), add the inline chart component, then build the pure
single-table/key/title/rename helpers, the server-only DynamoDB store, the
conversation + title + message-feedback APIs, the chat-relay persistence path
(disconnect-safe assistant persistence), the reopen/hydration page, and finally
the optimistic sidebar with editable titles. It also drops the superseded Postgres
`threads`/`messages`/`messageFeedback` tables via a generated Drizzle migration.
Property tests target the pure invariants defined in the design's Correctness
Properties; example, integration, and static-boundary tests cover the rest.

All AWS SDK access and secret handling stay server-side only; every new route
runs on the Node runtime, validates inputs with zod, and passes browser-bound
bytes through the existing redaction step. Chat history — and message feedback —
live entirely in DynamoDB; Postgres retains auth + connected accounts only.

## Tasks

- [x] 1. Set up iteration-2 dependencies, config, and shared types
  - [x] 1.1 Install AWS SDK clients and add the shadcn chart component
    - Add `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`, and
      `@aws-sdk/client-bedrock-runtime` to `app/package.json` via pnpm
    - Run `pnpm dlx shadcn@latest add chart` to generate `components/ui/chart.tsx`
      and pull Recharts (Base UI variant)
    - _Requirements: 12.1_

  - [x] 1.2 Add iteration-2 environment placeholders
    - Add non-secret `CBA_HISTORY_TABLE` and `CBA_TITLE_MODEL_ID` placeholders to
      the committed `app/.env.example`
    - _Requirements: 12.1, 12.2_

  - [x] 1.3 Extend the chat message type for persisted charts, reports, and feedback
    - In `components/chat/types.ts`, import `ChartSpec` and add optional
      `charts?: ChartSpec[]` and `reports?: { key: string }[]` to `ChatMessage`
    - Add an `id: string` field (the message SK id `MSG#…#<ulid>` used to address
      feedback writes) and an optional `feedback?: "up" | "down"` field so the
      hydrated transcript can address and render each assistant turn's persisted
      thumbs state
    - _Requirements: 4.10, 9.6, 14.1, 14.4_

  - [x] 1.4 Drop the superseded Postgres chat tables and generate the migration
    - In `lib/db/schema.ts`, remove the `threads`, `messages`, and `messageFeedback`
      table definitions (delete, not merely deprecate); retain the `users`,
      `sessions`, `connectedAccounts`, `activeAccount`, and `loginAttempts`
      definitions unchanged
    - Run `pnpm db:generate` (drizzle-kit) to emit a migration under
      `lib/db/migrations/` whose SQL `DROP`s exactly `threads`, `messages`, and
      `messageFeedback` and leaves the retained auth/account tables intact; commit
      the generated SQL and never hand-edit the DB
    - _Requirements: 12.5, 12.6_

  - [x] 1.5 Write a test asserting the migration drops exactly the three tables
    - Assert the generated migration SQL issues `DROP` for `threads`, `messages`,
      and `messageFeedback` and issues no `DROP` for `users`, `sessions`,
      `connectedAccounts`, `activeAccount`, or `loginAttempts`; and that
      `schema.ts` no longer exports the three dropped table definitions
    - _Requirements: 12.5, 12.6_

- [x] 2. Add the `chart` event to the server-side SSE pipeline
  - [x] 2.1 Extend `lib/aws/sse.ts` with the `ChartSpec` type and `chart` variant
    - Export the `ChartSpec` interface (`id`, `chart_type`, `title`, `currency`,
      `labels`, `values`) and add `{ type: "chart"; spec: ChartSpec }` to `SseEvent`
    - Add a `case "chart"` to `toKnownEvent` that forwards only when `spec` is an
      object, `chart_type ∈ {bar,hbar,line,pie}`, `labels` is a string array,
      `values` is a number array, and `labels.length === values.length`; return
      `null` (drop) otherwise, keeping the unknown-type drop behavior intact
    - Keep the module pure and client-safe (no `server-only`, no `@aws-sdk`)
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

  - [x] 2.2 Write property tests for chart-event narrowing
    - Create `lib/aws/sse.chart.property.test.ts` (extend the `sse.property.test.ts`
      generators with a valid `ChartSpec` arbitrary and a "malformed chart"
      arbitrary that breaks exactly one invariant)
    - **Property 1: Valid chart events narrow to an equal chart event**
    - **Property 2: Malformed chart events are dropped**
    - **Property 3: Unknown event types are always dropped**
    - **Validates: Requirements 2.1, 2.2, 2.3, 2.5**

- [x] 3. Accumulate chart specs in the stream reducer
  - [x] 3.1 Add the `charts` field and `chart` case to `hooks/useAgentStream.ts`
    - Add `charts: ChartSpec[]` to `StreamState`, seed `[]` in
      `createInitialStreamState`, append `event.spec` immutably in a `case "chart"`,
      and clear it on `reset`; leave all existing cases and the one-in-flight send
      guard unchanged
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

  - [x] 3.2 Write property tests for the chart reducer behavior
    - Create `hooks/useAgentStream.charts.property.test.ts`
    - **Property 4: The reducer appends chart specs in order without mutation**
    - **Property 5: Reset clears the charts list**
    - **Validates: Requirements 3.1, 3.2, 3.3**

  - [x] 3.3 Rename the client contract `threadId` → `conversationId`
    - In `hooks/useAgentStream.ts`, rename the hook parameter `threadId` →
      `conversationId` and change the Chat_Relay request body it POSTs to
      `{ conversationId, prompt }`; leave the one-in-flight send guard unchanged
    - Update every caller of `useAgentStream` (the `chat/[id]` page and any composer
      wiring) to pass a `conversationId` argument
    - Ensure the `/api/chat` zod schema is `{ conversationId, prompt }` so both
      sides of `/api/chat` agree (the relay-side schema change is implemented in
      task 11.1 — reference it here, do not duplicate)
    - _Requirements: 3.6, 3.7_

  - [x] 3.4 Write a test asserting client/relay contract agreement
    - Assert `useAgentStream` sends its body as `{ conversationId, prompt }` and
      that every caller passes a `conversationId`; assert the `/api/chat` zod
      schema accepts `{ conversationId, prompt }` and rejects a body missing either
      field with a typed error without invoking the runtime
    - _Requirements: 3.6, 3.7_

- [x] 4. Render charts inline in the assistant turn
  - [x] 4.1 Create the `ChartInline` client component
    - Create `components/chat/chart-inline.tsx` (`"use client"`) rendering one
      `ChartSpec` with shadcn Charts / Recharts inside a framed `Card` captioned
      with `title`; export a pure `toChartRows(spec)` helper that pairs
      `labels[i]` with `values[i]` into `{ name, value }`
    - Map `chart_type` (`bar`→vertical bar, `hbar`→horizontal bar, `line`→line/area,
      `pie`→donut); format ticks/tooltips with `currency` via `Intl.NumberFormat`;
      apply the preset theme (violet series, serif caption, sharp corners, no
      gradients); render responsively with interactive tooltips; render an
      empty-state placeholder for empty `labels` and a single point for one pair —
      never throwing; import no server-only/`@aws-sdk` module
    - _Requirements: 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 13.3_

  - [x] 4.2 Write property tests for chart-row transform and rendering
    - Create `components/chat/chart-inline.property.test.tsx`
    - **Property 6: Chart rows pair labels with values by index**
    - **Property 7: One inline chart is rendered per spec, in order**
    - **Validates: Requirements 4.1, 4.4, 4.8, 4.9, 4.10**

  - [x] 4.3 Wire chart rendering into the message list for live and persisted turns
    - In `components/chat/message-list.tsx` (and `chat-view.tsx` as needed), render
      one `ChartInline` per spec under the assistant markdown for the in-progress
      turn (`state.charts`) and for persisted assistant messages (`message.charts`),
      in received order
    - _Requirements: 4.1, 4.10_

  - [x] 4.4 Write unit tests for `ChartInline` rendering
    - Assert caption present, no `<img>`, one case per `chart_type`,
      currency-formatted ticks/tooltips, preset theme tokens, and responsive container
    - _Requirements: 4.2, 4.3, 4.5, 4.6, 4.7_

- [x] 5. Checkpoint — client-side chart pipeline
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Implement pure history-key, title, and rename helpers
  - [x] 6.1 Create single-table key builders `lib/history/keys.ts`
    - Pure, dependency-free, client-safe helpers: `userPk`, `convSk`, `convPk`,
      `gsi1Sk`, `msgSk`, and the `MSG_PREFIX` constant
    - _Requirements: 5.2, 5.5, 6.4_

  - [x] 6.2 Write property tests for the key builders
    - Create `lib/history/keys.property.test.ts`
    - **Property 8: Conversation item keys are correctly formed**
    - **Property 10: Message item keys are correctly formed**
    - **Validates: Requirements 5.2, 5.5, 6.4**

  - [x] 6.3 Create title normalization/fallback `lib/title.ts`
    - Pure, client-safe `normalizeTitle(raw)` (strip surrounding quotes + trailing
      punctuation, ≤ 6 words) and `fallbackTitle(firstPrompt)` (≤ 6 words from prompt)
    - _Requirements: 10.3, 10.7_

  - [x] 6.4 Write property tests for title production
    - Create `lib/title.property.test.ts`
    - **Property 15: Every title-producing path yields a clean, short title**
    - **Validates: Requirements 10.3, 10.7**

  - [x] 6.5 Create the rename-decision helper `lib/rename.ts`
    - Pure helper that trims a candidate title and decides accept/reject, returning
      the trimmed value when accepted and no request when empty-after-trim
    - _Requirements: 11.2, 11.6_

  - [x] 6.6 Write property tests for the rename decision
    - Create `lib/rename.property.test.ts`
    - **Property 16: Rename is accepted iff the trimmed title is non-empty**
    - **Validates: Requirements 11.2, 11.6**

- [x] 7. Implement the DynamoDB client and item builders
  - [x] 7.1 Create the server-only document client `lib/aws/dynamo.ts`
    - `import "server-only"`; lazily construct a memoized `DynamoDBDocumentClient`
      over `DynamoDBClient` with `AWS_REGION`; expose `getDocClient()` and
      `historyTableName()` which reads `process.env.CBA_HISTORY_TABLE` at call time
      and throws `MissingHistoryConfigError` (naming the var only, no value) before
      any DynamoDB call when unset/empty
    - _Requirements: 5.1, 12.3_

  - [x] 7.2 Create conversation/message item builders `lib/history/items.ts`
    - Server-safe builders that assemble the conversation item (`PK`, `SK`,
      `GSI1PK`, `GSI1SK` + `conversationId`, `title`, `titleSource`, `accountId`,
      `sessionId`, `createdAt`, `updatedAt`, `messageCount`) with `sessionId` derived
      via `sessionIdForThread(conversationId)`, and the message item (`PK=CONV#…`,
      `SK=MSG#<iso>#<uuid>` using `randomUUID` for same-ms disambiguation, plus
      `userId`, `role`, `content`, `charts`, `reports`, optional `activity`, an
      optional `feedback` (`up`/`down`, absent when unset), `createdAt`); route all
      output through the existing redaction so `role_arn`, `external_id`, and
      credentials are never written
    - _Requirements: 5.2, 5.3, 5.4, 5.6, 5.7, 13.6, 14.1_

  - [x] 7.3 Write property tests for item attribute completeness
    - Create `lib/history/items.property.test.ts`
    - **Property 9: Conversation items carry all required attributes**
    - **Property 11: Message items carry all required attributes** — cover the
      optional `feedback` attribute across all three cases (absent, `up`, `down`)
      so the built item's `feedback` is either absent or a value in `{up,down}`
    - **Validates: Requirements 5.3, 5.6, 14.1**

  - [x] 7.4 Write property tests for deterministic session derivation
    - Create `lib/history/session-derivation.property.test.ts` (reuse
      `session-id.property.test.ts` generators)
    - **Property 13: Session id is the deterministic derivation of the conversation id**
    - **Validates: Requirements 5.4, 8.7**

  - [x] 7.5 Extend redaction property tests to history items
    - Extend `lib/aws/redact.property.test.ts` to cover the conversation/message
      item builders
    - **Property 12: Secret fields never appear in stored or browser-bound data**
    - **Validates: Requirements 5.7, 9.3, 13.6, 13.7**

- [x] 8. Implement the conversation and message stores
  - [x] 8.1 Create the conversation store `lib/history/conversations.ts`
    - Server-only; derive `userId` from the session (never the browser); implement
      `createConversation` (titleSource `pending`), `listConversations` (Query
      `GSI1`, `ScanIndexForward=false`), `getConversationOwned` (ownership gate),
      `renameConversation`, `touchUpdatedAt` (updates `updatedAt` + `GSI1SK`), and
      `deleteConversation` (item + its messages)
    - _Requirements: 6.1, 6.5, 6.6, 7.1, 8.1_

  - [x] 8.2 Create the message store `lib/history/messages.ts`
    - Server-only; `appendMessage` puts the message item and, in the same logical
      operation, increments `messageCount` and sets `updatedAt` + `GSI1SK`, stamping
      `userId` from the session and writing only under an owned conversation;
      `listMessages` does the ownership `GetItem` first, then queries
      `PK=CONV#<id>` `SK begins_with "MSG#"`, returned `createdAt`-ascending; add
      `setMessageFeedback(userId, conversationId, messageSk, feedback)` as the
      single Message_Feedback write path — it authorizes ownership via
      `getConversationOwned` first and only then issues an `UpdateItem` setting the
      `feedback` attribute (`up`/`down`) on the Message_Item addressed by its
      `MSG#…` sort key; when the caller does not own the conversation it issues no
      `UpdateItem`, and it never writes to Postgres
    - _Requirements: 6.2, 6.3, 6.4, 6.7, 7.4, 14.2, 14.3, 14.5_

  - [x] 8.3 Write a property test for message ordering
    - Create `lib/history/messages.order.property.test.ts`
    - **Property 14: Messages are returned oldest-first**
    - **Validates: Requirements 6.7**

  - [x] 8.4 Write integration tests for the access patterns (mocked doc client)
    - GSI1 query with `ScanIndexForward=false`; get-owner-before-query with the
      query skipped when the owner item is absent; append issues Put + Update
      (count++/updatedAt); delete removes the conversation + message items
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_

  - [x] 8.5 Write integration tests for the feedback write path (mocked doc client)
    - `setMessageFeedback` gets the owner conversation item before issuing an
      `UpdateItem` on the addressed Message_Item; it performs no `UpdateItem` when
      the owner item is absent; the persisted value is constrained to `up`/`down`
    - _Requirements: 14.2, 14.3_

- [x] 9. Implement the conversation lifecycle API
  - [x] 9.1 Create `app/api/conversations/route.ts` (GET list · POST create)
    - `export const runtime = "nodejs"`; derive `userId` from `auth()` (401 when
      absent); zod-validate before any DynamoDB access; `GET` lists most-recent
      first; `POST { accountId }` verifies account ownership in Postgres, creates
      one conversation with `titleSource:"pending"`, returns `conversationId`, and
      rejects when the user owns zero/that account
    - _Requirements: 7.2, 7.5, 7.6, 8.1, 8.2, 8.3_

  - [x] 9.2 Create `app/api/conversations/[id]/route.ts` (GET · PATCH · DELETE)
    - Node runtime, ownership-gated, zod-validated; `GET` returns messages
      oldest-first incl. persisted charts; `PATCH { title }` renames with
      `titleSource:"user"`; `DELETE` removes the conversation + messages; a
      not-owned/absent conversation returns 404 leaking no attribute/`sessionId`/message
    - _Requirements: 7.3, 8.4, 8.5, 8.6, 11.2_

  - [x] 9.3 Write unit tests for the conversations API (mocked doc client)
    - Auth 401, ownership 404, zod 400, create/list/get/patch/delete happy paths,
      and account-ownership rejection on create
    - _Requirements: 7.2, 7.3, 7.5, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6_

  - [x] 9.4 Create the message-feedback route `app/api/conversations/[id]/messages/[messageId]/feedback/route.ts`
    - `export const runtime = "nodejs"`; derive `userId` from `auth()` (401 when
      absent); zod-validate the body as `{ feedback: "up" | "down" }` before any
      DynamoDB access; treat the `[messageId]` path segment as the Message_Item's
      `MSG#…` sort key id and call
      `setMessageFeedback(userId, conversationId, messageSk, feedback)`; a request
      for a conversation the user does not own resolves to 404 and writes nothing;
      never touch Postgres
    - _Requirements: 7.6, 14.2, 14.3, 14.5_

  - [x] 9.5 Write unit tests for the feedback route (mocked doc client)
    - zod rejects any value other than `up`/`down` (400) with no DynamoDB access;
      an owner's submit issues an `UpdateItem` setting `feedback` on the addressed
      Message_Item; an unauthenticated request returns 401 and a non-owner request
      returns 404, each writing nothing
    - _Requirements: 14.2, 14.3, 14.5_

- [x] 10. Implement the AI title service
  - [x] 10.1 Create the server-only Bedrock title call `lib/aws/bedrock.ts`
    - `import "server-only"`; `generateTitle(firstPrompt)` issues a `ConverseCommand`
      against `process.env.CBA_TITLE_MODEL_ID`; throws when the model id is
      unset/empty or the call fails; never invokes the AgentCore runtime
    - _Requirements: 10.3, 10.9, 12.4_

  - [x] 10.2 Create `app/api/conversations/[id]/title/route.ts`
    - Node runtime, ownership-gated, zod-validated; loads the conversation and, if
      `titleSource !== "pending"`, makes no change and returns success without
      invoking the model; otherwise reads the first user message, calls
      `generateTitle`, persists `normalizeTitle(...)` with `titleSource:"ai"` on
      success; on failure retries exactly once, then persists
      `fallbackTitle(firstPrompt)` with `titleSource:"ai"` so it is never left
      `pending`
    - _Requirements: 10.2, 10.4, 10.5, 10.6, 10.7, 10.9, 7.6, 12.4_

  - [x] 10.3 Write unit tests for the title flow (mocked bedrock + doc client)
    - Idempotent no-op for non-pending, ai-source persistence, single retry,
      fallback on second failure and on missing model id, and bedrock-runtime
      (not agentcore) usage
    - _Requirements: 10.1, 10.4, 10.5, 10.6, 10.7, 10.9_

- [x] 11. Persist the transcript through the chat relay
  - [x] 11.1 Update `app/api/chat/route.ts` for conversation load + persistence + charts
    - Change the body schema to `{ conversationId, prompt }`; load the conversation
      from DynamoDB with an ownership gate to get `accountId` and derive
      `sessionId = sessionIdForThread(conversationId)`; resolve the account secrets
      from Postgres (unchanged path); persist the user message before invoking;
      relay events forwarding narrowed `chart` events in order while accumulating
      assistant text, chart specs, report keys, and activity server-side
    - Persist the assistant message in a `finally`/after-the-accumulation-loop code
      path that is NOT gated on the client connection remaining open, so a turn
      whose browser navigated away or unmounted (its `AbortController` cancelling
      the fetch) is still persisted; the path checks the accumulated assistant text
      and MAY skip writing when a turn was aborted before any assistant `delta`
      arrived (empty-text skip). Preserve iteration-1 pre-invoke JSON rejections and
      the single redacted `error` event behavior
    - _Requirements: 2.4, 8.7, 9.1, 9.2, 9.3, 9.7, 13.6, 13.7_

  - [x] 11.2 Write unit tests for chat-relay persistence (mocked stores + invoke)
    - User message persisted before invoke; assistant message persisted on stream
      completion with collected text, charts, reports, and activity; secrets excluded
    - _Requirements: 9.1, 9.2, 9.3_

  - [x] 11.3 Write unit tests for disconnect-safe assistant persistence
    - With the client connection aborted mid-turn (simulated `AbortController` /
      closed stream) after assistant text has accumulated, the `finally`/after-loop
      path still persists the accumulated assistant Message_Item; a turn aborted
      before any assistant `delta` arrives writes no assistant Message_Item, while
      the already-persisted user Message_Item is unaffected either way
    - _Requirements: 9.2, 9.7_

- [x] 12. Rehydrate a conversation on reopen
  - [x] 12.1 Update the conversation page `app/app/(app)/chat/[id]/page.tsx`
    - Address the conversation by `conversationId`; server-side load messages via
      the ownership-gated conversation read and hydrate `ChatView` with each
      message's content and persisted `ChartSpec`s (rendered by the same
      `ChartInline`); render zero-message conversations as an empty state without error
    - _Requirements: 9.4, 9.5, 9.6_

  - [x] 12.2 Write unit tests for hydration
    - Persisted charts render via `ChartInline`; an empty conversation renders
      without surfacing an error
    - _Requirements: 9.4, 9.5, 9.6_

  - [x] 12.3 Wire the assistant-turn feedback UI through the feedback route
    - In the message-actions row under each assistant turn, wire the 👍/👎 controls
      to `PATCH`/`POST`
      `/api/conversations/[id]/messages/[messageId]/feedback` (addressing the turn
      by its `ChatMessage.id`/`MSG#…` sort key) — never to Postgres and never
      directly to DynamoDB; initialize each turn's feedback state on hydrate from
      the persisted `feedback` value (`up`/`down` shows the active control, absent
      shows neutral) and optimistically reflect the chosen state, reconciling on
      response
    - _Requirements: 14.2, 14.4, 14.5_

  - [x] 12.4 Write unit tests for the feedback UI
    - Hydration renders each assistant turn's persisted `feedback` state; a submit
      calls the feedback route (not Postgres) with the chosen value; the control
      reflects the optimistic state and reconciles on response
    - _Requirements: 14.2, 14.4, 14.5_

- [x] 13. Build the optimistic sidebar with editable AI titles
  - [x] 13.1 Create the `useConversations` client hook `hooks/useConversations.ts`
    - Holds the list plus optimistic operations: create (placeholder insert at top,
      single in-flight guard, reconcile to exactly one persisted row on success,
      rollback + leave rest unchanged on failure, always revalidate on settle),
      rename (optimistic update, rollback on failure), and delete; expose pure
      state-transition helpers for the placeholder insert/reconcile/rollback
    - _Requirements: 1.1, 1.2, 1.3, 1.5, 1.6, 1.7, 11.4, 11.7_

  - [x] 13.2 Write property tests for the optimistic list-state helpers
    - Create `hooks/useConversations.optimistic.property.test.ts`
    - **Property 17: Optimistic create reconciles to exactly one row**
    - **Property 18: Optimistic rollback restores the prior list**
    - **Validates: Requirements 1.5, 1.6**

  - [x] 13.3 Create the client conversation list `components/app-shell/conversation-list.tsx`
    - Extract the list from `sidebar.tsx`; render `titleSource:"pending"` rows with
      a skeleton shimmer; provide inline rename (pre-filled + focused field, max
      100 chars, Enter saves with `titleSource:"user"`, Escape/empty-after-trim
      discards); disable "New" with a connect-account affordance at zero accounts;
      editorial flat rows with a violet active-state left border
    - _Requirements: 1.1, 1.3, 1.8, 10.1, 11.1, 11.2, 11.3, 11.4, 11.6_

  - [x] 13.4 Wire the list into `components/app-shell/sidebar.tsx` and fire titles
    - On successful create, navigate to `/chat/<conversationId>` via the router
      without a full reload; fire exactly one background `POST .../title` so it
      never races the user-message write — either fire it only after the first user
      Message_Item is persisted (e.g. after the first `delta` event or on `done`)
      or include the first user prompt in the request body so the service can title
      from the payload; re-fire the title request when opening/listing a
      conversation still `pending` with `messageCount ≥ 1`
    - _Requirements: 1.4, 10.2, 10.5, 10.8_

  - [x] 13.5 Write unit tests for the sidebar UX
    - Placeholder insert, idle within 200 ms, single in-flight guard, router
      navigation without reload, revalidation on settle, disabled-with-affordance
      at zero accounts, rename pre-fill/Escape restore/success update/user-source
      no-op/failure rollback + toast
    - Assert the background title `POST` never races the user-message write: it is
      not sent before the first user Message_Item is persisted (fired after the
      first `delta`/on `done`) or it carries the first prompt in the body
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.7, 1.8, 10.2, 11.1, 11.3, 11.4, 11.5, 11.7_

- [x] 14. Enforce the server-side boundary and configuration in static tests
  - [x] 14.1 Extend `test/boundaries.static.test.ts`
    - Assert `lib/aws/dynamo.ts`, `lib/aws/bedrock.ts`, and `lib/history/*` import
      `server-only`; `chart-inline.tsx` imports no `@aws-sdk`/server-only module;
      each new route — including the message-feedback route
      `app/api/conversations/[id]/messages/[messageId]/feedback/route.ts` — exports
      `runtime = "nodejs"`; and `.env.example` includes the `CBA_HISTORY_TABLE` and
      `CBA_TITLE_MODEL_ID` placeholders (update the env-key count assertion)
    - _Requirements: 5.1, 7.6, 12.1, 12.2, 13.1, 13.2, 13.3_

- [x] 15. Final checkpoint — full suite green
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a
  faster MVP; core implementation sub-tasks are never optional.
- Each task references specific requirements clauses for traceability; property
  test sub-tasks additionally cite the design property they validate.
- Property tests use fast-check at ≥ 100 runs and are tagged with a comment of the
  form `// Feature: cloud-bill-analyst-web-iteration-2, Property {n}: {text}`.
- Inline charts use the shadcn `chart` component + Recharts (added in 1.1); charts
  are not implemented from scratch.
- Checkpoints (tasks 5 and 15) ensure incremental validation.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.4", "2.1", "6.1", "6.3", "6.5", "7.1", "10.1"] },
    { "id": 1, "tasks": ["1.3", "1.5", "2.2", "3.1", "6.2", "6.4", "6.6", "7.2"] },
    { "id": 2, "tasks": ["3.2", "3.3", "4.1", "7.3", "7.4", "7.5", "8.1", "8.2"] },
    { "id": 3, "tasks": ["4.2", "4.3", "8.3", "8.4", "8.5", "9.1", "9.2", "9.4", "11.1"] },
    { "id": 4, "tasks": ["3.4", "4.4", "9.3", "9.5", "10.2", "11.2", "11.3", "12.1", "13.1"] },
    { "id": 5, "tasks": ["10.3", "12.2", "12.3", "13.2", "13.3"] },
    { "id": 6, "tasks": ["12.4", "13.4"] },
    { "id": 7, "tasks": ["13.5", "14.1"] }
  ]
}
```
