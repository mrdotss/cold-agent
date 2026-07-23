/**
 * Shared, browser-safe types for the presentational chat components.
 *
 * These components are pure/presentational (task 14.2): they render FROM the
 * `StreamState` produced by `useAgentStream` plus a persisted message array and
 * a connected-account count, and never own the fetch. Keeping the shared shapes
 * here avoids re-declaring them per component and keeps the page-wiring (task
 * 14.3) honest about what it passes down.
 */

import type { ChartSpec } from "@/lib/aws/sse";

/** A persisted chat turn rendered in the message list (Req 10.4, 10.5). */
export interface ChatMessage {
  /**
   * The message SK id (`MSG#…#<ulid>`) used as the React key + scroll anchor id
   * and to address feedback writes for a hydrated assistant turn (Req 14.1, 14.4).
   */
  id: string;
  /** `user` turns render right-aligned; `assistant` turns render left-aligned. */
  role: "user" | "assistant";
  /** Raw text. Assistant content is rendered as GitHub-flavored markdown. */
  content: string;
  /**
   * Inline charts persisted with the assistant turn, rendered client-side from
   * their structured `spec` (no image, no presign) (Req 4.10, 9.6).
   */
  charts?: ChartSpec[];
  /**
   * Report artifacts persisted with the assistant turn. Each `key` is presigned
   * server-side on demand to render a download card (Req 9.6).
   */
  reports?: { key: string }[];
  /**
   * Persisted thumbs feedback for a hydrated assistant turn, so the reaction
   * state survives reload (Req 14.1, 14.4).
   */
  feedback?: "up" | "down";
}
