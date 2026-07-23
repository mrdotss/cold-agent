import "server-only";

import { randomUUID } from "node:crypto";

import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

import { getDocClient, historyTableName } from "@/lib/aws/dynamo";
import { buildConversationItem } from "@/lib/history/items";
import {
  convPk,
  convSk,
  gsi1Sk,
  MSG_PREFIX,
  userPk,
} from "@/lib/history/keys";

/**
 * Server-only conversation store for the single-table chat-history design.
 *
 * This module owns every conversation-item access pattern (Req 6, 7). It is
 * `import "server-only"` because it touches AWS credentials via the document
 * client. `userId` is ALWAYS derived from the caller (the authenticated
 * session) and never accepted from the browser (Req 7.1). `sessionId` is
 * DERIVED from the `conversationId` with `sessionIdForThread` (Req 5.4, 8.7)
 * so it is stable per thread and never supplied by a caller.
 *
 * Conversation items live at `PK = USER#<userId>, SK = CONV#<conversationId>`
 * and are listed most-recently-updated-first via `GSI1`
 * (`GSI1PK = USER#<userId>, GSI1SK = TS#<updatedAtIso>`, Req 6.1, 6.4).
 */

/**
 * Conversation record returned to callers (mirrors the item builder's shape).
 * `sessionId` is derived, never supplied by the caller (Req 5.4, 8.7).
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

/**
 * Project a raw DynamoDB item into a {@link ConversationRecord}, dropping the
 * key attributes (`PK`/`SK`/`GSI1PK`/`GSI1SK`) that never leave the store.
 */
function toRecord(item: Record<string, unknown>): ConversationRecord {
  return {
    conversationId: item.conversationId as string,
    title: item.title as string,
    titleSource: item.titleSource as ConversationRecord["titleSource"],
    accountId: item.accountId as string,
    sessionId: item.sessionId as string,
    createdAt: item.createdAt as string,
    updatedAt: item.updatedAt as string,
    messageCount: item.messageCount as number,
  };
}

/**
 * Create a new conversation for `userId` pinned to `accountId` (Req 8.1).
 *
 * The conversation starts with `titleSource: "pending"` (Req 8.1), a fresh
 * opaque `conversationId`, a derived `sessionId`, `createdAt`/`updatedAt` set to
 * now, and `messageCount: 0`. The assembled item (including all keys) is written
 * with a single `PutItem`. The persisted {@link ConversationRecord} is returned.
 */
export async function createConversation(
  userId: string,
  accountId: string,
): Promise<ConversationRecord> {
  const conversationId = randomUUID();
  const now = new Date().toISOString();

  const item = buildConversationItem(userId, {
    conversationId,
    title: "",
    titleSource: "pending",
    accountId,
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
  });

  await getDocClient().send(
    new PutCommand({
      TableName: historyTableName(),
      Item: item,
    }),
  );

  return {
    conversationId,
    title: item.title,
    titleSource: item.titleSource,
    accountId: item.accountId,
    sessionId: item.sessionId,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    messageCount: item.messageCount,
  };
}

/**
 * List a user's conversations, most-recently-updated first (Req 6.1).
 *
 * Queries `GSI1` with `GSI1PK = USER#<userId>` and `ScanIndexForward = false`
 * so items sort by `GSI1SK` (`TS#<updatedAtIso>`) descending.
 */
export async function listConversations(
  userId: string,
): Promise<ConversationRecord[]> {
  const client = getDocClient();
  const tableName = historyTableName();
  const records: ConversationRecord[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": userPk(userId) },
        ScanIndexForward: false,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );

    for (const item of result.Items ?? []) {
      records.push(toRecord(item));
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey !== undefined);

  return records;
}

/**
 * Load a conversation only if `userId` owns it (Req 6.2, 7.3).
 *
 * `GetItem` at `PK = USER#<userId>, SK = CONV#<conversationId>`; returns `null`
 * when the item is absent. This is the ownership gate used by the message store
 * and route handlers before any per-conversation read/write.
 */
export async function getConversationOwned(
  userId: string,
  conversationId: string,
): Promise<ConversationRecord | null> {
  const result = await getDocClient().send(
    new GetCommand({
      TableName: historyTableName(),
      Key: {
        PK: userPk(userId),
        SK: convSk(conversationId),
      },
    }),
  );

  if (result.Item === undefined) {
    return null;
  }
  return toRecord(result.Item);
}

/**
 * Rename a conversation, recording whether the title came from the AI summary or
 * the user (Req 6.5, 8.5).
 *
 * `UpdateItem` sets `title` + `titleSource` on the conversation item at
 * `PK = USER#<userId>, SK = CONV#<conversationId>`. Scoped to the owning user's
 * partition so a caller can only rename their own conversation.
 */
export async function renameConversation(
  userId: string,
  conversationId: string,
  title: string,
  source: "ai" | "user",
): Promise<void> {
  await getDocClient().send(
    new UpdateCommand({
      TableName: historyTableName(),
      Key: {
        PK: userPk(userId),
        SK: convSk(conversationId),
      },
      UpdateExpression: "SET title = :title, titleSource = :source",
      ExpressionAttributeValues: {
        ":title": title,
        ":source": source,
      },
    }),
  );
}

/**
 * Bump a conversation's `updatedAt` and its `GSI1SK` ordering key (Req 6.4).
 *
 * `UpdateItem` sets `updatedAt = <iso>` and `GSI1SK = TS#<iso>` so the
 * conversation floats to the top of the most-recently-updated list.
 */
export async function touchUpdatedAt(
  userId: string,
  conversationId: string,
  iso: string,
): Promise<void> {
  await getDocClient().send(
    new UpdateCommand({
      TableName: historyTableName(),
      Key: {
        PK: userPk(userId),
        SK: convSk(conversationId),
      },
      UpdateExpression: "SET updatedAt = :iso, GSI1SK = :gsi1sk",
      ExpressionAttributeValues: {
        ":iso": iso,
        ":gsi1sk": gsi1Sk(iso),
      },
    }),
  );
}

/**
 * Delete a conversation and all of its messages (Req 6.6).
 *
 * The message items live under `PK = CONV#<conversationId>, SK begins_with
 * "MSG#"`; they are queried (paginated) and removed via batched `DeleteRequest`s
 * before the conversation item itself is deleted at
 * `PK = USER#<userId>, SK = CONV#<conversationId>`. Deleting the conversation
 * item last means a mid-cascade failure still leaves the item reachable for a
 * retry (no orphaned, unlistable messages).
 */
export async function deleteConversation(
  userId: string,
  conversationId: string,
): Promise<void> {
  const client = getDocClient();
  const tableName = historyTableName();
  const messagePk = convPk(conversationId);

  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: {
          ":pk": messagePk,
          ":prefix": MSG_PREFIX,
        },
        ProjectionExpression: "PK, SK",
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );

    const items = result.Items ?? [];
    for (let i = 0; i < items.length; i += 1) {
      await client.send(
        new DeleteCommand({
          TableName: tableName,
          Key: { PK: items[i].PK, SK: items[i].SK },
        }),
      );
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey !== undefined);

  await client.send(
    new DeleteCommand({
      TableName: tableName,
      Key: {
        PK: userPk(userId),
        SK: convSk(conversationId),
      },
    }),
  );
}
