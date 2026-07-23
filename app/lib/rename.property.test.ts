import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { decideRename, type RenameDecision } from "./rename";

/**
 * Arbitraries that exercise the whole rename input space:
 *
 * - `nonEmptyTitleArb` — strings guaranteed to have a non-whitespace char, so
 *   they survive trimming (the ACCEPT branch).
 * - `whitespaceOnlyArb` — strings made purely of whitespace (the REJECT branch).
 * - `emptyArb` — the empty string (the REJECT branch, boundary).
 * - `paddedArb` — a real title wrapped in leading/trailing whitespace, to prove
 *   the returned title is trimmed.
 * - `fc.string()` — arbitrary strings for broad coverage of both branches.
 */
const WHITESPACE = [" ", "\t", "\n", "\r", "\f", "\v", "\u00a0", "\u2003"];
const whitespaceCharArb = fc.constantFrom(...WHITESPACE);
const padArb = fc.string({ unit: whitespaceCharArb, maxLength: 8 });

const nonEmptyTitleArb: fc.Arbitrary<string> = fc
  .tuple(fc.string(), fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0), fc.string())
  .map(([a, core, b]) => `${a}${core}${b}`);

const whitespaceOnlyArb: fc.Arbitrary<string> = fc.string({
  unit: whitespaceCharArb,
  minLength: 1,
  maxLength: 12,
});

const emptyArb: fc.Arbitrary<string> = fc.constant("");

const paddedArb: fc.Arbitrary<string> = fc
  .tuple(padArb, fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0), padArb)
  .map(([lead, core, trail]) => `${lead}${core}${trail}`);

const candidateArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 4, arbitrary: fc.string() },
  { weight: 3, arbitrary: nonEmptyTitleArb },
  { weight: 3, arbitrary: paddedArb },
  { weight: 2, arbitrary: whitespaceOnlyArb },
  { weight: 1, arbitrary: emptyArb },
);

describe("Rename decision property", () => {
  it("accepts iff the trimmed title is non-empty, and returns the trimmed title when accepted", () => {
    // Feature: cloud-bill-analyst-web-iteration-2, Property 16: Rename is accepted iff the trimmed title is non-empty
    // Validates: Requirements 11.2, 11.6
    fc.assert(
      fc.property(candidateArb, (candidate) => {
        const decision: RenameDecision = decideRename(candidate);
        const trimmed = candidate.trim();

        // Accept iff trimmed non-empty (Req 11.2 accept / 11.6 reject).
        expect(decision.accept).toBe(trimmed.length > 0);

        if (decision.accept) {
          // WHEN accepted, the returned title equals the trimmed candidate.
          expect(decision.title).toBe(trimmed);
        } else {
          // WHEN rejected, no title is present on the decision.
          expect("title" in decision).toBe(false);
        }
      }),
      { numRuns: 300 },
    );
  });
});
