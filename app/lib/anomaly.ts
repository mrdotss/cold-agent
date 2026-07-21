// Cloud Bill Analyst (Web) — pure cost-anomaly classifier.
//
// This module is intentionally PURE and dependency-free (no `server-only`, no AWS
// SDK): it classifies already-fetched per-service cost series so the same logic can
// power both the dashboard badges and the inline chat callouts, and be exercised
// directly by property tests (Property 25).

export type AnomalyKind = "spike" | "new_service" | "large_mom_delta";

export interface Anomaly {
  service: string;
  kind: AnomalyKind;
  /**
   * The numbers that justify the classification. Keys are stable per kind so tests
   * and UI can rely on them:
   *  - new_service:     { currentMonthCost, previousFullMonthCost }
   *  - large_mom_delta: { currentMonthCost, previousFullMonthCost, momRatio }
   *  - spike:           { latestDaily, trailing7DayAvg, ratio }
   */
  detail: Record<string, number>;
}

export interface ServiceCostSeries {
  service: string;
  currentMonthCost: number;
  previousFullMonthCost: number;
  /** Trailing daily costs including the latest day; the latest is the LAST element. */
  dailyCosts: number[];
}

/** Req 13.4: month-over-month increase >= 25% flags a large delta. */
const MOM_DELTA_THRESHOLD = 0.25;
/** Req 13.5: a single day >= 50% above the trailing-7-day average flags a spike. */
const SPIKE_MULTIPLIER = 1.5;

/**
 * Classify each service's cost series into at most one anomaly (Req 13.1,13.4,13.5,13.6).
 *
 * Raw conditions:
 *  - new_service     (Req 13.6): currentMonthCost > 0 AND previousFullMonthCost === 0.
 *  - large_mom_delta (Req 13.4): previousFullMonthCost > 0 AND
 *                                (current - prev) / prev >= 0.25.
 *  - spike           (Req 13.5): latestDaily >= 1.5 * trailing-7-day average.
 *
 * Spike window choice: the "trailing 7-day average" is the average of up to the 7 days
 * immediately PRECEDING the latest day (i.e. excluding the latest day itself, which is
 * the day being tested against that baseline). Given N daily entries with the latest at
 * index N-1, the baseline is the mean of the up-to-7 entries in indices
 * [max(0, N-8), N-1). A spike requires at least 1 prior day and a strictly positive
 * baseline average; with fewer than 2 entries, or a non-positive average, no spike is
 * flagged (avoids divide-by-zero and vacuous flags).
 *
 * Exactly-one-kind precedence (Req 13.1): a service may satisfy more than one raw
 * condition, so we emit AT MOST ONE anomaly per service using the deterministic
 * precedence new_service > large_mom_delta > spike. (new_service and large_mom_delta
 * are already mutually exclusive because large_mom_delta requires prev > 0 while
 * new_service requires prev === 0; the precedence additionally ensures a monthly
 * anomaly is preferred over a daily spike.) Input order of services is preserved in
 * the output, and services with no anomaly produce no entry.
 */
export function classifyAnomalies(series: ServiceCostSeries[]): Anomaly[] {
  const anomalies: Anomaly[] = [];

  for (const s of series) {
    const { service, currentMonthCost, previousFullMonthCost, dailyCosts } = s;

    // Precedence 1: new_service (Req 13.6)
    if (previousFullMonthCost === 0 && currentMonthCost > 0) {
      anomalies.push({
        service,
        kind: "new_service",
        detail: { currentMonthCost, previousFullMonthCost },
      });
      continue;
    }

    // Precedence 2: large_mom_delta (Req 13.4) — requires prev > 0 for the ratio.
    if (previousFullMonthCost > 0) {
      const momRatio =
        (currentMonthCost - previousFullMonthCost) / previousFullMonthCost;
      if (momRatio >= MOM_DELTA_THRESHOLD) {
        anomalies.push({
          service,
          kind: "large_mom_delta",
          detail: { currentMonthCost, previousFullMonthCost, momRatio },
        });
        continue;
      }
    }

    // Precedence 3: spike (Req 13.5) — daily-pattern based.
    const n = dailyCosts.length;
    if (n >= 2) {
      const latestDaily = dailyCosts[n - 1];
      const priorDays = dailyCosts.slice(Math.max(0, n - 8), n - 1);
      const sum = priorDays.reduce((acc, v) => acc + v, 0);
      const trailing7DayAvg = sum / priorDays.length;
      if (trailing7DayAvg > 0 && latestDaily >= SPIKE_MULTIPLIER * trailing7DayAvg) {
        anomalies.push({
          service,
          kind: "spike",
          detail: {
            latestDaily,
            trailing7DayAvg,
            ratio: latestDaily / trailing7DayAvg,
          },
        });
        continue;
      }
    }
  }

  return anomalies;
}
