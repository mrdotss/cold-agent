import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { roleArnSchema, ROLE_ARN_REGEX } from "./index";

describe("roleArnSchema property", () => {
  it("accepts iff arn:aws:iam::<12-digit>:role/<non-empty name>", () => {
    // Feature: cloud-bill-analyst-web, Property 9: For any string, the role ARN schema accepts it if and only if it matches arn:aws:iam::<12-digit>:role/<name>.

    const digit = fc.constantFrom("0", "1", "2", "3", "4", "5", "6", "7", "8", "9");

    // A generator for exactly-12-digit account ids.
    const accountId12 = fc.string({ unit: digit, minLength: 12, maxLength: 12 });

    // Role names: non-empty, may include a path (e.g. `a/b`). Kept free of `\n`
    // so the (non-multiline) regex anchors behave as intended in valid cases.
    const roleNameUnit = fc.constantFrom(
      ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+=,.@_-/".split(""),
    );
    const roleName = fc.string({ unit: roleNameUnit, minLength: 1, maxLength: 40 });

    // Well-formed ARNs — these MUST be accepted.
    const validArn = fc
      .tuple(accountId12, roleName)
      .map(([id, name]) => `arn:aws:iam::${id}:role/${name}`);

    // Near-miss mutations that MUST be rejected.
    const wrongDigitCount = fc
      .tuple(
        fc.oneof(
          fc.string({ unit: digit, minLength: 11, maxLength: 11 }),
          fc.string({ unit: digit, minLength: 13, maxLength: 13 }),
        ),
        roleName,
      )
      .map(([id, name]) => `arn:aws:iam::${id}:role/${name}`);

    const emptyRoleName = accountId12.map((id) => `arn:aws:iam::${id}:role/`);

    const missingRoleSegment = fc
      .tuple(accountId12, roleName)
      .map(([id, name]) => `arn:aws:iam::${id}:${name}`);

    const wrongPrefix = fc
      .tuple(accountId12, roleName)
      .map(([id, name]) => `arn:aws:s3::${id}:role/${name}`);

    const anyString = fc.oneof(
      fc.string(),
      validArn,
      wrongDigitCount,
      emptyRoleName,
      missingRoleSegment,
      wrongPrefix,
    );

    fc.assert(
      fc.property(anyString, (s) => {
        // Reuse the exported regex so the oracle matches the implementation exactly.
        const expected = ROLE_ARN_REGEX.test(s);
        expect(roleArnSchema.safeParse(s).success).toBe(expected);
      }),
    );
  });
});
