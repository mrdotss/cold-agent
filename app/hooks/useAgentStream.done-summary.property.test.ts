import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  streamReducer,
  createInitialStreamState,
  type StreamAction,
} from "@/hooks/useAgentStream";
import type { SseEvent } from "@/lib/aws/sse";

/** Same separator the reducer uses to join step summaries. */
const SUMMARY_SEPARATOR = " · ";

describe("done-summary ordering property", () => {
  it("collapses into the ordered status-or-label concatenation in insertion order", () => {
    // Feature: cloud-bill-analyst-web, Property 21: When a done event is processed, the collapsed summary is the ordered concatenation of each step's status (or label) in insertion order.

    // A small id pool so some `start` events land on an existing id (update in
    // place) while others introduce new steps — exercising insertion order.
    const idArb = fc.constantFrom("a", "b", "c", "d");

    const startArb: fc.Arbitrary<SseEvent> = fc.record({
      type: fc.constant("tool" as const),
      phase: fc.constant("start" as const),
      id: idArb,
      name: fc.string(),
      label: fc.string(),
      // Include empty-status cases to exercise the label fallback.
      status: fc.oneof(fc.constant(""), fc.string()),
    });

    const endArb: fc.Arbitrary<SseEvent> = fc.record({
      type: fc.constant("tool" as const),
      phase: fc.constant("end" as const),
      id: idArb,
      name: fc.string(),
    });

    const preDoneEventArb = fc.oneof(
      { weight: 3, arbitrary: startArb },
      { weight: 1, arbitrary: endArb },
    );

    fc.assert(
      fc.property(fc.array(preDoneEventArb, { maxLength: 30 }), (preDoneEvents) => {
        // Fold all pre-done events from a fresh initial state.
        const preDone = preDoneEvents.reduce<ReturnType<typeof createInitialStreamState>>(
          (state, event) => streamReducer(state, { kind: "event", event }),
          createInitialStreamState(),
        );

        // Reference summary derived from the reducer's own resulting steps:
        // status when non-empty, otherwise the label, joined in insertion order.
        const expected = preDone.steps
          .map((s) => (s.status.length > 0 ? s.status : s.label))
          .join(SUMMARY_SEPARATOR);

        const doneAction: StreamAction = { kind: "event", event: { type: "done" } };
        const afterDone = streamReducer(preDone, doneAction);

        expect(afterDone.liveRegion).toBe(expected);
        expect(afterDone.collapsed).toBe(true);
        expect(afterDone.phase).toBe("done");
        // `done` must not reorder or mutate the steps themselves.
        expect(afterDone.steps).toEqual(preDone.steps);
      }),
    );
  });
});
