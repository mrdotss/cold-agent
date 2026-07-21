import { beforeEach, describe, expect, it, vi } from "vitest";

import { connectedAccounts, threads } from "@/lib/db/schema";
import type { SseEvent } from "@/lib/aws/sse";

/**
 * Integration tests for the `POST /api/chat` SSE relay
 * (`app/app/api/chat/route.ts`) — relay wiring + error/guard paths.
 *
 * ## What is REAL vs. FAKED
 *
 * - **REAL:** the route handler under test runs its actual guard/wiring logic,
 *   and — crucially — the pure SSE core `@/lib/aws/sse`
 *   (`parseSseChunk` / `toKnownEvent` / `redactForBrowser`) is NOT mocked, so
 *   event filtering (Req 7.7) and secret redaction (Req 7.4) are exercised
 *   end-to-end against a real upstream byte stream.
 * - **FAKED:** the four side-effecting boundaries the route imports —
 *   `@/lib/auth` (`auth`, controls the session), `@/lib/db` (`getDb`, a
 *   programmable in-memory query builder returning the thread + pinned account
 *   rows), `@/lib/crypto` (`decryptSecret`, a deterministic fake plaintext),
 *   and `@/lib/aws/agentcore` (`invokeAgentRuntime`, a spy resolved to a fake
 *   SSE byte iterable or rejected to simulate an invoke-start failure).
 *
 * These cover Req 7.1 (invoke wiring), 7.2 (Node SSE headers), 7.3 (actor_id),
 * 7.8 (single invoke-start error event), 7.10 (no-session rejection), and
 * 7.11 (missing-account rejection), plus the 8.7 not-owned-thread guard.
 */

// ---------------------------------------------------------------------------
// Mocked boundaries (hoisted so `vi.mock` factories can reference them).
// ---------------------------------------------------------------------------
const { authMock, getDbMock, decryptSecretMock, invokeAgentRuntimeMock } =
  vi.hoisted(() => ({
    authMock: vi.fn(),
    getDbMock: vi.fn(),
    decryptSecretMock: vi.fn(),
    invokeAgentRuntimeMock: vi.fn(),
  }));

vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/lib/db", () => ({ getDb: getDbMock }));
vi.mock("@/lib/crypto", () => ({ decryptSecret: decryptSecretMock }));
vi.mock("@/lib/aws/agentcore", () => ({
  invokeAgentRuntime: invokeAgentRuntimeMock,
}));
// NOTE: `@/lib/aws/sse` and `@/lib/invocation-context` are intentionally REAL.

import { POST } from "./route";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const USER_ID = "user_owner_1";
// Runtime session id: stable per thread, 33–128 chars (Req 7.9).
const THREAD_SESSION_ID = `sess_${"a".repeat(35)}`; // 40 chars
const CONNECTED_ACCOUNT_ID = "acct_1";
const FAKE_ROLE_ARN = "arn:aws:iam::123456789012:role/cba-readonly";
const FAKE_EXTERNAL_ID = "ext-secret-should-never-leak";
const FAKE_EXTERNAL_ID_ENC = "ciphertext-blob-base64";

type Row = Record<string, unknown>;

/**
 * Programmable in-memory Drizzle query-builder fake supporting the route's
 * `db.select({...}).from(table).where(...).limit(1)` chains, resolving each
 * query to the rows registered for the table passed to `.from(table)`.
 */
