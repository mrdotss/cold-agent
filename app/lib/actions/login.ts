"use server";

import { redirect } from "next/navigation";

import { createUserSession, destroyUserSession, verifyCredentials } from "@/lib/auth";
import { isLockedOut, recordLoginAttempt } from "@/lib/rate-limit";
import { emailSchema, normalizeEmail, passwordSchema } from "@/lib/validation";

/**
 * Login + sign-out server actions (Req 2.2, 2.3, 2.5, 2.9).
 *
 * This module is the single entry point the login form calls. It performs the
 * field-level checks that must NOT leak which field was wrong, enforces the
 * per-email rate limit, and delegates the actual credential + session work to
 * the self-managed DB-session helpers (`verifyCredentials` + `createUserSession`
 * / `destroyUserSession` from `@/lib/auth`), which create the `sessions` row on
 * success and delete it on sign-out.
 *
 * `"use server"` marks every export as a server action; the value exports are
 * async functions and the `LoginResult` type is erased at build time.
 */

/** Generic invalid-credentials message — never reveals which field was wrong (Req 2.2). */
const INVALID_CREDENTIALS_MESSAGE = "Invalid email or password.";

/** Shown when an email is locked out by the rate limiter (Req 2.9). */
const TOO_MANY_ATTEMPTS_MESSAGE =
  "Too many failed login attempts. Try again in 15 minutes.";

/** Missing-field messages (Req 2.3) — identify the empty field. */
const EMAIL_REQUIRED_MESSAGE = "Email is required.";
const PASSWORD_REQUIRED_MESSAGE = "Password is required.";

/** Raw input from the login form. */
export interface LoginInput {
  email: string;
  password: string;
}

/**
 * Result of a login attempt.
 *
 * On failure the entered `email` is echoed back so the form can repopulate it
 * (Req 2.2, 2.3), and `field` (when present) marks which field was empty so the
 * UI can highlight it (Req 2.3). No failure result ever indicates whether the
 * email or the password was the reason credentials were rejected (Req 2.2).
 */
export type LoginResult =
  | { ok: true }
  | {
      ok: false;
      message: string;
      email: string;
      field?: "email" | "password";
    };

/**
 * Attempt to log a user in (Req 2.1, 2.2, 2.3, 2.9).
 *
 * Order of checks:
 *  1. Empty email / empty password → field-specific rejection, no session,
 *     email retained (Req 2.3).
 *  2. Email / password format → treated exactly like a credential mismatch:
 *     generic message + recorded failed attempt (keeps the counter advancing
 *     and never reveals the field, Req 2.2, 2.9).
 *  3. Lockout check BEFORE any credential verification (Req 2.9) — a locked
 *     email is rejected without touching the credential store.
 *  4. `verifyCredentials(email, password)`. Returns `null` for an unknown email
 *     OR a wrong password, which we map to the generic message (Req 2.2); on
 *     success we create the DB-backed session with `createUserSession`.
 *
 * Every attempt that reaches (or passes) credential verification is recorded in
 * `login_attempts` so the rate limiter's window advances (Req 2.9).
 */
export async function login(input: LoginInput): Promise<LoginResult> {
  const email = typeof input.email === "string" ? input.email : "";
  const password = typeof input.password === "string" ? input.password : "";

  // (1) Empty-field checks — report the specific missing field (Req 2.3).
  if (email.trim().length === 0) {
    return {
      ok: false,
      message: EMAIL_REQUIRED_MESSAGE,
      email,
      field: "email",
    };
  }
  if (password.length === 0) {
    return {
      ok: false,
      message: PASSWORD_REQUIRED_MESSAGE,
      email,
      field: "password",
    };
  }

  const normalizedEmail = normalizeEmail(email);

  // (2) Format checks. A malformed email or out-of-range password can never
  // match a stored user, so treat it exactly like a mismatch: generic message,
  // recorded failure. This avoids leaking which field was wrong (Req 2.2) while
  // still advancing the rate-limit counter (Req 2.9).
  const emailOk = emailSchema.safeParse(email).success;
  const passwordOk = passwordSchema.safeParse(password).success;
  if (!emailOk || !passwordOk) {
    await recordLoginAttempt(normalizedEmail, false);
    return { ok: false, message: INVALID_CREDENTIALS_MESSAGE, email };
  }

  // (3) Lockout check before any credential verification (Req 2.9).
  if (await isLockedOut(normalizedEmail, new Date())) {
    return { ok: false, message: TOO_MANY_ATTEMPTS_MESSAGE, email };
  }

  // (4) Verify credentials. A null result (unknown email OR wrong password) is
  // a recorded failure mapped to the generic message (Req 2.2, 2.9).
  const user = await verifyCredentials(email, password);
  if (user === null) {
    await recordLoginAttempt(normalizedEmail, false);
    return { ok: false, message: INVALID_CREDENTIALS_MESSAGE, email };
  }

  // Success: create the DB-backed session (Req 2.1) and record the attempt.
  await createUserSession(user.id);
  await recordLoginAttempt(normalizedEmail, true);
  return { ok: true };
}

/**
 * Sign the current user out (Req 2.5). Deletes the user's `sessions` row from
 * Postgres and clears the session cookie via `destroyUserSession`, then
 * redirects to `/login`. The guarded layout also enforces the redirect for any
 * unauthenticated request.
 */
export async function logout(): Promise<void> {
  await destroyUserSession();
  redirect("/login");
}
