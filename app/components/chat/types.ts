/**
 * Shared, browser-safe types for the presentational chat components.
 *
 * These components are pure/presentational (task 14.2): they render FROM the
 * `StreamState` produced by `useAgentStream` plus a persisted message array and
 * a connected-account count, and never own the fetch. Keeping the shared shapes
 * here avoids re-declaring them per component and keeps the page-wiring (task
 * 14.3) honest about what it passes down.
 */

/** A persisted chat turn rendered in the message list (Req 10.4, 10.5). */
export interface ChatMessage {
  /** Stable id used as the React key + scroll anchor id. */
  id: string;
  /** `user` turns render right-aligned; `assistant` turns render left-aligned. */
  role: "user" | "assistant";
  /** Raw text. Assistant content is rendered as GitHub-flavored markdown. */
  content: string;
}
