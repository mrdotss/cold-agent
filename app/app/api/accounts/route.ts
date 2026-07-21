import { NextResponse } from "next/server";
import { z } from "zod";

import {
  createConnectedAccount,
  listConnectedAccounts,
} from "@/lib/actions/accounts";
import { auth } from "@/lib/auth";

/**
 * Connected-accounts collection route (Req 4.4, 4.6, 4.7, 5.1, 5.2, 5.9, 18.6,
 * 18.7).
 *
 *  - `POST` creates one connected account for the authenticated user by
 *    delegating to {@link createConnectedAccount} (which enforces the count
 *    bound, encrypts the External_Id, applies the contract defaults, and
 *    associates the account with the user).
 *  - `GET` lists the user's accounts as browser-safe `ConnectedAccountView`s with
 *    every secret (`role_arn`, External_Id) stripped (Req 5.9).
 *
 * Both verbs are auth-guarded and return typed JSON errors. The body is
 * zod-validated at the route boundary before any store (Req 18.6, 18.7).
 *
 * Pinned to the **Node runtime**: the action reaches Postgres (`pg`) and uses
 * Node crypto to encrypt the External_Id, neither of which is available on edge.
 */
export const runtime = "nodejs";

/** Request body accepted by `POST /api/accounts`. */
const createBodySchema = z.object({
  alias: z.string(),
  roleArn: z.string(),
  externalId: z.string(),
});

/**
 * Create a connected account. Rejects unauthenticated callers (401) and
 * malformed bodies (400) before any store; maps a rejected creation to 400 and a
 * successful store to 201 with the browser-safe view.
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

  const parsed = createBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid account details." },
      { status: 400 },
    );
  }

  const result = await createConnectedAccount(parsed.data);
  if (!result.ok) {
    return NextResponse.json({ error: result.message }, { status: 400 });
  }

  return NextResponse.json({ account: result.account }, { status: 201 });
}

/**
 * List the authenticated user's connected accounts as `ConnectedAccountView[]`
 * (secrets stripped, Req 5.9). Rejects unauthenticated callers (401).
 */
export async function GET(): Promise<NextResponse> {
  const session = await auth();
  const userId = session?.user?.id;
  if (typeof userId !== "string" || userId.length === 0) {
    return NextResponse.json(
      { error: "You must be signed in." },
      { status: 401 },
    );
  }

  const accounts = await listConnectedAccounts();
  return NextResponse.json({ accounts }, { status: 200 });
}
