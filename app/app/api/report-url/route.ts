import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/lib/auth";
import {
  PresignError,
  ReportAuthorizationError,
  presignReport,
} from "@/lib/aws/s3";

/**
 * Report presign route (Report_Service, Req 11.1–11.4).
 *
 * `GET /api/report-url?key=<report-key>` mints a short-lived presigned S3 GET URL
 * for a report object on `CBA_REPORT_BUCKET`. A `GET` with a query param is the
 * natural shape for the browser to fetch a download URL once a `report_file` SSE
 * event surfaces a `key`.
 *
 * The route is a thin, auth-guarded boundary over {@link presignReport}:
 *  - Reject unauthenticated callers (401) before any presign (Req 15.x / defense
 *    in depth): no session ⇒ no URL.
 *  - zod-validate that `key` is a non-empty string; a missing/empty key is a 400
 *    and never reaches the presigner (Req 11.4).
 *  - Authorization (the key's actor prefix must match the signed-in user) is
 *    enforced inside `presignReport` via `keyBelongsToActor`; a
 *    {@link ReportAuthorizationError} maps to 403 and mints no URL (Req 11.3).
 *  - A {@link PresignError} (missing key/bucket, unsupported type, or a presigner
 *    failure) maps to a typed 400/500; the route NEVER returns a partial or
 *    malformed URL (Req 11.4).
 *  - On success returns `{ url, fileType, expiresIn }` (Req 11.1, 11.2).
 *
 * Generic error messages only — internal error details and secrets are never
 * leaked to the browser (Req 15.2).
 *
 * Pinned to the **Node runtime**: `presignReport` uses the AWS SDK (S3 presigner)
 * and reads server-only credentials/env, which are unavailable on edge.
 */
export const runtime = "nodejs";

/** Query params accepted by `GET /api/report-url`. */
const querySchema = z.object({
  key: z.string().min(1),
});

/**
 * Mint a presigned report URL for the authenticated user. Rejects unauthenticated
 * callers (401) and a missing/empty `key` (400) before touching AWS; maps
 * authorization failures to 403 and presign failures to 500, never returning a
 * partial URL.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const session = await auth();
  const actorId = session?.user?.id;
  if (typeof actorId !== "string" || actorId.length === 0) {
    return NextResponse.json(
      { error: "You must be signed in." },
      { status: 401 },
    );
  }

  const { searchParams } = new URL(request.url);
  const parsed = querySchema.safeParse({ key: searchParams.get("key") });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "A report key is required." },
      { status: 400 },
    );
  }

  try {
    const { url, fileType, expiresIn } = await presignReport(
      actorId,
      parsed.data.key,
    );
    return NextResponse.json({ url, fileType, expiresIn }, { status: 200 });
  } catch (error) {
    if (error instanceof ReportAuthorizationError) {
      return NextResponse.json(
        { error: "You are not authorized to access this report." },
        { status: 403 },
      );
    }
    if (error instanceof PresignError) {
      return NextResponse.json(
        { error: "Could not generate the report download link." },
        { status: 500 },
      );
    }
    throw error;
  }
}
