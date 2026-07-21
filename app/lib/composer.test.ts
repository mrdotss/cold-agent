import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { isComposerEnabled } from "./composer";

describe("isComposerEnabled account-count gate property", () => {
  it("is enabled iff accountCount >= 1", () => {
    // Feature: cloud-bill-analyst-web, Property 15: Composer enablement
    // Validates: Requirements 6.1, 6.2, 6.3, 6.4
    //
    // Enablement is a pure function of the connected-account count: enabled iff
    // count >= 1. This captures Req 6.1 (zero accounts -> disabled) and Req 6.2
    // (>=1 account -> enabled); the Req 6.3/6.4 transitions follow because
    // re-evaluating the rule against the new count flips the state.
    fc.assert(
      fc.property(fc.integer({ min: -2, max: 20 }), (accountCount) => {
        expect(isComposerEnabled(accountCount)).toBe(accountCount >= 1);
      }),
      { numRuns: 200 },
    );
  });

  it("holds at the enablement boundary and beyond", () => {
    // Feature: cloud-bill-analyst-web, Property 15: Composer enablement
    // Validates: Requirements 6.1, 6.2
    expect(isComposerEnabled(0)).toBe(false); // Req 6.1: zero accounts -> disabled
    expect(isComposerEnabled(1)).toBe(true); // Req 6.2: first account -> enabled
    expect(isComposerEnabled(10_000)).toBe(true); // many accounts -> still enabled
  });
});
