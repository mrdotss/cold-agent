import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Auth.js's framework packages (`next-auth`, its providers, and JWT helpers)
// import `next/server`, which is not loadable under Vitest/jsdom. We only need
// the app's own `SESSION_MAX_AGE_SECONDS` constant from `@/lib/auth`, so we
// stub those framework modules to no-ops. This lets `@/lib/auth` evaluate and
// expose its REAL constant (defined in the module body, not derived from
// next-auth) without pulling in the Next.js server runtime. `NextAuth(...)` is
// invoked at import with our stub, so the config factory never runs and no env
// read or adapter/DB access is triggered.
vi.mock("next-auth", () => ({
  default: vi.fn(() => ({
    handlers: {},
    auth: vi.fn(),
    signIn: vi.fn(),
    signOut: vi.fn(),
  })),
}));
vi.mock("next-auth/jwt", () => ({ encode: vi.fn() }));
vi.mock("next-auth/providers/credentials", () => ({ default: vi.fn(() => ({})) }));
vi.mock("@auth/drizzle-adapter", () => ({ DrizzleAdapter: vi.fn(() => ({})) }));

import { SESSION_MAX_AGE_SECONDS } from "@/lib/auth";

/**
 * Integration tests for the database-backed **session lifecycle** contract that
 * `lib/auth.ts` relies on (Req 1.6, 2.1, 2.5, 2.7, 2.8).
 *
 * ## What is REAL vs. FAKED
 *
 * - **REAL:** `SESSION_MAX_AGE_SECONDS` is imported from the actual `@/lib/auth`
 *   module. The 30-day lifetime math asserted below is pinned to the exported
 *   constant, so if the app ever changes its session max-age these tests move
 *   with it (or fail loudly if the 30-day requirement regresses). Importing the
 *   constant does not require a live DB or `AUTH_SECRET`: `lib/auth.ts` defers
 *   `requireEnv("AUTH_SECRET")`, Drizzle-adapter creation, and DB access to
 *   request time via a config factory, so module import is side-effect free for
 *   the purposes of reading the constant.
 *
 * - **FAKED:** the adapter's session store and the request clock. Driving
 *   Auth.js's full internal session flow (cookie mint -> `jwt.encode` ->
 *   adapter -> `getSessionAndUser`) end-to-end in a unit test would require a
 *   live Postgres and a real HTTP request pipeline. Instead we implement a small
 *   in-memory fake of the four adapter session methods the credentials +
 *   database-session path actually uses (`createSession`, `getSessionAndUser`,
 *   `updateSession`, `deleteSession`) and a controllable clock
 *   (`vi.useFakeTimers()` / `vi.setSystemTime()`).
 *
 * The tests encode and lock in the design's session invariants:
 *  - creation persists a row bound to the correct `userId` with `expires`
 *    exactly `now + SESSION_MAX_AGE_SECONDS` (Req 1.6, 2.1);
 *  - a not-yet-expired row resolves as authenticated across "page loads"
 *    (Req 2.7);
 *  - a row past its `expires` is treated as unauthenticated and its row is
 *    removed (Req 2.8);
 *  - sign-out deletes the row so later lookups return null (Req 2.5).
 */

/** A persisted `sessions` row (matches the app's `sessions` table shape). */
interface FakeSessionRow {
  sessionToken: string;
  userId: string;
  expires: Date;
}

/** A minimal user row as returned alongside a resolved session. */
interface FakeUserRow {
  id: string;
  email: string;
}

/**
 * The subset of the Auth.js adapter surface the credentials + database-session
 * path uses. Mirrors `@auth/drizzle-adapter`'s session methods.
 */
interface FakeSessionAdapter {
  createSession(row: FakeSessionRow): Promise<FakeSessionRow>;
  getSessionAndUser(
    token: string,
  ): Promise<{ session: FakeSessionRow; user: FakeUserRow } | null>;
  updateSession(
    partial: Partial<FakeSessionRow> & { sessionToken: string },
  ): Promise<FakeSessionRow | null>;
  deleteSession(token: string): Promise<void>;
  /** Test-only introspection: how many rows are currently stored. */
  readonly rowCount: number;
}

