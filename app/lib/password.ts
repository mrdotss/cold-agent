import "server-only";

import argon2 from "argon2";

/**
 * Password hashing / verification helpers (Req 1.1, 1.5).
 *
 * Factored out of the auth flow so both `lib/auth.ts` (login `authorize`) and
 * the `registerUser` server action (task 8.2) hash and verify passwords the
 * same way. Uses argon2id — the recommended general-purpose variant balancing
 * resistance to GPU and side-channel attacks.
 *
 * `server-only` guarantees this module can never be bundled into client code:
 * password hashes and the argon2 native binding stay on the server. The plain
 * text password is only ever held transiently in memory here and is never
 * persisted (Req 1.5); callers store only the returned hash.
 */

/** argon2id with library defaults (memory/time/parallelism cost). */
const HASH_OPTIONS = { type: argon2.argon2id } as const;

/**
 * Hash a plaintext password with argon2id.
 *
 * @returns an encoded argon2 hash string (includes algorithm, parameters, salt,
 *          and digest) suitable for storage in `users.password_hash`.
 */
export function hashPassword(plaintext: string): Promise<string> {
  return argon2.hash(plaintext, HASH_OPTIONS);
}

/**
 * Verify a plaintext password against a stored argon2 hash.
 *
 * Returns `false` (never throws) when the hash is malformed or verification
 * fails, so callers can treat any non-`true` result as "invalid credentials"
 * without leaking whether the failure was a bad hash or a wrong password
 * (Req 2.2).
 *
 * @param hash      the stored argon2 hash (`users.password_hash`).
 * @param plaintext the candidate password to check.
 */
export async function verifyPassword(
  hash: string,
  plaintext: string,
): Promise<boolean> {
  try {
    return await argon2.verify(hash, plaintext);
  } catch {
    return false;
  }
}
