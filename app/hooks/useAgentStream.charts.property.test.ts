import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import type { ChartSpec, SseEvent } from "@/lib/aws/sse";
import {
  streamReducer,
  createInitialStreamState,
  type StreamAction,
  type StreamState,
} from "./useAgentStream";

/**
 * Property tests for the chart handling in the pure `streamReducer`
 * (Requirement 3: Accumulate Chart Specs in the Stream Reducer).
 *
 * The reducer is a framework-free top-level export, so these tests drive it
 * directly with no React, no fetch, and no I/O.
 */

/** The four chart types accepted by a `ChartSpec` (Req 2.2 / 3.1). */
const chartTypeArb: fc.Arbitrary<ChartSpec["chart_type"]> = fc.constantFrom(
  "bar",
  "hbar",
  "line",
  "pie",
);

/**
 * A valid `ChartSpec`: `labels` (string[]) and `values` (number[]) are parallel
 * arrays of EQUAL length, and `chart_type` is one of the four known types. The
 * length is picked first, then both arrays are generated at that length so they
 * always match.
 */
const chartSpecArb: fc.Arbitrary<ChartSpec> = fc
  .nat({ max: 8 })
  .chain((len) =>
    fc.record({
      id: fc.string(),
      chart_type: chartTypeArb,
      title: fc.string(),
      currency: fc.string(),
      labels: fc.array(fc.string(), { minLength: len, maxLength: len }),
      values: fc.array(
        fc.double({ noNaN: true, noDefaultInfinity: true }),
        { minLength: len, maxLength: len },
      ),
    }),
  );

/** A `chart` SSE event carrying a valid spec. */
const chartEventArb: fc.Arbitrary<Extract<SseEvent, { type: "chart" }>> =
  chartSpecArb.map((spec) => ({ type: "chart" as const, spec }));

/** A `{ kind: "event", event: { type: "chart", ... } }` dispatch action. */
const chartActionArb: fc.Arbitrary<StreamAction> = chartEventArb.map((event) => ({
  kind: "event" as const,
  event,
}));

describe("chart reducer accumulation property", () => {
  it("appends chart specs in dispatch order and never mutates the previous state", () => {
    // Feature: cloud-bill-analyst-web-iteration-2, Property 4: The reducer appends chart specs in order without mutation — dispatching a sequence of chart events accumulates state.charts equal to the specs in dispatch order, and the previous state object (and its charts array) is not mutated.
    // Validates: Requirements 3.1, 3.2
    fc.assert(
      fc.property(fc.array(chartActionArb, { maxLength: 30 }), (actions) => {
        let state: StreamState = createInitialStreamState();
        const expectedSpecs: ChartSpec[] = [];

        for (const action of actions) {
          // Snapshot the prior state and its charts array BEFORE dispatch so we
          // can assert the reducer did not mutate them.
          const prevState = state;
          const prevCharts = state.charts;
          const prevChartsSnapshot = [...state.charts];

          const nextState = streamReducer(state, action);

          // (1) A brand-new state object is returned (no in-place mutation).
          expect(nextState).not.toBe(prevState);

          // (2) The previous state's charts array is neither swapped for a new
          // reference nor changed in length/content.
          expect(prevState.charts).toBe(prevCharts);
          expect(prevCharts).toHaveLength(prevChartsSnapshot.length);
          expect(prevCharts).toEqual(prevChartsSnapshot);

          // (3) The new state appended exactly one chart in received order.
          if (action.kind === "event" && action.event.type === "chart") {
            expectedSpecs.push(action.event.spec);
          }
          expect(nextState.charts).toEqual(expectedSpecs);
          expect(nextState.charts).toHaveLength(prevChartsSnapshot.length + 1);

          state = nextState;
        }

        // Final accumulated charts equal the specs in dispatch order.
        expect(state.charts).toEqual(expectedSpecs);
      }),
    );
  });
});

describe("chart reducer reset property", () => {
  it("clears the charts list on reset", () => {
    // Feature: cloud-bill-analyst-web-iteration-2, Property 5: Reset clears the charts list — after accumulating any number of charts, dispatching a reset action yields charts: [].
    // Validates: Requirement 3.3
    fc.assert(
      fc.property(fc.array(chartActionArb, { maxLength: 30 }), (actions) => {
        // Accumulate charts first.
        const accumulated = actions.reduce(
          streamReducer,
          createInitialStreamState(),
        );
        const accumulatedChartsSnapshot = [...accumulated.charts];

        const afterReset = streamReducer(accumulated, { kind: "reset" });

        // Reset yields an empty charts list.
        expect(afterReset.charts).toEqual([]);
        // Reset returns a fresh state object and leaves the prior state untouched.
        expect(afterReset).not.toBe(accumulated);
        expect(accumulated.charts).toEqual(accumulatedChartsSnapshot);
      }),
    );
  });
});
