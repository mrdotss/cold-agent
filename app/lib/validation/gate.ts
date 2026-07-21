import type { z } from "zod";

/**
 * Validate-before-side-effect gate (Req 18.6, 18.7).
 *
 * A tiny, pure, generic primitive that encodes the contract every server route
 * follows: input is validated against a zod schema BEFORE any side effect (an
 * AWS SDK call, a database write, or a secret read) runs. If validation fails,
 * NO side effect is performed and a typed, field-scoped validation error is
 * returned that echoes no secret value.
 *
 * The route handlers in `app/api/**` follow this same validate-before-effect
 * contract inline (e.g. the chat relay `safeParse`s its body before touching the
 * database, decrypting the External_Id, or invoking the runtime). This module
 * captures that contract as a reusable, independently tested unit so the
 * invariant can be exercised as a property.
 *
 * The gate itself performs no I/O: the only side effect is whatever the caller
 * passes as `effect`, and it is invoked at most once — exactly when (and only
 * when) parsing succeeds.
 */

/** A typed, field-scoped validation error that carries no parsed input value. */
export interface ValidationError {
  readonly kind: "validation_error";
  /**
   * Dotted field paths that failed validation (e.g. `["threadId"]`,
   * `["roleArn"]`). A top-level failure is reported as the empty-path marker
   * `"(root)"`. Never contains the offending values — only their locations.
   */
  readonly fields: readonly string[];
  /** A generic, secret-free summary suitable for returning to the browser. */
  readonly message: string;
}

/** Result of {@link runWithValidation}: either the effect ran, or validation gated it. */
export type GateResult<R> =
  | { readonly ok: true; readonly value: R }
  | { readonly ok: false; readonly error: ValidationError };

/** Generic, secret-free message returned whenever the input fails its schema. */
const VALIDATION_FAILED_MESSAGE = "Invalid input.";

/**
 * Marker used for a validation issue with an empty path (a top-level/whole-body
 * failure that zod does not attribute to a named field).
 */
const ROOT_FIELD = "(root)";

/**
 * Convert a zod error into a field-scoped {@link ValidationError}. Only the
 * issue *paths* are surfaced — never the input values — so no secret can leak
 * through the error (Req 18.7).
 */
function toValidationError(error: z.ZodError): ValidationError {
  const fields: string[] = [];
  for (const issue of error.issues) {
    const path = issue.path.length === 0 ? ROOT_FIELD : issue.path.join(".");
    if (!fields.includes(path)) {
      fields.push(path);
    }
  }
  if (fields.length === 0) {
    fields.push(ROOT_FIELD);
  }
  return { kind: "validation_error", fields, message: VALIDATION_FAILED_MESSAGE };
}

/**
 * Run `effect` with `input` only after it passes `schema`.
 *
 * - On success: `effect(parsed)` is invoked exactly once with the *parsed*
 *   (transformed) value and its result is returned as `{ ok: true, value }`.
 * - On failure: `effect` is NEVER invoked and a typed validation error is
 *   returned as `{ ok: false, error }`.
 *
 * This is the reusable form of the route contract: no side effect can precede a
 * successful parse.
 *
 * @typeParam Schema - the zod schema guarding the input.
 * @typeParam R - the value produced by the side effect.
 */
export function runWithValidation<Schema extends z.ZodTypeAny, R>(
  schema: Schema,
  input: unknown,
  effect: (value: z.infer<Schema>) => R,
): GateResult<R> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: toValidationError(parsed.error) };
  }
  return { ok: true, value: effect(parsed.data as z.infer<Schema>) };
}
