import { beforeEach, describe, expect, it, vi } from "vitest";

import { connectedAccounts } from "@/lib/db/schema";

/**
 * Unit tests for the `POST /api/chat` relay's TRANSCRIPT PERSISTENCE path
 * (`app/app/api/chat/route.ts`) — Req 9.1, 9.2, 9.3.
 *
 * These focus narrowly on what the relay writes to the DynamoDB history store
 * (`appendMessage`) and WHEN, complementing `route.integration.test.ts` (which
 * covers guard/wiring/redaction). Three properties are asserted:
 *
 *  - **Req 9.1 — user message persisted BEFORE invoke.** `appendMessage` is
 *    called with the user message (role `"user"`, `content === prompt`) and its
 *    `mock.invocationCallOrder` precedes `invokeAgentRuntime`'s.
 *  - **Req 9.2 — assistant message persisted on stream completion.** After the
 *    SSE stream yields delta + chart + report_file + tool events then `done`,
 *    `appendMessage` is called with role `"assistant"`, the concatenated delta
 *    text, the collected charts, the report keys, and the activity summary.
 *  - **Req 9.3 — secrets excluded.** No `role_arn`/`external_id`/credential
 *    value appears in the persisted assistant Message_Item args — the relay
 *    accumulates only narrowed events and never passes secrets into
 *    `appendMessage`.
 *
 * ## What is REAL vs. FAKED
 *
 * - **REAL:** the route handler under test, plus the pure SSE core
 *   `@/lib/aws/sse` (`parseSseChunk`/`toKnownEvent`/`redactForBrowser`) and
 *   `@/lib/invocation-context`, so event narrowing + accumulation run for real.
 * - **FAKED:** the side-effecting boundaries — `@/lib/auth` (session),
 *   `@/lib/db` (`getDb`, an in-memory query builder returning the pinned
 *   account row), `@/lib/crypto` (`decryptSecret`), `@/lib/aws/agentcore`
 *   (`invokeAgentRuntime`, resolved to a fake SSE byte iterable), and the two
 *   history stores `@/lib/history/conversations` (`getConversationOwned` →
 *   owned conversation) and `@/lib/history/messages` (`appendMessage` → spy).
 */

// ---------------------------------------------------------------------------
// Mocked boundaries (hoisted so `vi.mock` factories can reference them).
// ---------------------------------------------------------------------------
const {
  authMock,
  getDbMock,
  decryptSecretMock,
  invokeAgentRuntimeMock,
  getConversationOwnedMock,
  appendMessageMock,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  getDbMock: vi.fn(),
  decryptSecretMock: vi.fn(),
  invokeAgentRuntimeMock: vi.fn(),
  getConversationOwnedMock: vi.fn(),
  appendMessageMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/lib/db", () => ({ getDb: getDbMock }));
vi.mock("@/lib/crypto", () => ({ decryptSecret: decryptSecretMock }));
vi.mock("@/lib/aws/agentcore", () => ({
  invokeAgentRuntime: invokeAgentRuntimeMock,
}));
vi.mock("@/lib/history/conversations", () => ({
  getConversationOwned: getConversationOwnedMock,
}));
vi.mock("@/lib/history/messages", () => ({
  appendMessage: appendMessageMock,
}));
// NOTE: `@/lib/aws/sse` and `@/lib/invocation-context` are intentionally REAL.

import { POST } from "./route";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const USER_ID = "user_owner_1";
const CONVERSATION_ID = "conv_abc";
// Runtime session id: stable per conversation, 33–128 chars.
const CONV_SESSION_ID = `sess_${"a".repeat(35)}`; // 40 chars
const CONNECTED_ACCOUNT_ID = "acct_1";
const FAKE_ROLE_ARN = "arn:aws:iam::123456789012:role/cba-readonly";
const FAKE_EXTERNAL_ID = "ext-secret-should-never-leak";
const FAKE_EXTERNAL_ID_ENC = "ciphertext-blob-base64";

type Row = Record<string, unknown>;

/**
 * Programmable in-memory Drizzle query-builder fake supporting the route's
 * `db.select({...}).from(table).where(...).limit(1)` chain, resolving each query
 * to the rows registered for the table passed to `.from(table)`.
 */
function createFakeDb(selects: Array<{ table: unknown; rows: Row[] }>): {
  select: ReturnType<typeof vi.fn>;
} {
  const rowsByTable = new Map<unknown, Row[]>();
  for (const s of selects) rowsByTable.set(s.table, s.rows);

  function makeSelectBuilder() {
    let table: unknown;
    const resolve = () => Promise.resolve(rowsByTable.get(table) ?? []);
    const builder = {
      from(t: unknown) {
        table = t;
        return builder;
      },
      where() {
        return builder;
      },
      limit() {
        return resolve();
      },
    };
    return builder;
  }

  return { select: vi.fn(() => makeSelectBuilder()) };
}

/** The pinned-account fixture used for the happy-path relay. */
function dbWithPinnedAccount() {
  return createFakeDb([
    {
      table: connectedAccounts,
      rows: [
        {
          roleArn: FAKE_ROLE_ARN,
          externalIdEnc: FAKE_EXTERNAL_ID_ENC,
          displayCurrency: "USD",
          timezone: "America/New_York",
          alias: "prod",
        },
      ],
    },
  ]);
}

/** An owned conversation returned by the ownership gate. */
function ownedConversation() {
  return {
    conversationId: CONVERSATION_ID,
    title: "June spend",
    titleSource: "ai" as const,
    accountId: CONNECTED_ACCOUNT_ID,
    sessionId: CONV_SESSION_ID,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    messageCount: 2,
  };
}

/** Build a fake upstream SSE byte stream that yields one `data:` frame per event. */
function fakeUpstream(events: unknown[]): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder();
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
      }
    },
  };
}

