import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { emailSchema, EMAIL_REGEX, EMAIL_MAX_LENGTH } from "./index";

describe("emailSchema property", () => {
  it("accepts iff non-empty, at most 254 chars, and matches local@domain", () => {
    // Feature: cloud-bill-analyst-web, Property 3: For any string, the email schema accepts it if and only if it is non-empty, at most 254 characters, and matches the local-part@domain form.

    // Mix generators so both the accept and reject branches are exercised:
    //  - fc.string(): arbitrary noise (mostly rejected)
    //  - fc.emailAddress(): RFC-shaped emails (mostly accepted)
    //  - crafted local@domain tuples: target the regex boundary directly
    //  - values padded with surrounding whitespace: exercise the trim transform
    const craftedEmail = fc
      .tuple(
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.string({ minLength: 1, maxLength: 10 }),
      )
      .map(([local, domain, tld]) => `${local}@${domain}.${tld}`);

    const withSurroundingSpace = fc
      .tuple(fc.emailAddress(), fc.constantFrom("", " ", "  ", "\t", " \t "))
      .map(([email, pad]) => `${pad}${email}${pad}`);

    const anyString = fc.oneof(
      fc.string(),
      fc.emailAddress(),
      craftedEmail,
      withSurroundingSpace,
    );

    fc.assert(
      fc.property(anyString, (s) => {
        // Oracle mirrors the schema's transform: trim first, then evaluate.
        const trimmed = s.trim();
        const expected =
          trimmed.length > 0 &&
          trimmed.length <= EMAIL_MAX_LENGTH &&
          EMAIL_REGEX.test(trimmed);

        expect(emailSchema.safeParse(s).success).toBe(expected);
      }),
    );
  });
});
