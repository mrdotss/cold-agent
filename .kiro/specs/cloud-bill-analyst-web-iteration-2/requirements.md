# Requirements Document

## Introduction

Iteration 2 of Cloud Bill Analyst (Web) extends the existing Next.js App Router
application in `app/`. The MVP (iteration 1, spec `cloud-bill-analyst-web`) is in
place: Auth.js v5 email/password with Postgres/Drizzle sessions, read-only AWS
account connection, a Node-runtime SSE relay (`/api/chat`) to the deployed
AgentCore runtime, a pure `useAgentStream` reducer with property tests, presigned
report downloads (`/api/report-url`), and stable runtime session ids
(`lib/session-id.ts`).

This iteration delivers four features:

1. **Snappy "New conversation" UX** — creating a conversation updates the sidebar
   optimistically and navigates without a full page reload; the "New" control
   never gets stuck spinning.
2. **Inline charts in chat** — the agent streams a structured `chart` SSE event;
   the app renders each chart client-side (Recharts / shadcn Charts) inline in the
   assistant turn, both live and on reopen. No image, no S3, no presign.
3. **Persisted chat history in DynamoDB** — conversations and their messages
   (including chart specs) are stored in a single DynamoDB table and rehydrate
   when a conversation is reopened, across reloads and devices.
4. **Conversation titles** — a new conversation is titled by a direct, fast/cheap
   Bedrock Converse call summarizing the first user prompt, is user-editable by
   inline rename, and a user-set title is never overwritten by AI.

Confirmed design decisions (from clarification):

- **Full replace of the chat-history model.** The iteration-1 Postgres `threads`
  and `messages` tables are superseded. A **Conversation** (with its pinned
  account, derived runtime session id, title metadata, and full message
  transcript including chart specs) lives entirely in DynamoDB. Postgres retains
  **auth and connected accounts only**. The chat route addresses a conversation as
  `/chat/<conversationId>`. This is greenfield — there is **no existing
  thread/message data to migrate**.
- **Account pinning unchanged.** Creating a conversation still requires at least
  one connected account; `POST /api/conversations` rejects when the user has none.
  Chat availability gating is unchanged from iteration 1.
- **DynamoDB table is provisioned out-of-band.** `CBA_HISTORY_TABLE` and its
  `GSI1` index already exist; the application only reads and writes items and does
  not create or alter the table.
- **Title generation can never remain stuck on `pending`.** The title request is
  client-fired after the first user message, runs in the background, and is
  idempotent (acts only while `titleSource == "pending"`). On a Bedrock failure it
  retries once; if it still fails, it falls back to a trimmed first-prompt title
  (≤ 6 words) and sets `titleSource == "ai"`. As a safety net, opening or listing a
  conversation that is still `pending` with at least one message re-fires the title
  request.
- The runtime session id for a conversation is **derived deterministically from
  the conversation id** via `lib/session-id.ts` (`sessionIdForThread`), so it is
  stable per conversation and never reassigned.
- **Client contract rename (`threadId` → `conversationId`).** Iteration 1's
  `useAgentStream(threadId)` hook POSTed `{ threadId, prompt }`, but the
  iteration-2 `/api/chat` relay expects `{ conversationId, prompt }`. The hook
  parameter, its POST body, and every caller are renamed to `conversationId` so
  both sides of `/api/chat` agree and the chat POST passes zod validation.
- **Message feedback lives in DynamoDB.** The iteration-1 thumbs-up/thumbs-down
  feedback flow wrote to a Postgres `messageFeedback` table, which is retired.
  Feedback is now persisted as an optional `feedback` attribute on the DynamoDB
  Message_Item, written through an ownership-gated path — never to Postgres.

All AWS SDK calls and all secret access remain **server-side only**; every route
input is validated with **zod**; any route touching AWS runs on the **Node
runtime**. Persisted content is already SSE-redacted — `role_arn`, `external_id`,
and credentials are never stored. This document specifies iteration-2 behavior in
EARS format and follows the workspace steering in `.kiro/steering/` and the
invocation contract in `agent/AGENTCORE_INTEGRATION.md`.

## Glossary

- **Web_App**: The Next.js App Router application in `app/`.
- **User**: An authenticated person identified by the signed-in application user
  id (`userId`), used as the `actor_id` for the agent and as the DynamoDB
  ownership key. Never supplied by the browser.