/** A `POST /api/chat` request with a JSON body. */
function chatRequest(body: unknown): Request {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Drain a streaming Response body fully so the `start()` finally path runs. */
async function drain(response: Response): Promise<void> {
  const reader = response.body?.getReader();
  if (reader === undefined) return;
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
}

// The upstream turn: two deltas (accumulate to "Hello world"), a chart, a
// report_file, a tool start/end, then done. Each event ALSO carries stray secret
// fields the relay must never accumulate/persist (narrowing rebuilds each event
// from known fields only, Req 9.3).
const CHART_SPEC = {
  id: "c1",
  chart_type: "bar",
  title: "Top Services by Cost",
  currency: "USD",
  labels: ["Amazon EC2", "Amazon S3"],
  values: [4820.55, 1290.1],
};

const TURN_EVENTS = [
  { type: "delta", text: "Hello ", role_arn: FAKE_ROLE_ARN },
  { type: "delta", text: "world", external_id: FAKE_EXTERNAL_ID },
  { type: "chart", spec: { ...CHART_SPEC, role_arn: FAKE_ROLE_ARN } },
  {
    type: "report_file",
    key: "reports/user_owner_1/june.pdf",
    bucket: "mr-harness",
    external_id: FAKE_EXTERNAL_ID,
  },
  {
    type: "tool",
    phase: "start",
    id: "s1",
    name: "get_cost_and_usage",
    label: "Cost Explorer",
    status: "Querying AWS Cost Explorer…",
    role_arn: FAKE_ROLE_ARN,
  },
  { type: "tool", phase: "end", id: "s1", name: "get_cost_and_usage" },
  { type: "done" },
];

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: USER_ID } });
  decryptSecretMock.mockReturnValue(FAKE_EXTERNAL_ID);
  getConversationOwnedMock.mockResolvedValue(ownedConversation());
  getDbMock.mockReturnValue(dbWithPinnedAccount());
  appendMessageMock.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Req 9.1 — user message persisted BEFORE the runtime is invoked.
// ---------------------------------------------------------------------------
describe("POST /api/chat — persists the user message before invoking (Req 9.1)", () => {
  it("appends the user message with the prompt content and does so before invoke", async () => {
    invokeAgentRuntimeMock.mockResolvedValue(fakeUpstream(TURN_EVENTS));

    const response = await POST(
      chatRequest({ conversationId: CONVERSATION_ID, prompt: "How much did I spend?" }),
    );
    await drain(response);

    // The FIRST appendMessage call is the user message (role "user", content = prompt).
    const [userUserId, userConvId, userMsg] = appendMessageMock.mock.calls[0];
    expect(userUserId).toBe(USER_ID);
    expect(userConvId).toBe(CONVERSATION_ID);
    expect(userMsg).toMatchObject({
      userId: USER_ID,
      role: "user",
      content: "How much did I spend?",
      charts: [],
      reports: [],
    });

    // ORDER: the user append is issued before the runtime invocation (Req 9.1).
    expect(invokeAgentRuntimeMock).toHaveBeenCalledTimes(1);
    const userAppendOrder = appendMessageMock.mock.invocationCallOrder[0];
    const invokeOrder = invokeAgentRuntimeMock.mock.invocationCallOrder[0];
    expect(userAppendOrder).toBeLessThan(invokeOrder);
  });
});

