import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  classifyAnomalies,
  type AnomalyKind,
  type ServiceCostSeries,
} from "./anomaly";

// Independent oracle mirroring the exact rules & precedence in anomaly.ts.
// Uses the SAME comparisons, slice window slice(max(0, N-8), N-1), and >= thresholds
// to avoid floating-point mismatch with the implementation.
const MOM_DELTA_THRESHOLD = 0.25;
const SPIKE_MULTIPLIER = 1.5;

function oracle(s: ServiceCostSeries): AnomalyKind | null {
  const { currentMonthCost, previousFullMonthCost, dailyCosts } = s;

  // Precedence 1: new_service.
  if (previousFullMonthCost === 0 && currentMonthCost > 0) {
    return "new_service";
  }

  // Precedence 2: large_mom_delta (requires prev > 0).
  if (previousFullMonthCost > 0) {
    const momRatio =
      (currentMonthCost - previousFullMonthCost) / previousFullMonthCost;
    if (momRatio >= MOM_DELTA_THRESHOLD) {
      return "large_mom_delta";
    }
  }

  // Precedence 3: spike (daily-pattern based).
  const n = dailyCosts.length;
  if (n >= 2) {
    const latestDaily = dailyCosts[n - 1];
    const priorDays = dailyCosts.slice(Math.max(0, n - 8), n - 1);
    const sum = priorDays.reduce((acc, v) => acc + v, 0);
    const trailing7DayAvg = sum / priorDays.length;
    if (trailing7DayAvg > 0 && latestDaily >= SPIKE_MULTIPLIER * trailing7DayAvg) {
      return "spike";
    }
  }

  return null;
}

const VALID_KINDS: readonly AnomalyKind[] = [
  "spike",
  "new_service",
  "large_mom_delta",
];

describe("classifyAnomalies classification property", () => {
  it("flags a service iff a rule matches under precedence, with exactly one valid kind, preserving input order", () => {
    // Feature: cloud-bill-analyst-web, Property 25: For any service cost series, each returned anomaly has exactly one kind matching its rule, and a service is flagged iff a rule matches under the precedence new_service > large_mom_delta > spike.

    const seriesArb: fc.Arbitrary<ServiceCostSeries> = fc.record({
      service: fc.string(),
      currentMonthCost: fc.double({
        min: 0,
        max: 1e7,
        noNaN: true,
        noDefaultInfinity: true,
      }),
      previousFullMonthCost: fc.double({
        min: 0,
        max: 1e7,
        noNaN: true,
        noDefaultInfinity: true,
      }),
      dailyCosts: fc.array(
        fc.double({ min: 0, max: 1e6, noNaN: true, noDefaultInfinity: true }),
        { maxLength: 20 },
      ),
    });

    fc.assert(
      fc.property(fc.array(seriesArb, { maxLength: 15 }), (series) => {
        const out = classifyAnomalies(series);

        // 1. Flagged iff a rule matches, correct kind, and input order preserved.
        const expected = series
          .map((s) => oracle(s))
          .map((kind, i) =>
            kind ? { service: series[i].service, kind } : null,
          )
          .filter((e): e is { service: string; kind: AnomalyKind } => e !== null);

        expect(out.map((a) => ({ service: a.service, kind: a.kind }))).toEqual(
          expected,
        );

        for (const a of out) {
          // 2. Each emitted anomaly has exactly one valid kind literal.
          expect(VALID_KINDS).toContain(a.kind);
        }
      }),
    );
  });
});
