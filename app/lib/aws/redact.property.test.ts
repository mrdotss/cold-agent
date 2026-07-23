import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { redactForBrowser, type ChartSpec } from "./sse";
import {
  buildConversationItem,
  buildMessageItem,
  type ConversationItemInput,
  type MessageItemInput,
} from "@/lib/history/items";

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

/**
 * A small blob of one-or-more secret-named keys mapped to arbitrary leaf values.
 * Spread into nested elements (activity/report/chart) and onto the top-level
 * builder inputs (via casts) so the builders receive DELIBERATELY-planted secret
 * fields at multiple positions.
 */
const secretLeaf = fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null));
const secretBlob = fc.dictionary(fc.constantFrom(...SECRET_KEY_SAMPLES), secretLeaf, {
  minKeys: 1,
  maxKeys: 4,
});

/** A valid ChartSpec whose object additionally carries planted secret keys. */
const chartWithSecrets = fc
  .record({
    id: fc.string(),
    chart_type: fc.constantFrom("bar", "hbar", "line", "pie") as fc.Arbitrary<
      ChartSpec["chart_type"]
    >,
    title: fc.string(),
    currency: fc.string(),
    labels: fc.array(fc.string(), { maxLength: 3 }),
    values: fc.array(fc.integer(), { maxLength: 3 }),
  })
  .chain((spec) => secretBlob.map((blob) => ({ ...spec, ...blob }) as ChartSpec));

/** A report element `{ key }` that additionally carries planted secret keys. */
const reportWithSecrets = fc
  .record({ key: fc.string() })
  .chain((r) => secretBlob.map((blob) => ({ ...r, ...blob }) as { key: string }));

/** An activity element `{ label, status }` that additionally carries planted secret keys. */
const activityWithSecrets = fc
  .record({ label: fc.string(), status: fc.string() })
  .chain((a) =>
    secretBlob.map((blob) => ({ ...a, ...blob }) as { label: string; status: string }),
  );

/** Conversation builder input with planted secret keys spread onto the top level. */
const conversationInputWithSecrets = fc
  .record({
    conversationId: fc.string(),
    title: fc.string(),
    titleSource: fc.constantFrom("pending", "ai", "user") as fc.Arbitrary<
      ConversationItemInput["titleSource"]
    >,
    accountId: fc.string(),
    createdAt: fc.string(),
    updatedAt: fc.string(),
    messageCount: fc.nat(),
  })
  .chain((base) => secretBlob.map((blob) => ({ ...base, ...blob }) as ConversationItemInput));

/** Message builder input with planted secret keys nested throughout + on the top level. */
const messageInputWithSecrets = fc
  .record({
    conversationId: fc.string(),
    userId: fc.string(),
    role: fc.constantFrom("user", "assistant") as fc.Arbitrary<MessageItemInput["role"]>,
    content: fc.string(),
    charts: fc.array(chartWithSecrets, { maxLength: 3 }),
    reports: fc.array(reportWithSecrets, { maxLength: 3 }),
    activity: fc.option(fc.array(activityWithSecrets, { maxLength: 3 }), { nil: undefined }),
    feedback: fc.option(fc.constantFrom("up", "down"), { nil: undefined }) as fc.Arbitrary<
      MessageItemInput["feedback"]
    >,
    createdAt: fc.string(),
  })
  .chain((base) => secretBlob.map((blob) => ({ ...base, ...blob }) as MessageItemInput));

describe("history item builders redaction property", () => {
  it("never emits a secret-named key anywhere in a built conversation or message item", () => {
    // Feature: cloud-bill-analyst-web-iteration-2, Property 12: Secret fields never appear in stored or browser-bound data
    fc.assert(
      fc.property(
        fc.string(),
        conversationInputWithSecrets,
        messageInputWithSecrets,
        (userId, convInput, msgInput) => {
          const convItem = buildConversationItem(userId, convInput);
          const msgItem = buildMessageItem(msgInput);

          const convKeys: string[] = [];
          collectKeys(convItem, convKeys);
          for (const key of convKeys) {
            expect(SECRET_KEYS_LOWER.has(key.toLowerCase())).toBe(false);
          }

          const msgKeys: string[] = [];
          collectKeys(msgItem, msgKeys);
          for (const key of msgKeys) {
            expect(SECRET_KEYS_LOWER.has(key.toLowerCase())).toBe(false);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
