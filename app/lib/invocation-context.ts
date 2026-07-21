/**
 * Invocation-context resolution helpers (Req 7.5, 17.4, 17.5).
 *
 * When the Chat_Relay invokes the Agent_Runtime for a thread it must set
 * `context.display_currency` and `context.timezone` from the thread's pinned
 * Connected_Account, falling back to the contract defaults (`IDR` /
 * `Asia/Jakarta`) whenever a value is unset.
 *
 * This module is intentionally PURE — no `server-only`, no database access, no
 * I/O — so it can be exercised directly by unit and property tests (Property 18,
 * task 11.4) and imported from either server or tooling contexts. Callers on the
 * chat route map the returned fields into `context.display_currency` /
 * `context.timezone`.
 */

/** Contract default display currency used when a value is unset. */
export const DEFAULT_DISPLAY_CURRENCY = "IDR";

/** Contract default IANA time zone used when a value is unset. */
export const DEFAULT_TIMEZONE = "Asia/Jakarta";

/**
 * The subset of a Connected_Account needed to resolve invocation context. Both
 * fields are optional/nullable because in-memory rows may carry unset values
 * even though the DB layer defaults them.
 */
export interface CurrencyTimezoneSource {
  displayCurrency?: string | null;
  timezone?: string | null;
}

/** Resolved, always-populated invocation-context fields. */
export interface ResolvedCurrencyAndTimezone {
  displayCurrency: string;
  timezone: string;
}

/**
 * Normalize a possibly-unset setting: trim surrounding whitespace and treat an
 * `undefined`, `null`, empty, or all-whitespace value as unset, substituting
 * `fallback` in that case. A non-empty value is returned trimmed.
 */
function resolveWithDefault(value: string | null | undefined, fallback: string): string {
  if (value == null) {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

/**
 * Resolve `display_currency` / `timezone` for an invocation from a pinned
 * Connected_Account, substituting the contract defaults for each unset value.
 *
 * A value counts as unset when it is `undefined`, `null`, or empty/whitespace
 * only; otherwise the stored value is returned trimmed. A `null`/`undefined`
 * account yields both defaults. Each field is resolved independently, so one
 * unset field does not force the other to its default.
 */
export function resolveCurrencyAndTimezone(
  account: CurrencyTimezoneSource | null | undefined,
): ResolvedCurrencyAndTimezone {
  return {
    displayCurrency: resolveWithDefault(account?.displayCurrency, DEFAULT_DISPLAY_CURRENCY),
    timezone: resolveWithDefault(account?.timezone, DEFAULT_TIMEZONE),
  };
}
