import "server-only";

import { and, eq } from "drizzle-orm";

import { assumeReadOnlyRole } from "@/lib/aws/sts";
import { getCostAndUsage } from "@/lib/aws/cost-explorer";
import type {
  CeResultByTime,
  CeTimePeriod,
} from "@/lib/aws/cost-explorer";
import { classifyAnomalies } from "@/lib/anomaly";
import type { Anomaly, ServiceCostSeries } from "@/lib/anomaly";
import { currentMonthToDateWindowUtc } from "@/lib/dashboard";
import { decryptSecret } from "@/lib/crypto";
import { getDb } from "@/lib/db";
import { connectedAccounts } from "@/lib/db/schema";

/**
 * Server-only Anomaly_Detector (Req 13.1, 13.7).
 *
 * Cost-anomaly detection needs the very same secrets as the dashboard spend
 * overview — the active account's `role_arn` + decrypted `external_id` — to
 * assume the customer's read-only role and read Cost Explorer. Those secrets
 * live only in the full `connected_accounts` row and must never cross the
 * browser boundary, so this module is `server-only`: it is the single place
 * that
 *   1. loads the full account row (ownership-scoped by user),
 *   2. decrypts the External_Id and assumes the read-only role,
 *   3. gathers per-service cost series from Cost Explorer, and
 *   4. runs the PURE {@link classifyAnomalies} classifier,
 * all within a hard 10-second budget (Req 13.1).
 *
 * On ANY failure/timeout (decrypt, assume-role, or any Cost Explorer query) it
 * returns ZERO anomalies (Req 13.7) — never a secret, ARN, or internal error
 * detail. The dashboard therefore shows no badge and the chat renders no inline
 * callout for that account when detection cannot complete.
 */

/** The anomaly evaluation must complete within 10 seconds (Req 13.1). */
export const ANOMALY_DETECT_TIMEOUT_MS = 10_000;

/** Cost metric summed per service across every Cost Explorer query. */
const ANOMALY_METRIC = "UnblendedCost";

/**
 * Number of trailing daily buckets fetched for spike detection. The classifier
 * compares the latest day against the average of up to the 7 days preceding it,
 * so 8 buckets (latest + 7 prior) is the minimum window that fully exercises the
 * trailing-7-day baseline.
 */
const TRAILING_DAILY_DAYS = 8;

/** Group Cost Explorer results by the AWS service dimension. */
const SERVICE_GROUP_BY = [{ type: "DIMENSION" as const, key: "SERVICE" }];

/**
 * Detect anomalies for a user's connected account and return them classified
 * (Req 13.1). `activeAccountId` is scoped by `userId`, so a caller can only ever
 * read an account it owns. The whole assume-role + queries + classification is
 * bounded by {@link ANOMALY_DETECT_TIMEOUT_MS}; a timeout or any failure resolves
 * to `[]` (Req 13.7). This function never throws to its caller and never
 * surfaces secrets.
 */
export async function getAccountAnomalies(
  activeAccountId: string,
  userId: string,
): Promise<Anomaly[]> {
  if (
    typeof activeAccountId !== "string" ||
    activeAccountId.length === 0 ||
    typeof userId !== "string" ||
    userId.length === 0
  ) {
    return [];
  }

  return withTimeout(
    runAccountAnomalies(activeAccountId, userId),
    ANOMALY_DETECT_TIMEOUT_MS,
    [],
  );
}

/** Inner flow (guarded by the timeout in {@link getAccountAnomalies}). */
async function runAccountAnomalies(
  activeAccountId: string,
  userId: string,
): Promise<Anomaly[]> {
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
      return [];
    }

    const externalId = decryptSecret(account.externalIdEnc);
    const creds = await assumeReadOnlyRole(account.roleArn, externalId);

    // Three read-only Cost Explorer queries build the per-service series:
    //  - MONTHLY current-month-to-date  -> currentMonthCost per service
    //  - MONTHLY previous full month    -> previousFullMonthCost per service
    //  - DAILY trailing 8 days          -> dailyCosts[] per service (for spikes)
    const [current, previous, daily] = await Promise.all([
      getCostAndUsage(creds, {
        timePeriod: currentMonthToDateWindowUtc(),
        granularity: "MONTHLY",
        metrics: [ANOMALY_METRIC],
        groupBy: SERVICE_GROUP_BY,
      }),
      getCostAndUsage(creds, {
        timePeriod: previousFullMonthWindowUtc(),
        granularity: "MONTHLY",
        metrics: [ANOMALY_METRIC],
        groupBy: SERVICE_GROUP_BY,
      }),
      getCostAndUsage(creds, {
        timePeriod: trailingDailyWindowUtc(),
        granularity: "DAILY",
        metrics: [ANOMALY_METRIC],
        groupBy: SERVICE_GROUP_BY,
      }),
    ]);

    const series = buildServiceCostSeries(
      current.resultsByTime,
      previous.resultsByTime,
      daily.resultsByTime,
    );

    return classifyAnomalies(series);
  } catch {
    // Req 13.7: any failure (decrypt, assume-role, CE query) yields zero
    // anomalies — never leak the underlying error or any secret.
    return [];
  }
}

