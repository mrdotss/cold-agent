import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { sessionIdForThread, newSessionId } from "./session-id";

describe("runtime session id generation property", () => {
  it("sessionIdForThread is deterministic and within [33,128], distinct thread ids yield distinct ids, and newSessionId is within [33,128]", () => {
    // Feature: cloud-bill-analyst-web, Property 17: For any thread id, sessionIdForThread is deterministic and within [33,128] chars, distinct thread ids yield distinct session ids, and newSessionId is within [33,128] chars.

    // Determinism + length: same input -> same output, length always in [33,128]
    // (includes empty and long inputs).
    fc.assert(
      fc.property(fc.string(), (threadId) => {
        const first = sessionIdForThread(threadId);
        const second = sessionIdForThread(threadId);

        expect(first).toBe(second);
        expect(first.length).toBeGreaterThanOrEqual(33);
        expect(first.length).toBeLessThanOrEqual(128);
      }),
    );

    // Distinctness: distinct thread ids produce distinct session ids.
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        fc.pre(a !== b);
        expect(sessionIdForThread(a)).not.toBe(sessionIdForThread(b));
      }),
    );

    // newSessionId length: randomness comes from node:crypto, so fast-check
    // only drives the batch size per trial. Every generated id must be within
    // [33,128].
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50 }), (count) => {
        for (let i = 0; i < count; i++) {
          const id = newSessionId();
          expect(id.length).toBeGreaterThanOrEqual(33);
          expect(id.length).toBeLessThanOrEqual(128);
        }
      }),
    );
  });
});
