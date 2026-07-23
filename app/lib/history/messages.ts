import "server-only";

import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

import { getDocClient, historyTableName } from "@/lib/aws/dynamo";
import { getConversationOwned } from "@/lib/history/conversations";
import { buildMessageItem, type MessageRecord } from "@/lib/history/items";
import { convPk, convSk, gsi1Sk, MSG_PREFIX, userPk } from "@/lib/history/keys";

/**
 * Server-only message store for the single-table chat-history design.
 *
 * This module owns every Message_Item access pattern (Req 6.2, 6.3, 6.7) plus the
 * single Message_Feedback write path (Req 14.2, 14.3, 14.5). It is
 * `import "server-only"` because it touches AWS credentials via the document
 * client. `userId` is ALWAYS derived from the caller (the authenticated session)
 * and never accepted from the browser (Req 7.4).
 *
 * EVERY read or write is gated on ownership: before touching a message the store
 * calls `getConversationOwned(userId, conversationId)` (a `GetItem` under
 * `PK = USER#<userId>, SK = CONV#<conversationId>`). When the caller does not own
 * the conversation, no message item is written or updated (Req 7.4, 14.3).
 *
 * Message items live at `PK = CONV#<conversationId>, SK = MSG#<createdAtIso>#<uuid>`
 * (Req 5.5). The `SK` doubles as the message's opaque id: it is returned on each
 * {@link StoredMessage} so callers (e.g. the feedback route) can address a
 * specific message without an ambiguous positional index (Req 14.2).
 */

// Re-export the record shape so route handlers can import it from the store.
export type { MessageRecord } from "@/lib/history/items";

/**
 * A message as returned from the store: the persisted {@link MessageRecord}
 * attributes plus `id`, the Message_Item's sort key (`MSG#<createdAtIso>#<uuid>`).
 *
 * `id` is REQUIRED here because `listMessages` projects it from the queried item
 * so callers can (a) hydrate `ChatMessage.id` and (b) pass the same `SK` back to
 * `setMessageFeedback` to address exactly one message (Req 6.7, 14.2). It is the
 * only field beyond `MessageRecord` — the key attributes (`PK`) never leave the
 * store.
 */
export interface StoredMessage extends MessageRecord {
  /** The Message_Item sort key, e.g. `MSG#2026-06-01T12:00:01.500Z#<uuid>`. */
  id: string;
}

/**
 * Project a raw DynamoDB message item into a {@link StoredMessage}.
 *
 * `id` is taken from the item's `SK`. Optional `activity`/`feedback` are copied
 * only when present (they are omitted entirely from unset items, Req 5.6, 14.1).
 * The `PK` key attribute is intentionally dropped.
 */
function toStoredMessage(item: Record<string, unknown>): StoredMessage {
  const record: StoredMessage = {
    id: item.SK as string,
    userId: item.userId as string,
    role: item.role as MessageRecord["role"],
    content: item.content as string,
    charts: (item.charts as MessageRecord["charts"]) ?? [],
    reports: (item.reports as MessageRecord["reports"]) ?? [],
    createdAt: item.createdAt as string,
  };

  if (item.activity !== undefined) {
    record.activity = item.activity as MessageRecord["activity"];
  }
  if (item.feedback !== undefined) {
    record.feedback = item.feedback as MessageRecord["feedback"];
  }

  return record;
}

/**
 * Append a message to a conversation the caller owns (Req 6.3, 7.4).
 *
 * Ownership is verified FIRST via `getConversationOwned(userId, conversationId)`;
 * when the caller does not own the conversation this is a no-op (nothing is
 * written). Otherwise it performs two operations that together form the append:
 *
 * 1. `PutItem` the Message_Item assembled by `buildMessageItem` (`PK=CONV#…`,
 *    `SK=MSG#<createdAt>#<uuid>`), stamping `userId` from the session. The item
 *    builder runs the payload through redaction so no secret can be persisted.
 * 2. `UpdateItem` the conversation item in the SAME logical operation, bumping
 *    the ordering + count atomically:
 *    `SET updatedAt = :iso, GSI1SK = :g ADD messageCount :one`. The `ADD` is an
 *    atomic counter increment (Req 6.3) and `GSI1SK = TS#<iso>` floats the
 *    conversation to the top of the most-recently-updated list (Req 6.4).
 *
 * `updatedAt`/`GSI1SK` are stamped from the new message's `createdAt` so the
 * conversation's ordering reflects the moment of its latest message.
 */
