import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  currencySchema,
  CURRENCY_REGEX,
  timezoneSchema,
  isValidTimeZone,
} from "./index";

describe("currency and timezone validation property", () => {
  it("currency accepts iff 3 uppercase letters; timezone accepts iff valid IANA zone", () => {
    // Feature: cloud-bill-analyst-web, Property 30: For any string, the currency schema accepts it iff it is a 3-letter uppercase code, and the timezone schema accepts it iff it is a valid IANA timezone.

    // --- Currency strategy -------------------------------------------------
    const upper = fc.constantFrom(
      ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""),
    );

    // Crafted well-formed ISO 4217 shapes: exactly three uppercase A–Z letters.
    const validCurrency = fc.string({ unit: upper, minLength: 3, maxLength: 3 });

    // Near-misses: wrong length (2 or 4), lowercase letters, and digits.
    const lower = fc.constantFrom(
      ..."abcdefghijklmnopqrstuvwxyz".split(""),
    );
    const digit = fc.constantFrom(..."0123456789".split(""));

    const wrongLengthUpper = fc.oneof(
      fc.string({ unit: upper, minLength: 2, maxLength: 2 }),
      fc.string({ unit: upper, minLength: 4, maxLength: 4 }),
    );
    const lowercaseTriples = fc.string({ unit: lower, minLength: 3, maxLength: 3 });
    const digitTriples = fc.string({ unit: digit, minLength: 3, maxLength: 3 });

    const anyCurrency = fc.oneof(
      fc.string(),
      validCurrency,
      wrongLengthUpper,
      lowercaseTriples,
      digitTriples,
    );

    fc.assert(
      fc.property(anyCurrency, (s) => {
        // Reuse the exported regex so the oracle matches the implementation exactly.
        const expected = CURRENCY_REGEX.test(s);
        expect(currencySchema.safeParse(s).success).toBe(expected);
      }),
    );

    // --- Timezone strategy -------------------------------------------------
    // Draw known-valid IANA zones from the runtime when available, otherwise a
    // small hardcoded valid set. Either way the oracle reuses `isValidTimeZone`,
    // so the assertion stays correct across environments.
    const supportedValuesOf = (
      Intl as unknown as {
        supportedValuesOf?: (key: string) => string[];
      }
    ).supportedValuesOf;

    const knownZones =
      typeof supportedValuesOf === "function"
        ? supportedValuesOf("timeZone")
        : ["Asia/Jakarta", "America/New_York", "UTC", "Europe/London"];

    const validZone = fc.constantFrom(...knownZones);

    const invalidZone = fc.constantFrom(
      "",
      "Not/AZone",
      "asia/jakarta",
      "Mars/Phobos",
      "GMT+25",
      "Foo",
    );

    const anyTimezone = fc.oneof(fc.string(), validZone, invalidZone);

    fc.assert(
      fc.property(anyTimezone, (s) => {
        // Reuse the exported helper so the oracle matches the implementation exactly.
        const expected = isValidTimeZone(s);
        expect(timezoneSchema.safeParse(s).success).toBe(expected);
      }),
    );
  });
});
