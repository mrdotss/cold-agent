import { z } from "zod";

/**
 * Pure validation schemas and helpers (no `server-only` — these run on both the
 * client and the server for field-level validation, per the design
 * `lib/validation/*` contract).
 *
 * Everything here is deterministic: given the same input, the same result. The
 * only environment dependency is the `Intl` runtime used by `timezoneSchema`.
 */

// ---------------------------------------------------------------------------
// Shared regexes (kept as constants so schemas and helpers stay consistent)
// ---------------------------------------------------------------------------

/**
 * `local-part@domain` shape:
 *  - local part: one or more chars that are neither whitespace nor `@`
 *  - a single `@` (excluded from both sides, so exactly one is allowed)
 *  - domain: one-or-more non-space/non-`@` chars, a dot, then one-or-more more
 *    (guarantees at least one dot and a non-empty label on each side)
 *
 * `.` does not match `\n` and there is no `m` flag, so `^`/`$` anchor the whole
 * string and multi-line inputs are rejected.
 */
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * IAM role ARN: `arn:aws:iam::<12-digit account id>:role/<name>`.
 * The account id is captured so `accountIdFromRoleArn` can reuse this constant.
 * The role name (`.+`) is non-empty and may include a path (e.g. `role/a/b`).
 */
export const ROLE_ARN_REGEX = /^arn:aws:iam::(\d{12}):role\/.+$/;

/** ISO 4217 3-letter currency code shape: exactly three uppercase A–Z letters. */
export const CURRENCY_REGEX = /^[A-Z]{3}$/;

/** Maximum accepted email length (measured after trimming). */
export const EMAIL_MAX_LENGTH = 254;

/** Password length bounds (inclusive), measured on the raw string. */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

/** Alias length bounds (inclusive), measured after trimming. */
export const ALIAS_MIN_LENGTH = 1;
export const ALIAS_MAX_LENGTH = 100;

/** Character used to mask hidden account-id digits. */
export const MASK_CHAR = "•";

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

/**
 * Email: trims the input, then accepts iff the trimmed value is non-empty, at
 * most 254 characters, and matches `local-part@domain` (Req 1.3). The parsed
 * output is the trimmed string. (Aligns with Property 3.)
 */
export const emailSchema = z
  .string()
  .transform((value) => value.trim())
  .refine(
    (value) =>
      value.length > 0 &&
      value.length <= EMAIL_MAX_LENGTH &&
      EMAIL_REGEX.test(value),
    { message: "Invalid email address" },
  );

/**
 * Password: accepts iff its length is in the inclusive range 8..128 (Req 1.4).
 * The password is NOT trimmed — length is measured on the raw string so leading
 * or trailing spaces count. (Aligns with Property 4.)
 */
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, {
    message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
  })
  .max(PASSWORD_MAX_LENGTH, {
    message: `Password must be at most ${PASSWORD_MAX_LENGTH} characters`,
  });

/**
 * Role ARN: accepts iff it matches `arn:aws:iam::<12-digit>:role/<name>` with an
 * exactly-12-digit account id and a non-empty role name (Req 3.6). Not trimmed.
 * (Aligns with Property 9.)
 */
export const roleArnSchema = z
  .string()
  .regex(ROLE_ARN_REGEX, { message: "Invalid IAM role ARN" });

/**
 * Account alias: trims leading/trailing whitespace, then accepts iff the trimmed
 * length is in the inclusive range 1..100 (Req 3.4, 3.7). The parsed output is
 * the trimmed alias. (Aligns with Property 8.)
 */
export const aliasSchema = z
  .string()
  .transform((value) => value.trim())
  .refine(
    (value) =>
      value.length >= ALIAS_MIN_LENGTH && value.length <= ALIAS_MAX_LENGTH,
    { message: `Alias must be 1–${ALIAS_MAX_LENGTH} characters after trimming` },
  );

/**
 * Currency: ISO 4217 three-letter code, validated as three uppercase A–Z
 * letters (Req 17.2). (Aligns with Property 30.)
 */
export const currencySchema = z
  .string()
  .regex(CURRENCY_REGEX, { message: "Invalid ISO 4217 currency code" });

/**
 * Returns whether `value` is a supported IANA time-zone identifier.
 *
 * Prefers `Intl.supportedValuesOf('timeZone')` when available; otherwise falls
 * back to constructing an `Intl.DateTimeFormat` and treating a thrown
 * `RangeError` as "not a valid zone". Works under both Node and jsdom test envs.
 */
export function isValidTimeZone(value: string): boolean {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }

  const supportedValuesOf = (
    Intl as unknown as {
      supportedValuesOf?: (key: string) => string[];
    }
  ).supportedValuesOf;

  if (typeof supportedValuesOf === "function") {
    return supportedValuesOf("timeZone").includes(value);
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch (error) {
    if (error instanceof RangeError) {
      return false;
    }
    throw error;
  }
}

/**
 * Timezone: accepts iff `value` is a valid IANA time-zone identifier (Req 17.3),
 * validated against the runtime. (Aligns with Property 30.)
 */
export const timezoneSchema = z
  .string()
  .refine(isValidTimeZone, { message: "Invalid IANA time zone" });

// ---------------------------------------------------------------------------
// Pure helper functions
// ---------------------------------------------------------------------------

/**
 * Normalize an email for storage and duplicate detection: trim, then lowercase
 * (Req 1.2). Idempotent — `normalizeEmail(normalizeEmail(x)) === normalizeEmail(x)`
 * — and two emails differing only by surrounding whitespace or letter case
 * normalize to the same value.
 */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Mask an AWS account id, revealing only the last 4 characters and replacing
 * every preceding character with {@link MASK_CHAR} (Req 5.3). The output length
 * always equals the input length. For a 12-digit id this yields 8 mask
 * characters followed by the final 4 original digits.
 *
 * Inputs of length <= 4 are returned unchanged (nothing to hide).
 */
export function maskAccountId(accountId12: string): string {
  const revealCount = 4;
  if (accountId12.length <= revealCount) {
    return accountId12;
  }
  const maskedLength = accountId12.length - revealCount;
  return MASK_CHAR.repeat(maskedLength) + accountId12.slice(-revealCount);
}

/**
 * Extract the 12-digit account id embedded in an IAM role ARN, for use with
 * {@link maskAccountId}.
 *
 * @throws {Error} if `roleArn` is not a well-formed IAM role ARN.
 */
export function accountIdFromRoleArn(roleArn: string): string {
  const match = ROLE_ARN_REGEX.exec(roleArn);
  if (match === null) {
    throw new Error("Cannot extract account id: malformed IAM role ARN");
  }
  return match[1];
}

// ---------------------------------------------------------------------------
// Inferred types (convenience for callers)
// ---------------------------------------------------------------------------

export type Email = z.infer<typeof emailSchema>;
export type Password = z.infer<typeof passwordSchema>;
export type RoleArn = z.infer<typeof roleArnSchema>;
export type Alias = z.infer<typeof aliasSchema>;
export type Currency = z.infer<typeof currencySchema>;
export type Timezone = z.infer<typeof timezoneSchema>;
