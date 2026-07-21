import { randomBytes } from "node:crypto";

/**
 * External_Id generation.
 *
 * An External_Id is a per-account secret used in the cross-account role trust
 * condition (`sts:ExternalId`) and in the agent invocation context. It must be
 * between 16 and 1224 characters in length and unique across connections
 * (Req 3.1).
 *
 * The value is high-entropy and charset-safe for STS ExternalId, which permits
 * `[\w+=,.@:/-]`: base64url uses only `A-Za-z0-9-_`, all of which are allowed.
 */

/**
 * Generate a cryptographically random External_Id.
 *
 * Encodes 32 random bytes as base64url, producing exactly 43 characters (no
 * padding), which sits comfortably inside the inclusive [16, 1224] bound.
 * Generated values are distinct with overwhelming probability (256 bits of
 * entropy).
 */
export function newExternalId(): string {
  // 32 bytes -> ceil(32 * 4 / 3) = 43 base64url chars, always length 43.
  return randomBytes(32).toString("base64url");
}