- **Conversation**: A saved chat, replacing the iteration-1 "thread". Pinned to
  exactly one Connected_Account, addressed by a `conversationId`, and stored in the
  History_Table with a title, a `titleSource`, a derived Session_Id, timestamps,
  and a message count.
- **Connected_Account**: A stored read-only AWS account belonging to a User
  (Postgres), identified by `accountId`.
- **Conversation_Sidebar**: The client sidebar list of a User's Conversations,
  including the "New" control, per-row titles, and inline rename.
- **Conversation_Store**: The server-only DynamoDB data layer
  (`lib/aws/dynamo.ts` + `lib/history/{conversations,messages}.ts`) implementing
  the single-table access patterns.
- **History_Table**: The DynamoDB table named by `CBA_HISTORY_TABLE`, single-table
  design with a `GSI1` global secondary index.
- **Conversations_Api**: The Node-runtime route handlers `GET`/`POST`
  `/api/conversations` and `GET`/`PATCH`/`DELETE` `/api/conversations/[id]`.
- **Title_Service**: The server-side subsystem that generates a Conversation title
  via a direct Bedrock Converse call, exposed at `POST /api/conversations/[id]/title`.
- **Title_Model**: The Bedrock model identified by `CBA_TITLE_MODEL_ID`, invoked
  with `@aws-sdk/client-bedrock-runtime` — distinct from the AgentCore runtime.
- **Chat_Relay**: The existing Node-runtime `/api/chat` route that invokes the
  agent and relays the SSE stream to the browser.
- **SSE_Parser**: The pure module `lib/aws/sse.ts` that parses, narrows, and
  redacts SSE events server-side before they are forwarded to the browser.
- **Stream_Reducer**: The pure reducer `streamReducer` in `hooks/useAgentStream.ts`
  that folds SSE events into client UI state.
- **Chart_Spec**: The structured chart payload
  `{ id, chart_type, title, currency, labels, values }` carried by a `chart` SSE
  event, where `chart_type` is one of `bar`, `hbar`, `line`, `pie`,
  `labels` is a string array, and `values` is a number array of equal length.
- **Chart_Inline**: The client component `<ChartInline spec>` that renders a
  Chart_Spec with Recharts / shadcn Charts, themed to the preset.
- **Session_Id**: The 33–128 character runtime session id for a Conversation,
  derived deterministically from `conversationId` via `lib/session-id.ts`.
- **Message_Item**: A stored message within a Conversation (role, content, chart
  specs, report keys, optional activity summary, an optional `feedback` value, and
  timestamp).
- **Message_Feedback**: A User's thumbs-up or thumbs-down mark on an assistant
  Message_Item, persisted as an optional `feedback` attribute (value `up` or
  `down`, otherwise absent) on the Message_Item in the History_Table. The retired
  iteration-1 Postgres `messageFeedback` table is no longer used.
- **SSE_Event**: A streamed event forwarded by the Chat_Relay; the known
  vocabulary is `delta`, `tool`, `chart`, `report_file`, `error`, `done`.
- **titleSource**: A Conversation attribute with value `pending`, `ai`, or `user`,
  indicating how the current title was set.

## Requirements

### Requirement 1: Optimistic New-Conversation Creation Without Reload

**User Story:** As a signed-in user, I want the "New" control to create and open a
conversation instantly and show it in the sidebar without a page reload, so that
starting a chat feels immediate.

#### Acceptance Criteria

1. WHEN a User activates the "New" control WHILE the User has at least one Connected_Account, THE Conversation_Sidebar SHALL insert a placeholder Conversation row at the top of the conversation list before the create request completes.
2. WHEN the "New" control is activated, THE Web_App SHALL send exactly one Conversation create request and SHALL return the "New" control to its idle (non-busy) state within 200 milliseconds of the create request settling, whether the request succeeds or fails.
3. WHILE a Conversation create request initiated by the "New" control is in flight, THE Conversation_Sidebar SHALL prevent starting an additional create request until the in-flight request settles.
4. WHEN a Conversation create request succeeds, THE Web_App SHALL select the created Conversation and navigate to the route `/chat/<conversationId>` for that Conversation without performing a full page reload.
5. WHEN a Conversation create request succeeds, THE Conversation_Sidebar SHALL reconcile the optimistic placeholder with the persisted Conversation so that the list contains exactly one row for the created Conversation.
6. IF a Conversation create request fails, THEN THE Conversation_Sidebar SHALL remove the optimistic placeholder row, SHALL display a transient error notification, and SHALL leave the previously displayed conversation list otherwise unchanged.
7. WHEN a Conversation create request settles, THE Web_App SHALL revalidate the conversation list so that the displayed list matches the persisted set of the User's Conversations without requiring a full page reload.
8. WHILE the User has zero Connected_Accounts, THE Conversation_Sidebar SHALL render the "New" control in a disabled state that prevents create requests and SHALL present a connect-account affordance.

