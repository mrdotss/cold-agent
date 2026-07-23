import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  userPk,
  convSk,
  convPk,
  gsi1Sk,
  msgSk,
  MSG_PREFIX,
} from "./keys";

/**
 * Property tests for the pure single-table key builders (Req 5.2, 5.5, 6.4).
 *
 * The builders only ever *prepend* a fixed prefix, so the conversation-item
 * keys (Property 8) round-trip for ANY string, including ones that contain
 * `#` — stripping the fixed-length prefix recovers the exact input.
 *
 * `msgSk` joins two components with `#` (`MSG#<createdAtIso>#<ulid>`). To make
 * recovery unambiguous we constrain the two components to exclude `#` (a real
 * ISO-8601 timestamp and a Crockford-base32 ULID never contain `#`, so this
 * matches reality). With that constraint, splitting the body on `#` yields
 * exactly the two original components.
 */

// A string guaranteed not to contain `#`, so `#`-joined keys round-trip
// unambiguously. Mapping (rather than filtering) avoids rejected runs.
const noHash: fc.Arbitrary<string> = fc
  .string()
  .map((s) => s.replace(/#/g, ""));

describe("single-table key builders", () => {
  it("Property 8: conversation item keys are correctly prefixed and round-trip", () => {
    // Feature: cloud-bill-analyst-web-iteration-2, Property 8: Conversation item keys are correctly formed — for arbitrary userId/conversationId/updatedAtIso, userPk, convSk, gsi1Sk produce exactly the USER#…, CONV#…, TS#… prefixed strings (and round-trip: stripping the prefix returns the input).
    fc.assert(
      fc.property(
        fc.string(),
        fc.string(),
        fc.string(),
        (userId, conversationId, updatedAtIso) => {
          const pk = userPk(userId);
          const sk = convSk(conversationId);
          const cpk = convPk(conversationId);
          const g1sk = gsi1Sk(updatedAtIso);

          // Exact formation.
          expect(pk).toBe(`USER#${userId}`);
          expect(sk).toBe(`CONV#${conversationId}`);
          expect(cpk).toBe(`CONV#${conversationId}`);
          expect(g1sk).toBe(`TS#${updatedAtIso}`);

          // Correct prefixes.
          expect(pk.startsWith("USER#")).toBe(true);
          expect(sk.startsWith("CONV#")).toBe(true);
          expect(cpk.startsWith("CONV#")).toBe(true);
          expect(g1sk.startsWith("TS#")).toBe(true);

          // Round-trip: stripping the fixed prefix recovers the input.
          expect(pk.slice("USER#".length)).toBe(userId);
          expect(sk.slice("CONV#".length)).toBe(conversationId);
          expect(cpk.slice("CONV#".length)).toBe(conversationId);
          expect(g1sk.slice("TS#".length)).toBe(updatedAtIso);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("Property 10: message item keys are correctly formed and components are recoverable", () => {
    // Feature: cloud-bill-analyst-web-iteration-2, Property 10: Message item keys are correctly formed — for arbitrary createdAtIso/ulid, msgSk produces MSG#<createdAtIso>#<ulid>, begins with MSG_PREFIX, and its components are recoverable.
    fc.assert(
      fc.property(noHash, noHash, (createdAtIso, ulid) => {
        const sk = msgSk(createdAtIso, ulid);

        // Exact formation.
        expect(sk).toBe(`MSG#${createdAtIso}#${ulid}`);

        // Begins with the shared message prefix.
        expect(sk.startsWith(MSG_PREFIX)).toBe(true);

        // Components are recoverable: strip the MSG# prefix, then split the
        // remaining body on `#`. Because both components exclude `#`, this
        // yields exactly [createdAtIso, ulid].
        const body = sk.slice(MSG_PREFIX.length);
        const parts = body.split("#");
        expect(parts).toHaveLength(2);
        expect(parts[0]).toBe(createdAtIso);
        expect(parts[1]).toBe(ulid);
      }),
      { numRuns: 100 },
    );
  });
});
