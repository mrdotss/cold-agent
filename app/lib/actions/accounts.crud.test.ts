import { describe, it, expect, beforeEach, vi } from "vitest";

import { activeAccount, connectedAccounts } from "@/lib/db/schema";

/**
 * Unit tests for the account wizard / CRUD server actions in
 * `lib/actions/accounts.ts` (Req 3.5, 4.4, 5.4, 5.5, 5.6, 5.7, 5.8).
 *
 * ## What is REAL vs. FAKED
 *
 * - **REAL:** the server actions under test (`createConnectedAccount`,
 *   `listConnectedAccounts`, `deleteConnectedAccount`, `setActiveAccount`) run
 *   their actual guard / persistence logic, and the real `and` / `eq` operators
 *   from `drizzle-orm` build the query conditions. We only *spy* on `eq`/`and`
 *   (partial mock) so we can assert reads/writes are OWNERSHIP-scoped to the
 *   authenticated user without touching a DB.
 * - **FAKED:** the side-effecting boundaries the module imports — `@/lib/auth`
 *   (`auth`, controls the current user), `@/lib/db` (`getDb`, returns a
 *   programmable in-memory query builder incl. `transaction`), and `@/lib/crypto`
 *   (`encryptSecret`, pinned to a recognizable transform so we can assert the
 *   External_Id is stored ENCRYPTED, never in plaintext).
 *
 * The fake db builder resolves each query form
 * (`select…from…where[…limit]`, `insert…values…returning`,
 * `insert…values…onConflictDoUpdate`, `update…set…where[…returning]`,
 * `delete…where`, and `transaction`) to a per-table / per-op result the test
 * programs, and records every insert / update / delete so we can assert exactly
 * what crosses the persistence boundary.
 */

// Mocked boundaries (hoisted so `vi.mock` factories can reference them).
const { authMock, getDbMock, encryptSecretMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  getDbMock: vi.fn(),
  encryptSecretMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/lib/db", () => ({ getDb: getDbMock }));
vi.mock("@/lib/crypto", () => ({
  encryptSecret: encryptSecretMock,
  decryptSecret: vi.fn(),
}));

// Partially mock drizzle-orm so we keep the real operators but can inspect that
// reads/writes are scoped by userId (ownership). `drizzle-orm/pg-core` (used by
// the schema) is a different module and is left untouched.
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
  createConnectedAccount,
  deleteConnectedAccount,
  listConnectedAccounts,
  setActiveAccount,
  type CreateConnectedAccountInput,
} from "@/lib/actions/accounts";

// ---------------------------------------------------------------------------
// Programmable in-memory Drizzle query-builder fake
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

interface FakeDbConfig {
  /** select() results keyed by the table passed to `.from(table)`. */
  selects?: Array<{ table: unknown; rows: Row[] }>;
  /** rows returned by an `insert(...).values(...).returning()` chain. */
  insertRows?: Row[];
  /** rows returned by an `update(...).set(...).where(...).returning()` chain. */
  updateRows?: Row[];
  /** when true, awaiting a `delete(...)` chain rejects (simulates a DB failure). */
  throwOnDelete?: boolean;
}

interface MutationRecord {
  table: unknown;
  values?: Row;
  set?: Row;
  onConflict?: unknown;
}

interface FakeDb {
  db: {
    select: ReturnType<typeof vi.fn>;
    insert: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    transaction: ReturnType<typeof vi.fn>;
  };
  state: {
    selectFromTables: unknown[];
    insertCalls: MutationRecord[];
    updateCalls: MutationRecord[];
    deleteCalls: MutationRecord[];
    transactionRan: boolean;
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
    updateCalls: [],
    deleteCalls: [],
    transactionRan: false,
  };

