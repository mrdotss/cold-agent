import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import type { SseEvent } from "@/lib/aws/sse";
import {
  streamReducer,
  createInitialStreamState,
  type ActivityStep,
  type StreamAction,
} from "./useAgentStream";

/**
 * A small id pool so `start`/`end` collisions and repeated starts on the same
 * id actually happen frequently (with only 4 ids across a sequence of up to 40
 * events, duplicates and matching ends are the common case, not the exception).
 */
const idArb: fc.Arbitrary<string> = fc.constantFrom("a", "b", "c", "d");

const toolStartArb: fc.Arbitrary<SseEvent> = fc
  .record({
    id: idArb,
    name: fc.string(),
    label: fc.string(),
    status: fc.string(),
  })
  .map(({ id, name, label, status }) => ({
    type: "tool" as const,
    phase: "start" as const,
    id,
    name,
    label,
    status,
  }));

const toolEndArb: fc.Arbitrary<SseEvent> = fc
  .record({ id: idArb, name: fc.string() })
  .map(({ id, name }) => ({ type: "tool" as const, phase: "end" as const, id, name }));

const errorArb: fc.Arbitrary<SseEvent> = fc
  .string()
  .map((message) => ({ type: "error" as const, message }));

/**
 * Mostly tool events (so the timeline gets exercised), with the occasional
 * error mixed in (lower weight) to check that running steps become stopped.
 */
const eventArb: fc.Arbitrary<SseEvent> = fc.oneof(
  { weight: 5, arbitrary: toolStartArb },
  { weight: 4, arbitrary: toolEndArb },
  { weight: 1, arbitrary: errorArb },
);

const actionArb: fc.Arbitrary<StreamAction> = eventArb.map((event) => ({
  kind: "event" as const,
  event,
}));

/**
 * Independent reference model, kept EXACTLY consistent with `streamReducer`:
 *  - start(new id)      → append a running step (insertion order by first-seen id)
 *  - start(existing id) → update label + status in place, preserve current state
 *  - end(matching id)   → that step's state becomes "done"
 *  - end(unknown id)    → no-op
 *  - error              → every "running" step becomes "stopped"
 */
function referenceSteps(actions: StreamAction[]): ActivityStep[] {
  const steps: ActivityStep[] = [];
  for (const action of actions) {
    if (action.kind !== "event") continue;
    const event = action.event;
    if (event.type !== "tool" && event.type !== "error") continue;

    if (event.type === "error") {
      for (let i = 0; i < steps.length; i++) {
        if (steps[i].state === "running") {
          steps[i] = { ...steps[i], state: "stopped" };
        }
      }
      continue;
    }

    if (event.phase === "start") {
      const idx = steps.findIndex((step) => step.id === event.id);
      if (idx === -1) {
        steps.push({
          id: event.id,
          name: event.name,
          label: event.label,
          status: event.status,
          state: "running",
        });
      } else {
        steps[idx] = { ...steps[idx], label: event.label, status: event.status };
      }
      continue;
    }

    // phase === "end"
    const idx = steps.findIndex((step) => step.id === event.id);
    if (idx !== -1) {
      steps[idx] = { ...steps[idx], state: "done" };
    }
  }
  return steps;
}

describe("activity-timeline step invariants property", () => {
  it("preserves insertion order, keeps ids unique with in-place updates, tracks running/done, ignores unmatched ends, and stops running steps on error", () => {
    // Feature: cloud-bill-analyst-web, Property 20: For any sequence of tool events, timeline steps preserve insertion order, ids are unique with in-place updates, a step stays running until a matching end marks it done, unmatched ends are no-ops, and an error stops all running steps.
    fc.assert(
      fc.property(fc.array(actionArb, { maxLength: 40 }), (actions) => {
        const finalState = actions.reduce(streamReducer, createInitialStreamState());
        const actual = finalState.steps;
        const expected = referenceSteps(actions);

        // (a) + (b) + (c) + (d) + (e): the reference model encodes insertion
        // order, in-place updates, running→done transitions, unmatched-end
        // no-ops, and error→stopped. Deep equality checks all of them at once.
        expect(actual).toEqual(expected);

        // (a) insertion order matches first-seen id order explicitly.
        const seen: string[] = [];
        for (const action of actions) {
          if (action.kind !== "event") continue;
          if (action.event.type !== "tool") continue;
          if (action.event.phase !== "start") continue;
          if (!seen.includes(action.event.id)) seen.push(action.event.id);
        }
        expect(actual.map((step) => step.id)).toEqual(seen);

        // (b) ids are unique — repeated starts update in place, never duplicate.
        const ids = actual.map((step) => step.id);
        expect(new Set(ids).size).toBe(ids.length);

        // (e) if the final action was an error, no step may still be running.
        const lastEventAction = [...actions]
          .reverse()
          .find(
            (action): action is Extract<StreamAction, { kind: "event" }> =>
              action.kind === "event" &&
              (action.event.type === "tool" || action.event.type === "error"),
          );
        if (lastEventAction && lastEventAction.event.type === "error") {
          expect(actual.every((step) => step.state !== "running")).toBe(true);
        }
      }),
    );
  });
});
