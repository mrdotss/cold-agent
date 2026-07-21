"use server";

import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  messageFeedback,
  messages,
  threads,
  type FeedbackValue,
} from "@/lib/db/schema";

/**
 * Message-feedback server action (Req 14.5, 14.6, 14.7, 14.8).
 *
 * A message may carry AT MOST ONE feedback value (`message_feedback.message_id`
 * is the PK). Setting a value inserts-or-replaces that single row; passing
 * `null` (or the value equal to the currently stored one — the UI resolves the
 * toggle) removes the row and returns the message to the no-feedback state.
 *
 * ## Boundaries honored here
 *  - Requires an authenticated user; an unauthenticated caller is rejected.
 *  - OWNERSHIP-CHECKED: the target message must belong to a thread owned by the
 *    signed-in user (join messages→threads→userId). A message the caller does
 *    not own is indistinguishable from one that does not exist — neither its
 *    existence nor its feedback is ever mutated or revealed (Req 14.5, 14.6).
 *  - Returns a TYPED result and never throws for expected outcomes. On any
 *    failure the result is `{ ok: false }` so the UI can RETAIN the previously
 *    displayed feedback state and surface a subtle error (Req 14.7).
 *
 * `"use server"` marks this as a server action; it only ever runs server-side
 * and safely imports the `server-only` db/auth modules.
 */

/** The resolved feedback after a successful call (`null` = no feedback). */
export type FeedbackResultState = FeedbackValue | null;

/** Result of {@link setMessageFeedback} (never throws for expected outcomes). */
export type SetMessageFeedbackResult =
  | { ok: true; value: FeedbackResultState }
  | { ok: false; message: string };

/**
 * Accepted `value` argument: a concrete feedback value, or `null` to clear the
 * stored feedback for the message.
 */
const feedbackValueSchema = z.union([
  z.literal("up"),
  z.literal("down"),
  z.null(),
]);

/**
 * Persist, replace, or clear the feedback for a single assistant message.
 *
 * @param messageId The target message id (must belong to the caller's thread).
 * @param value `"up"` / `"down"` sets or replaces the single feedback row;
 *   `null` removes it (Req 14.5, 14.6).
 *
 * Returns `{ ok: true, value }` with the resulting stored state on success, or
 * `{ ok: false, message }` on any failure so the UI retains prior state
 * (Req 14.7).
 */
export async function setMessageFeedback(
  messageId: string,
  value: FeedbackValue | null,
): Promise<SetMessageFeedbackResult> {
  const session = await auth();
  const userId = session?.user?.id;
  if (typeof userId !== "string" || userId.length === 0) {
    return { ok: false, message: "You must be signed in to rate a message." };
  }

  if (typeof messageId !== "string" || messageId.length === 0) {
    return { ok: false, message: "Could not save feedback. Please retry." };
  }

  const parsedValue = feedbackValueSchema.safeParse(value);
  if (!parsedValue.success) {
    return { ok: false, message: "Could not save feedback. Please retry." };
  }
  const nextValue = parsedValue.data;

  try {
    const db = getDb();

    // Ownership gate: confirm the message exists AND its thread belongs to this
    // user before any mutation (join messages→threads→userId). A non-owned or
    // missing message never mutates state and is reported uniformly (Req 14.5).
    const [owned] = await db
      .select({ id: messages.id })
      .from(messages)
      .innerJoin(threads, eq(messages.threadId, threads.id))
      .where(and(eq(messages.id, messageId), eq(threads.userId, userId)))
      .limit(1);

    if (owned === undefined) {
      return { ok: false, message: "Could not save feedback. Please retry." };
    }

    if (nextValue === null) {
      // Clear the stored feedback → return to the no-feedback state (Req 14.6).
      await db
        .delete(messageFeedback)
        .where(eq(messageFeedback.messageId, messageId));
      return { ok: true, value: null };
    }

    // Insert-or-replace the single feedback row (upsert on the message_id PK):
    // submitting a value replaces any previously stored value (Req 14.5).
    await db
      .insert(messageFeedback)
      .values({ messageId, value: nextValue })
      .onConflictDoUpdate({
        target: messageFeedback.messageId,
        set: { value: nextValue },
      });

    return { ok: true, value: nextValue };
  } catch {
    // Any persistence failure: report an error so the UI retains prior state
    // (Req 14.7). The specific cause is never leaked to the browser.
    return { ok: false, message: "Could not save feedback. Please retry." };
  }
}
