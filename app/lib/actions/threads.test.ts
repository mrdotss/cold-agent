import { describe, it, expect, beforeEach, vi } from "vitest";

import { connectedAccounts, messages, threads } from "@/lib/db/schema";

/**
 * Unit tests for the thread pin / ownership / empty-thread guards in
 * `lib/actions/threads.ts` (Req 8.1, 8.2, 8.6, 8.7, 8.9).
 *
 * ## What is REAL vs. FAKED
 *
 * - **REAL:** the server actions under test (`createThread`, `getThread`,
 *   `getThreadMessages`, `listThreads`) run their actual guard logic, and the
 *   real `and` / `eq` / `asc` operators from `drizzle-orm` build the query
 *   conditions. We only *spy* on `eq`/`and` (partial mock) so we can assert the
 *   reads are OWNERSHIP-scoped to the authenticated user without touching a DB.
 * - **FAKED:** the three side-effecting boundaries the module imports —
 *   `@/lib/auth` (`auth`, controls the current user), `@/lib/db` (`getDb`,
 *   returns a programmable in-memory query builder), and `@/lib/session-id`
 *   (`newSessionId`, pinned to a fixed value so we can assert the generated
 *   session id is used at insert time and NEVER surfaced in the ThreadView).
 *
 * The fake db builder resolves each query form (`select…from…where…limit`,
 * `select…from…where…orderBy`, `insert…values…returning`) to a per-table result
 * the test programs, and records whether `insert` ran and which tables were read
 * — enough to assert "persists nothing" (8.2) and "no message query" (8.7).
 */

// Mocked boundaries (hoisted so `vi.mock` factories can reference them).
const { authMock, getDbMock, newSessionIdMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  getDbMock: vi.fn(),
  newSessionIdMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/lib/db", () => ({ getDb: getDbMock }));
vi.mock("@/lib/session-id", () => ({ newSessionId: newSessionIdMock }));

// Partially mock drizzle-orm so we keep the real operators but can inspect that
// reads are scoped by userId (ownership). `drizzle-orm/pg-core` (used by the
// schema) is a different module and is left untouched.
const { eqSpy, andSpy } = vi.hoisted(() => ({
  eqSpy: vi.fn(),
  andSpy: vi.fn(),
}));
vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    eq: (...args: Parameters<typeof actual.eq>) => {
      eqSpy(...args);
      return actual.eq(...args);
    },
    and: (...args: Parameters<typeof actual.and>) => {
      andSpy(...args);
      return actual.and(...args);
    },
  };
});

import {
  createThread,
  getThread,
  getThreadMessages,
  listThreads,
} from "@/lib/actions/threads";

// ---------------------------------------------------------------------------
// Programmable in-memory Drizzle query-builder fake
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

interface FakeDbConfig {
  /** select() results keyed by the table passed to `.from(table)`. */
  selects?: Array<{ table: unknown; rows: Row[] }>;
  /** rows returned by an `insert(...).values(...).returning(...)` chain. */
  insertRows?: Row[];
}

interface FakeDb {
  db: {
    select: ReturnType<typeof vi.fn>;
    insert: ReturnType<typeof vi.fn>;
  };
  state: {
    selectFromTables: unknown[];
    insertCalls: Array<{ table: unknown; values: Row }>;
  };
}

function createFakeDb(config: FakeDbConfig = {}): FakeDb {
  const selectRowsByTable = new Map<unknown, Row[]>();
  for (const s of config.selects ?? []) {
    selectRowsByTable.set(s.table, s.rows);
  }

  const state: FakeDb["state"] = {
    selectFromTables: [],
    insertCalls: [],
  };

  function makeSelectBuilder() {
    let table: unknown;
    const resolve = () => Promise.resolve(selectRowsByTable.get(table) ?? []);
    const builder = {
      from(t: unknown) {
        table = t;
        state.selectFromTables.push(t);
        return builder;
      },
      where() {
        return builder;
      },
      // Terminal forms the actions await:
      limit() {
        return resolve();
      },
      orderBy() {
        return resolve();
      },
    };
    return builder;
  }

  function makeInsertBuilder(table: unknown) {
    const builder = {
      values(v: Row) {
        state.insertCalls.push({ table, values: v });
        return builder;
      },
      returning() {
        return Promise.resolve(config.insertRows ?? []);
      },
    };
    return builder;
  }

  const db = {
    select: vi.fn(() => makeSelectBuilder()),
    insert: vi.fn((t: unknown) => makeInsertBuilder(t)),
  };

  return { db: db as FakeDb["db"], state };
}