### Requirement 2: Forward the `chart` SSE Event Server-Side

**User Story:** As a signed-in user, I want chart data the agent produces to reach
the browser, so that charts can be rendered inline.

#### Acceptance Criteria

1. THE SSE_Parser SHALL include `chart` in the known SSE event vocabulary alongside `delta`, `tool`, `report_file`, `error`, and `done`.
2. WHEN the SSE_Parser narrows a received event whose `type` is `chart` AND whose `spec` is an object containing a `chart_type` value of `bar`, `hbar`, `line`, or `pie`, a `labels` array, and a `values` array whose length equals the `labels` length, THE SSE_Parser SHALL forward the event as a known `chart` event.
3. IF the SSE_Parser receives an event whose `type` is `chart` but whose `spec` is not an object, whose `chart_type` is not one of `bar`, `hbar`, `line`, or `pie`, or whose `labels` and `values` lengths differ, THEN THE SSE_Parser SHALL treat the event as unknown and SHALL drop it without forwarding it to the browser.
4. WHEN the Chat_Relay forwards a narrowed `chart` event, THE Chat_Relay SHALL pass the event through the redaction step and SHALL forward it to the browser in the order it was received relative to other SSE_Events.
5. THE SSE_Parser SHALL continue to drop any SSE_Event whose type is none of `delta`, `tool`, `chart`, `report_file`, `error`, or `done` and SHALL continue processing subsequent events.

### Requirement 3: Accumulate Chart Specs in the Stream Reducer

**User Story:** As a signed-in user, I want charts to appear in the assistant turn
as the agent produces them, so that the answer includes its visualizations.

#### Acceptance Criteria

1. THE Stream_Reducer SHALL maintain a `charts` field that is an ordered list of Chart_Spec values.
2. WHEN the Stream_Reducer processes a `chart` event, THE Stream_Reducer SHALL append the event's Chart_Spec to the `charts` list in received order and SHALL return a new state without mutating the previous state.
3. WHEN the Stream_Reducer processes a `reset` action, THE Stream_Reducer SHALL set the `charts` list to empty.
4. THE Stream_Reducer SHALL remain a pure function whose existing behavior for `delta`, `tool`, `report_file`, `done`, and `error` events is unchanged, such that all existing property tests continue to pass.
5. THE Web_App SHALL preserve the one-in-flight send guard in `useAgentStream` such that a Conversation never runs two concurrent turns on one Session_Id.
6. THE Web_App SHALL name the `useAgentStream` hook parameter `conversationId`, SHALL send the Chat_Relay request body as `{ conversationId, prompt }`, and SHALL update every caller of `useAgentStream` to pass a `conversationId` argument, so that the field names produced by `useAgentStream` match the field names the Chat_Relay expects.
7. WHEN the Web_App sends a chat turn to the Chat_Relay, THE Chat_Relay SHALL validate the request body against a zod schema that requires a `conversationId` string and a `prompt` string, and IF the body omits `conversationId` or `prompt` THEN THE Chat_Relay SHALL reject the request with a typed error and SHALL NOT invoke the AgentCore runtime.

### Requirement 4: Render Charts Inline in the Assistant Turn

**User Story:** As a signed-in user, I want each chart rendered as an interactive,
themed chart in the chat, so that I can read my cost data visually.

#### Acceptance Criteria