// ---------------------------------------------------------------------------
// Req 9.2 — assistant message persisted on stream completion with the collected
// text, charts, reports, and activity.
// ---------------------------------------------------------------------------
describe("POST /api/chat — persists the assistant message on completion (Req 9.2)", () => {
  it("appends the assistant message with concatenated text, charts, reports, and activity", async () => {
    invokeAgentRuntimeMock.mockResolvedValue(fakeUpstream(TURN_EVENTS));

    const response = await POST(
      chatRequest({ conversationId: CONVERSATION_ID, prompt: "hi" }),
    );
    await drain(response);

    // Two appends total: [0] user (before invoke), [1] assistant (on completion).
    expect(appendMessageMock).toHaveBeenCalledTimes(2);

    const [asstUserId, asstConvId, asstMsg] = appendMessageMock.mock.calls[1];
    expect(asstUserId).toBe(USER_ID);
    expect(asstConvId).toBe(CONVERSATION_ID);

    expect(asstMsg.role).toBe("assistant");
    // Concatenated delta text.
    expect(asstMsg.content).toBe("Hello world");
    // Collected chart specs — narrowed to the known ChartSpec shape (no strays).
    expect(asstMsg.charts).toEqual([
      {
        id: "c1",
        chart_type: "bar",
        title: "Top Services by Cost",
        currency: "USD",
        labels: ["Amazon EC2", "Amazon S3"],
        values: [4820.55, 1290.1],
      },
    ]);
    // Collected report keys (key only, no bucket/presign).
    expect(asstMsg.reports).toEqual([{ key: "reports/user_owner_1/june.pdf" }]);
    // Activity summary derived from the turn's tool "start" steps.
    expect(asstMsg.activity).toEqual([
      { label: "Cost Explorer", status: "Querying AWS Cost Explorer…" },
    ]);

    // The assistant append happens after the runtime invocation started.
    const invokeOrder = invokeAgentRuntimeMock.mock.invocationCallOrder[0];
    const asstAppendOrder = appendMessageMock.mock.invocationCallOrder[1];
    expect(asstAppendOrder).toBeGreaterThan(invokeOrder);
  });
});

// ---------------------------------------------------------------------------
// Req 9.3 — no secret ever reaches the persisted assistant Message_Item args.
// ---------------------------------------------------------------------------
describe("POST /api/chat — excludes secrets from the persisted message (Req 9.3)", () => {
  it("never passes role_arn/external_id/credentials into appendMessage", async () => {
    invokeAgentRuntimeMock.mockResolvedValue(fakeUpstream(TURN_EVENTS));

    const response = await POST(
      chatRequest({ conversationId: CONVERSATION_ID, prompt: "hi" }),
    );
    await drain(response);

    // Serialize EVERY appendMessage argument and assert no secret is present —
    // the relay accumulates only narrowed events (Req 9.3).
    const allArgs = JSON.stringify(appendMessageMock.mock.calls);
    expect(allArgs).not.toContain(FAKE_ROLE_ARN);
    expect(allArgs).not.toContain(FAKE_EXTERNAL_ID);
    expect(allArgs).not.toContain("role_arn");
    expect(allArgs).not.toContain("external_id");
    expect(allArgs).not.toContain(FAKE_EXTERNAL_ID_ENC);

    // Specifically the assistant Message_Item (the accumulated one).
    const asstMsg = appendMessageMock.mock.calls[1][2];
    const asstJson = JSON.stringify(asstMsg);
    expect(asstJson).not.toContain(FAKE_ROLE_ARN);
    expect(asstJson).not.toContain(FAKE_EXTERNAL_ID);
    expect(asstJson).not.toContain("role_arn");
    expect(asstJson).not.toContain("external_id");
  });
});
