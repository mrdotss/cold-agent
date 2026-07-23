import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { getConversationOwned } from "@/lib/history/conversations";
import { setMessageFeedback } from "@/lib/history/messages";

/**
 * Message-feedback route (Req 7.6, 14.2, 14.3, 14.5).
 *
 * Sets a thumbs-up/down mark on a single assistant message addressed by its
 * `MSG#…` sort key (the `[messageId]` path segment). Both `PATCH` and `POST`
 * are exported with identical behavior so the client may use either verb.
 *
 * Guardrails, in order:
 *  - Derive `userId` from the session; unauthenticated callers get 401 (Req 7.6).
 *  - zod-validate the body as `{ feedback: "up" | "down" }` BEFORE any DynamoDB
 *    access; an invalid body is a 400 that never touches DynamoDB (Req 14.2).
 *  - Verify ownership via `getConversationOwned(userId, id)` FIRST; a conversation
 *    the user does not own resolves to 404 and writes nothing (Req 7.6, 14.3).
 *  - `setMessageFeedback` performs the SINGLE Message_Feedback write path; it is
 *    never written to Postgres (Req 14.5).
 *
 * Pinned to the **Node runtime**: the stores reach AWS credentials via the
 * DynamoDB document client, which is unavailable on edge.
 */
export const runtime = "nodejs";

/** Request body accepted by `PATCH`/`POST` on this route. */
const feedbackBodySchema = z.object({
  feedback: z.enum(["up", "down"]),
});

/**
 * Shared handler for both verbs. Applies the auth → zod → ownership gates before
 * the single feedback write.
 *
 * The `[messageId]` segment is the message's `MSG#<createdAtIso>#<uuid>` sort key,
 * URL-encoded by the client; it is decoded with `decodeURIComponent` before being
 * passed to `setMessageFeedback` (Req 14.2).
 */
async function handleFeedback(
  request: Request,
  context: { params: Promise<{ id: string; messageId: string }> },
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

  const parsed = feedbackBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Feedback must be either \"up\" or \"down\"." },
      { status: 400 },
    );
  }

  const { id, messageId } = await context.params;
  const messageSk = decodeURIComponent(messageId);

  // Ownership gate: 404 (and no write) when the user does not own the conversation.
  const owned = await getConversationOwned(userId, id);
  if (owned === null) {
    return NextResponse.json(
      { error: "Conversation not found." },
      { status: 404 },
    );
  }

  await setMessageFeedback(userId, id, messageSk, parsed.data.feedback);

  return NextResponse.json({ ok: true }, { status: 200 });
}

/** Set feedback via `PATCH` (Req 14.2). Delegates to {@link handleFeedback}. */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; messageId: string }> },
): Promise<NextResponse> {
  return handleFeedback(request, context);
}

/** Set feedback via `POST` (identical behavior to `PATCH`). */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; messageId: string }> },
): Promise<NextResponse> {
  return handleFeedback(request, context);
}
