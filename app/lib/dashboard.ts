import "server-only";

import { and, asc, eq } from "drizzle-orm";

import { assumeReadOnlyRole } from "@/lib/aws/sts";
import { getCostAndUsage } from "@/lib/aws/cost-explorer";
import type { CeTimePeriod } from "@/lib/aws/cost-explorer";
import { decryptSecret } from "@/lib/crypto";
import { getDb } from "@/lib/db";
import { activeAccount, connectedAccounts } from "@/lib/db/schema";

/**
 * Server-only dashboard reads (Req 12).
 *
 * The dashboard's spend overview needs to query Cost Explorer directly with a
 * customer account's assumed read-only role. That requires the account's
 * `role_arn` + decrypted `external_id` — both SECRETS that live only in the full
 * `connected_accounts` row and must never cross the browser boundary. So this
 * module (marked `server-only`) is the single place that:
 *   1. loads the full account row (ownership-scoped by user),
 *   2. decrypts the External_Id,
 *   3. assumes the read-only role,
 *   4. runs a current-month-to-date `GetCostAndUsage`,
 * all within a hard 10-second budget (Req 12.2, 12.6).
 *
 * Callers (the dashboard route) only ever receive a redacted
 * {@link CurrentMonthSpend}: a numeric total + currency label on success, or a
 * bare `{ ok: false }` on any failure/timeout. No secret, ARN, or internal error
 * detail is ever returned.
 *
 * ### Currency / FX assumption
 * Cost Explorer returns amounts in the payer account's billing currency (in
 * practice USD). A full FX conversion into each account's configured display
 * currency is out of scope for this task, so we present the numeric total from
 * Cost Explorer as-is and label it with the account's `displayCurrency`. The
 * value is therefore a faithful CE total shown with the account's currency
 * label, not a converted amount.
 */

/** The dashboard spend query must complete within 10 seconds (Req 12.2, 12.6). */
export const DASHBOARD_SPEND_TIMEOUT_MS = 10_000;

/** Cost metric summed for the month-to-date total. */
const SPEND_METRIC = "UnblendedCost";

/**
 * Redacted result of {@link getCurrentMonthSpend}. On success carries the
 * month-to-date `total` (a number) and the account's `currency` label; on any
 * failure/timeout it is a bare `{ ok: false }` with nothing else (Req 12.6).
 */
export type CurrentMonthSpend =
  | { ok: true; total: number; currency: string }
  | { ok: false };

/**
 * Compute the inclusive-start / exclusive-end Cost Explorer window covering the
 * current calendar month up to (and including) today, in UTC. `start` is the
 * first day of the current month; `end` is tomorrow (exclusive), so today's
 * partial spend is included — i.e. month-to-date (Req 12.2).
 */
export function currentMonthToDateWindowUtc(now: Date = new Date()): CeTimePeriod {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  );
  // Exclusive end = tomorrow, so the range includes all of today so far.
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
  return { start: toUtcDateString(start), end: toUtcDateString(end) };
}

/** Format a `Date` as `YYYY-MM-DD` in UTC. */
function toUtcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Resolve the active connected account id for a user, applying the Req 12.1
 * selection rule: the most recently selected account, defaulting to the FIRST
 * connected account (ordered by creation) when none has been selected. Returns
 * `null` when the user has zero connected accounts.
 */
export async function resolveActiveAccountId(
  userId: string,
): Promise<string | null> {
  const db = getDb();

  // Most recent explicit selection, if any.
  const [selected] = await db
    .select({ id: activeAccount.connectedAccountId })
    .from(activeAccount)
    .where(eq(activeAccount.userId, userId))
    .limit(1);

  if (selected?.id != null) {
    return selected.id;
  }

  // Default to the first connected account (Req 12.1).
  const [first] = await db
    .select({ id: connectedAccounts.id })
    .from(connectedAccounts)
    .where(eq(connectedAccounts.userId, userId))
    .orderBy(asc(connectedAccounts.createdAt), asc(connectedAccounts.id))
    .limit(1);

  return first?.id ?? null;
}

/**
 * Query Cost Explorer for the given user's connected account and return the
 * current-month-to-date total spend, expressed with the account's configured
 * display currency (Req 12.1, 12.2).
 *
 * `activeAccountId` is scoped by `userId` so a caller can only ever read an
 * account it owns. The whole assume-role + query is bounded by
 * {@link DASHBOARD_SPEND_TIMEOUT_MS}; a timeout or any failure resolves to the
 * redacted `{ ok: false }` (Req 12.6). This function never throws to its caller
 * and never surfaces secrets.
 */
export async function getCurrentMonthSpend(
  activeAccountId: string,
  userId: string,
): Promise<CurrentMonthSpend> {
  if (
    typeof activeAccountId !== "string" ||
    activeAccountId.length === 0 ||
    typeof userId !== "string" ||
    userId.length === 0
  ) {
    return { ok: false };
  }

  return withTimeout(
    runCurrentMonthSpend(activeAccountId, userId),
    DASHBOARD_SPEND_TIMEOUT_MS,
    { ok: false },
  );
}

/** Inner query flow (guarded by the timeout in {@link getCurrentMonthSpend}). */
async function runCurrentMonthSpend(
  activeAccountId: string,
  userId: string,
): Promise<CurrentMonthSpend> {
  try {
    const db = getDb();

    // Load the FULL account row (secrets included) — ownership-scoped so a user
    // can only read their own account.
    const [account] = await db
      .select()
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.id, activeAccountId),
          eq(connectedAccounts.userId, userId),
        ),
      )
      .limit(1);

    if (account === undefined) {
      return { ok: false };
    }

    const externalId = decryptSecret(account.externalIdEnc);
    const creds = await assumeReadOnlyRole(account.roleArn, externalId);

    const result = await getCostAndUsage(creds, {
      timePeriod: currentMonthToDateWindowUtc(),
      granularity: "MONTHLY",
      metrics: [SPEND_METRIC],
    });

    const total = sumMetric(result.resultsByTime, SPEND_METRIC);

    return { ok: true, total, currency: account.displayCurrency };
  } catch {
    // Any failure (decrypt, assume-role, CE query) is redacted to a bare
    // failure — never leak the underlying error or any secret (Req 12.6).
    return { ok: false };
  }
}

/**
 * Sum a single metric's amount across all returned time periods. A month-to-date
 * MONTHLY query typically returns one period, but summing is robust to any range
 * splitting. Non-numeric amounts are treated as zero.
 */
function sumMetric(
  resultsByTime: { total: Record<string, { amount: string }> }[],
  metric: string,
): number {
  let total = 0;
  for (const period of resultsByTime) {
    const raw = period.total[metric]?.amount;
    const value = raw === undefined ? Number.NaN : Number.parseFloat(raw);
    if (Number.isFinite(value)) {
      total += value;
    }
  }
  return total;
}

/**
 * Resolve with `promise` if it settles within `ms`, otherwise resolve with
 * `onTimeout`. The timer is always cleared so the process does not hang.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
