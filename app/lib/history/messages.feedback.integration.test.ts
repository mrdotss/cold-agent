// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

import { convPk, convSk, userPk } from "@/lib/history/keys";

/**
 * Integration tests for the single Message_Feedback write path
 * (`setMessageFeedback`) wired through the REAL ownership gate
 * `getConversationOwned` (Req 14.2, 14.3).
 *
 * ## Scope & environment
 *
 * These run in the **node** environment (see the `@vitest-environment node`
 * docblock): the code under test is the server-only `lib/history/messages.ts`
 * store, so there is deliberately NO DOM here.
 *
 * ## What is REAL vs. FAKED
 *
 * - **REAL:** `setMessageFeedback` AND the real `getConversationOwned` it calls
 *   first (from `lib/history/conversations.ts`). Both build real
 *   `GetCommand`/`UpdateCommand` instances (`@aws-sdk/lib-dynamodb`) and drive
 *   them through the document client's `.send`. Because both flow through the
 *   SAME mocked `.send`, the ordering GetCommand → UpdateCommand is directly
 *   observable in the single mock's call list.
 * - **FAKED:** `@/lib/aws/dynamo` — `getDocClient()` returns `{ send }` where
 *   `send` is a `vi.fn()`, and `historyTableName()` returns a fixed name, so no
 *   real AWS/DynamoDB is ever touched (hermetic).
 *
 * `server-only` is stubbed to a no-op by the Vitest config alias, so the
 * server-only store modules import cleanly under test.
 */

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

const TABLE_NAME = "cba-chat-history-test";

vi.mock("@/lib/aws/dynamo", () => ({
  getDocClient: () => ({ send: sendMock }),
  historyTableName: () => TABLE_NAME,
  MissingHistoryConfigError: class MissingHistoryConfigError extends Error {},
}));

import { setMessageFeedback } from "./messages";

const USER_ID = "user-123";
const CONVERSATION_ID = "conv-abc";
const MESSAGE_SK = "MSG#2026-06-01T12:00:01.500Z#11111111-1111-1111-1111-111111111111";

/** A minimal owned-conversation item as returned by the owner `GetItem`. */
function ownedItem() {
  return {
    PK: userPk(USER_ID),
    SK: convSk(CONVERSATION_ID),
    conversationId: CONVERSATION_ID,
    title: "June spend",
    titleSource: "user",
    accountId: "acct-1",
    sessionId: "session-1",
    createdAt: "2026-06-01T12:00:00.000Z",
    updatedAt: "2026-06-01T12:00:01.500Z",
    messageCount: 2,
  };
}

beforeEach(() => {
  sendMock.mockReset();
});

describe("setMessageFeedback write path (mocked doc client)", () => {
  it("gets the owner conversation item BEFORE issuing the UpdateItem on the addressed Message_Item", async () => {
    // First `.send` = owner GetCommand → returns the owned conversation item;
    // second `.send` = the feedback UpdateCommand.
    sendMock
      .mockResolvedValueOnce({ Item: ownedItem() })
      .mockResolvedValueOnce({});

    await setMessageFeedback(USER_ID, CONVERSATION_ID, MESSAGE_SK, "up");

    // Exactly two sends: the ownership Get, then the feedback Update — in order.
    expect(sendMock).toHaveBeenCalledTimes(2);

    const [getCommand] = sendMock.mock.calls[0];
    const [updateCommand] = sendMock.mock.calls[1];

    // Ordering: the ownership Get precedes the Update.
    expect(getCommand.constructor.name).toBe("GetCommand");
    expect(updateCommand.constructor.name).toBe("UpdateCommand");

    // The owner check reads PK=USER#<id>, SK=CONV#<id>.
    expect(getCommand.input).toMatchObject({
      TableName: TABLE_NAME,
      Key: {
        PK: userPk(USER_ID),
        SK: convSk(CONVERSATION_ID),
      },
    });

    // The Update targets the addressed Message_Item and sets `feedback`.
    expect(updateCommand.input).toMatchObject({
      TableName: TABLE_NAME,
      Key: {
        PK: convPk(CONVERSATION_ID),
        SK: MESSAGE_SK,
      },
      UpdateExpression: "SET feedback = :feedback",
      ExpressionAttributeValues: { ":feedback": "up" },
    });
  });

  it("performs NO UpdateItem when the owner item is absent", async () => {
    // Owner GetItem returns no Item → getConversationOwned resolves to null.
    sendMock.mockResolvedValueOnce({});

    await setMessageFeedback(USER_ID, CONVERSATION_ID, MESSAGE_SK, "up");

    // Only the ownership Get ran; no UpdateItem followed.
    expect(sendMock).toHaveBeenCalledTimes(1);

    const [onlyCommand] = sendMock.mock.calls[0];
    expect(onlyCommand.constructor.name).toBe("GetCommand");

    const issuedUpdate = sendMock.mock.calls.some(
      ([command]) => command.constructor.name === "UpdateCommand",
    );
    expect(issuedUpdate).toBe(false);
  });

  it.each(["up", "down"] as const)(
    "persists exactly the %s value in the UpdateItem",
    async (feedback) => {
      sendMock
        .mockResolvedValueOnce({ Item: ownedItem() })
        .mockResolvedValueOnce({});

      await setMessageFeedback(USER_ID, CONVERSATION_ID, MESSAGE_SK, feedback);

      const [updateCommand] = sendMock.mock.calls[1];
      expect(updateCommand.constructor.name).toBe("UpdateCommand");
      expect(updateCommand.input.ExpressionAttributeValues).toEqual({
        ":feedback": feedback,
      });
    },
  );
});
