import { beforeEach, describe, expect, it, vi } from "vitest";

import { connectedAccounts } from "@/lib/db/schema";

/**
 * Disconnect-safe assistant persistence tests for the `POST /api/chat` SSE relay
 * (`app/app/api/chat/route.ts`) — Req 9.2, 9.7.
 *
 * ## Why a DEDICATED file (route.disconnect.test.ts)
 * These tests exercise a narrow, timing-sensitive slice of the relay — the
 * stream's `start()` finally / after-loop persistence path under a *mid-turn
 * client disconnect* — and they need a controllable, "parked" upstream to hold
 * the server loop open while the client aborts. Keeping that machinery in its own
 * file leaves the broader persistence suite (task 11.2, `route.persistence.test.ts`)
 * and the relay-wiring suite (`route.integration.test.ts`) simple; this file
 * shares the same mocking shape as those so the harnesses stay recognizable.
 *
 * ## What is REAL vs. FAKED
 * - **REAL:** the route handler under test and the pure SSE core `@/lib/aws/sse`
 *   (`parseSseChunk` / `toKnownEvent` / `redactForBrowser`) run unmocked, so the
 *   server-side accumulation of `assistantText` from real upstream bytes is
 *   exercised end-to-end. `@/lib/invocation-context` is also real (pure).
 * - **FAKED:** the side-effecting boundaries — `@/lib/auth` (session),
 *   `@/lib/db` (`getDb`, in-memory account row), `@/lib/crypto`
 *   (`decryptSecret`), `@/lib/aws/agentcore` (`invokeAgentRuntime`, resolved to a
 *   controllable "parked" SSE iterable), `@/lib/history/conversations`
 *   (`getConversationOwned`, the ownership gate), and `@/lib/history/messages`
 *   (`appendMessage`, a spy asserting exactly which Message_Items get persisted).
 *
 * ## Disconnect simulation technique (deterministic — no timer races)
 * The faithful "browser navigated away mid-turn" simulation (task approach A):
 *  1. `invokeAgentRuntime` returns an async iterable that yields the pre-abort
 *     events, then `await`s a test-controlled promise (`park`) so the server's
 *     read loop is suspended INSIDE the turn (no `done` seen yet).
 *  2. The test drives the relay via `response.body.getReader()`, reads the first
 *     forwarded chunk (so the server-side accumulation has already happened for
 *     that event), then calls `reader.cancel()` — which triggers the stream's
 *     `cancel()` (`cancelled = true`, releases the upstream iterator).
 *  3. The test then resolves `park`, letting the suspended generator unwind so
 *     the server loop's pending `next()` settles, the `while (!finished &&
 *     !cancelled)` loop breaks, and the `finally` runs.
 *  4. Completion is awaited on an explicit signal, NOT a timeout: `appendMessage`
 *     resolves a deferred when it persists the ASSISTANT message (persist case),
 *     and a bounded microtask flush confirms the finally ran without persisting
 *     an assistant item (skip case). The 120s inactivity timer never fires and is
 *     cleared each iteration, so no real timers are involved in coordination.
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
vi.mock("@/lib/aws/agentcore", () => ({ invokeAgentRuntime: invokeAgentRuntimeMock }));
vi.mock("@/lib/history/conversations", () => ({
  getConversationOwned: getConversationOwnedMock,
}));
vi.mock("@/lib/history/messages", () => ({ appendMessage: appendMessageMock }));
// NOTE: `@/lib/aws/sse` and `@/lib/invocation-context` are intentionally REAL.

import { POST } from "./route";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const USER_ID = "user_owner_1";
const CONVERSATION_ID = "conv_1";
// Runtime session id: stable per conversation, 33–128 chars (Req 8.7 / 7.9).
const SESSION_ID = `sess_${"a".repeat(35)}`; // 40 chars
const CONNECTED_ACCOUNT_ID = "acct_1";
const FAKE_ROLE_ARN = "arn:aws:iam::123456789012:role/cba-readonly";
const FAKE_EXTERNAL_ID = "ext-secret-should-never-leak";
const FAKE_EXTERNAL_ID_ENC = "ciphertext-blob-base64";

type Row = Record<string, unknown>;

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

/** A promise whose `resolve` is exposed — the test-controlled coordination point. */
function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Minimal in-memory Drizzle query-builder fake supporting the route's
 * `db.select({...}).from(connectedAccounts).where(...).limit(1)` chain, resolving
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

/** Authenticate as the given user, or `null` for an unauthenticated request. */
function signInAs(userId: string | null): void {
  authMock.mockResolvedValue(userId === null ? null : { user: { id: userId } });
}

/** A conversation the user owns, pinned to the fake account (ownership gate passes). */
function ownedConversation() {
  getConversationOwnedMock.mockResolvedValue({
    conversationId: CONVERSATION_ID,
    title: "June spend",
    titleSource: "ai",
    accountId: CONNECTED_ACCOUNT_ID,
    sessionId: SESSION_ID,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    messageCount: 0,
  });
}

/** Register the pinned Connected_Account so the account guard passes. */
function withPinnedAccount(): void {
  getDbMock.mockReturnValue(
    createFakeDb([
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
    ]),
  );
}

