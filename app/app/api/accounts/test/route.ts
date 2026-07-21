import { NextResponse } from "next/server";
import { z } from "zod";

import { testConnection } from "@/lib/aws/sts";
import { auth } from "@/lib/auth";
import { aliasSchema, roleArnSchema } from "@/lib/validation";

/**
 * Connection-test route (Req 4.1, 4.2, 4.5, 18.6).
 *
 * `POST` validates the pending connection's `roleArn` + `alias` + `externalId`,
 * then runs {@link testConnection} (assume the role + a minimal Cost Explorer
 * probe within 30s). It returns `{ ok, category? }` with only a coarse failure
 * category — never the External_Id, role credentials, or internal identifiers
 * (Req 4.5).
 *
 * Invalid input is rejected at the route boundary BEFORE any assume-role
 * (Req 4.2, 18.6); `testConnection` re-validates defensively, so no STS call is
 * made on malformed input.
 *
 * Pinned to the **Node runtime**: the STS SDK call and secret handling must stay
 * server-side and off the edge runtime.
 */
export const runtime = "nodejs";

/** STS ExternalId permitted charset + bounds mirror `lib/aws/sts` (Req 3.1). */
const EXTERNAL_ID_REGEX = /^[\w+=,.@:/-]+$/;

/** Request body accepted by `POST /api/accounts/test`. */
const testBodySchema = z.object({
  alias: aliasSchema,
  roleArn: roleArnSchema,
  externalId: z
    .string()
    .min(16)
    .max(1224)
    .regex(EXTERNAL_ID_REGEX),
});

/**
 * Test a pending connection. Rejects unauthenticated callers (401) and malformed
 * bodies (400, no assume-role), then returns the categorized test result.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const session = await auth();
  const userId = session?.user?.id;
  if (typeof userId !== "string" || userId.length === 0) {
    return NextResponse.json(
      { error: "You must be signed in." },
      { status: 401 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const parsed = testBodySchema.safeParse(body);
  if (!parsed.success) {
    // Reject invalid input before any assume-role (Req 4.2, 18.6).
    return NextResponse.json(
      { ok: false, category: "invalid_input", error: "Invalid connection details." },
      { status: 400 },
    );
  }

  const result = await testConnection(parsed.data.roleArn, parsed.data.externalId);
  return NextResponse.json(result, { status: 200 });
}
