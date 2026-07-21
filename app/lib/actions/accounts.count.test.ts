import { describe, it, expect } from "vitest";
import * as fc from "fast-check";

import {
  MAX_CONNECTED_ACCOUNTS,
  canAddConnectedAccount,
} from "@/lib/accounts-limit";

/*
 * Feature: cloud-bill-analyst-web, Property 13: Connected-account count bound
 *
 * Validates: Requirements 5.1, 5.2
 *
 * The count-bound decision is tested against the pure `canAddConnectedAccount`
 * predicate exported from `@/lib/accounts-limit`. That is the SAME predicate the
 * `"use server"` action `createConnectedAccount` uses for its guard, so this test
 * exercises the production code path without pulling in server-only auth/db/crypto
 * dependencies (which would make the property non-hermetic under Vitest).
 *
 * Rule (Req 5.1, 5.2): a user may store between 1 and MAX_CONNECTED_ACCOUNTS (10)
 * accounts inclusive. Storing a new account is permitted IFF the current count is
 * strictly below the maximum (currentCount in [0, 9]); a user already holding 10
 * is rejected and existing accounts remain unchanged.
 */
describe("Property 13: connected-account count bound", () => {
  it("permits adding an account IFF current count < MAX_CONNECTED_ACCOUNTS", () => {
    fc.assert(
      fc.property(
        // Straddle the bound so both the allowed and rejected regions are hit.
        fc.integer({ min: 0, max: 20 }),
        (currentCount) => {
          const allowed = canAddConnectedAccount(currentCount);
          expect(allowed).toBe(currentCount < MAX_CONNECTED_ACCOUNTS);

          // Restated as the requirement's two directions:
          if (currentCount < MAX_CONNECTED_ACCOUNTS) {
            // 0..9 -> a user under the cap can add another account.
            expect(allowed).toBe(true);
          } else {
            // 10+ -> at/over the cap the store is rejected.
            expect(allowed).toBe(false);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("holds at the exact boundaries (0 allowed, 9 allowed, 10 rejected)", () => {
    // The maximum is exactly 10 for the 1..10 inclusive storage bound.
    expect(MAX_CONNECTED_ACCOUNTS).toBe(10);

    // Empty store: the first account (making 1 total) may be added.
    expect(canAddConnectedAccount(0)).toBe(true);

    // Holding 9 (one below the cap): a 10th account may be added.
    expect(canAddConnectedAccount(9)).toBe(true);

    // Holding 10 (at the cap): an 11th account is rejected.
    expect(canAddConnectedAccount(10)).toBe(false);
  });
});