/**
 * A "parked" upstream SSE byte stream: yields each of `preEvents` as a `data:`
 * frame, then suspends on `park` (holding the server loop mid-turn), then yields
 * `postEvents` and ends. Resolving `park` lets the generator unwind.
 */
function parkedUpstream(
  preEvents: unknown[],
  park: Promise<void>,
  postEvents: unknown[] = [],
): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder();
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of preEvents) {
        yield encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
      }
      await park;
      for (const event of postEvents) {
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

/** Flush queued microtasks/promise jobs a bounded number of times (no fake timers). */
async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  decryptSecretMock.mockReturnValue(FAKE_EXTERNAL_ID);
  appendMessageMock.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Req 9.2 — assistant text accumulated before a mid-turn disconnect is STILL
// persisted from the stream's finally/after-loop path.
// ---------------------------------------------------------------------------
describe("POST /api/chat — persists accumulated assistant text despite mid-turn disconnect (Req 9.2)", () => {
  it("runs the finally-path assistant persist after the client aborts mid-turn", async () => {
    signInAs(USER_ID);
    ownedConversation();
    withPinnedAccount();

    // The assistant message persist resolves this deferred — the deterministic
    // completion signal (no timeout).
    const assistantPersisted = deferred();
    appendMessageMock.mockImplementation(async (_userId, _conversationId, msg) => {
      if (msg.role === "assistant") assistantPersisted.resolve();
    });

    // Upstream: one delta (so assistantText accumulates), then park mid-turn —
    // NO `done` is ever delivered before the client disconnects.
    const park = deferred();
    invokeAgentRuntimeMock.mockResolvedValue(
      parkedUpstream([{ type: "delta", text: "Hello world" }], park.promise),
    );

    const response = await POST(
      chatRequest({ conversationId: CONVERSATION_ID, prompt: "hi" }),
    );
    expect(response.status).toBe(200);

    // The USER message is persisted BEFORE the runtime is invoked (Req 9.1).
    expect(appendMessageMock).toHaveBeenCalledTimes(1);
    expect(appendMessageMock.mock.calls[0][2].role).toBe("user");

    // Drive the stream: read the first forwarded chunk (the delta), proving the
    // server accumulated it, while the upstream is parked mid-turn.
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value!)).toContain('"delta"');

    // Simulate the browser navigating away mid-turn: cancel the client reader
    // (triggers the stream's cancel()), THEN unpark so the loop can break and the
    // finally can run.
    const cancelPromise = reader.cancel();
    park.resolve();
    await cancelPromise;
    await assistantPersisted.promise;

    // Req 9.2: the assistant Message_Item is persisted from the finally path even
    // though the client connection was aborted — with the accumulated text.
    expect(appendMessageMock).toHaveBeenCalledTimes(2);
    const [userId, conversationId, assistantMsg] = appendMessageMock.mock.calls[1];
    expect(userId).toBe(USER_ID);
    expect(conversationId).toBe(CONVERSATION_ID);
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.content).toBe("Hello world");

    // Req 9.3: no secret is ever written into the persisted assistant item.
    const serialized = JSON.stringify(assistantMsg);
    expect(serialized).not.toContain(FAKE_ROLE_ARN);
    expect(serialized).not.toContain(FAKE_EXTERNAL_ID);
  });
});

// ---------------------------------------------------------------------------
// Req 9.7 — a turn aborted BEFORE any assistant delta writes NO assistant
// Message_Item (empty-text skip); the user Message_Item is unaffected.
// ---------------------------------------------------------------------------
describe("POST /api/chat — empty-text turn aborted before any delta skips assistant persist (Req 9.7)", () => {
  it("persists only the user message and never an assistant message", async () => {
    signInAs(USER_ID);
    ownedConversation();
    withPinnedAccount();

    // Upstream: a single non-delta (tool) event — so events flowed but NO
    // assistant text accumulated — then park; the client aborts before any delta.
    const park = deferred();
    invokeAgentRuntimeMock.mockResolvedValue(
      parkedUpstream(
        [
          {
            type: "tool",
            phase: "start",
            id: "t1",
            name: "get_cost_and_usage",
            label: "Cost Explorer",
            status: "Querying AWS Cost Explorer…",
          },
        ],
        park.promise,
      ),
    );

    const response = await POST(
      chatRequest({ conversationId: CONVERSATION_ID, prompt: "hi" }),
    );
    expect(response.status).toBe(200);

    // The USER message is already persisted before invoke (Req 9.1).
    expect(appendMessageMock).toHaveBeenCalledTimes(1);
    expect(appendMessageMock.mock.calls[0][2].role).toBe("user");

    // Read the forwarded tool frame (no delta), then abort before any delta.
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value!)).toContain('"tool"');

    const cancelPromise = reader.cancel();
    park.resolve();
    await cancelPromise;
    await flush();

    // Req 9.7: no assistant Message_Item is written (empty-text skip), and the
    // already-persisted user Message_Item is unaffected either way.
    expect(appendMessageMock).toHaveBeenCalledTimes(1);
    const roles = appendMessageMock.mock.calls.map((call) => call[2].role);
    expect(roles).toEqual(["user"]);
    expect(roles).not.toContain("assistant");
    expect(appendMessageMock.mock.calls[0][2].content).toBe("hi");
  });
});
