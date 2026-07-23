"use client";

import type { ReactNode } from "react";

import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Message, MessageContent } from "@/components/ui/message";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { cn } from "@/lib/utils";

import { AssistantMarkdown } from "./assistant-markdown";
import { ChartInline } from "./chart-inline";
import type { ChatMessage } from "./types";

/**
 * The scrollable message list (Req 10.2–10.7).
 *
 * User turns render as subtle RIGHT-aligned zinc bubbles (Req 10.4); assistant
 * turns render as LEFT-aligned plain prose (Req 10.5) parsed as GitHub-flavored
 * markdown with tables + inline code chips (Req 10.2) — and tolerate malformed
 * mid-stream markdown without crashing (Req 10.7).
 *
 * Scroll behavior is delegated to the Base UI `MessageScroller`: with
 * `autoScroll`, the view stays anchored to the newest content while `delta`
 * events stream (Req 10.3) and automatically yields the instant the user
 * scrolls away, resuming only when they return to the live edge (Req 10.6). The
 * jump-to-latest button surfaces while scrolled away. No manual scroll math.
 *
 * Presentational only: it renders the persisted `messages` plus an optional
 * in-progress assistant turn (its streaming text, the activity timeline, and any
 * trailing content such as report cards) driven entirely by props.
 */

export interface MessageListProps {
  /** Persisted turns, oldest first (Req 8.5 ordering is the caller's job). */
  messages: ChatMessage[];
  /** Accumulated in-progress assistant text (`StreamState.assistantText`). */
  streamingText?: string;
  /** Whether a turn is currently active (renders the in-progress assistant row). */
  isStreaming?: boolean;
  /** Activity timeline attached to the in-progress assistant turn (Req 9). */
  activitySlot?: ReactNode;
  /**
   * Inline charts for the in-progress assistant turn, built from `state.charts`
   * in received order. Rendered under the streaming markdown, before the
   * trailing slot (Req 4.1, 4.10).
   */
  chartsSlot?: ReactNode;
  /** Extra content under the in-progress turn (report cards, anomaly callouts). */
  trailingSlot?: ReactNode;
  /**
   * Optional footer rendered directly under each PERSISTED assistant turn —
   * used by the page to attach a `MessageActions` bar (copy / regenerate /
   * feedback) per assistant message (Req 14). Not rendered for user turns.
   */
  renderAssistantActions?: (message: ChatMessage, index: number) => ReactNode;
  className?: string;
}

function UserTurn({ content, anchor }: { content: string; anchor: boolean }) {
  return (
    <MessageScrollerItem scrollAnchor={anchor}>
      <Message align="end">
        <MessageContent>
          <Bubble variant="secondary" align="end">
            <BubbleContent className="whitespace-pre-wrap">{content}</BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>
    </MessageScrollerItem>
  );
}

function AssistantTurn({
  content,
  activitySlot,
  chartsSlot,
  trailingSlot,
}: {
  content: string;
  activitySlot?: ReactNode;
  chartsSlot?: ReactNode;
  trailingSlot?: ReactNode;
}) {
  return (
    <MessageScrollerItem>
      <Message align="start">
        <MessageContent className="gap-3">
          {activitySlot}
          {content.length > 0 ? <AssistantMarkdown content={content} /> : null}
          {chartsSlot}
          {trailingSlot}
        </MessageContent>
      </Message>
    </MessageScrollerItem>
  );
}

export function MessageList({
  messages,
  streamingText = "",
  isStreaming = false,
  activitySlot,
  chartsSlot,
  trailingSlot,
  renderAssistantActions,
  className,
}: MessageListProps) {
  // Render the in-progress assistant row when a turn is active or when there is
  // anything to attach to it (streaming text, the timeline, charts, or cards).
  const showInProgress =
    isStreaming ||
    streamingText.length > 0 ||
    activitySlot !== undefined ||
    chartsSlot !== undefined ||
    trailingSlot !== undefined;

  return (
    <MessageScrollerProvider autoScroll>
      <MessageScroller className={cn("size-full", className)}>
        <MessageScrollerViewport>
          <MessageScrollerContent className="mx-auto w-full max-w-3xl px-4 py-6">
            {messages.map((message, index) =>
              message.role === "user" ? (
                <UserTurn key={message.id} content={message.content} anchor />
              ) : (
                <MessageScrollerItem key={message.id}>
                  <Message align="start">
                    <MessageContent className="gap-2">
                      <AssistantMarkdown content={message.content} />
                      {message.charts?.map((spec) => (
                        <ChartInline key={spec.id} spec={spec} />
                      ))}
                      {renderAssistantActions?.(message, index)}
                    </MessageContent>
                  </Message>
                </MessageScrollerItem>
              ),
            )}

            {showInProgress ? (
              <AssistantTurn
                content={streamingText}
                activitySlot={activitySlot}
                chartsSlot={chartsSlot}
                trailingSlot={trailingSlot}
              />
            ) : null}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