export async function appendMessage(
  userId: string,
  conversationId: string,
  msg: MessageRecord,
): Promise<void> {
  const owned = await getConversationOwned(userId, conversationId);
  if (owned === null) {
    return;
  }

  const client = getDocClient();
  const tableName = historyTableName();

  const item = buildMessageItem({
    ...msg,
    userId,
    conversationId,
  });

  await client.send(
    new PutCommand({
      TableName: tableName,
      Item: item,
    }),
  );

  await client.send(
    new UpdateCommand({
      TableName: tableName,
      Key: {
        PK: userPk(userId),
        SK: convSk(conversationId),
      },
      UpdateExpression:
        "SET updatedAt = :iso, GSI1SK = :g ADD messageCount :one",
      ExpressionAttributeValues: {
        ":iso": msg.createdAt,
        ":g": gsi1Sk(msg.createdAt),
        ":one": 1,
      },
    }),
  );
}

/**
 * List a conversation's messages oldest-first, gated on ownership (Req 6.2, 6.7).
 *
 * Performs the ownership `GetItem` first via `getConversationOwned`. When the
 * caller does not own the conversation (or it does not exist) this returns `[]`
 * and issues no query — callers/routes translate the empty result into a 404
 * (design §8). This means an owned-but-empty conversation and a not-owned
 * conversation both surface as `[]`; the store does not distinguish them here
 * because routes already re-run the ownership gate to decide 404 vs 200 (the
 * simplest contract that leaks no attribute of an unowned conversation, Req 7.3).
 *
 * When owned, it queries `PK = CONV#<conversationId>` with
 * `SK begins_with "MSG#"`. `ScanIndexForward` defaults to `true` (ascending),
 * which — because sort keys are `MSG#<createdAtIso>#<uuid>` — yields messages in
 * `createdAt`-ascending (oldest-first) order (Req 6.7). Results are paginated to
 * completion and projected to {@link StoredMessage} (each carrying its `SK` `id`).
 */
export async function listMessages(
  userId: string,
  conversationId: string,
): Promise<StoredMessage[]> {
  const owned = await getConversationOwned(userId, conversationId);
  if (owned === null) {
    return [];
  }

  const client = getDocClient();
  const tableName = historyTableName();
  const messages: StoredMessage[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: {
          ":pk": convPk(conversationId),
          ":prefix": MSG_PREFIX,
        },
        // ScanIndexForward defaults to true (ascending) => oldest-first (Req 6.7).
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );

    for (const item of result.Items ?? []) {
      messages.push(toStoredMessage(item));
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey !== undefined);

  return messages;
}

/**
 * Set a thumbs-up/down mark on a single assistant message — the SINGLE
 * Message_Feedback write path (Req 14.2, 14.3, 14.5).
 *
 * Ownership is authorized FIRST via `getConversationOwned(userId, conversationId)`;
 * when the caller does not own the conversation this is a no-op — NO `UpdateItem`
 * is issued (Req 14.3). Feedback is never written to Postgres (Req 14.5).
 *
 * The `feedback` argument is typed as `"up" | "down"`, so only those two values
 * can reach DynamoDB (the route additionally validates with a zod enum before
 * calling). When owned, it issues an `UpdateItem` that `SET`s the `feedback`
 * attribute on the Message_Item addressed by its `MSG#…` sort key
 * (`PK = CONV#<conversationId>`, `SK = <messageSk>`).
 */
export async function setMessageFeedback(
  userId: string,
  conversationId: string,
  messageSk: string,
  feedback: "up" | "down",
): Promise<void> {
  const owned = await getConversationOwned(userId, conversationId);
  if (owned === null) {
    return;
  }

  await getDocClient().send(
    new UpdateCommand({
      TableName: historyTableName(),
      Key: {
        PK: convPk(conversationId),
        SK: messageSk,
      },
      UpdateExpression: "SET feedback = :feedback",
      ExpressionAttributeValues: {
        ":feedback": feedback,
      },
    }),
  );
}