1. WHEN the Web_App renders an assistant turn that has one or more Chart_Spec values, THE Web_App SHALL render one Chart_Inline component per Chart_Spec, in the order the Chart_Spec values were received.
2. THE Chart_Inline SHALL render the chart inside a framed card captioned with the Chart_Spec `title`, using a client-side charting library, with no image element, no S3 object, and no presigned URL.
3. WHEN the Chart_Spec `chart_type` is `bar`, THE Chart_Inline SHALL render a vertical bar chart; WHEN `hbar`, a horizontal bar chart; WHEN `line`, a line or area chart; WHEN `pie`, a donut chart.
4. THE Chart_Inline SHALL transform the Chart_Spec into chart rows by pairing each `labels[i]` with `values[i]` into a `{ name, value }` record for every index of the `labels` array.
5. THE Chart_Inline SHALL format numeric axis ticks and tooltip values using the Chart_Spec `currency`.
6. THE Chart_Inline SHALL apply the preset theme: a violet data series, a serif title, sharp (zero-radius) corners, and no gradient fills.
7. THE Chart_Inline SHALL render responsively to its container width and SHALL expose interactive tooltips on data points.
8. IF a Chart_Spec has an empty `labels` array, THEN THE Chart_Inline SHALL render an empty-state placeholder within the framed card instead of an empty chart and SHALL NOT raise an unhandled error.
9. WHERE a Chart_Spec contains exactly one label-value pair, THE Chart_Inline SHALL render that single data point without raising an unhandled error.
10. WHEN the Web_App renders a Conversation on hydrate from persisted Chart_Spec values, THE Web_App SHALL render each persisted Chart_Spec with the same Chart_Inline component used for live `chart` events.

### Requirement 5: DynamoDB Single-Table Chat-History Store

**User Story:** As a signed-in user, I want my conversations and messages stored
durably, so that they survive reloads and are available across devices.

#### Acceptance Criteria

1. THE Conversation_Store SHALL access the History_Table named by `process.env.CBA_HISTORY_TABLE` through a `DynamoDBDocumentClient` from `@aws-sdk/lib-dynamodb` in a server-only module.
2. THE Conversation_Store SHALL store each Conversation as an item with partition key `PK = "USER#<userId>"`, sort key `SK = "CONV#<conversationId>"`, `GSI1PK = "USER#<userId>"`, and `GSI1SK = "TS#<updatedAtISO>"`.
3. THE Conversation_Store SHALL store on each Conversation item the attributes `conversationId`, `title`, `titleSource` with a value of `pending`, `ai`, or `user`, `accountId`, `sessionId`, `createdAt`, `updatedAt`, and `messageCount`.
4. THE Conversation_Store SHALL set the Conversation `sessionId` to the Session_Id derived from `conversationId` via `lib/session-id.ts`, whose length is within the inclusive range 33 to 128 characters.
5. THE Conversation_Store SHALL store each Message_Item with partition key `PK = "CONV#<conversationId>"` and sort key `SK = "MSG#<createdAtISO>#<ulid>"`.
6. THE Conversation_Store SHALL store on each Message_Item the attributes `userId`, `role` with a value of `user` or `assistant`, `content`, `charts` as a list of Chart_Spec values, `reports` as a list of `{ key }` values, an optional `activity` list of `{ label, status }` values, an optional `feedback` attribute whose value is `up` or `down` when present and is otherwise absent, and `createdAt`.
7. THE Conversation_Store SHALL exclude `role_arn`, `external_id`, and AWS credential values from every stored Conversation item and Message_Item.

### Requirement 6: Conversation Access Patterns

**User Story:** As a signed-in user, I want my conversation list and transcripts
loaded efficiently and correctly ordered, so that history is fast and accurate.

#### Acceptance Criteria

1. WHEN the Conversation_Store lists a User's Conversations, THE Conversation_Store SHALL query `GSI1` with `GSI1PK = "USER#<userId>"` and `ScanIndexForward = false` so that Conversations are returned most-recently-updated first.
2. WHEN the Conversation_Store loads a Conversation, THE Conversation_Store SHALL first get the Conversation item at `PK = "USER#<userId>"`, `SK = "CONV#<conversationId>"` to authorize ownership, and only when that item exists SHALL query `PK = "CONV#<conversationId>"` with `SK` beginning with `"MSG#"` to read the messages.
3. WHEN the Conversation_Store appends a Message_Item, THE Conversation_Store SHALL put the Message_Item, increment the Conversation `messageCount`, and set the Conversation `updatedAt` to the append time.
4. WHEN a Conversation `updatedAt` changes, THE Conversation_Store SHALL update `GSI1SK` to `"TS#<updatedAtISO>"` so that the list ordering reflects the most recent update.
5. WHEN the Conversation_Store renames a Conversation, THE Conversation_Store SHALL update the Conversation `title` and `titleSource` on the Conversation item identified by `PK = "USER#<userId>"`, `SK = "CONV#<conversationId>"`.
6. WHEN the Conversation_Store deletes a Conversation, THE Conversation_Store SHALL delete the Conversation item and its associated Message_Items.
7. THE Conversation_Store SHALL return messages of a loaded Conversation ordered by `createdAt` ascending, oldest first.

