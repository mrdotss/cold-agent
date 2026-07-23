import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/lib/auth";
import {
  deleteConversation,
  getConversationOwned,
  renameConversation,
} from "@/lib/history/conversations";
import { listMessages } from "@/lib/history/messages";

/**
 * Per-conversation route (Req 7.3, 8.4, 8.5, 8.6, 11.2).
 *
 *  - `GET` returns the conversation's messages oldest-first (each carrying its
 *    persisted `charts`, `id`, and `feedback`) plus the conversation metadata the
 *    client hydrates from (`title`, `titleSource`, `accountId`, `messageCount`).
 *  - `PATCH { title }` renames the conversation with `titleSource: "user"`.
 *  - `DELETE` removes the conversation and all of its messages.
 *
 * Every verb is auth-guarded (401 when the session is absent, Req 7.2) and
 * ownership-gated: `getConversationOwned(userId, id)` runs FIRST and a `null`
 * result (absent or not owned) becomes a bare 404 that leaks no attribute,
 * `sessionId`, or message of the conversation (Req 7.3). `userId` is always
 * derived from `auth()`, never from the request (Req 7.1). Inputs are
 * zod-validated before any store access (Req 7.5).
 *
 * Pinned to the **Node runtime** (Req 7.6): the history store reaches DynamoDB
 * via the AWS SDK, which is unavailable on edge.
 */
export const runtime = "nodejs";

/** Request body accepted by `PATCH /api/conversations/[id]`. */
const renameBodySchema = z.object({
  // Trim first, then require non-empty and at most 100 chars on the trimmed
  // value (Req 11.1, 11.2). `parsed.data.title` is therefore already trimmed.
  title: z.string().trim().min(1).max(100),
});

/** Dynamic route params. In this Next version `params` is a Promise. */
type RouteContext = { params: Promise<{ id: string }> };

/**
 * Return the owned conversation's messages oldest-first (with persisted charts,
 * `id`, and feedback) plus the conversation metadata for client hydration. A
 * not-owned/absent conversation → 404 leaking no attribute (Req 8.4, 6.2, 6.7,
 * 7.3).
 */
export async function GET(
  _request: Request,
  { params }: RouteContext,
): Promise<NextResponse> {
  const session = await auth();
  const userId = session?.user?.id;
  if (typeof userId !== "string" || userId.length === 0) {
    return NextResponse.json(
      { error: "You must be signed in." },
      { status: 401 },
    );
  }

  const { id } = await params;

  const conversation = await getConversationOwned(userId, id);
  if (conversation === null) {
    return NextResponse.json(
      { error: "Conversation not found." },
      { status: 404 },
    );
  }

  const messages = await listMessages(userId, id);

  return NextResponse.json(
    {
      conversation: {
        conversationId: conversation.conversationId,
        title: conversation.title,
        titleSource: conversation.titleSource,
        accountId: conversation.accountId,
        messageCount: conversation.messageCount,
      },
      messages,
    },
    { status: 200 },
  );
}

/**
 * Rename an owned conversation, recording `titleSource: "user"` (Req 8.5, 11.2).
 * Validates the title with zod before any store access; a not-owned/absent
 * conversation → 404 (Req 7.3).
 */
export async function PATCH(
  request: Request,
  { params }: RouteContext,
): Promise<NextResponse> {
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

  const parsed = renameBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid title." }, { status: 400 });
  }

  const { id } = await params;

  const conversation = await getConversationOwned(userId, id);
  if (conversation === null) {
    return NextResponse.json(
      { error: "Conversation not found." },
      { status: 404 },
    );
  }

  await renameConversation(userId, id, parsed.data.title, "user");

  return NextResponse.json(
    { title: parsed.data.title, titleSource: "user" },
    { status: 200 },
  );
}

/**
 * Delete an owned conversation and all of its messages (Req 8.6, 6.6). A
 * not-owned/absent conversation → 404 (Req 7.3).
 */
export async function DELETE(
  _request: Request,
  { params }: RouteContext,
): Promise<NextResponse> {
  const session = await auth();
  const userId = session?.user?.id;
  if (typeof userId !== "string" || userId.length === 0) {
    return NextResponse.json(
      { error: "You must be signed in." },
      { status: 401 },
    );
  }

  const { id } = await params;

  const conversation = await getConversationOwned(userId, id);
  if (conversation === null) {
    return NextResponse.json(
      { error: "Conversation not found." },
      { status: 404 },
    );
  }

  await deleteConversation(userId, id);

  return NextResponse.json({ success: true }, { status: 200 });
}
