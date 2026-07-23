import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { generateTitle } from "@/lib/aws/bedrock";
import {
  getConversationOwned,
  renameConversation,
} from "@/lib/history/conversations";
import { listMessages } from "@/lib/history/messages";
import { fallbackTitle, normalizeTitle } from "@/lib/title";

/**
 * AI conversation-title route (Req 10.2, 10.4–10.7, 10.9, 7.6, 12.4).
 *
 * `POST /api/conversations/[id]/title` derives a short AI title for a
 * conversation from its first user prompt. It is auth-guarded (401 when the
 * session is absent) and ownership-gated: `getConversationOwned(userId, id)`
 * runs FIRST and a `null` result → a bare 404 that leaks no attribute of the
 * conversation. `userId` is always derived from `auth()`, never the request.
 *
 * Behavior:
 *  - **Idempotent no-op** — when `titleSource !== "pending"` the route makes NO
 *    change and returns 200 WITHOUT invoking the model, so a user-set (or
 *    already-AI) title is never overwritten (Req 10.4).
 *  - **First prompt** — the client MAY pass `{ firstPrompt }` (zod-validated) to
 *    avoid racing the persisted write; when a non-empty string is provided it is
 *    preferred, otherwise the first `role: "user"` message from
 *    `listMessages(userId, id)` is used. If no first prompt is available at all,
 *    the fallback path runs with an empty prompt.
 *  - **AI title** — `generateTitle(firstPrompt)` → `normalizeTitle(result)`
 *    persisted with `renameConversation(userId, id, title, "ai")` (Req 10.5).
 *  - **Single retry** — on failure `generateTitle` is retried EXACTLY once
 *    (Req 10.6).
 *  - **Fallback** — if it still fails (including a missing `CBA_TITLE_MODEL_ID`,
 *    which `generateTitle` throws — Req 12.4), or the normalized title is empty,
 *    `fallbackTitle(firstPrompt)` is persisted with `titleSource: "ai"` so the
 *    conversation is never left `pending` (Req 10.7).
 *
 * The AgentCore runtime is NEVER invoked here — titles use only the direct
 * Bedrock Converse call in `generateTitle` (Req 10.9).
 *
 * Pinned to the **Node runtime** (Req 7.6): the history store and Bedrock reach
 * AWS via the SDK, which is unavailable on edge.
 */
export const runtime = "nodejs";

/** Dynamic route params. In this Next version `params` is a Promise. */
type RouteContext = { params: Promise<{ id: string }> };

/**
 * Optional request body. The client may pass the first user prompt directly so
 * the title can be generated before the persisted message write settles. Any
 * field is optional; an empty/whitespace-only or absent value falls back to the
 * persisted first message.
 */
const titleBodySchema = z.object({
  firstPrompt: z.string().optional(),
});

/**
 * Generate a normalized AI title with EXACTLY one retry (Req 10.6). Returns the
 * normalized (possibly empty) title on success, or `null` when both the initial
 * attempt and the single retry throw (e.g. `TitleGenerationError` or a missing
 * `CBA_TITLE_MODEL_ID`, Req 12.4). Never throws.
 */
async function generateNormalizedTitle(
  firstPrompt: string,
): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = await generateTitle(firstPrompt);
      return normalizeTitle(raw);
    } catch {
      // Swallow and either retry once or fall through to the fallback path.
    }
  }
  return null;
}

export async function POST(
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

  // Parse the OPTIONAL body before any model/store access. A missing/invalid
  // JSON body is treated as "no firstPrompt provided" — the body is optional
  // here, so it never 400s.
  let firstPromptFromBody: string | undefined;
  try {
    const parsed = titleBodySchema.safeParse(await request.json());
    if (parsed.success) {
      firstPromptFromBody = parsed.data.firstPrompt;
    }
  } catch {
    firstPromptFromBody = undefined;
  }

  const { id } = await params;

  const conversation = await getConversationOwned(userId, id);
  if (conversation === null) {
    return NextResponse.json(
      { error: "Conversation not found." },
      { status: 404 },
    );
  }

  // Idempotent no-op: a title that is already AI- or user-sourced is never
  // regenerated or overwritten, and the model is not invoked (Req 10.4).
  if (conversation.titleSource !== "pending") {
    return NextResponse.json(
      { title: conversation.title, titleSource: conversation.titleSource },
      { status: 200 },
    );
  }

  // Prefer a non-empty client-supplied prompt; otherwise read the first
  // persisted user message. When neither is available, `firstPrompt` stays "".
  let firstPrompt = "";
  if (
    typeof firstPromptFromBody === "string" &&
    firstPromptFromBody.trim().length > 0
  ) {
    firstPrompt = firstPromptFromBody;
  } else {
    const messages = await listMessages(userId, id);
    const firstUserMessage = messages.find((m) => m.role === "user");
    if (firstUserMessage !== undefined) {
      firstPrompt = firstUserMessage.content;
    }
  }

  // Generate + normalize with a single retry (Req 10.5, 10.6). A null result
  // (both attempts threw) or an empty normalized title triggers the fallback so
  // the conversation is never left pending with an empty title (Req 10.7, 12.4).
  const aiTitle = await generateNormalizedTitle(firstPrompt);
  const title =
    aiTitle !== null && aiTitle.length > 0 ? aiTitle : fallbackTitle(firstPrompt);

  await renameConversation(userId, id, title, "ai");

  return NextResponse.json({ title, titleSource: "ai" }, { status: 200 });
}
