import { randomUUID } from "node:crypto";

import { redactForBrowser, type ChartSpec } from "@/lib/aws/sse";
import { sessionIdForThread } from "@/lib/session-id";
import { convPk, convSk, gsi1Sk, msgSk, userPk } from "@/lib/history/keys";

/**
 * Server-safe builders that assemble the DynamoDB items for the single-table
 * chat-history design (Req 5.2–5.7). These functions are PURE: given the record
 * inputs they return the exact item object to `PutItem`, with no DynamoDB calls,
 * no session lookups, and no I/O — the stores (`lib/history/*`) own persistence.
 *
 * This module is deliberately server-SAFE without `import "server-only"`: it
 * imports only pure/client-safe helpers (`@/lib/aws/sse` redaction + `ChartSpec`,
 * `@/lib/session-id`, `@/lib/history/keys`) and never touches `lib/aws/dynamo.ts`
 * or any secret. Every item is routed through `redactForBrowser` so that
 * `role_arn`, `external_id`, and raw AWS credentials can never be written into a
 * stored item, even if a caller accidentally passes them in (Req 5.7, 13.6, 18.2).
 */

/**
 * Conversation record shape (mirrors `lib/history/conversations.ts`). `sessionId`
 * is intentionally omitted from the builder input because it is DERIVED from the
 * `conversationId` (Req 5.4, 8.7), never supplied by the caller.
 */
export interface ConversationRecord {
  conversationId: string;
  title: string;
  titleSource: "pending" | "ai" | "user";
  accountId: string;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

/** Input for {@link buildConversationItem} — a `ConversationRecord` minus the derived `sessionId`. */
export type ConversationItemInput = Omit<ConversationRecord, "sessionId">;

/**
 * Message record shape (mirrors `lib/history/messages.ts`). `feedback` and
 * `activity` are optional and are OMITTED entirely from the built item when
 * unset (Req 5.6, 14.1) rather than written as `undefined`.
 */
export interface MessageRecord {
  userId: string;
  role: "user" | "assistant";
  content: string;
  charts: ChartSpec[];
  reports: { key: string }[];
  activity?: { label: string; status: string }[];
  feedback?: "up" | "down";
  createdAt: string;
}

/** Input for {@link buildMessageItem}: a `MessageRecord` plus the owning conversation id. */
export interface MessageItemInput extends MessageRecord {
  conversationId: string;
}

/** The fully-assembled Conversation_Item written under the user's partition. */
export interface ConversationItem {
  PK: string;
  SK: string;
  GSI1PK: string;
  GSI1SK: string;
  conversationId: string;
  title: string;
  titleSource: "pending" | "ai" | "user";
  accountId: string;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

/** The fully-assembled Message_Item written under the conversation's partition. */
export interface MessageItem {
  PK: string;
  SK: string;
  userId: string;
  role: "user" | "assistant";
  content: string;
  charts: ChartSpec[];
  reports: { key: string }[];
  activity?: { label: string; status: string }[];
  feedback?: "up" | "down";
  createdAt: string;
}

/**
 * Assemble the Conversation_Item for `PutItem` (Req 5.2, 5.3).
 *
 * Keys: `PK = USER#<userId>`, `SK = CONV#<conversationId>`, and the GSI1 list
 * projection `GSI1PK = USER#<userId>`, `GSI1SK = TS#<updatedAt>` (Req 6.1, 6.4).
 * `sessionId` is DERIVED with `sessionIdForThread(conversationId)` (Req 5.4) so
 * it is stable per thread and never supplied by the caller. The result is passed
 * through `redactForBrowser` so no secret field can ever be persisted (Req 5.7).
 */
export function buildConversationItem(
  userId: string,
  input: ConversationItemInput,
): ConversationItem {
  const item: ConversationItem = {
    PK: userPk(userId),
    SK: convSk(input.conversationId),
    GSI1PK: userPk(userId),
    GSI1SK: gsi1Sk(input.updatedAt),
    conversationId: input.conversationId,
    title: input.title,
    titleSource: input.titleSource,
    accountId: input.accountId,
    sessionId: sessionIdForThread(input.conversationId),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    messageCount: input.messageCount,
  };

  return redactForBrowser(item);
}

/**
 * Assemble the Message_Item for `PutItem` (Req 5.5, 5.6).
 *
 * Keys: `PK = CONV#<conversationId>`, `SK = MSG#<createdAt>#<uuid>` where `uuid`
 * is a fresh `randomUUID()` used purely to disambiguate same-millisecond writes
 * so `createdAt`-ascending ordering stays stable (Req 6.7). Optional `activity`
 * and `feedback` keys are OMITTED entirely when unset (Req 5.6, 14.1) rather than
 * stored as `undefined`. The result is passed through `redactForBrowser` so no
 * secret field can ever be persisted (Req 5.7).
 */
export function buildMessageItem(input: MessageItemInput): MessageItem {
  const item: MessageItem = {
    PK: convPk(input.conversationId),
    SK: msgSk(input.createdAt, randomUUID()),
    userId: input.userId,
    role: input.role,
    content: input.content,
    charts: input.charts,
    reports: input.reports,
    createdAt: input.createdAt,
  };

  if (input.activity !== undefined) item.activity = input.activity;
  if (input.feedback !== undefined) item.feedback = input.feedback;

  return redactForBrowser(item);
}