  // A select builder is thenable at any point after `.from()`, so both
  // `await select().from().where()` and `…where().limit(1)` resolve to rows.
  function makeSelectBuilder() {
    let table: unknown;
    const rows = () => Promise.resolve(selectRowsByTable.get(table) ?? []);
    const builder = {
      from(t: unknown) {
        table = t;
        state.selectFromTables.push(t);
        return builder;
      },
      innerJoin() {
        return builder;
      },
      where() {
        return builder;
      },
      limit() {
        return builder;
      },
      orderBy() {
        return builder;
      },
      then<TResult1, TResult2>(
        onFulfilled?:
          | ((value: Row[]) => TResult1 | PromiseLike<TResult1>)
          | null,
        onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) {
        return rows().then(onFulfilled, onRejected);
      },
    };
    return builder;
  }

  // insert / update / delete share a thenable builder; the awaited result and
  // recorded state depend on the op kind.
  function makeMutationBuilder(kind: "insert" | "update" | "delete", table: unknown) {
    const record: MutationRecord = { table };
    if (kind === "insert") state.insertCalls.push(record);
    if (kind === "update") state.updateCalls.push(record);
    if (kind === "delete") state.deleteCalls.push(record);

    const result = (): Promise<Row[]> => {
      if (kind === "insert") return Promise.resolve(config.insertRows ?? []);
      if (kind === "update") return Promise.resolve(config.updateRows ?? []);
      // delete
      return config.throwOnDelete
        ? Promise.reject(new Error("delete failed"))
        : Promise.resolve([]);
    };

    const builder = {
      values(v: Row) {
        record.values = v;
        return builder;
      },
      set(v: Row) {
        record.set = v;
        return builder;
      },
      where() {
        return builder;
      },
      returning() {
        return builder;
      },
      onConflictDoUpdate(cfg: unknown) {
        record.onConflict = cfg;
        return builder;
      },
      then<TResult1, TResult2>(
        onFulfilled?:
          | ((value: Row[]) => TResult1 | PromiseLike<TResult1>)
          | null,
        onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) {
        return result().then(onFulfilled, onRejected);
      },
    };
    return builder;
  }

  const db = {
    select: vi.fn(() => makeSelectBuilder()),
    insert: vi.fn((t: unknown) => makeMutationBuilder("insert", t)),
    update: vi.fn((t: unknown) => makeMutationBuilder("update", t)),
    delete: vi.fn((t: unknown) => makeMutationBuilder("delete", t)),
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => {
      state.transactionRan = true;
      // The action calls tx.select / tx.update / tx.delete — the same surface.
      return fn(db);
    }),
  };

  return { db: db as unknown as FakeDb["db"], state };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_ID = "user_owner_1";
const OTHER_ACCOUNT_ID = "acct_not_owned";
const ACCOUNT_ID = "acct_1";

/** Well-formed IAM role ARN; account id 123456789012 masks to "••••••••9012". */
const VALID_ROLE_ARN = "arn:aws:iam::123456789012:role/CloudBillAnalystReadOnly";
const AWS_ACCOUNT_ID = "123456789012";
const MASKED_ACCOUNT_ID = "\u2022".repeat(8) + "9012";
/** Structurally valid External_Id (16..1224 chars, STS charset). */
const VALID_EXTERNAL_ID = "abcdefghijklmnop1234";

/** Authenticate as the given user (or unauthenticate with `null`). */
function signInAs(userId: string | null): void {
  authMock.mockResolvedValue(userId === null ? null : { user: { id: userId } });
}

beforeEach(() => {
  vi.clearAllMocks();
  // A recognizable, non-identity transform so a stored value that still equals
  // the plaintext External_Id proves encryption was skipped.
  encryptSecretMock.mockImplementation((plaintext: string) => `enc:${plaintext}`);
});

// ---------------------------------------------------------------------------
// Req 3.5 — the create path never collects or persists AWS access keys
// ---------------------------------------------------------------------------

