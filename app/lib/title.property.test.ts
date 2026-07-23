import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { normalizeTitle, fallbackTitle } from "./title";

/**
 * Property tests for the pure title helpers in `lib/title.ts`.
 *
 * These mirror the (intentionally duplicated) constants inside `title.ts` so the
 * test asserts the *observable* invariants of a produced title rather than
 * re-implementing the normalization. Keeping them local also documents the
 * contract the helpers promise.
 */
const MAX_WORDS = 6;
const QUOTE_CHARS = "\"'`\u201C\u201D\u2018\u2019\u00AB\u00BB\u2039\u203A";
const TRAILING_PUNCT = ".,!?;:\u2026" + QUOTE_CHARS;

/**
 * Assert the four "clean, short title" invariants on a produced title:
 *   1. at most MAX_WORDS whitespace-separated words,
 *   2. no leading quotation mark,
 *   3. no trailing quotation mark,
 *   4. no trailing sentence punctuation (which subsumes the trailing quote check).
 * The empty string trivially satisfies all of them.
 */
function assertCleanTitle(result: string): void {
  expect(typeof result).toBe("string");
  if (result === "") return;

  const words = result.split(/\s+/).filter((w) => w.length > 0);
  expect(words.length).toBeLessThanOrEqual(MAX_WORDS);

  const first = result[0];
  const last = result[result.length - 1];
  expect(QUOTE_CHARS.includes(first)).toBe(false);
  expect(QUOTE_CHARS.includes(last)).toBe(false);
  expect(TRAILING_PUNCT.includes(last)).toBe(false);
}

// --- Arbitraries that target the normalization branches. -------------------

/** A single word: 1-8 non-whitespace characters. */
const wordChar = fc.constantFrom(
  ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split(""),
);
const wordArb: fc.Arbitrary<string> = fc
  .array(wordChar, { minLength: 1, maxLength: 8 })
  .map((cs) => cs.join(""));

const quoteArb = fc.constantFrom(...QUOTE_CHARS.split(""));
const punctArb = fc.constantFrom(...TRAILING_PUNCT.split(""));
const wsArb = fc.constantFrom(" ", "  ", "\t", "\n", "\r\n", " \t ");

/**
 * A raw string deliberately built to exercise every branch: surrounding quotes,
 * trailing punctuation, extra/irregular whitespace, and a variable word count
 * that frequently exceeds MAX_WORDS (0-12 words).
 */
const structuredRawArb: fc.Arbitrary<string> = fc
  .record({
    words: fc.array(wordArb, { minLength: 0, maxLength: 12 }),
    leadingQuotes: fc.array(quoteArb, { maxLength: 3 }),
    trailingPunct: fc.array(punctArb, { maxLength: 4 }),
    innerWs: wsArb,
    leadingWs: fc.constantFrom("", " ", "  ", "\t", "\n"),
    trailingWs: fc.constantFrom("", " ", "  ", "\t", "\n"),
  })
  .map(({ words, leadingQuotes, trailingPunct, innerWs, leadingWs, trailingWs }) => {
    const body = words.join(innerWs);
    return leadingWs + leadingQuotes.join("") + body + trailingPunct.join("") + trailingWs;
  });

/** Empty or whitespace-only strings (includes the empty string). */
const whitespaceOnlyArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(" ", "\t", "\n", "\r", "\f", "\v"), { maxLength: 12 })
  .map((cs) => cs.join(""));

/** The full raw-input space: arbitrary strings + the targeted generators. */
const rawArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: fc.string() },
  { weight: 3, arbitrary: structuredRawArb },
  { weight: 1, arbitrary: whitespaceOnlyArb },
);

describe("title production — clean, short title invariants", () => {
  it("normalizeTitle and fallbackTitle produce clean, short titles for any raw string", () => {
    // Feature: cloud-bill-analyst-web-iteration-2, Property 15: Every title-producing path yields a clean, short title
    fc.assert(
      fc.property(rawArb, (raw) => {
        // never throws
        const normalized = normalizeTitle(raw);
        const fallback = fallbackTitle(raw);
        assertCleanTitle(normalized);
        assertCleanTitle(fallback);
      }),
      { numRuns: 300 },
    );
  });

  it("both helpers return \"\" for empty / whitespace-only input", () => {
    // Feature: cloud-bill-analyst-web-iteration-2, Property 15: Every title-producing path yields a clean, short title
    fc.assert(
      fc.property(whitespaceOnlyArb, (blank) => {
        expect(normalizeTitle(blank)).toBe("");
        expect(fallbackTitle(blank)).toBe("");
      }),
      { numRuns: 100 },
    );
  });
});

// Validates: Requirements 10.3, 10.7
