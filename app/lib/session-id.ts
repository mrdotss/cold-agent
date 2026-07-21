import { createHash, randomBytes } from "node:crypto";

/**
 * Runtime session id helpers.
 *
 * AgentCore's `runtimeSessionId` must be 33-128 characters and stable per chat
 * thread so the agent's memory follows the conversation (Req 7.9, 8.3, 8.4).
 *
 * These functions are PURE aside from the RNG inside `newSessionId`:
 * `sessionIdForThread` is a deterministic function of its input, so the same
 * `threadId` always maps to the same session id and it is never reassigned.
 *
 * Encoding is URL/charset-safe: `sessionIdForThread` emits lowercase hex and
 * `newSessionId` emits base64url (A-Za-z0-9-_), both safe to place in headers
 * and payloads.
 */

/** Namespace so thread-derived ids do not collide with other hashed values. */
const SESSION_NAMESPACE = "cba:session:v1:";

/**
 * Deterministically derive a stable session id for a chat thread.
 *
 * The same `threadId` ALWAYS yields the same session id (stable per thread,
 * never reassigned). The result is the SHA-256 hex digest of the namespaced
 * thread id, which is exactly 64 lowercase-hex characters for ANY input —
 * including the empty string and arbitrarily long inputs — so the length is
 * always within the inclusive [33, 128] bound. Distinct thread ids produce
 * distinct session ids with overwhelming probability (SHA-256 collision
 * resistance).
 */
export function sessionIdForThread(threadId: string): string {
  // 32-byte digest -> 64 hex chars, constant length regardless of input size.
  return createHash("sha256")
    .update(SESSION_NAMESPACE + threadId, "utf8")
    .digest("hex");
}

/**
 * One-shot cryptographically random session id, used at thread creation.
 *
 * Encodes 48 random bytes as base64url, producing exactly 64 characters (no
 * padding), which is comfortably inside the inclusive [33, 128] bound. Distinct
 * calls yield distinct ids with overwhelming probability (384 bits of entropy).
 */
export function newSessionId(): string {
  // 48 bytes -> ceil(48 * 4 / 3) = 64 base64url chars, always length 64.
  return randomBytes(48).toString("base64url");
}
