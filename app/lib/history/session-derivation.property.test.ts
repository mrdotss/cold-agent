import { describe, it, expect } from "vitest";
import * as fc from "fast-check";

import { buildConversationItem } from "@/lib/history/items";
import { sessionIdForThread } from "@/lib/session-id";

describe("deterministic session derivation property", () => {
  it("conversation item sessionId is the deterministic derivation of its conversationId and within [33,128]", () => {
    // Feature: cloud-bill-analyst-web-iteration-2, Property 13: Session id is the deterministic derivation of the conversation id
    // Validates: Requirements 5.4, 8.7

    const titleSource = fc.constantFrom(
      "pending" as const,
      "ai" as const,
      "user" as const,
    );

    fc.assert(
      fc.property(
        fc.string(),
        fc.string(),
        fc.string(),
        titleSource,
        fc.string(),
        fc.string(),
        fc.string(),
        fc.nat(),
        (
          userId,
          conversationId,
          title,
          source,
          accountId,
          createdAt,
          updatedAt,
          messageCount,
        ) => {
          const input = {
            conversationId,
            title,
            titleSource: source,
            accountId,
            createdAt,
            updatedAt,
            messageCount,
          };

          const item = buildConversationItem(userId, input);

          // The builder derives sessionId internally via sessionIdForThread.
          expect(item.sessionId).toBe(sessionIdForThread(conversationId));

          // Determinism: building twice from the same inputs yields the same
          // sessionId (same conversationId -> same sessionId).
          const again = buildConversationItem(userId, input);
          expect(again.sessionId).toBe(item.sessionId);

          // Length invariant: within the inclusive [33, 128] range.
          expect(item.sessionId.length).toBeGreaterThanOrEqual(33);
          expect(item.sessionId.length).toBeLessThanOrEqual(128);
        },
      ),
      { numRuns: 200 },
    );
  });
});