// A fixed session id so we can assert it is used at insert time and that it is
// NEVER leaked into the returned ThreadView.
const FIXED_SESSION_ID = `sess_${"0".repeat(35)}`; // 40 chars
const USER_ID = "user_owner_1";

/** Authenticate as the given user (or unauthenticate with `null`). */
function signInAs(userId: string | null): void {
  authMock.mockResolvedValue(userId === null ? null : { user: { id: userId } });
}

beforeEach(() => {
  vi.clearAllMocks();
  newSessionIdMock.mockReturnValue(FIXED_SESSION_ID);
  expect(FIXED_SESSION_ID).toHaveLength(40);
});

// ---------------------------------------------------------------------------
// Req 8.1 — createThread pins the given connected account + a generated session
// ---------------------------------------------------------------------------

describe("createThread — pins the connected account (Req 8.1)", () => {
  it("inserts a thread with the given connectedAccountId and generated sessionId; returns a ThreadView without sessionId", async () => {
    signInAs(USER_ID);
    const createdAt = new Date("2025-01-01T00:00:00.000Z");
    const { db, state } = createFakeDb({
      selects: [{ table: connectedAccounts, rows: [{ id: "acct_1" }] }],
      insertRows: [
        {
          id: "thread_1",
          connectedAccountId: "acct_1",
          title: null,
          createdAt,
        },
      ],
    });
    getDbMock.mockReturnValue(db);

    const result = await createThread({ connectedAccountId: "acct_1" });

    expect(result.ok).toBe(true);
    // Exactly one thread persisted, pinning the account + the generated session.
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(state.insertCalls).toHaveLength(1);
    const inserted = state.insertCalls[0];
    expect(inserted.table).toBe(threads);
    expect(inserted.values.connectedAccountId).toBe("acct_1");
    expect(inserted.values.sessionId).toBe(FIXED_SESSION_ID);
    expect(inserted.values.userId).toBe(USER_ID);
    expect(inserted.values.id).toEqual(expect.any(String));

    // The ThreadView never carries the runtime session id.
    if (result.ok) {
      expect(result.thread).toEqual({
        id: "thread_1",
        connectedAccountId: "acct_1",
        title: null,
        createdAt,
      });
      expect(result.thread).not.toHaveProperty("sessionId");
      expect(JSON.stringify(result.thread)).not.toContain(FIXED_SESSION_ID);
    }
  });

  it("verifies account ownership before pinning (lookup scoped by userId)", async () => {
    signInAs(USER_ID);
    const { db } = createFakeDb({
      selects: [{ table: connectedAccounts, rows: [{ id: "acct_1" }] }],
      insertRows: [
        { id: "t", connectedAccountId: "acct_1", title: null, createdAt: new Date() },
      ],
    });
    getDbMock.mockReturnValue(db);

    await createThread({ connectedAccountId: "acct_1" });

    // The account existence check is scoped to the current user.
    expect(eqSpy).toHaveBeenCalledWith(connectedAccounts.userId, USER_ID);
    expect(eqSpy).toHaveBeenCalledWith(connectedAccounts.id, "acct_1");
  });
});

// ---------------------------------------------------------------------------
// Req 8.2 — reject (persist NOTHING) when there is no owned account
// ---------------------------------------------------------------------------

