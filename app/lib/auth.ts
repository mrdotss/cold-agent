import "server-only";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { cookies } from "next/headers";

import { getDb } from "@/lib/db";
import { sessions, users } from "@/lib/db/schema";
import { verifyPassword } from "@/lib/password";
import { normalizeEmail } from "@/lib/validation";

/**
 * Self-managed, database-backed sessions for the Cloud Bill Analyst web app
 * (Req 1.6, 2.1, 2.5, 2.6, 2.7, 2.8).
 *
 * ## Why not Auth.js
 *
 * Auth.js (NextAuth v5) does NOT support the Credentials provider together with
 * database sessions: signing in with credentials only works under the JWT
 * strategy, and at runtime a credentials + `session.strategy: "database"` config
 * throws `UnsupportedStrategy`. But this app REQUIRES the stored `sessions` row
 * to be the single source of truth so that:
 *  - sign-out can DELETE the row (Req 2.5), and
 *  - reaching the 30-day maximum lifetime invalidates AND deletes the row
 *    (Req 2.8).
 * A stateless JWT satisfies neither. So instead of fighting the framework we
 * manage the session directly on the EXISTING `sessions` table via an HttpOnly
 * cookie.
 *
 * ## How it works
 *
 *  - `createUserSession` mints a random `session_token`, inserts a `sessions`
 *    row with `expires = now + 30 days`, and sets the HttpOnly session cookie
 *    (login / registration path — Req 1.6, 2.1).
 *  - `auth` reads the cookie, joins the `sessions` row to its `users` row, and
 *    returns `{ user: { id, email } }` (the `id` is the application user id =
 *    agent `actor_id`, Req 2.6). A missing row, or one whose `expires <= now`,
 *    resolves as unauthenticated; an expired row is best-effort deleted
 *    (Req 2.7, 2.8).
 *  - `destroyUserSession` deletes the row and clears the cookie (Req 2.5).
 *
 * `server-only` keeps this module (and the DB access it performs) out of any
 * client bundle. It is imported by guarded layouts/pages and route handlers,
 * all of which call `await auth()`.
 */

/** 30-day maximum session lifetime, in seconds (Req 2.7, 2.8). */
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/** Name of the HttpOnly cookie that carries the opaque session token. */
const SESSION_COOKIE = "cba_session";

/** The authenticated principal surfaced to callers. */
export interface AuthUser {
  /** Application user id — also the agent `actor_id` (Req 2.6). */
  id: string;
  email: string;
}

/** Resolved session, or `null` when the request is unauthenticated. */
export type AuthResult = { user: AuthUser } | null;

/**
 * Resolve the current session from the request's session cookie (Req 2.6, 2.7,
 * 2.8).
 *
 * Reads the `cba_session` cookie, looks up the matching `sessions` row joined to
 * its `users` row, and returns `{ user: { id, email } }`. Returns `null` when:
 *  - no cookie is present,
 *  - no row matches the token, or
 *  - the row has reached its `expires` (`expires <= now`) — a session at or past
 *    its 30-day lifetime is treated as unauthenticated (Req 2.8).
 *
 * An expired row is deleted from the database on a best-effort basis. This
 * function NEVER mutates the cookie: `auth()` may run during a server-component
 * render, where cookie writes throw. Clearing the cookie is left to
 * `destroyUserSession` (sign-out).
 */
export async function auth(): Promise<AuthResult> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (token === undefined || token.length === 0) {
    return null;
  }

  const db = getDb();
  const [row] = await db
    .select({
      userId: users.id,
      email: users.email,
      expires: sessions.expires,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.sessionToken, token))
    .limit(1);

  if (row === undefined) {
    return null;
  }

  // A row at or past its expiry is unauthenticated; remove the stale row
  // (best-effort — never let cleanup failure surface as an auth error). We do
  // NOT touch the cookie here (see the doc comment).
  if (row.expires.getTime() <= Date.now()) {
    try {
      await db.delete(sessions).where(eq(sessions.sessionToken, token));
    } catch {
      // Ignore: the session is invalid regardless of whether cleanup succeeded.
    }
    return null;
  }

  return { user: { id: row.userId, email: row.email } };
}

/**
 * Verify submitted credentials without creating a session (Req 2.2).
 *
 * Normalizes the email, looks up the user by `email_normalized`, and verifies
 * the password with argon2. Returns the application user on success, or `null`
 * on any failure (unknown email OR wrong password) so callers can surface a
 * single generic invalid-credentials message that never reveals which field was
 * wrong.
 */
export async function verifyCredentials(
  email: string,
  password: string,
): Promise<AuthUser | null> {
  const normalizedEmail = normalizeEmail(email);
  const db = getDb();
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.emailNormalized, normalizedEmail))
    .limit(1);

  if (user === undefined) {
    return null;
  }

  const passwordOk = await verifyPassword(user.passwordHash, password);
  if (!passwordOk) {
    return null;
  }

  return { id: user.id, email: user.email };
}

/**
 * Create a database-backed session bound to `userId` and set the session cookie
 * (Req 1.6, 2.1, 2.6, 2.7).
 *
 * Mints a random opaque token, inserts a `sessions` row with `expires = now +
 * SESSION_MAX_AGE_SECONDS`, and writes the HttpOnly, SameSite=Lax session
 * cookie (secure in production). Must be called from a server action or route
 * handler, where cookie mutation is permitted.
 */
export async function createUserSession(userId: string): Promise<void> {
  const sessionToken = randomUUID();
  const expires = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);

  const db = getDb();
  await db.insert(sessions).values({ sessionToken, userId, expires });

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

/**
 * Sign the current user out (Req 2.5).
 *
 * Reads the session cookie; if present, DELETEs the matching `sessions` row so
 * the server-side session is destroyed, then clears the cookie. Safe to call
 * when no session exists (no-op). Must be called from a server action or route
 * handler (it mutates the cookie).
 */
export async function destroyUserSession(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;

  if (token !== undefined && token.length > 0) {
    const db = getDb();
    await db.delete(sessions).where(eq(sessions.sessionToken, token));
  }

  cookieStore.delete(SESSION_COOKIE);
}
