import "server-only";

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { requireEnv } from "@/lib/env";

/**
 * Report presign (Report_Service).
 *
 * On a `report_file` SSE event the Chat_Relay hands the report `key` to this
 * module, which authorizes it against the signed-in User's `actor_id` and mints
 * a short-lived presigned S3 GET on `CBA_REPORT_BUCKET` (Req 11.1–11.4).
 *
 * `server-only` guarantees this module is never bundled into a client (it touches
 * AWS credentials and mints URLs). Under Node/Vitest the import is a no-op, so the
 * two PURE helpers below (`keyBelongsToActor`, `reportFileType`) are directly
 * unit/property-testable — same pattern as `lib/crypto.ts`.
 */

/**
 * Fixed report key prefix, matching the deployed runtime's `REPORT_PREFIX`
 * (see `agent/` — `cloud-bill-analyst/reports/`). Report keys have the exact
 * shape `cloud-bill-analyst/reports/<actor_id>/<filename>`.
 */
export const REPORT_PREFIX = "cloud-bill-analyst/reports/";

/**
 * Default presigned-URL lifetime in seconds. Kept short (Req 11.2 requires a
 * value in the inclusive range [1, 300]).
 */
export const DEFAULT_EXPIRES_IN_SECONDS = 300;

export interface PresignResult {
  url: string;
  fileType: "pdf" | "xlsx";
  expiresIn: number;
}

/**
 * Thrown when a report `key` is not authorized for the given actor (Req 11.3).
 * A rejected key mints NO URL.
 */
export class ReportAuthorizationError extends Error {
  constructor(message = "Report key is not authorized for this user") {
    super(message);
    this.name = "ReportAuthorizationError";
    Object.setPrototypeOf(this, ReportAuthorizationError.prototype);
  }
}

/**
 * Thrown when the presign cannot complete — a missing key, a missing
 * `CBA_REPORT_BUCKET`, an unsupported report file type, or a failure inside the
 * S3 presigner (Req 11.4). Callers get a typed failure and never a partial or
 * malformed URL.
 */
export class PresignError extends Error {
  constructor(message = "Failed to presign report URL", options?: { cause?: unknown }) {
    super(message);
    this.name = "PresignError";
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
    Object.setPrototypeOf(this, PresignError.prototype);
  }
}

/**
 * Pure helper: derive the report file type from a key's extension (Req 11.6).
 *
 * Returns `"pdf"` for a `.pdf` key, `"xlsx"` for a `.xlsx` key, and `null` for
 * anything else. The extension check is case-insensitive.
 */
export function reportFileType(key: string): "pdf" | "xlsx" | null {
  if (typeof key !== "string") return null;
  const lower = key.toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".xlsx")) return "xlsx";
  return null;
}

/**
 * Pure helper: authorize a report `key` for `actorId` (Req 11.3).
 *
 * Returns `true` IFF `key` has the EXACT form
 * `cloud-bill-analyst/reports/<actorId>/<filename>` where:
 *   - `key` begins with the fixed {@link REPORT_PREFIX};
 *   - the path segment immediately following the prefix equals `actorId`
 *     exactly (not a prefix/substring of some other actor id);
 *   - a single, non-empty `<filename>` segment follows that actor segment.
 *
 * This is deliberately NOT a `startsWith`/`includes` check: a key like
 * `cloud-bill-analyst/reports/<actorId>-evil/f.pdf` or
 * `cloud-bill-analyst/reports/<other>/<actorId>/f.pdf` must NOT authorize.
 */
export function keyBelongsToActor(actorId: string, key: string): boolean {
  if (typeof actorId !== "string" || typeof key !== "string") return false;
  // An empty or slash-bearing actor id can never be a single path segment.
  if (actorId.length === 0 || actorId.includes("/")) return false;
  if (!key.startsWith(REPORT_PREFIX)) return false;

  const remainder = key.slice(REPORT_PREFIX.length);
  const segments = remainder.split("/");

  // Exactly `<actorId>/<filename>`: two segments, both meaningful.
  if (segments.length !== 2) return false;
  return segments[0] === actorId && segments[1].length > 0;
}

/**
 * Authorize `key` for `actorId`, then mint a presigned S3 GET on
 * `CBA_REPORT_BUCKET` with an expiry in [1, 300]s (Req 11.1–11.4).
 *
 * @throws {ReportAuthorizationError} when `key` is not authorized for `actorId`.
 * @throws {PresignError} when `key`/`CBA_REPORT_BUCKET` is missing, the report
 *   type is unsupported, or the presign operation fails. Never returns a
 *   partial or malformed URL.
 */
export async function presignReport(actorId: string, key: string): Promise<PresignResult> {
  if (!key) {
    throw new PresignError("Cannot presign report: missing key");
  }

  // Authorize BEFORE touching any AWS resource so a rejected key mints no URL.
  if (!keyBelongsToActor(actorId, key)) {
    throw new ReportAuthorizationError();
  }

  const fileType = reportFileType(key);
  if (fileType === null) {
    throw new PresignError("Cannot presign report: unsupported file type");
  }

  const bucket = process.env.CBA_REPORT_BUCKET;
  if (!bucket) {
    throw new PresignError("Cannot presign report: missing CBA_REPORT_BUCKET");
  }

  const expiresIn = DEFAULT_EXPIRES_IN_SECONDS;

  let url: string;
  try {
    const region = requireEnv("AWS_REGION");
    const client = new S3Client({ region });
    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    url = await getSignedUrl(client, command, { expiresIn });
  } catch (cause) {
    throw new PresignError("Failed to presign report URL", { cause });
  }

  // Guard against a partial/malformed result (Req 11.4).
  if (typeof url !== "string" || url.length === 0) {
    throw new PresignError("Presign produced an empty URL");
  }

  return { url, fileType, expiresIn };
}
