import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { normalizeEmail } from "./index";

// Feature: cloud-bill-analyst-web, Property 2: For any email string, normalizeEmail is idempotent, and any two emails differing only by surrounding whitespace or letter case normalize to the same value.

/**
 * Whitespace characters that `String.prototype.trim` strips. Restricting the
 * generated surrounding whitespace to this set keeps the trim-based oracle
 * exact: every prefix/suffix char here is guaranteed to be removed by trim().
 */
const TRIMMABLE_WHITESPACE = [" ", "\t", "\n", "\r", "\f", "\v"];

const trimmableWhitespace = fc
  .array(fc.constantFrom(...TRIMMABLE_WHITESPACE), { maxLength: 8 })
  .map((chars) => chars.join(""));

/**
 * A single printable-ASCII character. Restricting the base to ASCII keeps the
 * per-character re-casing oracle exact: for these characters
 * `toUpperCase`/`toLowerCase` preserve length and round-trip, so a variant that
 * only re-cases letters normalizes to the same value as its base. (Unicode
 * folds like `ß` -> `SS` change length and are out of scope for email casing.)
 */
const asciiChar = fc
  .integer({ min: 0x20, max: 0x7e })
  .map((code) => String.fromCharCode(code));

/**
 * A base string paired with a per-character upper/lower decision, so the
 * re-cased variant always aligns 1:1 with the base characters.
 */
const casedChars = fc.array(fc.tuple(asciiChar, fc.boolean()));

describe("normalizeEmail (Property 2: normalization equivalence)", () => {
  it("is idempotent and collapses whitespace/case-only differences", () => {
    // (a) Idempotence: normalizing an already-normalized value is a no-op.
    fc.assert(
      fc.property(fc.string(), (s) => {
        const once = normalizeEmail(s);
        expect(normalizeEmail(once)).toBe(once);
      }),
    );

    // (b) Whitespace/case invariance: a base string and a variant produced by
    // adding surrounding (trim-removable) whitespace and arbitrarily remapping
    // each character's letter case normalize to the same value.
    fc.assert(
      fc.property(
        casedChars,
        trimmableWhitespace,
        trimmableWhitespace,
        (chars, lead, trail) => {
          const base = chars.map(([ch]) => ch).join("");
          const recased = chars
            .map(([ch, upper]) => (upper ? ch.toUpperCase() : ch.toLowerCase()))
            .join("");

          const variant = `${lead}${recased}${trail}`;

          expect(normalizeEmail(variant)).toBe(normalizeEmail(base));
        },
      ),
    );
  });
});