### Requirement 7: Ownership Authorization for History Access

**User Story:** As a signed-in user, I want only my own conversations to be
readable and writable, so that my cost history stays private.

#### Acceptance Criteria

1. THE Conversation_Store SHALL derive the `userId` for every read and write from the authenticated session and SHALL NOT accept a `userId` supplied by the browser.
2. IF a Conversation read or write is requested by a request without a valid authenticated session, THEN THE Conversations_Api SHALL reject the request and SHALL NOT read or write any History_Table item.
3. IF a User requests a Conversation whose Conversation item does not exist under `PK = "USER#<userId>"`, THEN THE Conversations_Api SHALL deny access and SHALL NOT return that Conversation's messages, `sessionId`, or any attribute.
4. WHEN the Web_App persists a Message_Item, THE Conversation_Store SHALL set the Message_Item `userId` to the authenticated User's id and SHALL store the Message_Item only under a Conversation the authenticated User owns.
5. THE Conversations_Api SHALL validate every route input with a zod schema before any History_Table access, and IF validation fails THEN THE Conversations_Api SHALL return a typed error and SHALL NOT access the History_Table.
6. THE Conversations_Api route handlers and the Title_Service route handler SHALL run on the Node runtime.

### Requirement 8: Conversation Lifecycle API

**User Story:** As a signed-in user, I want to create, list, open, rename, and
delete conversations, so that I can manage my chat history.

#### Acceptance Criteria

1. WHEN an authenticated User sends `POST /api/conversations` WHILE the User has at least one Connected_Account, THE Conversations_Api SHALL create exactly one Conversation pinned to the specified Connected_Account with `titleSource = "pending"` and return its `conversationId`.
2. IF an authenticated User sends `POST /api/conversations` WHILE the User has zero Connected_Accounts, or specifies an `accountId` the User does not own, THEN THE Conversations_Api SHALL reject the request with a typed error and SHALL create no Conversation.
3. WHEN an authenticated User sends `GET /api/conversations`, THE Conversations_Api SHALL return that User's Conversations most-recently-updated first, excluding any Conversation not owned by the User.
4. WHEN an authenticated User sends `GET /api/conversations/[id]` for a Conversation the User owns, THE Conversations_Api SHALL return the Conversation's messages ordered oldest first, including each Message_Item's persisted Chart_Spec values.
5. WHEN an authenticated User sends `PATCH /api/conversations/[id]` with a new title for a Conversation the User owns, THE Conversations_Api SHALL update the Conversation title and set `titleSource = "user"`.
6. WHEN an authenticated User sends `DELETE /api/conversations/[id]` for a Conversation the User owns, THE Conversations_Api SHALL delete the Conversation and its Message_Items and return a success indication.
7. WHEN a Conversation is created, THE Web_App SHALL set the created Conversation's Session_Id to the value derived from its `conversationId` via `lib/session-id.ts`, and the Chat_Relay SHALL use that same Session_Id for every turn of that Conversation.

### Requirement 9: Persist and Rehydrate the Transcript

**User Story:** As a signed-in user, I want my messages and their charts saved and
restored, so that a reopened conversation looks exactly as it did.

#### Acceptance Criteria

1. WHEN a User sends a chat turn for a Conversation, THE Web_App SHALL persist the user Message_Item with its `content` before or as the turn is relayed.
2. WHEN the Chat_Relay finishes the server-side accumulation of a turn's SSE_Events, THE Chat_Relay SHALL persist the assistant Message_Item — containing the final assistant text, the Chart_Spec values collected during the turn, the report keys collected during the turn, and an activity summary derived from the turn's steps — in a code path that is not gated on the client connection remaining open, such as a `finally` block executed after the server-side accumulation loop, so that a turn whose client navigated away or unmounted (its `AbortController` cancelling the browser fetch) is still persisted.
3. THE Web_App SHALL exclude `role_arn`, `external_id`, and AWS credential values from every persisted Message_Item.
4. WHEN a User opens `/chat/<conversationId>` for a Conversation the User owns, THE Web_App SHALL hydrate the transcript from the Conversation_Store and render each Message_Item's content and persisted Chart_Spec values.
5. WHEN the Web_App hydrates a Conversation that has zero messages, THE Web_App SHALL render the empty conversation without surfacing an error.
6. WHEN a User reopens a Conversation that contained rendered charts, THE Web_App SHALL render the same charts from the persisted Chart_Spec values using the Chart_Inline component so that the reopened Conversation matches the live-rendered Conversation.
7. WHEN a turn's server-side accumulation produced assistant text, THE Chat_Relay SHALL persist the assistant Message_Item regardless of whether the client connection remained open; IF a turn is aborted before any assistant text is produced, THEN THE Chat_Relay MAY skip persisting the assistant Message_Item for that turn.

