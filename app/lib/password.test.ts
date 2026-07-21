import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { hashPassword, verifyPassword } from "./password";

describe("password hash verification round-trip (Property 1)", () => {
  it("verifies the same password against its hash as true and a different password as false", async () => {
    // Feature: cloud-bill-analyst-web, Property 1: Password hash verification round-trip
    // Validates: Requirements 1.1, 1.5
    //
    // For any password of length 8..128: hashing it then verifying the SAME
    // password against that hash returns true (Req 1.1 — passwords are stored
    // as an argon2 hash the login flow can verify), while verifying a DIFFERENT
    // password returns false (Req 1.5 — only the correct plaintext matches; the
    // plaintext itself is never persisted, only the hash).
    //
    // argon2id hashing is CPU-intensive, so this exercises real hashing (no
    // mocks) at the shared >= 100 iteration default (test/setup.ts). We keep
    // numRuns at the default 100 and grant a generous per-test timeout below to
    // absorb ~100 hashes plus verifications rather than reducing coverage.
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 8, maxLength: 128 }),
        fc.string({ minLength: 8, maxLength: 128 }),
        async (password, other) => {
          const hash = await hashPassword(password);

          // Positive: the same password verifies against its own hash.
          expect(await verifyPassword(hash, password)).toBe(true);

          // Negative: a different password does not verify. Constrain the
          // generated pair to be distinct so this case is meaningful.
          fc.pre(password !== other);
          expect(await verifyPassword(hash, other)).toBe(false);
        },
      ),
    );
  }, 120_000);
});