/**
 * FAKE in-memory implementation of the adapter session methods. Performs raw
 * storage/lookup only — like the real Drizzle adapter, it does NOT itself apply
 * expiry policy (that is modeled by {@link resolveAuthenticatedUser} below,
 * which mirrors what Auth.js core does at request time).
 */
function createInMemorySessionAdapter(
  seedUsers: readonly FakeUserRow[],
): FakeSessionAdapter {
  const users = new Map(seedUsers.map((u) => [u.id, u] as const));
  const sessions = new Map<string, FakeSessionRow>();

  return {
    async createSession(row) {
      // Store a defensive copy so callers can't mutate the persisted row.
      sessions.set(row.sessionToken, { ...row, expires: new Date(row.expires) });
      return row;
    },
    async getSessionAndUser(token) {
      const session = sessions.get(token);
      if (session === undefined) {
        return null;
      }
      const user = users.get(session.userId);
      if (user === undefined) {
        return null;
      }
      return {
        session: { ...session, expires: new Date(session.expires) },
        user: { ...user },
      };
    },
    async updateSession(partial) {
      const existing = sessions.get(partial.sessionToken);
      if (existing === undefined) {
        return null;
      }
      const updated: FakeSessionRow = { ...existing, ...partial };
      sessions.set(partial.sessionToken, updated);
      return updated;
    },
    async deleteSession(token) {
      sessions.delete(token);
    },
    get rowCount() {
      return sessions.size;
    },
  };
}

/**
 * MODELS the app's `jwt.encode` credentials path from `lib/auth.ts`: mint a
 * token and persist a session row whose `expires` is exactly `now +
 * SESSION_MAX_AGE_SECONDS` (Req 1.6, 2.1). Uses the REAL exported constant and
 * the faked clock (`Date.now()` is controlled by `vi.setSystemTime`).
 */
async function createSessionForUser(
  adapter: FakeSessionAdapter,
  sessionToken: string,
  userId: string,
): Promise<FakeSessionRow> {
  return adapter.createSession({
    sessionToken,
    userId,
    expires: new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000),
  });
}

/**
 * MODELS Auth.js's request-time database-session resolution (the policy layered
 * on top of the raw adapter): look the token up, and if the row has reached its
 * `expires`, treat the request as unauthenticated AND delete the stale row
 * (Req 2.8). A future-dated row resolves to its user (Req 2.7).
 */
async function resolveAuthenticatedUser(
  adapter: FakeSessionAdapter,
  token: string,
): Promise<FakeUserRow | null> {
  const found = await adapter.getSessionAndUser(token);
  if (found === null) {
    return null;
  }
  if (found.session.expires.getTime() <= Date.now()) {
    await adapter.deleteSession(token);
    return null;
  }
  return found.user;
}

const USER: FakeUserRow = { id: "user_abc", email: "owner@example.com" };
const OTHER_USER: FakeUserRow = { id: "user_xyz", email: "other@example.com" };
const FIXED_NOW = new Date("2025-01-01T00:00:00.000Z");

