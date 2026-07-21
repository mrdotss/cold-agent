// Feature: cloud-bill-analyst-web, Property 8: For any string, the alias schema accepts it if and only if its trimmed length is between 1 and 100 inclusive.

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { aliasSchema, ALIAS_MIN_LENGTH, ALIAS_MAX_LENGTH } from "@/lib/validation";

/**
 * Whitespace characters that `String.prototype.trim` strips. Kept small and
 * explicit so the generator can build inputs whose UNtrimmed length differs
 * from their trimmed length in controlled ways.
 */
const WHITESPACE = [" ", "\t", "\n", "\r", "\f", "\v", "\u00a0"] as const;

const whitespaceRun = fc
  .array(fc.constantFrom(...WHITESPACE), { minLength: 0, maxLength: 60 })
  .map((chars) => chars.join(""));

/**
 * Non-whitespace "core" strings whose trimmed length straddles the 0/1/100/101
 * boundaries. We build the core from characters that never trim away so its
 * length is exactly the trimmed length of the whole input.
 */
const nonWhitespaceChar = fc
  .string({ minLength: 1, maxLength: 1 })
  .filter((c) => c.trim().length === 1);

const coreAroundBoundaries = fc.oneof(
  // Empty core -> trimmed length 0 (must be rejected).
  fc.constant(""),
  // Lengths that hug the lower and upper bounds and just past them.
  fc
    .integer({ min: 1, max: 3 })
    .chain((n) => fc.array(nonWhitespaceChar, { minLength: n, maxLength: n }).map((cs) => cs.join(""))),
  fc
    .integer({ min: ALIAS_MAX_LENGTH - 2, max: ALIAS_MAX_LENGTH + 2 })
    .chain((n) => fc.array(nonWhitespaceChar, { minLength: n, maxLength: n }).map((cs) => cs.join(""))),
  // A broad middle range for general coverage.
  fc
    .array(nonWhitespaceChar, { minLength: 0, maxLength: ALIAS_MAX_LENGTH + 5 })
    .map((cs) => cs.join("")),
);

const aliasInput = fc.oneof(
  // Fully arbitrary strings for broad coverage.
  fc.string({ maxLength: 130 }),
  fc.string({ unit: "grapheme", maxLength: 130 }),
  // Whitespace-only strings (trimmed length 0 -> rejected).
  whitespaceRun,
  // Core padded with leading/trailing whitespace: untrimmed length can exceed
  // 100 while trimmed length stays within bounds (should be accepted).
  fc
    .tuple(whitespaceRun, coreAroundBoundaries, whitespaceRun)
    .map(([lead, core, trail]) => `${lead}${core}${trail}`),
);

describe("aliasSchema (Property 8)", () => {
  it("accepts a string iff its trimmed length is within [1, 100]", () => {
    fc.assert(
      fc.property(aliasInput, (s) => {
        const t = s.trim();
        const expected = t.length >= ALIAS_MIN_LENGTH && t.length <= ALIAS_MAX_LENGTH;
        expect(aliasSchema.safeParse(s).success).toBe(expected);
      }),
    );
  });
});
