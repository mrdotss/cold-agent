import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  passwordSchema,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
} from "@/lib/validation";

// Feature: cloud-bill-analyst-web, Property 4: For any string, the password schema accepts it if and only if its length is in the inclusive range 8 to 128.

describe("passwordSchema length validation (Property 4)", () => {
  it("accepts a string iff its raw length is in [8, 128]", () => {
    // Mix unconstrained strings with generators pinned to lengths that straddle
    // both boundaries (7/8/9 and 127/128/129), so the property exercises the
    // exact accept/reject transitions and not just the interior.
    const boundaryLength = fc.oneof(
      fc.constant(0),
      fc.constant(PASSWORD_MIN_LENGTH - 1),
      fc.constant(PASSWORD_MIN_LENGTH),
      fc.constant(PASSWORD_MIN_LENGTH + 1),
      fc.constant(PASSWORD_MAX_LENGTH - 1),
      fc.constant(PASSWORD_MAX_LENGTH),
      fc.constant(PASSWORD_MAX_LENGTH + 1),
      fc.integer({ min: 0, max: 200 }),
    );

    const passwordCandidate = fc.oneof(
      fc.string({ maxLength: 200 }),
      boundaryLength.chain((length) =>
        fc.string({ minLength: length, maxLength: length }),
      ),
    );

    fc.assert(
      fc.property(passwordCandidate, (s) => {
        // Oracle: length measured on the RAW string, no trimming.
        const expected =
          s.length >= PASSWORD_MIN_LENGTH && s.length <= PASSWORD_MAX_LENGTH;
        expect(passwordSchema.safeParse(s).success).toBe(expected);
      }),
    );
  });
});
