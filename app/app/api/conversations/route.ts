import { NextResponse } from "next/server";
import { z } from "zod";

import { listConnectedAccounts } from "@/lib/actions/accounts";
import { auth } from "@/lib/auth";
import {
  createConversation,
  listConversations,
} from "@/lib/history/conversations";

/**
 * Conversations collection route (Req 7.2, 7.5, 7.6, 8.1, 8.2, 8.3).
 *
 *  - `GET` lists the authenticated user's conversations, most-recently-updated
 *    first, by delegating to {@link listConversations} (a `GSI1` query with
 *    `ScanIndexForward = false`). Conversations not owned by the user never
 *    appear because the store keys every read on `PK = USER#<userId>` (Req 8.3).
 *  - `POST { accountId }` verifies the account is owned by the user in Postgres,
 *    then creates exactly one conversation pinned to that account with
 *    `titleSource: "pending"` via {@link createConversation}, returning its
 *    `conversationId` (201). A user who owns zero accounts, or who names an
 *    `accountId` they do not own, is rejected with a typed 400 and no
 *    conversation is created (Req 8.1, 8.2).
 *
 * Both verbs are auth-guarded: `userId` is derived from `auth()` and never from
 * the browser (Req 7.2); an unauthenticated caller is rejected with 401 before
 * any History_Table access. The `POST` body is zod-validated before any
 * DynamoDB access, returning a typed error on failure (Req 7.5).
 *
 * Pinned to the **Node runtime** (Req 7.6): the handlers reach DynamoDB via the
 * document client and Postgres via the accounts action, neither available on
 * edge.
 */
export const runtime = "nodejs";

/** Request body accepted by `POST /api/conversations`. */
const createBodySchema = z.object({
  accountId: z.string().min(1),
});

/**
 * List the authenticated user's conversations, most-recently-updated first
 * (Req 8.3). Rejects unauthenticated callers (401) before any store access.
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

  const conversations = await listConversations(userId);
  return NextResponse.json({ conversations }, { status: 200 });
}

/**
 * Create one conversation pinned to an owned Connected_Account (Req 8.1, 8.2).
 *
 * Rejects unauthenticated callers (401) and malformed bodies (400) before any
 * store access. Verifies account ownership in Postgres via
 * {@link listConnectedAccounts}; a user with zero accounts or one who names an
 * `accountId` they do not own is rejected with a typed 400 and no conversation
 * is created. On success returns the new `conversationId` (201).
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

  // Validate the body BEFORE any store access (Req 7.5).
  const parsed = createBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid conversation details." },
      { status: 400 },
    );
  }

  // Verify the account is owned by this user in Postgres. `listConnectedAccounts`
  // derives the user from the session and returns only that user's accounts, so
  // membership in this list is the ownership proof. An empty list means the user
  // owns zero accounts (Req 8.2).
  const accounts = await listConnectedAccounts();
  const ownsAccount = accounts.some(
    (account) => account.id === parsed.data.accountId,
  );
  if (!ownsAccount) {
    return NextResponse.json(
      { error: "Connect an AWS account before starting a conversation." },
      { status: 400 },
    );
  }

  // Create exactly one conversation with titleSource "pending" (Req 8.1).
  const conversation = await createConversation(userId, parsed.data.accountId);
  return NextResponse.json(
    { conversationId: conversation.conversationId },
    { status: 201 },
  );
}
