// Feature: cloud-bill-analyst-web, Property 14: For any 12-digit AWS account id, maskAccountId reveals only the last 4 digits and masks all preceding digits, preserving length.

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { maskAccountId, MASK_CHAR } from "@/lib/validation";

/** Single decimal digit unit for building numeric account ids. */
const digit = fc.constantFrom("0", "1", "2", "3", "4", "5", "6", "7", "8", "9");

/** Exactly-12-digit AWS account ids (the shape callers actually mask, per Req 5.3). */
const accountId12 = fc.string({ unit: digit, minLength: 12, maxLength: 12 });

/**
 * Arbitrary-length strings longer than the 4 revealed characters, for the
 * secondary generic length/last-4 invariants. Uses printable characters so the
 * "last 4 preserved exactly" assertion is meaningful.
 */
const longString = fc.string({ minLength: 5, maxLength: 40 });

describe("maskAccountId (Property 14)", () => {
  it("reveals only the last 4 digits of a 12-digit account id and masks the preceding 8, preserving length", () => {
    fc.assert(
      fc.property(accountId12, (id) => {
        const masked = maskAccountId(id);

        // Length is preserved (12 in, 12 out).
        expect(masked.length).toBe(id.length);
        expect(masked.length).toBe(12);

        // The last 4 digits are revealed exactly.
        expect(masked.slice(-4)).toBe(id.slice(-4));

        // The first 8 characters are all the mask character.
        expect(masked.slice(0, 8)).toBe(MASK_CHAR.repeat(8));

        // No original digit leaks through the masked prefix.
        expect(/\d/.test(masked.slice(0, 8))).toBe(false);
      }),
    );
  });

  it("preserves length and the last 4 characters for any string longer than 4", () => {
    fc.assert(
      fc.property(longString, (s) => {
        const masked = maskAccountId(s);

        // Length is always preserved.
        expect(masked.length).toBe(s.length);

        // The trailing 4 characters are revealed exactly.
        expect(masked.slice(-4)).toBe(s.slice(-4));

        // Everything before the last 4 is masked.
        expect(masked.slice(0, s.length - 4)).toBe(MASK_CHAR.repeat(s.length - 4));
      }),
    );
  });
});
