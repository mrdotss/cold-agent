import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  feedbackReducer,
  isSelected,
  type FeedbackState,
  type FeedbackValue,
} from "./interactions";

// Feature: cloud-bill-analyst-web, Property 26: For any sequence of feedback activations, at most one value is stored, activating the current value clears it and a different value replaces it, and isSelected reflects the stored value.

// Independent reference model: activating the currently-stored value clears it to
// null; activating any other value stores that value.
function apply(state: FeedbackState, v: FeedbackValue): FeedbackState {
  return state === v ? null : v;
}

const feedbackValue = fc.constantFrom<FeedbackValue>("up", "down");
const initialState = fc.constantFrom<FeedbackState>(null, "up", "down");

describe("feedbackReducer / isSelected (Property 26)", () => {
  it("stores at most one value, toggles/replaces correctly, and isSelected mirrors the stored value", () => {
    fc.assert(
      fc.property(
        initialState,
        fc.array(feedbackValue),
        (start, values) => {
          let state = start;
          let model = start;

          for (const value of values) {
            const prev = state;
            const result = feedbackReducer(prev, { kind: "activate", value });

            // (a) result is always one of null | "up" | "down" (at most one value).
            expect(result === null || result === "up" || result === "down").toBe(
              true,
            );

            // (b) activating the current value clears it; a different value replaces it.
            if (value === prev) {
              expect(result).toBe(null);
            } else {
              expect(result).toBe(value);
            }

            // (d) isSelected(state, v) === (state === v); when null, both false.
            expect(isSelected(result, "up")).toBe(result === "up");
            expect(isSelected(result, "down")).toBe(result === "down");
            if (result === null) {
              expect(isSelected(result, "up")).toBe(false);
              expect(isSelected(result, "down")).toBe(false);
            }

            // Step matches the reference model.
            model = apply(model, value);
            expect(result).toBe(model);

            state = result;
          }

          // (c) the final folded state matches the reference fold model.
          expect(state).toBe(model);
        },
      ),
    );
  });
});
