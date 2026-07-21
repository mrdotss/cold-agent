import { describe, it, expect, vi } from "vitest";
import * as fc from "fast-check";

import { isValidExternalId } from "@/lib/aws/sts";
import { roleArnSchema } from "@/lib/validation";

/**
 * Property 10 (Req 4.2): For any invalid connection-test input — a malformed
 * role ARN, or an External_Id whose length is outside [16, 1224] or which
 * contains a disallowed character — `testConnection` returns
 * `{ ok: false, category: "invalid_input" }` WITHOUT ever issuing an STS
 * AssumeRole (or any Cost Explorer probe).
 *
 * We replace the STS SDK client's `send` with a spy and stub `probeCostExplorer`
 * so we can assert, per generated invalid input, that neither is ever invoked.
 * A spy on the SDK `send` is the strongest guarantee that no assume-role network
 * call happened.
 */

const { stsSend, stsDestroy, probeSpy } = vi.hoisted(() => ({
  stsSend: vi.fn(),
  stsDestroy: vi.fn(),
  probeSpy: vi.fn(),
}));

vi.mock("@aws-sdk/client-sts", () => ({
  STSClient: vi.fn().mockImplementation(() => ({
    send: stsSend,
    destroy: stsDestroy,
  })),
  AssumeRoleCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

vi.mock("@/lib/aws/cost-explorer", () => ({
  probeCostExplorer: probeSpy,
}));

// Imported after the mocks are registered (vi.mock is hoisted above imports).
const { testConnection } = await import("@/lib/aws/sts");

/** Replicates the module-internal validity check to build precise generators. */
function isValidAssumeInput(roleArn: string, externalId: string): boolean {
  return roleArnSchema.safeParse(roleArn).success && isValidExternalId(externalId);
}

describe("testConnection invalid-input rejection property", () => {
  it("rejects any invalid input as invalid_input and never assumes a role", async () => {
    // Feature: cloud-bill-analyst-web, Property 10: Connection test rejects invalid input before any assume-role

    const digit = fc.constantFrom(..."0123456789".split(""));
    const accountId12 = fc.string({ unit: digit, minLength: 12, maxLength: 12 });
    const roleNameUnit = fc.constantFrom(
      ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+=,.@_-/".split(""),
    );
    const roleName = fc.string({ unit: roleNameUnit, minLength: 1, maxLength: 40 });

    // A well-formed role ARN (used to isolate the "invalid external id" case).
    const validRoleArn = fc
      .tuple(accountId12, roleName)
      .map(([id, name]) => `arn:aws:iam::${id}:role/${name}`);

    // A well-formed External_Id (used with an invalid ARN to prove the ARN alone
    // triggers rejection).
    const externalIdUnit = fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789+=,.@:/-".split(""));
    const validExternalId = fc.string({ unit: externalIdUnit, minLength: 16, maxLength: 64 });

    // Malformed role ARNs: arbitrary strings that fail roleArnSchema.
    const invalidRoleArn = fc
      .string()
      .filter((s) => !roleArnSchema.safeParse(s).success);

    // Invalid External_Ids: too short, too long, or containing a disallowed char.
    const tooShort = fc.string({ unit: externalIdUnit, minLength: 0, maxLength: 15 });
    const tooLong = fc.string({ unit: externalIdUnit, minLength: 1225, maxLength: 1260 });
    const disallowedChar = fc.constantFrom(" ", "\t", "\n", "#", "$", "%", "*", "(", ")", "!", "?", "&");
    const badCharset = fc
      .tuple(
        fc.string({ unit: externalIdUnit, minLength: 8, maxLength: 30 }),
        disallowedChar,
        fc.string({ unit: externalIdUnit, minLength: 8, maxLength: 30 }),
      )
      .map(([a, bad, b]) => `${a}${bad}${b}`);
    const invalidExternalId = fc
      .oneof(tooShort, tooLong, badCharset)
      .filter((s) => !isValidExternalId(s));

    // Every branch is guaranteed to be invalid overall: either the ARN is
    // malformed, or the ARN is valid but the External_Id is invalid.
    const invalidPair = fc
      .oneof(
        fc.record({
          roleArn: invalidRoleArn,
          externalId: fc.oneof(validExternalId, invalidExternalId),
        }),
        fc.record({ roleArn: validRoleArn, externalId: invalidExternalId }),
      )
      .filter(({ roleArn, externalId }) => !isValidAssumeInput(roleArn, externalId));

    await fc.assert(
      fc.asyncProperty(invalidPair, async ({ roleArn, externalId }) => {
        // Reset call history between runs so "never called" is per-input.
        stsSend.mockClear();
        stsDestroy.mockClear();
        probeSpy.mockClear();

        const result = await testConnection(roleArn, externalId);

        expect(result).toEqual({ ok: false, category: "invalid_input" });
        // Critical assertion: no assume-role / STS network call occurred.
        expect(stsSend).not.toHaveBeenCalled();
        // And no Cost Explorer probe either.
        expect(probeSpy).not.toHaveBeenCalled();
      }),
    );
  });
});
