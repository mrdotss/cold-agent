"use client";

import * as React from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert02Icon,
  Copy01Icon,
  RefreshIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  feedbackReducer,
  isSelected,
  type FeedbackState,
  type FeedbackValue,
} from "@/lib/interactions";

/**
 * Per-assistant-turn action bar (Req 14, design-system §4, ref-6): copy ·
 * regenerate · thumbs up / down, in the editorial Sera language (flat, sharp
 * corners, HugeIcons line icons, violet accent for the active vote).
 *
 * Presentational + browser-only. It owns three small pieces of local UI state
 * (copy status, the optimistic feedback vote, and a transient error) and
 * persists a chosen vote via the message-feedback ROUTE (`PATCH
 * /api/conversations/[id]/messages/[messageId]/feedback`) — never Postgres and
 * never DynamoDB directly (Req 14.2, 14.5). Regeneration is delegated to
 * `onRegenerate` (the page wires it to the stream hook's
 * `send(precedingUserPrompt)`), and whether it is allowed is decided upstream by
 * `canRegenerate` (`lib/regenerate.ts`).
 */

/**
 * Duration the "Copied" confirmation stays visible before reverting. Kept at or
 * above 2s so the confirmation is clearly perceivable (Req 14.1). The
 * copy-failed indication reuses the same window (Req 14.2).
 */
const COPY_STATUS_VISIBLE_MS = 2000;

type CopyStatus = "idle" | "copied" | "error";

export interface MessageActionsProps {
  /**
   * The conversation this turn belongs to — the `[id]` path segment of the
   * feedback route (owned-thread checked server-side). Required to address the
   * persist call.
   */
  conversationId: string;
  /**
   * The target assistant message id — the `MSG#…` sort key and the `[messageId]`
   * path segment (URL-encoded before use; owned-thread checked server-side).
   */
  messageId: string;
  /**
   * The assistant message's COMPLETE rendered text — copied verbatim to the
   * clipboard by the copy action (Req 14.1).
   */
  content: string;
  /**
   * Whether regenerate is enabled — computed upstream via
   * `canRegenerate(messages, assistantIndex)`. When false the control is
   * disabled and the agent is never invoked (Req 14.4).
   */
  canRegenerate?: boolean;
  /**
   * Invoked when the (enabled) regenerate control is activated. The page wires
   * this to `send(precedingUserPrompt(...))` for the SAME thread, reusing the
   * thread's existing session id server-side (Req 14.3).
   */
  onRegenerate?: () => void;
  /**
   * The feedback value already stored for this message, shown as selected on
   * first render (Req 14.8). Defaults to `null` (no feedback).
   */
  initialFeedback?: FeedbackState;
  className?: string;
}

