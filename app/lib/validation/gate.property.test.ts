import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { z } from "zod";

import { runWithValidation } from "./gate";
import { roleArnSchema, aliasSchema, ALIAS_MAX_LENGTH } from "./index";

/**
 * Property 31: Input validation gates side effects (Req 18.6, 18.7).
 *
 * We model a "route boundary" as {@link runWithValidation}: it parses the input
 * with a zod schema and only then runs a side effect. The property asserts the
 * two halves of the contract across many generated inputs:
 *   - valid input  → the effect spy runs exactly once and its result is returned;
 *   - invalid input → the effect spy is NEVER called and a typed, field-scoped
 *                     validation error (carrying no input value) is returned.
 *
 * Two representative schemas are exercised: the chat route body
 * (`{ threadId, prompt }`) and an account-ish body built from the real exported
 * `roleArnSchema` / `aliasSchema`.
 */

// The real chat route body schema (mirrors app/app/api/chat/route.ts).
const chatBodySchema = z.object({
  threadId: z.string().min(1),
  prompt: z.string().min(1),
});

// An account-ish body composed from the real shared schemas.
const accountBodySchema = z.object({
  roleArn: roleArnSchema,
  alias: aliasSchema,
});

const digit = fc.constantFrom(..."0123456789".split(""));
const accountId12 = fc.string({ unit: digit, minLength: 12, maxLength: 12 });
const roleNameUnit = fc.constantFrom(
  ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+=,.@_-/".split(
    "",
  ),
);
const roleName = fc.string({ unit: roleNameUnit, minLength: 1, maxLength: 40 });

// --- chat body generators -------------------------------------------------

const validChatBody = fc.record({
  threadId: fc.string({ minLength: 1 }),
  prompt: fc.string({ minLength: 1 }),
});

// At least one required string is empty (or the shape is wrong) → must fail.
const invalidChatBody = fc.oneof(
  fc.record({ threadId: fc.constant(""), prompt: fc.string() }),
  fc.record({ threadId: fc.string(), prompt: fc.constant("") }),
  fc.record({ threadId: fc.constant(""), prompt: fc.constant("") }),
  // Wrong / missing fields and non-object inputs.
  fc.record({ prompt: fc.string({ minLength: 1 }) }),
  fc.record({ threadId: fc.integer(), prompt: fc.string({ minLength: 1 }) }),
  fc.constant(null),
  fc.constant(undefined),
  fc.string(),
  fc.integer(),
);

// --- account body generators ----------------------------------------------

const validAccountBody = fc
  .tuple(accountId12, roleName, fc.string({ minLength: 1, maxLength: ALIAS_MAX_LENGTH }))
  .map(([id, name, aliasCore]) => ({
    roleArn: `arn:aws:iam::${id}:role/${name}`,
    // Ensure the trimmed alias is within 1..100: build from non-space core.
    alias: `x${aliasCore.replace(/\s/g, "y")}`.slice(0, ALIAS_MAX_LENGTH),
  }));

const invalidAccountBody = fc.oneof(
  // Malformed role ARN (wrong service prefix), valid alias.
  fc
    .tuple(accountId12, roleName)
    .map(([id, name]) => ({ roleArn: `arn:aws:s3::${id}:role/${name}`, alias: "ok" })),
  // Bad digit count in the account id.
  fc
    .tuple(fc.string({ unit: digit, minLength: 11, maxLength: 11 }), roleName)
    .map(([id, name]) => ({ roleArn: `arn:aws:iam::${id}:role/${name}`, alias: "ok" })),
  // Valid ARN, over-long alias (>100 after trim).
  fc
    .tuple(accountId12, roleName, fc.integer({ min: ALIAS_MAX_LENGTH + 1, max: 200 }))
    .map(([id, name, len]) => ({
      roleArn: `arn:aws:iam::${id}:role/${name}`,
      alias: "a".repeat(len),
    })),
  // Valid ARN, whitespace-only alias (empty after trim).
  fc
    .tuple(accountId12, roleName)
    .map(([id, name]) => ({ roleArn: `arn:aws:iam::${id}:role/${name}`, alias: "   " })),
  fc.constant(null),
  fc.string(),
);

describe("runWithValidation gates side effects (Property 31)", () => {
  it("valid input runs the effect exactly once; invalid input never does", () => {
    // Feature: cloud-bill-analyst-web, Property 31: Input validation gates side effects — for any route input that fails its zod schema, the gate returns a typed, field-scoped validation error and performs zero side effects; valid input runs the effect exactly once.

    const cases = fc.oneof(
      validChatBody.map((input) => ({ schema: chatBodySchema, input, expectValid: true })),
      invalidChatBody.map((input) => ({ schema: chatBodySchema, input, expectValid: false })),
      validAccountBody.map((input) => ({ schema: accountBodySchema, input, expectValid: true })),
      invalidAccountBody.map((input) => ({ schema: accountBodySchema, input, expectValid: false })),
    );

    fc.assert(
      fc.property(cases, ({ schema, input, expectValid }) => {
        // Guard the generators against the real schema so the oracle is exact.
        const actuallyValid = schema.safeParse(input).success;
        fc.pre(actuallyValid === expectValid);

        // A spy standing in for the real side effect (AWS call / DB write /
        // secret read). It must run at most once, and only when input is valid.
        let calls = 0;
        const sentinel = Symbol("effect-result");
        const effect = (): symbol => {
          calls += 1;
          return sentinel;
        };

        const result = runWithValidation(schema as z.ZodTypeAny, input, effect);

        if (actuallyValid) {
          // Proceed → side effect allowed exactly once, its result returned.
          expect(result.ok).toBe(true);
          expect(calls).toBe(1);
          if (result.ok) {
            expect(result.value).toBe(sentinel);
          }
        } else {
          // Gate closed → the side effect NEVER ran, a typed error is returned.
          expect(result.ok).toBe(false);
          expect(calls).toBe(0);
          if (!result.ok) {
            expect(result.error.kind).toBe("validation_error");
            expect(result.error.fields.length).toBeGreaterThan(0);
            // The typed error carries no input value — only field paths + a
            // generic message (Req 18.7: echoes no secret value).
            const serialized = JSON.stringify(result.error);
            if (
              typeof input === "object" &&
              input !== null &&
              "roleArn" in input &&
              typeof (input as { roleArn: unknown }).roleArn === "string"
            ) {
              expect(serialized).not.toContain((input as { roleArn: string }).roleArn);
            }
          }
        }
      }),
    );
  });
});