function createFakeDb(selects: Array<{ table: unknown; rows: Row[] }>): {
  db: { select: ReturnType<typeof vi.fn> };
  state: { selectFromTables: unknown[] };
} {
  const rowsByTable = new Map<unknown, Row[]>();
  for (const s of selects) rowsByTable.set(s.table, s.rows);

  const state = { selectFromTables: [] as unknown[] };

  function makeSelectBuilder() {
    let table: unknown;
    const resolve = () => Promise.resolve(rowsByTable.get(table) ?? []);
    const builder = {
      from(t: unknown) {
        table = t;
        state.selectFromTables.push(t);
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

  const db = { select: vi.fn(() => makeSelectBuilder()) };
  return { db, state };
}

/** Authenticate as the given user, or `null` for an unauthenticated request. */
function signInAs(userId: string | null): void {
  authMock.mockResolvedValue(userId === null ? null : { user: { id: userId } });
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

/** Drain a streaming Response body to a string. */
async function readAll(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value !== undefined) out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

/** Parse `data: {json}` SSE frames out of a relayed stream body. */
function parseFrames(body: string): SseEvent[] {
  return body
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.startsWith("data:"))
    .map((block) => JSON.parse(block.slice("data:".length).trim()) as SseEvent);
}

/** A thread+account fixture where both guards pass. */
function ownedThreadWithAccount() {
  return createFakeDb([
    {
      table: threads,
      rows: [{ sessionId: THREAD_SESSION_ID, connectedAccountId: CONNECTED_ACCOUNT_ID }],
    },
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

beforeEach(() => {
  vi.clearAllMocks();
  decryptSecretMock.mockReturnValue(FAKE_EXTERNAL_ID);
});

// ---------------------------------------------------------------------------
// Req 7.10 — no valid session → reject WITHOUT invoking and WITHOUT any SSE.
// ---------------------------------------------------------------------------
describe("POST /api/chat — no authenticated session (Req 7.10)", () => {
  it("returns 401, does not invoke the runtime, and opens no SSE stream", async () => {
    signInAs(null);

    const response = await POST(chatRequest({ threadId: "t1", prompt: "hi" }));

    expect(response.status).toBe(401);
    // No runtime invocation.
    expect(invokeAgentRuntimeMock).not.toHaveBeenCalled();
    // Not an SSE response — a plain JSON error instead.
    expect(response.headers.get("content-type") ?? "").not.toContain(
      "text/event-stream",
    );
    const body = await response.text();
    expect(body).not.toContain("data:");
    // DB is never consulted for an unauthenticated caller.
    expect(getDbMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Req 8.7 / 7.11 path — thread not owned/missing → 404, no invoke.
// ---------------------------------------------------------------------------
describe("POST /api/chat — thread not found / not owned (Req 8.7)", () => {
  it("returns 404 and does not invoke the runtime", async () => {
    signInAs(USER_ID);
    const { db, state } = createFakeDb([{ table: threads, rows: [] }]);
    getDbMock.mockReturnValue(db);

    const response = await POST(
      chatRequest({ threadId: "t_missing", prompt: "hi" }),
    );

    expect(response.status).toBe(404);
    expect(invokeAgentRuntimeMock).not.toHaveBeenCalled();
    // The account is never looked up once the ownership gate fails.
    expect(state.selectFromTables).not.toContain(connectedAccounts);
    expect(response.headers.get("content-type") ?? "").not.toContain(
      "text/event-stream",
    );
  });
});

// ---------------------------------------------------------------------------
// Req 7.11 / 6.5 — thread has no pinned Connected_Account → 400, no invoke.
// ---------------------------------------------------------------------------
describe("POST /api/chat — missing pinned account (Req 7.11, 6.5)", () => {
  it("returns 400 with a connect-account error and does not invoke the runtime", async () => {
    signInAs(USER_ID);
    const { db } = createFakeDb([
      {
        table: threads,
        rows: [
          { sessionId: THREAD_SESSION_ID, connectedAccountId: CONNECTED_ACCOUNT_ID },
        ],
      },
      { table: connectedAccounts, rows: [] }, // pinned account missing
    ]);
    getDbMock.mockReturnValue(db);

    const response = await POST(chatRequest({ threadId: "t1", prompt: "hi" }));

    expect(response.status).toBe(400);
    expect(invokeAgentRuntimeMock).not.toHaveBeenCalled();
    const body = (await response.json()) as { error?: string };
    expect(body.error ?? "").toMatch(/connect an aws account/i);
  });
});

// ---------------------------------------------------------------------------
// Req 7.1, 7.2, 7.3, 7.9, 7.4, 7.7 — happy-path wiring + redaction + filtering.
// ---------------------------------------------------------------------------
describe("POST /api/chat — happy-path relay wiring (Req 7.1, 7.2, 7.3)", () => {
  it("invokes with the thread's session id + user actor_id and streams redacted, filtered events", async () => {
    signInAs(USER_ID);
    const { db } = ownedThreadWithAccount();
    getDbMock.mockReturnValue(db);

    // Upstream frames: a delta carrying secret fields (must be stripped), an
    // unknown event type (must be dropped, Req 7.7), then done.
    invokeAgentRuntimeMock.mockResolvedValue(
      fakeUpstream([
        {
          type: "delta",
          text: "Hello world",
          role_arn: FAKE_ROLE_ARN,
          external_id: FAKE_EXTERNAL_ID,
        },
        { type: "__unknown_future__", payload: { role_arn: FAKE_ROLE_ARN } },
        { type: "done" },
      ]),
    );

    const response = await POST(chatRequest({ threadId: "t1", prompt: "hi" }));

    // Req 7.1/7.3/7.9: invoked once with the stored session id + user actor_id.
    expect(invokeAgentRuntimeMock).toHaveBeenCalledTimes(1);
    const invokeArg = invokeAgentRuntimeMock.mock.calls[0][0];
    expect(invokeArg.sessionId).toBe(THREAD_SESSION_ID);
    expect(invokeArg.prompt).toBe("hi");
    expect(invokeArg.context.actor_id).toBe(USER_ID);
    // Secrets are resolved server-side into the invocation context (Req 7.4).
    expect(invokeArg.context.role_arn).toBe(FAKE_ROLE_ARN);
    expect(invokeArg.context.external_id).toBe(FAKE_EXTERNAL_ID);

    // Req 7.2: Node-runtime SSE response with buffering disabled.
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toContain("no-cache");
    expect(response.headers.get("x-accel-buffering")).toBe("no");

    const body = await readAll(response);
    const frames = parseFrames(body);

    // Req 7.7: unknown event dropped; only delta then done forwarded, in order.
    expect(frames.map((f) => f.type)).toEqual(["delta", "done"]);
    expect(frames[0]).toEqual({ type: "delta", text: "Hello world" });

    // Req 7.4: no secret ever reaches the browser.
    expect(body).not.toContain("role_arn");
    expect(body).not.toContain("external_id");
    expect(body).not.toContain(FAKE_ROLE_ARN);
    expect(body).not.toContain(FAKE_EXTERNAL_ID);
    expect(body).not.toContain("__unknown_future__");
  });
});

// ---------------------------------------------------------------------------
// Req 7.8 — invoke-start failure → exactly one redacted `error` event, close.
// ---------------------------------------------------------------------------
describe("POST /api/chat — invoke-start failure (Req 7.8)", () => {
  it("emits exactly one redacted error event then closes the stream", async () => {
    signInAs(USER_ID);
    const { db } = ownedThreadWithAccount();
    getDbMock.mockReturnValue(db);

    // Simulate the runtime failing to start (e.g. missing config / SDK error).
    invokeAgentRuntimeMock.mockRejectedValue(
      new Error(`boom ${FAKE_ROLE_ARN} ${FAKE_EXTERNAL_ID}`),
    );

    const response = await POST(chatRequest({ threadId: "t1", prompt: "hi" }));

    // The stream still opens with SSE headers; the error is emitted in-band.
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const body = await readAll(response);
    const frames = parseFrames(body);

    // Exactly one frame, and it is a redacted error (Req 7.8).
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe("error");
    expect(body).not.toContain(FAKE_ROLE_ARN);
    expect(body).not.toContain(FAKE_EXTERNAL_ID);
    expect(body).not.toContain("role_arn");
    expect(body).not.toContain("external_id");
  });
});