### Requirement 10: AI-Generated Conversation Titles

**User Story:** As a signed-in user, I want new conversations titled automatically
from my first message, so that my history is easy to scan.

#### Acceptance Criteria

1. WHILE a Conversation has `titleSource = "pending"`, THE Conversation_Sidebar SHALL display a skeleton placeholder in place of that Conversation's title.
2. WHEN a User sends the first user message of a Conversation, THE Web_App SHALL send exactly one `POST /api/conversations/[id]/title` request in the background without blocking the chat turn, and — because the Title_Service reads the first user message from the History_Table — THE Web_App SHALL either send that request only after the first user Message_Item is persisted (for example, after the first `delta` event or on the `done` event) or include the first user prompt in the request body, so that the title request never races ahead of the user-message write.
3. WHEN the Title_Service receives a title request for a Conversation whose `titleSource` is `pending`, THE Title_Service SHALL invoke the Title_Model via a direct Bedrock Converse call using the model id from `process.env.CBA_TITLE_MODEL_ID` to summarize the first user prompt into a title of at most 6 words with no surrounding quotation marks and no trailing punctuation.
4. IF the Title_Service receives a title request for a Conversation whose `titleSource` is not `pending`, THEN THE Title_Service SHALL make no title change and SHALL return a success indication without invoking the Title_Model.
5. WHEN the Title_Model returns a summarized title, THE Title_Service SHALL persist the title with `titleSource = "ai"` and THE Conversation_Sidebar SHALL display the new title without a full page reload.
6. IF the Title_Model invocation fails, THEN THE Title_Service SHALL retry the invocation exactly one additional time.
7. IF the Title_Model invocation fails on the retry, THEN THE Title_Service SHALL derive a fallback title from the first user prompt of at most 6 words and SHALL persist it with `titleSource = "ai"`, such that the Conversation is never left with `titleSource = "pending"` after a title request completes.
8. WHEN the Web_App opens or lists a Conversation that has `titleSource = "pending"` and a `messageCount` of at least 1, THE Web_App SHALL re-fire the title request for that Conversation.
9. THE Title_Service SHALL invoke the Title_Model and SHALL NOT invoke the AgentCore runtime for title generation.

### Requirement 11: Editable Conversation Titles

**User Story:** As a signed-in user, I want to rename a conversation inline, so
that I can label it as I choose.

#### Acceptance Criteria

1. WHEN a User activates rename on a Conversation row in the Conversation_Sidebar via the row's rename affordance, THE Conversation_Sidebar SHALL present an editable inline title field pre-filled with the current title, place keyboard focus in that field, and constrain the field to a maximum of 100 characters.
2. WHEN a User confirms an inline rename with the Enter key AND the entered title is non-empty after trimming leading and trailing whitespace, THE Web_App SHALL send `PATCH /api/conversations/[id]` with the trimmed title and set the Conversation `titleSource` to `user`.
3. WHEN a User cancels an inline rename with the Escape key, THE Conversation_Sidebar SHALL discard the edit and restore the previously displayed title.
4. WHEN a rename request succeeds, THE Conversation_Sidebar SHALL display the new title in the Conversation row without a full page reload.
5. IF a Conversation has `titleSource = "user"`, THEN THE Title_Service SHALL make no change to that Conversation's title.
6. IF a User confirms an inline rename whose entered title is empty after trimming leading and trailing whitespace, THEN THE Conversation_Sidebar SHALL discard the edit, restore the previously displayed title, and send no rename request.
7. IF a rename request fails, THEN THE Conversation_Sidebar SHALL restore the previously displayed title and SHALL display a transient error notification.

### Requirement 12: Environment Configuration for Iteration 2

