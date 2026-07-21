import "server-only";

import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  type GetCostAndUsageCommandInput,
  type Granularity,
  type GroupDefinitionType,
} from "@aws-sdk/client-cost-explorer";

import type { AssumedCreds } from "@/lib/aws/sts";

/**
 * Server-only AWS Cost Explorer reads, scoped to a customer's assumed read-only
 * role (dashboard overview + anomaly detection, Req 12/13). Also provides the
 * minimal probe used by the connection test (Req 4.1).
 *
 * `server-only`: this module runs AWS SDK calls with temporary credentials and
 * must never be bundled for the browser.
 *
 * Cost Explorer is a global service reachable only through its `us-east-1`
 * endpoint, so the client is always pinned to that region regardless of the
 * app's operating region.
 */

/** Cost Explorer's only endpoint region. */
const COST_EXPLORER_REGION = "us-east-1";

/** A single-metric amount as returned by Cost Explorer. */
export interface CeMetricValue {
  amount: string;
  unit: string;
}

/** Inclusive-start / exclusive-end date window in `YYYY-MM-DD` form. */
export interface CeTimePeriod {
  start: string;
  end: string;
}

/** Optional grouping dimension for a `GetCostAndUsage` read. */
export interface CeGroupBy {
  type: GroupDefinitionType;
  key: string;
}

/**
 * Input for {@link getCostAndUsage}. Mirrors the subset of the Cost Explorer
 * `GetCostAndUsage` request the dashboard/anomaly code (tasks 12/16) needs.
 */
export interface CeQueryInput {
  timePeriod: CeTimePeriod;
  granularity: Granularity;
  /** One or more cost metrics, e.g. `["UnblendedCost"]`. */
  metrics: string[];
  /** Optional group-by definitions (e.g. by `SERVICE`). */
  groupBy?: CeGroupBy[];
}

/** A grouped slice of cost within one time period. */
export interface CeResultGroup {
  keys: string[];
  metrics: Record<string, CeMetricValue>;
}

/** Cost for a single time period, with the total and any groups. */
export interface CeResultByTime {
  timePeriod: CeTimePeriod;
  total: Record<string, CeMetricValue>;
  groups: CeResultGroup[];
}

/** Normalized result of a {@link getCostAndUsage} read. */
export interface CeResult {
  resultsByTime: CeResultByTime[];
}

/** Metric used by the minimal connection-test probe. */
const PROBE_METRIC = "UnblendedCost";

/** Build a Cost Explorer client from assumed temporary credentials. */
function costExplorerClient(creds: AssumedCreds): CostExplorerClient {
  return new CostExplorerClient({
    region: COST_EXPLORER_REGION,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
  });
}

/**
 * Run a read-only `GetCostAndUsage` query using the given assumed credentials
 * and return a normalized {@link CeResult}. The caller owns credential scope;
 * this function performs no additional authorization.
 *
 * @throws propagates the underlying AWS SDK error (callers such as
 *   `testConnection` map it to a coarse, secret-free category).
 */
export async function getCostAndUsage(
  creds: AssumedCreds,
  input: CeQueryInput,
): Promise<CeResult> {
  const client = costExplorerClient(creds);

  const commandInput: GetCostAndUsageCommandInput = {
    TimePeriod: { Start: input.timePeriod.start, End: input.timePeriod.end },
    Granularity: input.granularity,
    Metrics: input.metrics,
    ...(input.groupBy && input.groupBy.length > 0
      ? { GroupBy: input.groupBy.map((g) => ({ Type: g.type, Key: g.key })) }
      : {}),
  };

  try {
    const response = await client.send(new GetCostAndUsageCommand(commandInput));

    const resultsByTime: CeResultByTime[] = (response.ResultsByTime ?? []).map(
      (period) => ({
        timePeriod: {
          start: period.TimePeriod?.Start ?? "",
          end: period.TimePeriod?.End ?? "",
        },
        total: normalizeMetrics(period.Total),
        groups: (period.Groups ?? []).map((group) => ({
          keys: group.Keys ?? [],
          metrics: normalizeMetrics(group.Metrics),
        })),
      }),
    );

    return { resultsByTime };
  } finally {
    client.destroy();
  }
}

/**
 * Minimal Cost Explorer probe used by the connection test: a single-day, DAILY,
 * single-metric `GetCostAndUsage` (Req 4.1). Resolves on success; throws on
 * failure so `testConnection` can categorize it as `query_failed`.
 */
export async function probeCostExplorer(creds: AssumedCreds): Promise<void> {
  await getCostAndUsage(creds, {
    timePeriod: singleDayWindowUtc(),
    granularity: "DAILY",
    metrics: [PROBE_METRIC],
  });
}

/**
 * Compute a single-day Cost Explorer window `[yesterday, today)` in UTC. Cost
 * Explorer treats `End` as exclusive, so this spans exactly one day.
 */
export function singleDayWindowUtc(now: Date = new Date()): CeTimePeriod {
  const today = toUtcDateString(now);
  const yesterday = toUtcDateString(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  return { start: yesterday, end: today };
}

/** Format a `Date` as `YYYY-MM-DD` in UTC. */
function toUtcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Convert the SDK's metric map (`{ Amount, Unit }`) into our `CeMetricValue`
 * shape, dropping entries that lack an amount.
 */
function normalizeMetrics(
  metrics: Record<string, { Amount?: string; Unit?: string }> | undefined,
): Record<string, CeMetricValue> {
  const out: Record<string, CeMetricValue> = {};
  if (metrics === undefined) {
    return out;
  }
  for (const [name, value] of Object.entries(metrics)) {
    out[name] = { amount: value.Amount ?? "0", unit: value.Unit ?? "" };
  }
  return out;
}