export function MessageActions({
  conversationId,
  messageId,
  content,
  canRegenerate = false,
  onRegenerate,
  initialFeedback = null,
  className,
}: MessageActionsProps) {
  // ---- Copy state (Req 14.1, 14.2) ----------------------------------------
  const [copyStatus, setCopyStatus] = React.useState<CopyStatus>("idle");
  const copyTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---- Feedback state (Req 14.5–14.8) -------------------------------------
  // `feedback` is the DISPLAYED (optimistic) vote; it equals the stored state
  // except during an in-flight persist, which is rolled back on failure.
  const [feedback, setFeedback] = React.useState<FeedbackState>(
    initialFeedback,
  );
  const [feedbackError, setFeedbackError] = React.useState(false);
  const [isSaving, startSaving] = React.useTransition();

  React.useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const scheduleCopyReset = React.useCallback(() => {
    if (copyTimerRef.current !== null) {
      clearTimeout(copyTimerRef.current);
    }
    copyTimerRef.current = setTimeout(
      () => setCopyStatus("idle"),
      COPY_STATUS_VISIBLE_MS,
    );
  }, []);

  const handleCopy = React.useCallback(async () => {
    try {
      if (
        typeof navigator === "undefined" ||
        navigator.clipboard === undefined
      ) {
        throw new Error("Clipboard API unavailable");
      }
      await navigator.clipboard.writeText(content);
      setCopyStatus("copied");
    } catch {
      // Leave the message content untouched and surface a non-fatal failure
      // indication (Req 14.2).
      setCopyStatus("error");
    } finally {
      scheduleCopyReset();
    }
  }, [content, scheduleCopyReset]);

  const handleVote = React.useCallback(
    (value: FeedbackValue) => {
      if (isSaving) return;

      const previous = feedback;
      // Toggling the active vote clears it; a different vote replaces it
      // (Req 14.5, 14.6) — the reducer's result IS the displayed value.
      const next = feedbackReducer(previous, { kind: "activate", value });

      // Optimistically reflect the new displayed state, clearing any prior error.
      setFeedback(next);
      setFeedbackError(false);

      // Toggle-off (next === null): the feedback route body only accepts
      // "up"/"down", so there is no valid "clear" value to send. Reflect the
      // cleared state locally WITHOUT a network call; the persisted attribute
      // stays as-is server-side (documented behavior for this task).
      if (next === null) {
        return;
      }

      // Persist the chosen up/down vote via the feedback ROUTE — addressed by the
      // conversation id and the URL-encoded `MSG#…` sort key. Never Postgres,
      // never DynamoDB directly (Req 14.2, 14.5). Optimistic; rolls back on
      // failure (Req 14.7).
      startSaving(async () => {
        try {
          const res = await fetch(
            `/api/conversations/${encodeURIComponent(
              conversationId,
            )}/messages/${encodeURIComponent(messageId)}/feedback`,
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ feedback: next }),
            },
          );
          if (!res.ok) {
            throw new Error(`Feedback persist failed: ${res.status}`);
          }
        } catch {
          // Persist failed: roll back to the previously stored state and surface
          // a subtle error (Req 14.7).
          setFeedback(previous);
          setFeedbackError(true);
        }
      });
    },
    [conversationId, feedback, isSaving, messageId],
  );

  const copyIcon =
    copyStatus === "copied"
      ? Tick02Icon
      : copyStatus === "error"
        ? Alert02Icon
        : Copy01Icon;

  const copyLabel =
    copyStatus === "copied"
      ? "Copied to clipboard"
      : copyStatus === "error"
        ? "Copy failed"
        : "Copy message";

  const upSelected = isSelected(feedback, "up");
  const downSelected = isSelected(feedback, "down");

  return (
    <div
      className={cn(
        "flex items-center gap-0.5 text-muted-foreground",
        className,
      )}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={handleCopy}
        aria-label={copyLabel}
        data-state={copyStatus}
        className={cn(
          "hover:text-foreground",
          copyStatus === "copied" && "text-primary",
          copyStatus === "error" && "text-destructive",
        )}
      >
        <HugeiconsIcon icon={copyIcon} />
      </Button>

      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={onRegenerate}
        disabled={!canRegenerate}
        aria-label="Regenerate response"
        className="hover:text-foreground"
      >
        <HugeiconsIcon icon={RefreshIcon} />
      </Button>

      <span aria-hidden="true" className="mx-1 h-3.5 w-px bg-border" />

      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={() => handleVote("up")}
        disabled={isSaving}
        aria-pressed={upSelected}
        aria-label={upSelected ? "Remove thumbs up" : "Thumbs up"}
        className={cn(
          "hover:text-foreground",
          upSelected && "text-primary",
        )}
      >
        <HugeiconsIcon icon={ThumbsUpIcon} />
      </Button>

      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={() => handleVote("down")}
        disabled={isSaving}
        aria-pressed={downSelected}
        aria-label={downSelected ? "Remove thumbs down" : "Thumbs down"}
        className={cn(
          "hover:text-foreground",
          downSelected && "text-primary",
        )}
      >
        <HugeiconsIcon icon={ThumbsDownIcon} />
      </Button>

      {feedbackError ? (
        <span className="ml-1 text-xs text-destructive">
          Couldn&apos;t save
        </span>
      ) : null}

      {/* Polite live region announcing copy + feedback outcomes to AT users. */}
      <span aria-live="polite" className="sr-only">
        {copyStatus === "copied"
          ? "Message copied to clipboard"
          : copyStatus === "error"
            ? "Copy failed"
            : feedbackError
              ? "Could not save feedback"
              : ""}
      </span>
    </div>
  );
}