describe("session lifecycle (Req 1.6, 2.1, 2.5, 2.7, 2.8)", () => {
  let adapter: FakeSessionAdapter;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    adapter = createInMemorySessionAdapter([USER, OTHER_USER]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("exports a 30-day maximum session lifetime", () => {
    // Req 2.7 / 2.8: the max lifetime is 30 days. Guards against an accidental
    // change to the exported constant the whole lifecycle depends on.
    expect(SESSION_MAX_AGE_SECONDS).toBe(30 * 24 * 60 * 60);
  });

  it("creation persists a row bound to the user with a 30-day expiry (Req 1.6, 2.1)", async () => {
    const row = await createSessionForUser(adapter, "tok_1", USER.id);

    // Bound to the signing-in user's id (this id is the agent actor_id).
    expect(row.userId).toBe(USER.id);
    expect(row.sessionToken).toBe("tok_1");

    // expires is EXACTLY now + SESSION_MAX_AGE_SECONDS (30-day lifetime).
    const expectedExpiry = FIXED_NOW.getTime() + SESSION_MAX_AGE_SECONDS * 1000;
    expect(row.expires.getTime()).toBe(expectedExpiry);
    expect(row.expires.getTime() - FIXED_NOW.getTime()).toBe(
      30 * 24 * 60 * 60 * 1000,
    );

    // The row is retrievable through the adapter and carries the right user.
    const found = await adapter.getSessionAndUser("tok_1");
    expect(found?.user.id).toBe(USER.id);
    expect(adapter.rowCount).toBe(1);
  });

  it("resolves a not-yet-expired session as authenticated across page loads (Req 2.7)", async () => {
    await createSessionForUser(adapter, "tok_live", USER.id);

    // First "page load": authenticated.
    expect(await resolveAuthenticatedUser(adapter, "tok_live")).toEqual(USER);

    // Advance 29 days (still within the 30-day window) — a later "page load"
    // must remain authenticated without re-prompting for credentials.
    vi.setSystemTime(new Date(FIXED_NOW.getTime() + 29 * 24 * 60 * 60 * 1000));
    expect(await resolveAuthenticatedUser(adapter, "tok_live")).toEqual(USER);

    // The row is untouched for a live session.
    expect(adapter.rowCount).toBe(1);
  });

  it("treats a session past its 30-day lifetime as unauthenticated and deletes the row (Req 2.8)", async () => {
    await createSessionForUser(adapter, "tok_stale", USER.id);
    expect(adapter.rowCount).toBe(1);

    // Advance just past the 30-day maximum lifetime.
    vi.setSystemTime(
      new Date(FIXED_NOW.getTime() + SESSION_MAX_AGE_SECONDS * 1000 + 1000),
    );

    // Expired -> unauthenticated.
    expect(await resolveAuthenticatedUser(adapter, "tok_stale")).toBeNull();

    // The stale row is removed, so a subsequent raw lookup finds nothing.
    expect(adapter.rowCount).toBe(0);
    expect(await adapter.getSessionAndUser("tok_stale")).toBeNull();
  });

  it("treats a session exactly at its expiry boundary as expired (Req 2.8)", async () => {
    await createSessionForUser(adapter, "tok_boundary", USER.id);

    // Exactly at `expires`: the lifetime has been reached, so the session is
    // invalidated (expires <= now).
    vi.setSystemTime(
      new Date(FIXED_NOW.getTime() + SESSION_MAX_AGE_SECONDS * 1000),
    );

    expect(await resolveAuthenticatedUser(adapter, "tok_boundary")).toBeNull();
    expect(adapter.rowCount).toBe(0);
  });

  it("sign-out deletes the session row so later lookups return null (Req 2.5)", async () => {
    await createSessionForUser(adapter, "tok_signout", USER.id);
    expect(await resolveAuthenticatedUser(adapter, "tok_signout")).toEqual(USER);

    // Sign out: with the database strategy, signOut deletes the sessions row.
    await adapter.deleteSession("tok_signout");

    // Subsequent request is unauthenticated and the row is gone.
    expect(await resolveAuthenticatedUser(adapter, "tok_signout")).toBeNull();
    expect(await adapter.getSessionAndUser("tok_signout")).toBeNull();
    expect(adapter.rowCount).toBe(0);
  });

  it("deleting one user's session does not affect another user's session (Req 2.5)", async () => {
    await createSessionForUser(adapter, "tok_a", USER.id);
    await createSessionForUser(adapter, "tok_b", OTHER_USER.id);

    await adapter.deleteSession("tok_a");

    expect(await resolveAuthenticatedUser(adapter, "tok_a")).toBeNull();
    // The unrelated session remains valid and authenticated.
    expect(await resolveAuthenticatedUser(adapter, "tok_b")).toEqual(OTHER_USER);
    expect(adapter.rowCount).toBe(1);
  });

  it("an unknown session token resolves as unauthenticated (Req 2.7)", async () => {
    expect(await resolveAuthenticatedUser(adapter, "does_not_exist")).toBeNull();
  });
});
