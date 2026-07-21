/**
 * Pure connected-account count-bound rule (Req 5.1, 5.2).
 *
 * This module is intentionally free of `"use server"` and of any server-only
 * dependency (auth / db / crypto) so the count-bound decision can be imported
 * and property-tested in isolation. The real server action
 * (`lib/actions/accounts.ts#createConnectedAccount`) reuses {@link canAddConnectedAccount}
 * for its guard, so the test exercises the SAME logic that runs in production.
 */

/** Inclusive per-user connected-account bound (Req 5.1, 5.2). */
export const MAX_CONNECTED_ACCOUNTS = 10;

/**
 * Decide whether another connected account may be stored given how many the
 * user already holds.
 *
 * A user may store between 1 and {@link MAX_CONNECTED_ACCOUNTS} accounts
 * inclusive: storing a new account is permitted if and only if the current
 * count is strictly below the maximum (i.e. `currentCount` in `[0, 9]`). When
 * the user already holds {@link MAX_CONNECTED_ACCOUNTS} (10) or more, the store
 * is rejected and existing accounts remain unchanged (Req 5.1, 5.2).
 */
export function canAddConnectedAccount(currentCount: number): boolean {
  return currentCount < MAX_CONNECTED_ACCOUNTS;
}
