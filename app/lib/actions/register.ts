"use server";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { z } from "zod";

import { createUserSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { hashPassword } from "@/lib/password";
import { emailSchema, normalizeEmail, passwordSchema } from "@/lib/validation";

/**
 * `registerUser` server action (Req 1) — open self-serve email/password
 * registration for the MVP (no email verification).
 *
 * Flow (matches the design "Server actions" contract):
 *  1. Validate the submitted email + password with the shared zod schemas
 *     (`emailSchema`, `passwordSchema`). On failure, persist nothing and return
 *     a field-identifying validation message (Req 1.3, 1.4).
 *  2. Normalize the email (`trim().toLowerCase()`) and reject a case-insensitive
 *     / trim-insensitive duplicate against `users.email_normalized`, creating no
 *     new row (Req 1.2). A pre-check gives a friendly message; the DB UNIQUE
 *     constraint is the source of truth and is caught for the concurrent-signup
 *     race.
 *  3. argon2-hash the password (only the hash is ever stored — plaintext is
 *     never persisted, Req 1.5) and insert exactly one `users` row (Req 1.1).
 *  4. Establish a database-backed session bound to the new user by calling
 *     `createUserSession(newUserId)`, which mints a `sessions` row (30-day
 *     `expires`) and sets the HttpOnly session cookie (Req 1.6).
 *
 * ## Session-creation approach
 *
 * We call `createUserSession(newUserId)` — the same self-managed DB-session path
 * that login uses after credential verification — so registration and login
 * create sessions identically. The session cookie (the client's session
 * identifier) is set on the response; the caller (the auth UI) decides where to
 * route next (Req 1.6).
 *
 * Returns a typed result object instead of throwing, so the form UI can render
 * field-level errors. Internal errors are never leaked to the caller.
 *
 * `use server` marks every export as a server action; this module is only ever
 * invoked server-side and safely imports the `server-only` db/auth/password
 * modules.
 */

/** Fields that a validation failure can be attributed to. */
export type RegisterField = "email" | "password";

/** Result of a {@link registerUser} call (never throws for expected outcomes). */
export type RegisterResult =
  | { ok: true }
  | { ok: false; field?: RegisterField; message: string };

/** Raw, unvalidated input accepted from the registration form. */
export interface RegisterInput {
  email: string;
  password: string;
}

/**
 * Combined field schema. Both fields are validated together so a single parse
 * yields all issues; the field attribution below prioritizes the email field.
 */
const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});

/** Postgres unique-violation SQLSTATE (node-postgres surfaces it as `code`). */
const PG_UNIQUE_VIOLATION = "23505";

/** True when an unknown error is a Postgres unique-constraint violation. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}

/**
 * Register a new user and start an authenticated, database-backed session.
 *
 * @param input the raw email/password submitted by the visitor.
 * @returns `{ ok: true }` on success, or `{ ok: false, field?, message }` on a
 *          validation failure or duplicate email.
 */
export async function registerUser(
  input: RegisterInput,
): Promise<RegisterResult> {
  // 1. Validate — persist nothing on failure (Req 1.3, 1.4).
  const parsed = registerSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues;
    // Prefer an email-field message, else password, else a generic fallback.
    const emailIssue = issues.find((issue) => issue.path[0] === "email");
    const passwordIssue = issues.find((issue) => issue.path[0] === "password");
    const chosen = emailIssue ?? passwordIssue ?? issues[0];
    const field: RegisterField | undefined =
      chosen === emailIssue
        ? "email"
        : chosen === passwordIssue
          ? "password"
          : undefined;
    return {
      ok: false,
      field,
      message: chosen?.message ?? "Invalid registration details",
    };
  }

  const { email, password } = parsed.data;
  const emailNormalized = normalizeEmail(email);
  const db = getDb();

  // 2. Reject an existing (case-insensitive / trim-insensitive) email (Req 1.2).
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.emailNormalized, emailNormalized))
    .limit(1);
  if (existing !== undefined) {
    return {
      ok: false,
      field: "email",
      message: "That email is already in use",
    };
  }

  // 3. Hash the password (only the hash is stored, Req 1.5) and insert one row.
  const passwordHash = await hashPassword(password);
  const newUserId = randomUUID();
  try {
    await db.insert(users).values({
      id: newUserId,
      email,
      emailNormalized,
      passwordHash,
    });
  } catch (error) {
    // Lost the race with a concurrent signup for the same normalized email:
    // the UNIQUE constraint on `email_normalized` is the source of truth, so no
    // second row was created (Req 1.2).
    if (isUniqueViolation(error)) {
      return {
        ok: false,
        field: "email",
        message: "That email is already in use",
      };
    }
    // Do not leak internal error details to the caller.
    return {
      ok: false,
      message: "Registration failed. Please try again.",
    };
  }

  // 4. Establish a DB-backed session bound to the new user (Req 1.6). Mints a
  //    `sessions` row and sets the HttpOnly session cookie.
  try {
    await createUserSession(newUserId);
  } catch {
    // The user row exists, so the visitor can sign in directly; surface a
    // generic message rather than leaking internal error details.
    return {
      ok: false,
      message: "Account created, but sign-in failed. Please log in.",
    };
  }

  return { ok: true };
}
