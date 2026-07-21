// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

import { activeAccount, connectedAccounts } from "@/lib/db/schema";

/**
 * Integration tests for the dashboard spend flow — the `GET /api/dashboard/spend`
 * route wired through the server-only `@/lib/dashboard` reads (Req 12.1, 12.2,
 * 12.3, 12.5, 12.6).
 *
 * ## Scope & environment
 *
 * These run in the **node** environment (see the `@vitest-environment node`
 * docblock above): the code under test is server-side (an App Router route + a
 * `server-only` lib that drives STS + Cost Explorer), so there is deliberately
 * NO DOM rendering here. The visual loading state (Req 12.3) and the retry
 * button live in the client `SpendOverview` component and are covered by a
 * sibling rendering test; at THIS layer we assert the retry *contract* — the
 * route is idempotently re-callable so a retry after a failure can succeed
 * (see the retry test).
 *
 * ## What is REAL vs. FAKED
 *
 * - **REAL:** the route handler (`GET`) and the whole `@/lib/dashboard` module
 *   under test — `resolveActiveAccountId` (active-selection rule, Req 12.1),
 *   `getCurrentMonthSpend` (load row → decrypt → assume role → CE query, all
 *   under a 10s budget, Req 12.2/12.6), the `withTimeout` race, and
 *   `currentMonthToDateWindowUtc` (the CE query window).
 * - **FAKED:** every side-effecting boundary the lib imports — `@/lib/auth`
 *   (`auth`, controls the signed-in user), `@/lib/db` (`getDb`, a programmable
 *   in-memory query builder), `@/lib/crypto` (`decryptSecret`, a recognizable
 *   transform), `@/lib/aws/sts` (`assumeReadOnlyRole`) and
 *   `@/lib/aws/cost-explorer` (`getCostAndUsage`) so no real AWS/DB/network is
 *   ever touched (hermetic).
 */

