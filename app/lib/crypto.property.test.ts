import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import * as fc from "fast-check";
import { encryptSecret, decryptSecret } from "./crypto";

describe("crypto encryption round-trip property", () => {
  // The key is read at CALL TIME via requireEnv("APP_ENCRYPTION_KEY"), so
  // setting it before the fc.assert call is sufficient even though the module
  // is statically imported above. Use a fixed 32-byte key for determinism.
  let priorKey: string | undefined;

  beforeAll(() => {
    priorKey = process.env.APP_ENCRYPTION_KEY;
    process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  });

  afterAll(() => {
    if (priorKey === undefined) {
      delete process.env.APP_ENCRYPTION_KEY;
    } else {
      process.env.APP_ENCRYPTION_KEY = priorKey;
    }
  });

  it("round-trips any string and produces distinct ciphertexts per encryption", () => {
    // Feature: cloud-bill-analyst-web, Property 11: For any string, decryptSecret(encryptSecret(x)) === x, and two encryptions of the same plaintext differ.

    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ maxLength: 2000 }),
          fc.string({ unit: "grapheme", maxLength: 2000 }),
        ),
        (x) => {
          // Round-trip: decrypt(encrypt(x)) recovers the original plaintext.
          expect(decryptSecret(encryptSecret(x))).toBe(x);

          // IV difference: two fresh encryptions of the same plaintext differ
          // because a random IV is generated per call.
          expect(encryptSecret(x)).not.toBe(encryptSecret(x));
        },
      ),
    );
  });
});
