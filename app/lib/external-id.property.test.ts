import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { newExternalId } from "./external-id";

describe("newExternalId property", () => {
  it("produces ids within [16, 1224] that are all distinct", () => {
    // Feature: cloud-bill-analyst-web, Property 6: For any number of generated External_Ids, each has length in [16, 1224] and all generated values are distinct.

    // Randomness comes from node:crypto, so fast-check only drives the batch
    // size per trial. The >= 100 iterations still exercise many batches; an
    // outer Set checks global uniqueness across the entire run.
    const allIds = new Set<string>();

    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50 }), (count) => {
        const ids = Array.from({ length: count }, () => newExternalId());

        for (const id of ids) {
          expect(id.length).toBeGreaterThanOrEqual(16);
          expect(id.length).toBeLessThanOrEqual(1224);
        }

        // Distinct within this batch.
        expect(new Set(ids).size).toBe(ids.length);

        // Distinct across the whole run.
        for (const id of ids) {
          expect(allIds.has(id)).toBe(false);
          allIds.add(id);
        }
      }),
    );
  });
});
