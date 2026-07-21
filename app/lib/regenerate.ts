/**
 * Regenerate re-invocation wiring (Req 14.3, 14.4) — pure, hermetic helpers.
 *
 * "Regenerate" lets a user re-run the agent for an assistant message. This
 * module isolates the two decisions the feature turns on so they can be
 * unit/property-tested with no React, no fetch, and no I/O:
 *
 *  1. WHICH prompt to re-send — the nearest **preceding User prompt** (the user
 *     turn immediately before the target assistant message), via
 *     {@link precedingUserPrompt}.
 *  2. WHETHER the action is enabled — disabled when no preceding user prompt
 *     exists, via {@link canRegenerate} (Req 14.4).
 *
 * ## How regeneration reuses the existing session id (Req 14.3)
 * Regeneration does NOT create a new thread or a new runtime session. The UI
 * (task 15.2 `MessageActions`) resolves the preceding user prompt with these
 * helpers and re-invokes through the **same** `POST /api/chat` with the **same**
 * `threadId` — e.g. `useAgentStream(threadId).send(precedingUserPrompt(...))`.
 *
 * The relay (`app/app/api/chat/route.ts`) derives `runtimeSessionId` from the
 * thread's persisted `session_id` (`thread.sessionId`) and never regenerates it.
 * So re-invoking with the same `threadId` inherently reuses the thread's
 * existing Session_Id — preserving the agent's memory continuity for that
 * conversation. No new session id is minted here or anywhere in the regenerate
 * path.
 *
 * These helpers deliberately keep the actual network call in the hook
 * (task 14.1); they only compute the prompt + enablement so both the hook and
 * the message-action UI can consume them without duplicating the rules.
 */

/**
 * Minimal message shape these helpers need: a role and its text content. This
 * is structurally compatible with `MessageView` from `lib/actions/threads.ts`
 * (whose `role` is `"user" | "assistant"`), so ordered thread messages can be
 * passed straight in without mapping.
 */
export interface RegenerateMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Arguments for a regenerate re-invocation. Intentionally carries ONLY the
 * stable `threadId` (which selects the thread's existing session id server-side)
 * and the resolved preceding-user `prompt` — never a session id and never any
 * account secret. The UI passes `prompt` to the stream hook's `send(prompt)` for
 * the same `threadId`.
 */
export interface RegenerateArgs {
  threadId: string;
  prompt: string;
}

/**
 * Return the content of the nearest User message BEFORE the assistant message at
 * `assistantIndex`, or `null` when there is none (Req 14.3, 14.4).
 *
 * Scans backwards from `assistantIndex - 1` and returns the first `user` turn's
 * content. Out-of-range indices and empty inputs safely yield `null`. The
 * message at `assistantIndex` itself is never considered a candidate.
 */
export function precedingUserPrompt(
  messages: readonly RegenerateMessage[],
  assistantIndex: number,
): string | null {
  if (!Number.isInteger(assistantIndex)) {
    return null;
  }
  // Clamp the search start to the end of the array so an index past the end
  // still scans every preceding message.
  const start = Math.min(assistantIndex - 1, messages.length - 1);
  for (let i = start; i >= 0; i -= 1) {
    const message = messages[i];
    if (message !== undefined && message.role === "user") {
      return message.content;
    }
  }
  return null;
}

/**
 * Whether the regenerate action is ENABLED for the assistant message at
 * `assistantIndex` (Req 14.4).
 *
 * True iff a preceding user prompt exists AND is non-empty (ignoring
 * surrounding whitespace); otherwise the UI disables regenerate and MUST NOT
 * invoke the agent. This keeps the disable rule identical to what would produce
 * a valid `POST /api/chat` body.
 */
export function canRegenerate(
  messages: readonly RegenerateMessage[],
  assistantIndex: number,
): boolean {
  const prompt = precedingUserPrompt(messages, assistantIndex);
  return prompt !== null && prompt.trim().length > 0;
}

/**
 * Build the {@link RegenerateArgs} for re-invoking the given thread, or `null`
 * when regeneration is disabled ({@link canRegenerate} is false).
 *
 * The returned `prompt` is the resolved preceding user prompt; the caller feeds
 * it to `send(prompt)` on the stream hook for the SAME `threadId`, which reuses
 * the thread's existing session id server-side (Req 14.3). Returns `null` rather
 * than throwing so the UI can treat a disabled action uniformly (Req 14.4).
 */
export function regenerateArgs(
  threadId: string,
  messages: readonly RegenerateMessage[],
  assistantIndex: number,
): RegenerateArgs | null {
  if (typeof threadId !== "string" || threadId.length === 0) {
    return null;
  }
  const prompt = precedingUserPrompt(messages, assistantIndex);
  if (prompt === null || prompt.trim().length === 0) {
    return null;
  }
  return { threadId, prompt };
}
