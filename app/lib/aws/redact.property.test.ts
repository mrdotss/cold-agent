import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { redactForBrowser } from "./sse";

/**
 * The secret-key set mirrored from the implementation (`SECRET_KEYS` in
 * `sse.ts`), stored lowercased so membership checks are case-insensitive.
 */
const SECRET_KEYS_LOWER: ReadonlySet<string> = new Set(
  [
    "role_arn",
    "roleArn",
    "external_id",
    "externalId",
    "external_id_enc",
    "externalIdEnc",
    "accessKeyId",
    "secretAccessKey",
    "sessionToken",
    "aws_access_key_id",
    "aws_secret_access_key",
    "aws_session_token",
  ].map((k) => k.toLowerCase()),
);

/** Case variants + canonical forms of secret keys, used as generated keys. */
const SECRET_KEY_SAMPLES = [
  "role_arn",
  "roleArn",
  "ROLE_ARN",
  "RoleArn",
  "external_id",
  "externalId",
  "ExternalId",
  "EXTERNAL_ID",
  "external_id_enc",
  "externalIdEnc",
  "accessKeyId",
  "AccessKeyId",
  "secretAccessKey",
  "SecretAccessKey",
  "sessionToken",
  "SESSIONTOKEN",
  "aws_access_key_id",
  "aws_secret_access_key",
  "aws_session_token",
  "AWS_SECRET_ACCESS_KEY",
];

/** Recursively freeze an object graph so any mutation attempt throws. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      deepFreeze(v);
    }
    Object.freeze(value);
  }
  return value;
}

/** Collect every object key (at every depth) appearing in a graph. */
function collectKeys(value: unknown, acc: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, acc);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      acc.push(key);
      collectKeys(val, acc);
    }
  }
}

describe("redactForBrowser property", () => {
  it("strips all secret-named keys at every depth, is idempotent, and does not mutate input", () => {
    // Feature: cloud-bill-analyst-web, Property 12: For any object graph, redactForBrowser strips all secret-named keys at every depth, is idempotent, and does not mutate the input.

    const leaf = fc.oneof(
      fc.string(),
      fc.integer(),
      fc.boolean(),
      fc.constant(null),
    );

    const safeKey = fc.string({ minLength: 1, maxLength: 8 }).filter(
      (k) => !SECRET_KEYS_LOWER.has(k.toLowerCase()),
    );
    const secretKey = fc.constantFrom(...SECRET_KEY_SAMPLES);
    // Bias toward including secret keys so they actually appear in most graphs.
    const anyKey = fc.oneof({ weight: 2, arbitrary: secretKey }, { weight: 1, arbitrary: safeKey });

    const { graph } = fc.letrec((tie) => ({
      graph: fc.oneof(
        { depthSize: "small", withCrossShrink: true },
        { arbitrary: leaf, weight: 3 },
        { arbitrary: fc.array(tie("graph"), { maxLength: 4 }), weight: 1 },
        {
          arbitrary: fc
            .array(fc.tuple(anyKey, tie("graph")), { maxLength: 5 })
            .map((entries) => Object.fromEntries(entries)),
          weight: 2,
        },
      ),
    }));

    fc.assert(
      fc.property(graph, (g) => {
        const before = JSON.stringify(g);

        // Strongest no-mutation check: freeze the input; a mutating redact throws.
        deepFreeze(g);
        const r = redactForBrowser(g);

        // 1. Input was not mutated.
        expect(JSON.stringify(g)).toBe(before);

        // 2. No secret key survives at any depth in the output.
        const keys: string[] = [];
        collectKeys(r, keys);
        for (const key of keys) {
          expect(SECRET_KEYS_LOWER.has(key.toLowerCase())).toBe(false);
        }

        // 3. Idempotence.
        expect(JSON.stringify(redactForBrowser(r))).toBe(JSON.stringify(r));
      }),
    );
  });
});
