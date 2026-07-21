import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { generateSuggestions, MAX_CHIPS, type SuggestionCtx } from "./suggestions";

describe("generateSuggestions variability property", () => {
  it("keeps at least half of each render's chips novel vs the immediately preceding render", () => {
    // Feature: cloud-bill-analyst-web, Property 29: When a previous render is provided, at least half of the newly returned chips differ in wording from the previous render.

    // The guarantee in Req 16.3 is scoped to the "immediately preceding render
    // within the same thread". A real preceding render is itself an output of
    // `generateSuggestions` and shows at most MAX_CHIPS (6) chips. With a pool
    // of >= 14 distinct chips per context there are always >= ceil(n/2) novel
    // chips available, so filling novel-first satisfies the invariant. We
    // therefore model `previous` as a genuine prior render (or a sub-slice of
    // one, since a render shows <= MAX_CHIPS chips), NOT as an adversarial set
    // containing the whole pool, which would be out of scope for Req 16.3.

    const ctxArb: fc.Arbitrary<SuggestionCtx> = fc.record({
      hasAccount: fc.boolean(),
      displayCurrency: fc.option(fc.string(), { nil: undefined }),
      accountAlias: fc.option(fc.string(), { nil: undefined }),
      seed: fc.option(fc.integer(), { nil: undefined }),
    });

    const expectHalfNovel = (current: string[], previous: string[]) => {
      if (current.length === 0) return; // Req 16.4: no chips is allowed.
      const novel = current.filter((chip) => !previous.includes(chip)).length;
      expect(novel).toBeGreaterThanOrEqual(Math.ceil(current.length / 2));
    };

    fc.assert(
      fc.property(ctxArb, fc.integer(), fc.nat(MAX_CHIPS), (ctx, nextSeed, subsetLen) => {
        // A realistic thread sequence: the first render has an empty `previous`
        // (all chips novel), and the second render's `previous` is exactly that
        // first render's output.
        const first = generateSuggestions(ctx, []);
        const ctx2: SuggestionCtx = { ...ctx, seed: nextSeed };
        const second = generateSuggestions(ctx2, first);
        expectHalfNovel(second, first);

        // More general block: `previous` is an arbitrary sub-slice of a real
        // prior render (a render shows <= MAX_CHIPS chips), which still lets the
        // pool supply enough novel chips.
        const prior = generateSuggestions(ctx, []);
        const previousSubset = prior.slice(0, Math.min(subsetLen, prior.length));
        const current = generateSuggestions(ctx, previousSubset);
        expectHalfNovel(current, previousSubset);
      }),
    );
  });
});
