import { describe, it, expect } from "vitest";
import * as fc from "fast-check";

import { orderMessagesByCreatedAtAsc } from "./messages";

interface TestMessage {
  id: string;
  createdAt: Date;
}

/** Multiset of ids so we can assert output is a permutation of the input. */
function idMultiset(messages: readonly TestMessage[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of messages) {
    counts.set(m.id, (counts.get(m.id) ?? 0) + 1);
  }
  return counts;
}

describe("orderMessagesByCreatedAtAsc — Property 19: Message ordering", () => {
  it("returns a permutation of the input that is non-decreasing by createdAt", () => {
    // Feature: cloud-bill-analyst-web, Property 19: Message ordering

    // Draw timestamps from a small pool of epoch millis so DUPLICATE timestamps
    // are common, exercising the stable/equal-timestamp case. Arbitrary
    // insertion order (including already-sorted and reverse-sorted) is covered
    // by fast-check's shrinking + random generation.
    const messageArb: fc.Arbitrary<TestMessage> = fc.record({
      id: fc.uuid(),
      createdAt: fc
        .integer({ min: 0, max: 20 })
        .map((tick) => new Date(tick * 60_000)),
    });

    fc.assert(
      fc.property(
        fc.array(messageArb, { maxLength: 50 }),
        (input) => {
          const output = orderMessagesByCreatedAtAsc(input);

          // Same length (necessary for a permutation).
          expect(output.length).toBe(input.length);

          // Permutation: identical multiset of ids as the input.
          expect(idMultiset(output)).toEqual(idMultiset(input));

          // Non-decreasing by createdAt for every adjacent pair (oldest first).
          for (let i = 0; i + 1 < output.length; i++) {
            expect(output[i].createdAt.getTime()).toBeLessThanOrEqual(
              output[i + 1].createdAt.getTime(),
            );
          }

          // Purity: the input array is not mutated.
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });

  it("does not mutate the input array", () => {
    const input: TestMessage[] = [
      { id: "a", createdAt: new Date(3_000) },
      { id: "b", createdAt: new Date(1_000) },
      { id: "c", createdAt: new Date(2_000) },
    ];
    const snapshot = input.map((m) => m.id);

    orderMessagesByCreatedAtAsc(input);

    expect(input.map((m) => m.id)).toEqual(snapshot);
  });

  it("preserves insertion order for equal timestamps (stable)", () => {
    const t = new Date(5_000);
    const input: TestMessage[] = [
      { id: "first", createdAt: t },
      { id: "second", createdAt: t },
      { id: "third", createdAt: t },
    ];

    const output = orderMessagesByCreatedAtAsc(input);

    expect(output.map((m) => m.id)).toEqual(["first", "second", "third"]);
  });
});