**User Story:** As an operator, I want the new configuration variables documented
and required, so that the app is configured correctly and fails clearly when it is
not.

#### Acceptance Criteria

1. THE Web_App SHALL read the History_Table name from `process.env.CBA_HISTORY_TABLE` and the Title_Model id from `process.env.CBA_TITLE_MODEL_ID`, server-side only.
2. THE Web_App SHALL include a non-secret placeholder for `CBA_HISTORY_TABLE` and for `CBA_TITLE_MODEL_ID` in the committed `.env.example` file.
3. IF `CBA_HISTORY_TABLE` is missing or empty WHEN a History_Table operation is attempted, THEN THE Conversation_Store SHALL return an error indicating the missing configuration and SHALL NOT attempt the DynamoDB operation.
4. IF `CBA_TITLE_MODEL_ID` is missing or empty WHEN a title generation is attempted, THEN THE Title_Service SHALL treat the generation as failed and SHALL apply the fallback title behavior defined in Requirement 10.
5. THE Web_App SHALL generate a Drizzle migration that drops the now-unused `threads`, `messages`, and `messageFeedback` tables, given that chat history and message feedback live entirely in the History_Table.
6. THE Web_App SHALL retain the `users`, `sessions`, `connectedAccounts`, `activeAccount`, and `loginAttempts` Postgres tables in the schema-cleanup migration.

### Requirement 13: Server-Side Boundary and IAM for Iteration 2

**User Story:** As a security-conscious operator, I want the new AWS access to stay
server-side and minimally scoped, so that secrets and permissions are contained.

#### Acceptance Criteria

1. THE Conversation_Store, the `@aws-sdk/lib-dynamodb` client, and the Title_Service SHALL execute in server-side modules only, and no client component SHALL import them.
2. IF a client component imports the Conversation_Store, the `@aws-sdk/lib-dynamodb` client, or the Title_Service, THEN THE Web_App build SHALL fail with an error indicating a server-only module was imported into client code, and SHALL NOT produce a client bundle.
3. THE Web_App SHALL render the Chart_Inline component and its Chart_Spec data on the client without importing any server-only AWS module.
4. THE Web_App backend identity SHALL be granted `dynamodb:GetItem`, `dynamodb:PutItem`, `dynamodb:UpdateItem`, `dynamodb:DeleteItem`, and `dynamodb:Query` scoped to exactly the History_Table and its `GSI1` index, and SHALL be granted no other DynamoDB action and no access to any other table or index.
5. THE Web_App backend identity SHALL be granted `bedrock:InvokeModel` scoped to exactly the model identified by `CBA_TITLE_MODEL_ID`, and SHALL be granted no other Bedrock action and no access to any other model.
6. THE Web_App SHALL keep the iteration-1 server-side boundary intact such that the literal values of `role_arn`, `external_id`, and AWS credentials appear in zero HTTP response bodies or headers, zero SSE payloads, zero DynamoDB items, and zero other bytes transmitted to the browser.
7. IF a value derived from `role_arn`, `external_id`, or AWS credentials is about to be written to any browser-bound response, SSE payload, or persisted DynamoDB item, THEN THE Web_App SHALL omit that value and SHALL complete the operation without exposing it.

### Requirement 14: Message Feedback Persisted in DynamoDB

**User Story:** As a signed-in user, I want to mark an assistant message with a
thumbs-up or thumbs-down and have that choice saved with my conversation, so that
my feedback persists across reloads and devices.

#### Acceptance Criteria

1. THE Message_Item MAY carry an optional `feedback` attribute whose value is `up` or `down` when the User has given feedback and is absent otherwise.
2. WHEN a User submits thumbs-up or thumbs-down feedback on an assistant Message_Item of a Conversation the User owns, THE Web_App SHALL persist the corresponding `feedback` value onto that Message_Item in the History_Table through an ownership-gated route or Conversation_Store path.
3. IF a feedback submission is requested without a valid authenticated session, or for a Conversation the requesting User does not own, THEN THE Web_App SHALL reject the request and SHALL NOT write any `feedback` value to the History_Table.
4. WHEN the Web_App hydrates a Conversation whose Message_Items carry a `feedback` value, THE Web_App SHALL render each assistant Message_Item's feedback state from the persisted `feedback` value.
5. THE Web_App SHALL persist Message_Feedback only on the DynamoDB Message_Item and SHALL NOT use the retired Postgres `messageFeedback` table in any feedback flow.