describe("createThread — rejects without an owned account, persisting nothing (Req 8.2)", () => {
  it("rejects when the account is not owned / does not exist (zero matching rows) and inserts nothing", async () => {
    signInAs(USER_ID);
    const { db, state } = createFakeDb({
      // No connected account matches the ownership-scoped lookup (also covers
      // the zero-accounts case).
      selects: [{ table: connectedAccounts, rows: [] }],
    });
    getDbMock.mockReturnValue(db);

    const result = await createThread({ connectedAccountId: "acct_not_owned" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/connect at least one aws account/i);
    }
    // Persist NOTHING: no insert, no session id generated.
    expect(db.insert).not.toHaveBeenCalled();
    expect(state.insertCalls).toHaveLength(0);
    expect(newSessionIdMock).not.toHaveBeenCalled();
  });

  it("rejects a missing/blank account id without touching the database", async () => {
    signInAs(USER_ID);
    const { db } = createFakeDb();
    getDbMock.mockReturnValue(db);

    const result = await createThread({ connectedAccountId: "" });

    expect(result.ok).toBe(false);
    // Validation fails before any query; nothing is persisted.
    expect(db.select).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(newSessionIdMock).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated caller without touching the database", async () => {
    signInAs(null);
    const { db } = createFakeDb();
    getDbMock.mockReturnValue(db);

    const result = await createThread({ connectedAccountId: "acct_1" });

    expect(result.ok).toBe(false);
    expect(getDbMock).not.toHaveBeenCalled();
    expect(newSessionIdMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Req 8.6 — getThreadMessages on an OWNED empty thread returns []
// ---------------------------------------------------------------------------

describe("getThreadMessages — owned empty thread returns [] (Req 8.6)", () => {
  it("returns an empty array (not null / not an error) for an owned thread with no messages", async () => {
    signInAs(USER_ID);
    const { db } = createFakeDb({
      selects: [
        { table: threads, rows: [{ id: "thread_1" }] }, // ownership passes
        { table: messages, rows: [] }, // no messages yet
      ],
    });
    getDbMock.mockReturnValue(db);

    const result = await getThreadMessages("thread_1");

    expect(result).toEqual([]);
    expect(result).not.toBeNull();
  });

  it("returns owned messages ordered as queried for a non-empty owned thread", async () => {
    signInAs(USER_ID);
    const msg = {
      id: "m1",
      threadId: "thread_1",
      role: "user" as const,
      content: "hello",
      createdAt: new Date("2025-01-01T00:00:00.000Z"),
    };
    const { db } = createFakeDb({
      selects: [
        { table: threads, rows: [{ id: "thread_1" }] },
        { table: messages, rows: [msg] },
      ],
    });
    getDbMock.mockReturnValue(db);

    const result = await getThreadMessages("thread_1");

    expect(result).toEqual([msg]);
  });
});

// ---------------------------------------------------------------------------
// Req 8.7 — non-owned thread: getThread/getThreadMessages return null, no leak
// ---------------------------------------------------------------------------

describe("getThread / getThreadMessages — non-owned thread returns null (Req 8.7)", () => {
  it("getThread returns null for a thread the user does not own (scoped by userId)", async () => {
    signInAs(USER_ID);
    const { db } = createFakeDb({
      // Ownership-scoped lookup finds nothing => not owned / missing.
      selects: [{ table: threads, rows: [] }],
    });
    getDbMock.mockReturnValue(db);

    const result = await getThread("thread_other");

    expect(result).toBeNull();
    // The lookup was scoped to the authenticated user.
    expect(eqSpy).toHaveBeenCalledWith(threads.userId, USER_ID);
  });

  it("getThreadMessages returns null and never queries messages for a non-owned thread", async () => {
    signInAs(USER_ID);
    const { db, state } = createFakeDb({
      selects: [{ table: threads, rows: [] }], // ownership gate fails
    });
    getDbMock.mockReturnValue(db);

    const result = await getThreadMessages("thread_other");

    expect(result).toBeNull();
    // No messages/session id leaked: the messages table is never read.
    expect(state.selectFromTables).not.toContain(messages);
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("getThread / getThreadMessages return null for an unauthenticated caller without touching the database", async () => {
    signInAs(null);
    const { db } = createFakeDb();
    getDbMock.mockReturnValue(db);

    expect(await getThread("thread_1")).toBeNull();
    expect(await getThreadMessages("thread_1")).toBeNull();
    expect(getDbMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Req 8.9 — listThreads is scoped to the authenticated user; [] when unauth
// ---------------------------------------------------------------------------

describe("listThreads — scoped to the authenticated user (Req 8.9)", () => {
  it("returns only the current user's threads (query scoped by userId) as sessionId-free ThreadViews", async () => {
    signInAs(USER_ID);
    const createdAt = new Date("2025-01-01T00:00:00.000Z");
    const { db } = createFakeDb({
      selects: [
        {
          table: threads,
          rows: [
            { id: "t1", connectedAccountId: "acct_1", title: "First", createdAt },
            { id: "t2", connectedAccountId: "acct_1", title: null, createdAt },
          ],
        },
      ],
    });
    getDbMock.mockReturnValue(db);

    const result = await listThreads();

    expect(result).toEqual([
      { id: "t1", connectedAccountId: "acct_1", title: "First", createdAt },
      { id: "t2", connectedAccountId: "acct_1", title: null, createdAt },
    ]);
    // Scoped to the signed-in user.
    expect(eqSpy).toHaveBeenCalledWith(threads.userId, USER_ID);
    // No runtime session id ever crosses the boundary.
    for (const view of result) {
      expect(view).not.toHaveProperty("sessionId");
    }
    expect(JSON.stringify(result)).not.toContain(FIXED_SESSION_ID);
  });

  it("returns [] for an unauthenticated caller without touching the database", async () => {
    signInAs(null);
    const { db } = createFakeDb();
    getDbMock.mockReturnValue(db);

    const result = await listThreads();

    expect(result).toEqual([]);
    expect(getDbMock).not.toHaveBeenCalled();
  });
});
