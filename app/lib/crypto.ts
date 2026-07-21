import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { requireEnv } from "@/lib/env";

/**
 * Symmetric encryption for secrets at rest (each connected account's
 * `external_id`) using AES-256-GCM (Req 4.4, 4.6, 18.5).
 *
 * `server-only` guarantees this module can never be pulled into a client bundle
 * (it touches the encryption key). Under Node/Vitest the import is a no-op, so
 * these functions are directly testable.
 *
 * Contract:
 *   - `encryptSecret(x)` returns a single self-contained base64 string encoding
 *     `iv | authTag | ciphertext`.
 *   - `decryptSecret(encryptSecret(x)) === x` for any UTF-8 string `x`.
 *   - Two encryptions of the same plaintext differ (fresh random IV per call).
 *   - `decryptSecret` throws on tampered/invalid input (GCM tag verification).
 *
 * The key is read at CALL TIME via `requireEnv("APP_ENCRYPTION_KEY")` (not at
 * module load), so request-time evaluation works and tests can set the env var
 * immediately before calling.
 */

/** AES-256 requires a 32-byte key. */
const KEY_BYTES = 32;
/** GCM standard/recommended IV length is 12 bytes. */
const IV_BYTES = 12;
/** GCM authentication tag length. */
const TAG_BYTES = 16;

const ALGORITHM = "aes-256-gcm";

/**
 * Resolve the 32-byte AES key from `APP_ENCRYPTION_KEY`.
 *
 * The documented, primary contract is a base64-encoded 32-byte key (see
 * `.env.example`). As a convenience we also accept a value that is already
 * exactly 32 raw bytes (e.g. a raw utf-8/ascii passphrase of length 32).
 *
 * Throws a clear error naming the variable (never its value) if the key does
 * not resolve to exactly 32 bytes.
 */
function getKey(): Buffer {
  const raw = requireEnv("APP_ENCRYPTION_KEY");

  // Primary path: base64-of-32-bytes.
  const fromBase64 = Buffer.from(raw, "base64");
  if (fromBase64.length === KEY_BYTES) {
    return fromBase64;
  }

  // Fallback: an exactly-32-raw-byte key provided directly.
  const fromRaw = Buffer.from(raw, "utf8");
  if (fromRaw.length === KEY_BYTES) {
    return fromRaw;
  }

  throw new Error(
    `APP_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes ` +
      `(base64 of a 32-byte key, or 32 raw bytes)`,
  );
}

/**
 * Encrypt a UTF-8 plaintext string.
 *
 * @returns base64 of `iv (12B) | authTag (16B) | ciphertext`.
 */
export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_BYTES);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

/**
 * Decrypt a value produced by {@link encryptSecret}.
 *
 * Parses `iv | authTag | ciphertext` out of the base64 blob and verifies the
 * GCM auth tag. Throws on tampered or malformed input.
 *
 * @returns the original UTF-8 plaintext.
 */
export function decryptSecret(ciphertext: string): string {
  const key = getKey();
  const blob = Buffer.from(ciphertext, "base64");

  if (blob.length < IV_BYTES + TAG_BYTES) {
    throw new Error("Invalid ciphertext: too short");
  }

  const iv = blob.subarray(0, IV_BYTES);
  const authTag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = blob.subarray(IV_BYTES + TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  // `final()` throws if the auth tag does not verify (tampered input).
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString(
    "utf8",
  );
}
