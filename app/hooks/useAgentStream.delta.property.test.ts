import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import type { SseEvent } from "@/lib/aws/sse";
import { streamReducer, createInitialStreamState } from "./useAgentStream";

// Feature: cloud-bill-analyst-web, Property 22: After folding a sequence of events, assistantText equals the exact in-order concatenation of all delta texts, with no earlier content lost.

// A small pool of tool ids so start/end events can actually match and exercise
// the timeline paths interleaved with deltas. Keeping the pool small makes
// end-events realistically hit existing steps.
const TOOL_ID_POOL = ["t0", "t1", "t2"] as const;

// delta texts include: empty, plain, unicode, and malformed-markdown-looking
// strings that must NEVER be discarded or "cleaned up" by the reducer.
const deltaTextArb: fc.Arbitrary<string> = fc.oneof(
  fc.constant(""),
  fc.string(),
  fc.constantFrom(
    "**bold",
    "| a | b",
    "`code",
    "~~strike",
    "# heading\nno close",
    "línea ünïcode 漢字 🚀",
    "\n\n",
    "\t| col |",
    "> quote\n- item",
    "]]>malformed",
  ),
);

const toolNameArb = fc.constantFrom(
  "get_cost_and_usage",
  "get_exchange_rate",
  "create_chart",
  "create_report",
);

const deltaEventArb: fc.Arbitrary<SseEvent> = deltaTextArb.map((text) => ({
  type: "delta",
  text,
}));

const toolStartArb: fc.Arbitrary<SseEvent> = fc.record({
  id: fc.constantFrom(...TOOL_ID_POOL),
  name: toolNameArb,
  label: fc.string(),
  status: fc.string(),
}).map(({ id, name, label, status }) => ({
  type: "tool",
  phase: "start",
  id,
  name,
  label,
  status,
}));

const toolEndArb: fc.Arbitrary<SseEvent> = fc.record({
  id: fc.constantFrom(...TOOL_ID_POOL),
  name: toolNameArb,
}).map(({ id, name }) => ({ type: "tool", phase: "end", id, name }));

const reportFileArb: fc.Arbitrary<SseEvent> = fc.record({
  key: fc.string(),
  bucket: fc.string(),
}).map(({ key, bucket }) => ({ type: "report_file", key, bucket }));

// done sets phase/collapsed but must NOT touch assistantText. (error is
// deliberately excluded to keep the sequence focused, but including it would
// also be safe since it doesn't change assistantText.)
const doneArb: fc.Arbitrary<SseEvent> = fc.constant({ type: "done" });

// Weight deltas more heavily so the concatenation is exercised, while still
// interleaving non-delta events that must not disturb assistantText.
const eventArb: fc.Arbitrary<SseEvent> = fc.oneof(
  { weight: 5, arbitrary: deltaEventArb },
  { weight: 2, arbitrary: toolStartArb },
  { weight: 2, arbitrary: toolEndArb },
  { weight: 1, arbitrary: reportFileArb },
  { weight: 1, arbitrary: doneArb },
);

describe("useAgentStream reducer — delta accumulation (Property 22)", () => {
  it("assistantText is the in-order concatenation of all delta texts, and grows monotonically (no earlier content lost)", () => {
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 60 }), (events) => {
        const expected = events
          .filter((e): e is Extract<SseEvent, { type: "delta" }> => e.type === "delta")
          .map((e) => e.text)
          .join("");

        // Fold step-by-step so we can assert the prefix (no-loss) invariant at
        // every step, and check the final concatenation at the end.
        let state = createInitialStreamState();
        for (const event of events) {
          const prev = state;
          const next = streamReducer(prev, { kind: "event", event });

          // Earlier content is never dropped or reordered: each new
          // assistantText starts with the previous one.
          expect(next.assistantText.startsWith(prev.assistantText)).toBe(true);

          // Non-delta events must not alter assistantText at all.
          if (event.type !== "delta") {
            expect(next.assistantText).toBe(prev.assistantText);
          }

          state = next;
        }

        // Exact in-order concatenation of every delta text.
        expect(state.assistantText).toBe(expected);
      }),
    );
  });
});
