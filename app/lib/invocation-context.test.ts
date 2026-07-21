import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  resolveCurrencyAndTimezone,
  DEFAULT_DISPLAY_CURRENCY,
  DEFAULT_TIMEZONE,
} from "./invocation-context";

/**
 * A setting value paired with its oracle expectation.
 * `input` is what we feed into the resolver for that field; `expected` is what
 * the resolver must return for it, computed independently of the resolver.
 */
interface FieldCase {
  input: string | null | undefined;
  expected: string;
}

/** Surrounding-whitespace arbitrary used to exercise trimming. */
const whitespace = fc.string({
  unit: fc.constantFrom(" ", "\t", "\n", "\r"),
  maxLength: 4,
});

/**
 * Generate a field value that resolves to the account's own (trimmed) value:
 * a string guaranteed to contain at least one non-whitespace character, with
 * optional surrounding whitespace to check that the resolver trims it.
 */
function nonEmptyFieldCase(fallback: string): fc.Arbitrary<FieldCase> {
  // A core token with >= 1 non-whitespace char. Filter guarantees the trimmed
  // core is itself non-empty; wrapping whitespace is added around it.
  const core = fc
    .string({ minLength: 1, maxLength: 12 })
    .filter((s) => s.trim().length > 0);
  return fc
    .record({ lead: whitespace, core, trail: whitespace })
    .map(({ lead, core, trail }) => {
      const input = `${lead}${core}${trail}`;
      return { input, expected: input.trim() } satisfies FieldCase;
    })
    .filter((c) => c.expected !== "" && c.expected !== fallback);
}

/**
 * Generate an "unset" field value: undefined, null, empty, or whitespace-only.
 * These must resolve to the supplied default.
 */
function unsetFieldCase(fallback: string): fc.Arbitrary<FieldCase> {
  const unsetInput: fc.Arbitrary<string | null | undefined> = fc.oneof(
    fc.constant(undefined),
    fc.constant(null),
    fc.constant(""),
    whitespace.map((w) => (w.length === 0 ? " " : w)),
  );
  return unsetInput.map((input) => ({ input, expected: fallback }));
}

/** A field is either a resolvable non-empty value or an unset value. */
function fieldCase(fallback: string): fc.Arbitrary<FieldCase> {
  return fc.oneof(nonEmptyFieldCase(fallback), unsetFieldCase(fallback));
}

describe("invocation-context currency/timezone resolution property", () => {
  it("resolves each field to its trimmed value when set and to the contract default when unset, independently per field", () => {
    // Feature: cloud-bill-analyst-web, Property 18: Currency and timezone resolution with defaults
    // Validates: Requirements 7.5, 17.5
    fc.assert(
      fc.property(
        fieldCase(DEFAULT_DISPLAY_CURRENCY),
        fieldCase(DEFAULT_TIMEZONE),
        (currencyCase, timezoneCase) => {
          const resolved = resolveCurrencyAndTimezone({
            displayCurrency: currencyCase.input,
            timezone: timezoneCase.input,
          });

          // Each field matches its own oracle regardless of the other field's
          // set/unset state, proving independent resolution.
          expect(resolved.displayCurrency).toBe(currencyCase.expected);
          expect(resolved.timezone).toBe(timezoneCase.expected);
        },
      ),
    );
  });

  it("yields both contract defaults for a null or undefined account", () => {
    // Feature: cloud-bill-analyst-web, Property 18: Currency and timezone resolution with defaults
    // Validates: Requirements 7.5, 17.5
    fc.assert(
      fc.property(fc.constantFrom(null, undefined), (account) => {
        const resolved = resolveCurrencyAndTimezone(account);
        expect(resolved.displayCurrency).toBe(DEFAULT_DISPLAY_CURRENCY);
        expect(resolved.timezone).toBe(DEFAULT_TIMEZONE);
      }),
    );
  });
});
