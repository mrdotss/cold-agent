"use client";

import { useCallback, useMemo, useRef, useState } from "react";

import { useAgentStream } from "@/hooks/useAgentStream";
import { canRegenerate, precedingUserPrompt } from "@/lib/regenerate";

import { ActivityTimeline } from "./activity-timeline";
import { AgentIntro } from "./agent-intro";
import { Composer } from "./composer";
import { MessageActions } from "./message-actions";
import { MessageList } from "./message-list";
import { ReportCardFor } from "./report-card";
import { Suggestions } from "./suggestions";
import type { ChatMessage } from "./types";

/**
 * Client container that composes the chat experience for one thread (task 14.3).
 *
 * It wires the presentational chat components (task 14.2) to the SSE stream hook
 * (`useAgentStream`, task 14.1) and the pure helpers (`regenerate`,
 * `suggestions`). The page (a server component) authenticates, loads the thread,
 * its persisted messages, the connected-account count, and the seed suggestions,
 * then hands them here — this container owns all interactivity and imports no
 * `server-only` module, so no secret ever reaches the browser.
 *
 * Responsibilities:
 *  - Render the persisted transcript plus any user prompt sent this session, and
 *    the in-progress assistant turn (streamed text + activity timeline + resolved
 *    report cards) driven by `StreamState` (Req 9, 10, 11.5).
 *  - Show the {@link AgentIntro} empty state until the thread has content.
 *  - Attach a {@link MessageActions} bar under each persisted assistant message,
 *    wiring regenerate to `send(precedingUserPrompt(...))` for the SAME thread so
 *    the existing session id is reused (Req 14.3, 14.4).
 *  - Present seed {@link Suggestions} whose `onPick` REPLACES the composer text
 *    and focuses it WITHOUT submitting (Req 16.2).
 *  - Gate the {@link Composer} on the connected-account count: zero accounts →
 *    disabled with a connect-account CTA (Req 6.1); ≥1 → enabled (Req 6.2). The
 *    count is server-derived, so connecting/removing an account flips the state
 *    on the next load/refresh (Req 6.3, 6.4).
 */

export interface ChatViewProps {
  /** The thread id; drives the stream hook + regenerate re-invocation. */
  threadId: string;
  /** Persisted turns for the thread, oldest first (Req 8.5). */
  initialMessages: ChatMessage[];
  /**
   * Number of connected accounts for the signed-in user. Zero disables the
   * composer with a connect-account CTA; ≥1 enables it (Req 6.1, 6.2).
   */
  accountCount: number;
  /** Alias of the account this thread is pinned to (shown in the intro chip). */
  accountAlias?: string | null;
  /** Server-seeded prompt chips (from `generateSuggestions`). */
  initialSuggestions: string[];
}

export function ChatView({
  threadId,
  initialMessages,
  accountCount,
  accountAlias,
  initialSuggestions,
}: ChatViewProps) {
  const { state, send } = useAgentStream(threadId);

  // The transcript rendered by the message list: the persisted turns plus any
  // user prompts sent during this session (so the user immediately sees their
  // own message while the assistant streams). The active assistant turn is
  // rendered separately via the in-progress slot below.
  const [history, setHistory] = useState<ChatMessage[]>(initialMessages);

  // Controlled composer draft so suggestion chips can replace its contents.
  const [draft, setDraft] = useState("");
  const composerWrapRef = useRef<HTMLDivElement>(null);

  const isStreaming = state.phase === "streaming";

  const handleSend = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      setHistory((prev) => [
        ...prev,
        { id: `local-user-${crypto.randomUUID()}`, role: "user", content: trimmed },
      ]);
      void send(trimmed);
    },
    [send],
  );

  // A chip replaces the composer contents and moves focus there WITHOUT
  // submitting (Req 16.2). Focus is applied after the value update paints.
  const handlePick = useCallback((text: string) => {
    setDraft(text);
    requestAnimationFrame(() => {
      composerWrapRef.current?.querySelector("textarea")?.focus();
    });
  }, []);

  // Activity timeline for the in-progress turn — only present when there are
  // steps, so the message list does not render an empty in-progress row.
  const activitySlot =
    state.steps.length > 0 ? (
      <ActivityTimeline
        steps={state.steps}
        collapsed={state.collapsed}
        liveRegion={state.liveRegion}
      />
    ) : undefined;

  // Report cards render only once their presigned URL resolves (Req 11.5); the
  // error message (already redacted upstream) surfaces inline.
  const resolvedReports = state.reports.filter(
    (report) => typeof report.url === "string" && report.url.length > 0,
  );
  const errorNode =
    state.phase === "error" && state.errorMessage !== undefined ? (
      <p role="alert" className="text-sm text-destructive">
        {state.errorMessage}
      </p>
    ) : null;
  const trailingSlot =
    resolvedReports.length > 0 || errorNode !== null ? (
      <div className="flex flex-col gap-2">
        {resolvedReports.map((report) => (
          <ReportCardFor key={report.key} report={report} />
        ))}
        {errorNode}
      </div>
    ) : undefined;

  // The intro empty state shows until the thread has any content or a turn
  // begins streaming.
  const showIntro = history.length === 0 && state.phase === "idle";

  const renderAssistantActions = useCallback(
    (message: ChatMessage, index: number) => (
      <MessageActions
        messageId={message.id}
        content={message.content}
        canRegenerate={canRegenerate(history, index)}
        onRegenerate={() => {
          const prompt = precedingUserPrompt(history, index);
          if (prompt !== null) void send(prompt);
        }}
      />
    ),
    [history, send],
  );

  const suggestions = useMemo(() => initialSuggestions, [initialSuggestions]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        {showIntro ? (
          <div className="mx-auto flex h-full w-full max-w-3xl flex-col items-center justify-center gap-10 overflow-y-auto px-4 py-10">
            <AgentIntro accountAlias={accountAlias} />
            {accountCount > 0 ? (
              <Suggestions
                suggestions={suggestions}
                onPick={handlePick}
                className="w-full max-w-xl"
              />
            ) : null}
          </div>
        ) : (
          <MessageList
            messages={history}
            streamingText={state.assistantText}
            isStreaming={isStreaming}
            activitySlot={activitySlot}
            trailingSlot={trailingSlot}
            renderAssistantActions={renderAssistantActions}
          />
        )}
      </div>

      <div className="border-t border-border bg-background/80">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 py-4">
          {!showIntro && accountCount > 0 && state.phase === "idle" ? (
            <Suggestions suggestions={suggestions} onPick={handlePick} />
          ) : null}
          <div ref={composerWrapRef}>
            <Composer
              accountCount={accountCount}
              busy={isStreaming}
              value={draft}
              onValueChange={setDraft}
              onSend={handleSend}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
