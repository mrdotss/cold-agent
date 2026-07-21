import "server-only";

import { randomUUID } from "node:crypto";

import { and, eq, gte } from "drizzle-orm";

import { getDb } from "@/lib/db";
import { loginAttempts } from "@/lib/db/schema";

/**
 * Login rate limiting (Req 2.9, Property 5).
 *
 * Every login attempt for a normalized email is recorded in `login_attempts`
 * with a success flag and a timestamp. An email is considered "locked out" at a
 * given instant when at least {@link FAILED_ATTEMPT_THRESHOLD} FAILED attempts
 * fall within the trailing {@link LOCKOUT_WINDOW_MINUTES}-minute window
 * `[now - 15min, now]`.
 *
 * Because the lockout is defined purely by the trailing window, it is
 * self-expiring: once the 5th-oldest failure ages out of the window the count
 * drops below the threshold, so a locked email automatically unlocks 15 minutes
 * after its most recent qualifying failure — i.e. "locked for 15 minutes"
 * (Req 2.9) without any separate timer or stored lock state.
 *
 * `server-only` keeps this module (and its DB access) out of any client bundle.
 */

/** Number of failed attempts within the window that triggers a lockout. */
export const FAILED_ATTEMPT_THRESHOLD = 5;

/** Trailing window (and resulting lockout duration), in minutes. */
export const LOCKOUT_WINDOW_MINUTES = 15;

/** Trailing window length, in milliseconds. */
export const LOCKOUT_WINDOW_MS = LOCKOUT_WINDOW_MINUTES * 60 * 1000;

/**
 * Pure lockout predicate (Property 5). Given the timestamps of FAILED login
 * attempts for a single normalized email and the current instant `now`, returns
 * `true` if and only if at least {@link FAILED_ATTEMPT_THRESHOLD} of those
 * failures fall within the inclusive trailing window `[now - 15min, now]`.
 *
 * Kept free of any I/O so it can be exercised directly across arbitrary
 * timestamp sequences; {@link isLockedOut} layers the database read on top.
 */
export function isLockedOutFromFailures(
  failureTimestamps: readonly Date[],
  now: Date,
): boolean {
  const nowMs = now.getTime();
  const windowStartMs = nowMs - LOCKOUT_WINDOW_MS;

  let failuresInWindow = 0;
  for (const timestamp of failureTimestamps) {
    const ms = timestamp.getTime();
    if (ms >= windowStartMs && ms <= nowMs) {
      failuresInWindow += 1;
      if (failuresInWindow >= FAILED_ATTEMPT_THRESHOLD) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Record a single login attempt for `emailNormalized` (Req 2.9). `success`
 * distinguishes a completed sign-in from a rejected one; only failures count
 * toward the lockout threshold, but successes are recorded too for a complete
 * audit trail.
 *
 * @param emailNormalized the normalized (trimmed + lowercased) email.
 * @param success         whether the attempt authenticated successfully.
 * @param now             attempt timestamp (defaults to the current instant).
 */
export async function recordLoginAttempt(
  emailNormalized: string,
  success: boolean,
  now: Date = new Date(),
): Promise<void> {
  const db = getDb();
  await db.insert(loginAttempts).values({
    id: randomUUID(),
    emailNormalized,
    success,
    createdAt: now,
  });
}

/**
 * Whether `emailNormalized` is currently locked out at instant `now` (Req 2.9,
 * Property 5). Reads the failed attempts for that email within the trailing
 * window from the database, then applies {@link isLockedOutFromFailures} as the
 * authoritative inclusive-window count.
 *
 * The `gte(windowStart)` filter is only a query-side optimization; the pure
 * predicate re-checks both bounds so the window semantics live in exactly one
 * place.
 */
export async function isLockedOut(
  emailNormalized: string,
  now: Date,
): Promise<boolean> {
  const windowStart = new Date(now.getTime() - LOCKOUT_WINDOW_MS);
  const db = getDb();
  const rows = await db
    .select({ createdAt: loginAttempts.createdAt })
    .from(loginAttempts)
    .where(
      and(
        eq(loginAttempts.emailNormalized, emailNormalized),
        eq(loginAttempts.success, false),
        gte(loginAttempts.createdAt, windowStart),
      ),
    );

  return isLockedOutFromFailures(
    rows.map((row) => row.createdAt),
    now,
  );
}