describe("createConnectedAccount — no AWS keys are collected or stored (Req 3.5)", () => {
  it("accepts only alias/roleArn/externalId as its input contract", () => {
    // The accepted input shape has exactly the three no-secret-key fields.
    const input: CreateConnectedAccountInput = {
      alias: "Prod",
      roleArn: VALID_ROLE_ARN,
      externalId: VALID_EXTERNAL_ID,
    };
    expect(Object.keys(input).sort()).toEqual(["alias", "externalId", "roleArn"]);
    // There is no access-key field anywhere in the contract.
    expect(input).not.toHaveProperty("accessKeyId");
    expect(input).not.toHaveProperty("secretAccessKey");
  });

  it("ignores extra access-key-like fields: they are never persisted", async () => {
    signInAs(USER_ID);
    const { db, state } = createFakeDb({
      selects: [{ table: connectedAccounts, rows: [] }],
      insertRows: [
        {
          id: ACCOUNT_ID,
          userId: USER_ID,
          alias: "Prod",
          roleArn: VALID_ROLE_ARN,
          externalIdEnc: `enc:${VALID_EXTERNAL_ID}`,
          awsAccountId: AWS_ACCOUNT_ID,
          displayCurrency: "IDR",
          timezone: "Asia/Jakarta",
        },
      ],
    });
    getDbMock.mockReturnValue(db);

    // Pass forbidden key material as extra fields — the action must drop them.
    const inputWithKeys = {
      alias: "Prod",
      roleArn: VALID_ROLE_ARN,
      externalId: VALID_EXTERNAL_ID,
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    } as unknown as CreateConnectedAccountInput;

    const result = await createConnectedAccount(inputWithKeys);

    expect(result.ok).toBe(true);
    // Exactly one row inserted, and it carries NO access-key fields.
    expect(state.insertCalls).toHaveLength(1);
    const stored = state.insertCalls[0].values ?? {};
    expect(stored).not.toHaveProperty("accessKeyId");
    expect(stored).not.toHaveProperty("secretAccessKey");
    expect(stored).not.toHaveProperty("accessKey");
    // The forbidden key values never reached the persistence boundary.
    const persisted = JSON.stringify(stored);
    expect(persisted).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(persisted).not.toContain("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
  });
});

// ---------------------------------------------------------------------------
// Req 4.4 — happy-path store applies contract defaults + encrypts External_Id
// ---------------------------------------------------------------------------

describe("createConnectedAccount — happy-path store with defaults (Req 4.4)", () => {
  it("inserts one row with IDR/Asia/Jakarta defaults, encrypted External_Id, and userId; returns a secret-free view", async () => {
    signInAs(USER_ID);
    const { db, state } = createFakeDb({
      selects: [{ table: connectedAccounts, rows: [] }], // under the count bound
      insertRows: [
        {
          id: ACCOUNT_ID,
          userId: USER_ID,
          alias: "Prod",
          roleArn: VALID_ROLE_ARN,
          externalIdEnc: `enc:${VALID_EXTERNAL_ID}`,
          awsAccountId: AWS_ACCOUNT_ID,
          displayCurrency: "IDR",
          timezone: "Asia/Jakarta",
        },
      ],
    });
    getDbMock.mockReturnValue(db);

    const result = await createConnectedAccount({
      alias: "Prod",
      roleArn: VALID_ROLE_ARN,
      externalId: VALID_EXTERNAL_ID,
    });

    expect(result.ok).toBe(true);

    // Exactly one insert into connected_accounts with the contract defaults.
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(state.insertCalls).toHaveLength(1);
    const stored = state.insertCalls[0];
    expect(stored.table).toBe(connectedAccounts);
    expect(stored.values?.displayCurrency).toBe("IDR");
    expect(stored.values?.timezone).toBe("Asia/Jakarta");
    // Associated with the authenticated user + derived account id.
    expect(stored.values?.userId).toBe(USER_ID);
    expect(stored.values?.awsAccountId).toBe(AWS_ACCOUNT_ID);

    // External_Id is encrypted at rest (encryptSecret used); NEVER stored plain.
    expect(encryptSecretMock).toHaveBeenCalledWith(VALID_EXTERNAL_ID);
    expect(stored.values?.externalIdEnc).toBe(`enc:${VALID_EXTERNAL_ID}`);
    expect(stored.values?.externalIdEnc).not.toBe(VALID_EXTERNAL_ID);

    // The returned view carries only browser-safe fields (Req 5.9): no role_arn
    // and no External_Id (plain or encrypted).
    if (result.ok) {
      expect(Object.keys(result.account).sort()).toEqual([
        "alias",
        "displayCurrency",
        "id",
        "maskedAccountId",
        "timezone",
      ]);
      expect(result.account.maskedAccountId).toBe(MASKED_ACCOUNT_ID);
      const view = JSON.stringify(result.account);
      expect(view).not.toContain(VALID_ROLE_ARN);
      expect(view).not.toContain(VALID_EXTERNAL_ID);
      expect(view).not.toContain("enc:");
    }
  });

  it("rejects invalid input before any store (no db access, no encryption)", async () => {
    signInAs(USER_ID);
    const { db, state } = createFakeDb();
    getDbMock.mockReturnValue(db);

    const result = await createConnectedAccount({
      alias: "   ", // blank after trim
      roleArn: "not-an-arn",
      externalId: "short", // < 16 chars
    });

    expect(result.ok).toBe(false);
    expect(getDbMock).not.toHaveBeenCalled();
    expect(encryptSecretMock).not.toHaveBeenCalled();
    expect(state.insertCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Req 5.5 — setActiveAccount upserts for an owned account, rejects non-owned
// ---------------------------------------------------------------------------

describe("setActiveAccount — active-selection transitions (Req 5.5)", () => {
  it("upserts the active selection for an owned account", async () => {
    signInAs(USER_ID);
    const { db, state } = createFakeDb({
      selects: [{ table: connectedAccounts, rows: [{ id: ACCOUNT_ID }] }],
    });
    getDbMock.mockReturnValue(db);

    const result = await setActiveAccount(ACCOUNT_ID);

    expect(result.ok).toBe(true);
    // Ownership was verified scoped to the signed-in user.
    expect(eqSpy).toHaveBeenCalledWith(connectedAccounts.id, ACCOUNT_ID);
    expect(eqSpy).toHaveBeenCalledWith(connectedAccounts.userId, USER_ID);
    // The selection is upserted into active_account (persisted per user).
    expect(state.insertCalls).toHaveLength(1);
    const upsert = state.insertCalls[0];
    expect(upsert.table).toBe(activeAccount);
    expect(upsert.values?.userId).toBe(USER_ID);
    expect(upsert.values?.connectedAccountId).toBe(ACCOUNT_ID);
    expect(upsert.onConflict).toBeDefined();
  });

  it("rejects a non-owned account and changes no selection", async () => {
    signInAs(USER_ID);
    const { db, state } = createFakeDb({
      selects: [{ table: connectedAccounts, rows: [] }], // ownership lookup misses
    });
    getDbMock.mockReturnValue(db);

    const result = await setActiveAccount(OTHER_ACCOUNT_ID);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/not found/i);
    // No upsert happened.
    expect(db.insert).not.toHaveBeenCalled();
    expect(state.insertCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Req 5.6, 5.7, 5.8 — delete flows and active-selection clearing
// ---------------------------------------------------------------------------

describe("deleteConnectedAccount — CRUD + active clear (Req 5.6, 5.7, 5.8)", () => {
  it("deletes an owned account and clears the active selection that pointed at it (Req 5.6, 5.7)", async () => {
    signInAs(USER_ID);
    const { db, state } = createFakeDb({
      selects: [{ table: connectedAccounts, rows: [{ id: ACCOUNT_ID }] }],
    });
    getDbMock.mockReturnValue(db);

    const result = await deleteConnectedAccount(ACCOUNT_ID);

    expect(result.ok).toBe(true);
    expect(state.transactionRan).toBe(true);

    // The active-account selection is cleared (set null) for this user (Req 5.7).
    const clear = state.updateCalls.find((u) => u.table === activeAccount);
    expect(clear).toBeDefined();
    expect(clear?.set).toEqual({ connectedAccountId: null });

    // The connected_accounts row itself is deleted (Req 5.6).
    const del = state.deleteCalls.find((d) => d.table === connectedAccounts);
    expect(del).toBeDefined();

    // Both the clear and delete are scoped to the signed-in user (ownership).
    expect(eqSpy).toHaveBeenCalledWith(connectedAccounts.userId, USER_ID);
    expect(eqSpy).toHaveBeenCalledWith(activeAccount.userId, USER_ID);
  });

  it("rejects a non-owned/missing account without deleting anything", async () => {
    signInAs(USER_ID);
    const { db, state } = createFakeDb({
      selects: [{ table: connectedAccounts, rows: [] }], // ownership gate fails
    });
    getDbMock.mockReturnValue(db);

    const result = await deleteConnectedAccount(OTHER_ACCOUNT_ID);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/not found/i);
    expect(state.deleteCalls).toHaveLength(0);
  });

  it("returns an error and does not claim success when deletion fails (Req 5.8)", async () => {
    signInAs(USER_ID);
    const { db } = createFakeDb({
      selects: [{ table: connectedAccounts, rows: [{ id: ACCOUNT_ID }] }],
      throwOnDelete: true, // the row deletion fails at the DB layer
    });
    getDbMock.mockReturnValue(db);

    const result = await deleteConnectedAccount(ACCOUNT_ID);

    // The row is retained (delete failed) and the caller is told it did not
    // complete — never a false success (Req 5.8).
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/could not remove/i);
  });

  it("rejects an unauthenticated caller without touching the database", async () => {
    signInAs(null);
    const { db } = createFakeDb();
    getDbMock.mockReturnValue(db);

    const result = await deleteConnectedAccount(ACCOUNT_ID);

    expect(result.ok).toBe(false);
    expect(getDbMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Req 5.4 — listConnectedAccounts is user-scoped; [] for an account-less user
// ---------------------------------------------------------------------------

describe("listConnectedAccounts — user-scoped views + empty state (Req 5.4)", () => {
  it("returns secret-free views scoped to the signed-in user", async () => {
    signInAs(USER_ID);
    const { db } = createFakeDb({
      selects: [
        {
          table: connectedAccounts,
          rows: [
            {
              id: ACCOUNT_ID,
              userId: USER_ID,
              alias: "Prod",
              roleArn: VALID_ROLE_ARN,
              externalIdEnc: `enc:${VALID_EXTERNAL_ID}`,
              awsAccountId: AWS_ACCOUNT_ID,
              displayCurrency: "IDR",
              timezone: "Asia/Jakarta",
            },
          ],
        },
      ],
    });
    getDbMock.mockReturnValue(db);

    const result = await listConnectedAccounts();

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: ACCOUNT_ID,
      alias: "Prod",
      maskedAccountId: MASKED_ACCOUNT_ID,
      displayCurrency: "IDR",
      timezone: "Asia/Jakarta",
    });
    // Scoped to the signed-in user; no secrets in the projection.
    expect(eqSpy).toHaveBeenCalledWith(connectedAccounts.userId, USER_ID);
    const json = JSON.stringify(result);
    expect(json).not.toContain(VALID_ROLE_ARN);
    expect(json).not.toContain(VALID_EXTERNAL_ID);
    expect(json).not.toContain("enc:");
  });

  it("returns [] for a user with no connected accounts (empty state)", async () => {
    signInAs(USER_ID);
    const { db } = createFakeDb({
      selects: [{ table: connectedAccounts, rows: [] }],
    });
    getDbMock.mockReturnValue(db);

    expect(await listConnectedAccounts()).toEqual([]);
  });

  it("returns [] for an unauthenticated caller without touching the database", async () => {
    signInAs(null);
    const { db } = createFakeDb();
    getDbMock.mockReturnValue(db);

    expect(await listConnectedAccounts()).toEqual([]);
    expect(getDbMock).not.toHaveBeenCalled();
  });
});
