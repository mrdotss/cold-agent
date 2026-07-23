import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

/**
 * Integration tests for the single-table chat-history access patterns
 * (`lib/history/conversations.ts` + `lib/history/messages.ts`) against a mocked
 * `DynamoDBDocumentClient`.
 *
 * ## File-layout choice
 *
 * Both the conversation-store and message-store access patterns are exercised in
 * THIS one file (rather than split into `messages.integration.test.ts`) because
 * the message paths (`appendMessage`, `listMessages`) authorize ownership by
 * calling the REAL `getConversationOwned` from `conversations.ts`. Keeping them
 * together lets a single mocked doc client drive both modules and lets us assert
 * the cross-module "get-owner-before-query" ordering directly.
 *
 * ## What is REAL vs. FAKED
 *
 * - **REAL:** the store functions under test run their actual command-building
 *   logic, and — importantly — the REAL `getConversationOwned` runs for the
 *   message paths (approach (a) from the task): it issues its own `GetCommand`
 *   through the same mocked doc client, so the ordering "owner `GetItem` BEFORE
 *   the message `QueryCommand`" is observable in the recorded `.send` sequence.
 * - **FAKED:** only the doc-client boundary — `@/lib/aws/dynamo`'s
 *   `getDocClient()` returns `{ send: sendMock }` and `historyTableName()`
 *   returns a fixed table name. `sendMock` is a `vi.fn()` whose per-test
 *   implementation returns the appropriate shape keyed by the command's
 *   `constructor.name` (`GetCommand`/`QueryCommand`/`PutCommand`/`UpdateCommand`/
 *   `DeleteCommand`). `server-only` is already aliased to a no-op in
 *   `vitest.config.ts`, so no manual `vi.mock("server-only", …)` is needed.
 *
 * These cover Req 6.1 (GSI1 list, `ScanIndexForward=false`), 6.2 (owner GetItem
 * before the message query, query skipped when the owner is absent), 6.3
 * (append = Put + atomic `messageCount` increment), 6.4 (`updatedAt`/`GSI1SK`
 * bump), and 6.6 (delete removes message items + the conversation item).
 */

const TABLE_NAME = "test-history-table";

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock("@/lib/aws/dynamo", () => ({
  getDocClient: () => ({ send: sendMock }),
  historyTableName: () => TABLE_NAME,
}));

// Imported AFTER the mock is registered so the stores bind to the fake client.
import {
  deleteConversation,
  listConversations,
} from "@/lib/history/conversations";
import { appendMessage, listMessages } from "@/lib/history/messages";
import type { MessageRecord } from "@/lib/history/items";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const USER_ID = "user_1";
const CONVERSATION_ID = "conv_1";

/** A fully-populated owned Conversation item as returned by a GetItem. */
function ownedConversationItem(): Record<string, unknown> {
  return {
    PK: `USER#${USER_ID}`,
    SK: `CONV#${CONVERSATION_ID}`,
    GSI1PK: `USER#${USER_ID}`,
    GSI1SK: "TS#2026-06-01T12:00:00.000Z",
    conversationId: CONVERSATION_ID,
    title: "June spend review",
    titleSource: "ai",
    accountId: "acct_1",
    sessionId: `sess_${"a".repeat(35)}`,
    createdAt: "2026-06-01T12:00:00.000Z",
    updatedAt: "2026-06-01T12:00:00.000Z",
    messageCount: 2,
  };
}

/** The command constructor names in the exact order `.send` was invoked. */
function sentCommandNames(): string[] {
  return sendMock.mock.calls.map((call) => call[0].constructor.name);
}

