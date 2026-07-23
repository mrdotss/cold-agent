/**
 * Pure inline-rename decision rule (Req 11.2, 11.6) — client-safe & hermetic.
 *
 * This module is intentionally free of `"use client"`/`"use server"`, of any
 * DOM dependency, and of any `@aws-sdk`/`server-only` import so the accept vs.
 * reject decision can be imported by the sidebar rename UI AND property-tested
 * in isolation. The inline rename field in the Conversation_Sidebar derives its
 * "should I PATCH?" behavior from {@link decideRename}, so the test exercises the
 * SAME logic that runs in production.
 *
 * The core rule: a rename is ACCEPTED if and only if the entered title is
 * non-empty after trimming leading/trailing whitespace (Req 11.2). When accepted
 * the submitted title equals the trimmed value and a `PATCH /api/conversations/[id]`
 * rename request should be sent (with `titleSource:"user"`). When the candidate is
 * empty after trimming it is REJECTED: the edit is discarded and NO rename request
 * is sent (Req 11.6).
 */

/**
 * Result of deciding an inline rename. A small discriminated union so callers can
 * branch on `accept`:
 *
 * - `{ accept: true; title }` — send `PATCH` with `title` (the trimmed value).
 * - `{ accept: false }` — discard the edit; send no rename request.
 */
export type RenameDecision =
  | { accept: true; title: string }
  | { accept: false };

/**
 * Decide whether an inline rename should be applied for the given candidate
 * title (Req 11.2, 11.6).
 *
 * Trims leading/trailing whitespace from `candidate`. If the trimmed value is
 * non-empty, returns `{ accept: true, title }` where `title` is the trimmed value
 * (the payload the caller PATCHes). Otherwise returns `{ accept: false }`, meaning
 * the caller discards the edit and sends no rename request.
 */
export function decideRename(candidate: string): RenameDecision {
  const title = candidate.trim();
  if (title.length === 0) {
    return { accept: false };
  }
  return { accept: true, title };
}
