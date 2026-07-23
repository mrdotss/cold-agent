/**
 * Single-table key builders for the DynamoDB chat-history store.
 *
 * These are pure, dependency-free, client-safe helpers that centralize the
 * key encoding for the single-table design (Req 5.2, 5.5). Conversation items
 * live at `PK=USER#<userId>, SK=CONV#<conversationId>` and are listed per user
 * via GSI1 (`GSI1PK=USER#<userId>, GSI1SK=TS#<updatedAtIso>`); message items
 * live under `PK=CONV#<conversationId>, SK=MSG#<createdAtIso>#<ulid>` (Req 6.4).
 *
 * No `server-only`, no AWS SDK, no other imports: the same encoding can be used
 * on both the server (data layer) and the client without leaking secrets.
 */

/** Partition key for a user's conversation items and GSI1 list partition. */
export const userPk = (userId: string) => `USER#${userId}`;

/** Sort key for a conversation item under its owning user partition. */
export const convSk = (conversationId: string) => `CONV#${conversationId}`;

/** Partition key for the message items belonging to a conversation. */
export const convPk = (conversationId: string) => `CONV#${conversationId}`;

/** GSI1 sort key: updated-at timestamp ordering for the conversation list. */
export const gsi1Sk = (updatedAtIso: string) => `TS#${updatedAtIso}`;

/** Sort key for a message item, ordered by creation time then ULID tiebreak. */
export const msgSk = (createdAtIso: string, ulid: string) =>
  `MSG#${createdAtIso}#${ulid}`;

/** Prefix used to query/select message items within a conversation partition. */
export const MSG_PREFIX = "MSG#";