// Mocked boundaries (hoisted so `vi.mock` factories can reference them).
const {
  authMock,
  getDbMock,
  decryptSecretMock,
  assumeReadOnlyRoleMock,
  getCostAndUsageMock,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  getDbMock: vi.fn(),
  decryptSecretMock: vi.fn(),
  assumeReadOnlyRoleMock: vi.fn(),
  getCostAndUsageMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/lib/db", () => ({ getDb: getDbMock }));
vi.mock("@/lib/crypto", () => ({
  decryptSecret: decryptSecretMock,
  encryptSecret: vi.fn(),
}));
vi.mock("@/lib/aws/sts", () => ({ assumeReadOnlyRole: assumeReadOnlyRoleMock }));
vi.mock("@/lib/aws/cost-explorer", () => ({ getCostAndUsage: getCostAndUsageMock }));

import { GET } from "./route";
import {
  DASHBOARD_SPEND_TIMEOUT_MS,
  currentMonthToDateWindowUtc,
} from "@/lib/dashboard";
import type { CeResult } from "@/lib/aws/cost-explorer";

// ---------------------------------------------------------------------------
// Programmable in-memory Drizzle query-builder fake
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

/**
 * Build a fake `db` whose `select().from(table)…` chains resolve to the rows
 * programmed per table. Every chain form the dashboard uses is thenable at any
 * point after `.from()`, so both `await …where().limit(1)` and
 * `…where().orderBy().limit(1)` resolve to the table's rows.
 */
function createFakeDb(selects: Array<{ table: unknown; rows: Row[] }> = []): {
  select: ReturnType<typeof vi.fn>;
} {
  const rowsByTable = new Map<unknown, Row[]>();
  for (const s of selects) rowsByTable.set(s.table, s.rows);

  function makeSelectBuilder() {
    let table: unknown;
    const rows = () => Promise.resolve(rowsByTable.get(table) ?? []);
    const builder = {
      from(t: unknown) {
        table = t;
        return builder;
      },
      where() {
        return builder;
      },
      orderBy() {
        return builder;
      },
      limit() {
        return builder;
      },
      then<TResult1, TResult2>(
        onFulfilled?:
          | ((value: Row[]) => TResult1 | PromiseLike<TResult1>)
          | null,
        onRejected?:
          | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
          | null,
      ) {
        return rows().then(onFulfilled, onRejected);
      },
    };
    return builder;
  }

  return { select: vi.fn(() => makeSelectBuilder()) };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_ID = "user_owner_1";
const ACCOUNT_ID = "acct_1";
const DISPLAY_CURRENCY = "IDR";

const ROLE_ARN = "arn:aws:iam::123456789012:role/CloudBillAnalystReadOnly";
const EXTERNAL_ID_PLAINTEXT = "abcdefghijklmnop1234";
/** The encrypted-at-rest External_Id as it would live in the row. */
const EXTERNAL_ID_ENC = `enc:${EXTERNAL_ID_PLAINTEXT}`;

const FAKE_CREDS = {
  accessKeyId: "ASIA_FAKE",
  secretAccessKey: "fake-secret",
  sessionToken: "fake-token",
};

/** Full connected-account row (secrets included) as loaded by the lib. */
const ACCOUNT_ROW: Row = {
  id: ACCOUNT_ID,
  userId: USER_ID,
  alias: "Prod",
  roleArn: ROLE_ARN,
  externalIdEnc: EXTERNAL_ID_ENC,
  awsAccountId: "123456789012",
  displayCurrency: DISPLAY_CURRENCY,
  timezone: "Asia/Jakarta",
};

/** A successful CE month-to-date result: one MONTHLY period totalling 123.45. */
const CE_RESULT: CeResult = {
  resultsByTime: [
    {
      timePeriod: currentMonthToDateWindowUtc(),
      total: { UnblendedCost: { amount: "123.45", unit: "USD" } },
      groups: [],
    },
  ],
};
const CE_TOTAL = 123.45;

/** Authenticate as the given user (or unauthenticate with `null`). */
function signInAs(userId: string | null): void {
  authMock.mockResolvedValue(userId === null ? null : { user: { id: userId } });
}

/**
 * Program the fake db so the user has ONE active account (short-circuits the
 * active-selection lookup to `ACCOUNT_ID`) and its full row is loadable.
 */
function withActiveAccount(): void {
  getDbMock.mockReturnValue(
    createFakeDb([
      { table: activeAccount, rows: [{ id: ACCOUNT_ID }] },
      { table: connectedAccounts, rows: [ACCOUNT_ROW] },
    ]),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // A recognizable transform: a returned value equal to the ciphertext would
  // prove decryption was skipped.
  decryptSecretMock.mockImplementation((enc: string) =>
    enc.startsWith("enc:") ? enc.slice(4) : enc,
  );
});

// ---------------------------------------------------------------------------
// 1. Success (Req 12.1, 12.2)
// ---------------------------------------------------------------------------

describe("GET /api/dashboard/spend — success (Req 12.1, 12.2)", () => {
  it("returns the month-to-date total in the account's currency and queries CE with the current-month window", async () => {
    signInAs(USER_ID);
    withActiveAccount();
    assumeReadOnlyRoleMock.mockResolvedValue(FAKE_CREDS);
    getCostAndUsageMock.mockResolvedValue(CE_RESULT);

    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: "ok",
      total: CE_TOTAL,
      currency: DISPLAY_CURRENCY,
    });

    // The assumed-role secrets flow ran: the encrypted External_Id was decrypted
    // and used to assume the account's read-only role before any CE call.
    expect(decryptSecretMock).toHaveBeenCalledWith(EXTERNAL_ID_ENC);
    expect(assumeReadOnlyRoleMock).toHaveBeenCalledWith(
      ROLE_ARN,
      EXTERNAL_ID_PLAINTEXT,
    );

    // CE was queried once with the current-month-to-date window at MONTHLY
    // granularity for the UnblendedCost metric (Req 12.2).
    expect(getCostAndUsageMock).toHaveBeenCalledTimes(1);
    const [creds, input] = getCostAndUsageMock.mock.calls[0];
    expect(creds).toEqual(FAKE_CREDS);
    expect(input.granularity).toBe("MONTHLY");
    expect(input.metrics).toContain("UnblendedCost");
    expect(input.timePeriod).toEqual(currentMonthToDateWindowUtc());
  });

  it("rejects an unauthenticated caller with 401 and never queries CE", async () => {
    signInAs(null);
    getDbMock.mockReturnValue(createFakeDb());

    const res = await GET();
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ status: "error" });

    // No account resolution, no assume-role, no CE query on the unauth path.
    expect(getDbMock).not.toHaveBeenCalled();
    expect(assumeReadOnlyRoleMock).not.toHaveBeenCalled();
    expect(getCostAndUsageMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. Zero-account (Req 12.5)
// ---------------------------------------------------------------------------

describe("GET /api/dashboard/spend — zero connected accounts (Req 12.5)", () => {
  it("returns { status: 'no-accounts' } and NEVER queries Cost Explorer", async () => {
    signInAs(USER_ID);
    // No active selection AND no connected accounts → resolveActiveAccountId=null.
    getDbMock.mockReturnValue(
      createFakeDb([
        { table: activeAccount, rows: [] },
        { table: connectedAccounts, rows: [] },
      ]),
    );

    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "no-accounts" });

    // Req 12.5: the CE path (assume-role + query) is skipped entirely.
    expect(assumeReadOnlyRoleMock).not.toHaveBeenCalled();
    expect(getCostAndUsageMock).not.toHaveBeenCalled();
    expect(decryptSecretMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. Failure (Req 12.6)
// ---------------------------------------------------------------------------

describe("GET /api/dashboard/spend — query failure (Req 12.6)", () => {
  it("returns a redacted { status: 'error' } when the CE query rejects, leaking no secret", async () => {
    signInAs(USER_ID);
    withActiveAccount();
    assumeReadOnlyRoleMock.mockResolvedValue(FAKE_CREDS);
    getCostAndUsageMock.mockRejectedValue(new Error("AccessDenied: ce:GetCostAndUsage"));

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "error" });

    // The redacted error body carries no secret material (Req 12.6).
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(ROLE_ARN);
    expect(serialized).not.toContain(EXTERNAL_ID_PLAINTEXT);
    expect(serialized).not.toContain(EXTERNAL_ID_ENC);
    expect(serialized).not.toContain(FAKE_CREDS.secretAccessKey);
  });

  it("returns { status: 'error' } when assume-role rejects", async () => {
    signInAs(USER_ID);
    withActiveAccount();
    assumeReadOnlyRoleMock.mockRejectedValue(new Error("AssumeRole failed"));

    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "error" });

    // We failed at assume-role, so the CE query never ran.
    expect(getCostAndUsageMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. Timeout (Req 12.6)
// ---------------------------------------------------------------------------

describe("GET /api/dashboard/spend — timeout (Req 12.6)", () => {
  it("returns { status: 'error' } when the CE query hangs past the 10s budget", async () => {
    signInAs(USER_ID);
    withActiveAccount();
    assumeReadOnlyRoleMock.mockResolvedValue(FAKE_CREDS);
    // The CE query never settles; only the timeout can resolve the race.
    getCostAndUsageMock.mockReturnValue(new Promise<CeResult>(() => {}));

    vi.useFakeTimers();
    try {
      const pending = GET();
      // Advance past the hard budget so `withTimeout` resolves `{ ok: false }`
      // WITHOUT actually waiting 10 real seconds.
      await vi.advanceTimersByTimeAsync(DASHBOARD_SPEND_TIMEOUT_MS);
      const res = await pending;

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ status: "error" });
      expect(getCostAndUsageMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Loading / retry contract (Req 12.3, 12.6)
// ---------------------------------------------------------------------------

describe("GET /api/dashboard/spend — retry contract (Req 12.3, 12.6)", () => {
  it("is idempotently re-callable: a second GET after a failure can succeed", async () => {
    // NOTE: the visual loading state (Req 12.3) and the retry button live in the
    // client `SpendOverview` component and are exercised by a sibling rendering
    // test. Here we assert the ROUTE-LEVEL retry contract that backs that button:
    // the query is re-runnable, so a retry after an error can return "ok".
    signInAs(USER_ID);
    withActiveAccount();
    assumeReadOnlyRoleMock.mockResolvedValue(FAKE_CREDS);

    // First attempt fails (CE rejects) → the client would show the error + retry.
    getCostAndUsageMock.mockRejectedValueOnce(new Error("transient CE failure"));
    const first = await GET();
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({ status: "error" });

    // Retry: CE now succeeds → the same route returns a fresh "ok" result.
    getCostAndUsageMock.mockResolvedValueOnce(CE_RESULT);
    const second = await GET();
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual({
      status: "ok",
      total: CE_TOTAL,
      currency: DISPLAY_CURRENCY,
    });

    // Two independent CE attempts were made (the query is re-runnable).
    expect(getCostAndUsageMock).toHaveBeenCalledTimes(2);
  });
});
