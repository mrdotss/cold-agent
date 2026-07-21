import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  generateSuggestions,
  MIN_CHIPS,
  MAX_CHIPS,
  MAX_CHIP_LENGTH,
  type SuggestionCtx,
} from "./suggestions";

describe("generateSuggestions bounds property", () => {
  it("returns either [] or 3..6 distinct chips each of length 1..120", () => {
    // Feature: cloud-bill-analyst-web, Property 28: For any context, generateSuggestions returns either [] or 3..6 distinct chips each of length 1..120.

    const ctxArb: fc.Arbitrary<SuggestionCtx> = fc.record({
      hasAccount: fc.boolean(),
      displayCurrency: fc.option(fc.string(), { nil: undefined }),
      accountAlias: fc.option(fc.string(), { nil: undefined }),
      seed: fc.option(fc.integer(), { nil: undefined }),
    });

    fc.assert(
      fc.property(ctxArb, fc.array(fc.string(), { maxLength: 8 }), (ctx, previous) => {
        const chips = generateSuggestions(ctx, previous);

        // Either empty or within [MIN_CHIPS, MAX_CHIPS].
        expect(
          chips.length === 0 || (chips.length >= MIN_CHIPS && chips.length <= MAX_CHIPS),
        ).toBe(true);

        // Every chip is a non-empty string within the length bound.
        for (const c of chips) {
          expect(c.length).toBeGreaterThanOrEqual(1);
          expect(c.length).toBeLessThanOrEqual(MAX_CHIP_LENGTH);
        }

        // All chips are distinct within the render.
        expect(new Set(chips).size).toBe(chips.length);
      }),
    );
  });
});