/**
 * Compute the previous full calendar month window in UTC: inclusive-start =
 * first day of last month, exclusive-end = first day of the current month (Req
 * 13.4, 13.6 compare against the immediately preceding full month).
 */
export function previousFullMonthWindowUtc(now: Date = new Date()): CeTimePeriod {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { start: toUtcDateString(start), end: toUtcDateString(end) };
}

/**
 * Compute a trailing daily window ending today (inclusive) in UTC. The exclusive
 * end is tomorrow, so the range covers {@link TRAILING_DAILY_DAYS} whole days up
 * to and including today's partial spend, giving the spike classifier the latest
 * day plus its trailing baseline.
 */
export function trailingDailyWindowUtc(now: Date = new Date()): CeTimePeriod {
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
  const start = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1 - TRAILING_DAILY_DAYS,
    ),
  );
  return { start: toUtcDateString(start), end: toUtcDateString(end) };
}

/**
 * Assemble per-service {@link ServiceCostSeries} from the three Cost Explorer
 * result sets. Services are unioned across all three queries (a service present
 * in only one still gets an entry, with zeros elsewhere); daily costs are
 * ordered oldest-to-latest (matching Cost Explorer's chronological
 * `resultsByTime`) so the latest day is the final element the spike classifier
 * expects.
 */
export function buildServiceCostSeries(
  currentMonth: CeResultByTime[],
  previousMonth: CeResultByTime[],
  daily: CeResultByTime[],
): ServiceCostSeries[] {
  const currentByService = sumGroupsByService(currentMonth);
  const previousByService = sumGroupsByService(previousMonth);
  const dailyByService = dailyCostsByService(daily);

  const services = new Set<string>([
    ...currentByService.keys(),
    ...previousByService.keys(),
    ...dailyByService.keys(),
  ]);

  const series: ServiceCostSeries[] = [];
  for (const service of services) {
    series.push({
      service,
      currentMonthCost: currentByService.get(service) ?? 0,
      previousFullMonthCost: previousByService.get(service) ?? 0,
      dailyCosts: dailyByService.get(service) ?? [],
    });
  }
  return series;
}

/**
 * Sum a single metric per service group across all time periods, yielding a
 * `service -> total` map. Robust to a range that splits into multiple periods.
 */
function sumGroupsByService(
  resultsByTime: CeResultByTime[],
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const period of resultsByTime) {
    for (const group of period.groups) {
      const service = group.keys[0];
      if (service === undefined) {
        continue;
      }
      const amount = parseAmount(group.metrics[ANOMALY_METRIC]?.amount);
      totals.set(service, (totals.get(service) ?? 0) + amount);
    }
  }
  return totals;
}

/**
 * Build a `service -> dailyCosts[]` map from DAILY, service-grouped results. The
 * daily arrays are aligned to the chronological order of `resultsByTime`, with a
 * `0` filled in for any day a service has no group, so every service's array has
 * one entry per returned day and the latest day is last.
 */
function dailyCostsByService(
  resultsByTime: CeResultByTime[],
): Map<string, number[]> {
  const dayCount = resultsByTime.length;
  const byService = new Map<string, number[]>();

  resultsByTime.forEach((period, dayIndex) => {
    for (const group of period.groups) {
      const service = group.keys[0];
      if (service === undefined) {
        continue;
      }
      let costs = byService.get(service);
      if (costs === undefined) {
        costs = new Array<number>(dayCount).fill(0);
        byService.set(service, costs);
      }
      costs[dayIndex] = parseAmount(group.metrics[ANOMALY_METRIC]?.amount);
    }
  });

  return byService;
}

/** Parse a Cost Explorer amount string to a finite number, defaulting to 0. */
function parseAmount(raw: string | undefined): number {
  if (raw === undefined) {
    return 0;
  }
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : 0;
}

/** Format a `Date` as `YYYY-MM-DD` in UTC. */
function toUtcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
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