/** All recorded commands of a given class, in call order. */
function commandsOfType<T>(ctor: new (...args: never[]) => T): T[] {
  return sendMock.mock.calls
    .map((call) => call[0])
    .filter((command): command is T => command instanceof ctor);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Req 6.1 — list queries GSI1 with ScanIndexForward=false (most-recent first).
// ---------------------------------------------------------------------------
describe("listConversations — GSI1 most-recent-first query (Req 6.1)", () => {
  it("issues a QueryCommand on GSI1 keyed by GSI1PK with ScanIndexForward:false", async () => {
    sendMock.mockImplementation(async (command: unknown) => {
      if ((command as { constructor: { name: string } }).constructor.name === "QueryCommand") {
        // No LastEvaluatedKey => the pagination loop terminates after one page.
        return { Items: [ownedConversationItem()] };
      }
      return {};
    });

    const records = await listConversations(USER_ID);

    const queries = commandsOfType(QueryCommand);
    expect(queries).toHaveLength(1);

    const input = queries[0].input;
    expect(input.TableName).toBe(TABLE_NAME);
    expect(input.IndexName).toBe("GSI1");
    // Key condition is on the GSI1 partition key.
    expect(input.KeyConditionExpression).toContain("GSI1PK");
    expect(input.ExpressionAttributeValues?.[":pk"]).toBe(`USER#${USER_ID}`);
    // Descending order => most-recently-updated first.
    expect(input.ScanIndexForward).toBe(false);

    // The single page is projected back to a record.
    expect(records).toHaveLength(1);
    expect(records[0].conversationId).toBe(CONVERSATION_ID);
  });
});

// ---------------------------------------------------------------------------
// Req 6.2 — owner GetItem gates the message query; skipped when owner absent.
// ---------------------------------------------------------------------------
describe("listMessages — get-owner-before-query gate (Req 6.2)", () => {
  it("skips the message QueryCommand and returns [] when the owner item is absent", async () => {
    // GetItem returns no Item => getConversationOwned resolves to null.
    sendMock.mockImplementation(async () => ({}));

    const messages = await listMessages(USER_ID, CONVERSATION_ID);

    expect(messages).toEqual([]);
    // Exactly one send — the ownership GetItem — and NO message query.
    const names = sentCommandNames();
    expect(names).toEqual(["GetCommand"]);
    expect(commandsOfType(QueryCommand)).toHaveLength(0);
  });

  it("issues the ownership GetItem BEFORE the message QueryCommand when owned", async () => {
    sendMock.mockImplementation(async (command: unknown) => {
      const name = (command as { constructor: { name: string } }).constructor.name;
      if (name === "GetCommand") return { Item: ownedConversationItem() };
      if (name === "QueryCommand") return { Items: [] };
      return {};
    });

    await listMessages(USER_ID, CONVERSATION_ID);

    // Order matters: owner GetItem first, then the message query (Req 6.2).
    const names = sentCommandNames();
    expect(names).toEqual(["GetCommand", "QueryCommand"]);

    const get = commandsOfType(GetCommand)[0];
    expect(get.input.Key).toEqual({
      PK: `USER#${USER_ID}`,
      SK: `CONV#${CONVERSATION_ID}`,
    });

    const query = commandsOfType(QueryCommand)[0];
    expect(query.input.ExpressionAttributeValues?.[":pk"]).toBe(
      `CONV#${CONVERSATION_ID}`,
    );
    expect(query.input.KeyConditionExpression).toContain("begins_with(SK, :prefix)");
  });
});

// ---------------------------------------------------------------------------
// Req 6.3, 6.4 — append = Put(message) + Update(count++/updatedAt/GSI1SK).
// ---------------------------------------------------------------------------
describe("appendMessage — Put + Update on an owned conversation (Req 6.3, 6.4)", () => {
  it("puts the message item then updates the conversation counter + ordering", async () => {
    sendMock.mockImplementation(async (command: unknown) => {
      const name = (command as { constructor: { name: string } }).constructor.name;
      if (name === "GetCommand") return { Item: ownedConversationItem() };
      return {};
    });

    const msg: MessageRecord = {
      userId: USER_ID,
      role: "user",
      content: "How much did I spend in June?",
      charts: [],
      reports: [],
      createdAt: "2026-06-02T09:30:00.000Z",
    };

    await appendMessage(USER_ID, CONVERSATION_ID, msg);

    // Ownership GetItem first, then Put (message), then Update (conversation).
    expect(sentCommandNames()).toEqual([
      "GetCommand",
      "PutCommand",
      "UpdateCommand",
    ]);

    // Put writes the Message_Item under the conversation partition.
    const put = commandsOfType(PutCommand)[0];
    expect(put.input.TableName).toBe(TABLE_NAME);
    const putItem = put.input.Item as Record<string, unknown>;
    expect(putItem.PK).toBe(`CONV#${CONVERSATION_ID}`);
    expect(String(putItem.SK)).toMatch(/^MSG#2026-06-02T09:30:00\.000Z#/);
    expect(putItem.userId).toBe(USER_ID);
    expect(putItem.content).toBe(msg.content);

    // Update bumps the conversation: ADD messageCount + SET updatedAt/GSI1SK.
    const update = commandsOfType(UpdateCommand)[0];
    expect(update.input.Key).toEqual({
      PK: `USER#${USER_ID}`,
      SK: `CONV#${CONVERSATION_ID}`,
    });
    const expr = update.input.UpdateExpression ?? "";
    expect(expr).toContain("ADD messageCount :one");
    expect(expr).toContain("SET updatedAt = :iso");
    expect(expr).toContain("GSI1SK = :g");
    const values = update.input.ExpressionAttributeValues ?? {};
    expect(values[":one"]).toBe(1);
    expect(values[":iso"]).toBe(msg.createdAt);
    expect(values[":g"]).toBe(`TS#${msg.createdAt}`);
  });
});

// ---------------------------------------------------------------------------
// Req 6.6 — delete removes the message items then the conversation item.
// ---------------------------------------------------------------------------
describe("deleteConversation — cascade delete (Req 6.6)", () => {
  it("queries the message partition then deletes each message item + the conversation item", async () => {
    const messageKeys = [
      { PK: `CONV#${CONVERSATION_ID}`, SK: "MSG#2026-06-01T12:00:00.000Z#m1" },
      { PK: `CONV#${CONVERSATION_ID}`, SK: "MSG#2026-06-01T12:00:01.000Z#m2" },
    ];

    sendMock.mockImplementation(async (command: unknown) => {
      const name = (command as { constructor: { name: string } }).constructor.name;
      if (name === "QueryCommand") return { Items: messageKeys };
      return {};
    });

    await deleteConversation(USER_ID, CONVERSATION_ID);

    // Query the message partition first, then a Delete per message, then the
    // conversation-item delete LAST.
    expect(sentCommandNames()).toEqual([
      "QueryCommand",
      "DeleteCommand",
      "DeleteCommand",
      "DeleteCommand",
    ]);

    // The query targets the conversation's message partition, projecting keys.
    const query = commandsOfType(QueryCommand)[0];
    expect(query.input.ExpressionAttributeValues?.[":pk"]).toBe(
      `CONV#${CONVERSATION_ID}`,
    );
    expect(query.input.KeyConditionExpression).toContain("begins_with(SK, :prefix)");

    const deletes = commandsOfType(DeleteCommand);
    expect(deletes).toHaveLength(3);

    // First two deletes remove the queried message items (by their PK/SK).
    expect(deletes[0].input.Key).toEqual(messageKeys[0]);
    expect(deletes[1].input.Key).toEqual(messageKeys[1]);

    // The final delete removes the conversation item under the user partition.
    expect(deletes[2].input.Key).toEqual({
      PK: `USER#${USER_ID}`,
      SK: `CONV#${CONVERSATION_ID}`,
    });
  });
});
