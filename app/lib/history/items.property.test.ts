import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import type { ChartSpec } from "@/lib/aws/sse";
import { sessionIdForThread } from "@/lib/session-id";
import { MSG_PREFIX } from "@/lib/history/keys";
import {
  buildConversationItem,
  buildMessageItem,
  type ConversationItemInput,
  type MessageItemInput,
} from "./items";

/**
 * Property tests for the pure item builders in `lib/history/items.ts`
 * (`buildConversationItem`, `buildMessageItem`). The builders assemble the
 * single-table DynamoDB items and must carry EVERY required attribute plus the
 * derived keys, while the message builder must handle the optional `feedback`
 * and `activity` attributes correctly (omit-when-unset semantics).
 *
 * These builders are pure (no DynamoDB, no I/O), so the tests drive them
 * directly with generated inputs and assert on the returned item shape.
 */

/** The four chart types accepted by a `ChartSpec` (Req 2.2). */
const chartTypeArb: fc.Arbitrary<ChartSpec["chart_type"]> = fc.constantFrom(
  "bar",
  "hbar",
  "line",
  "pie",
);

/**
 * A valid `ChartSpec`: `labels` (string[]) and `values` (number[]) are parallel
 * arrays of EQUAL length. The length is chosen first, then both arrays are
 * generated at exactly that length so they always match.
 */
const chartSpecArb: fc.Arbitrary<ChartSpec> = fc.nat({ max: 6 }).chain((len) =>
  fc.record({
    id: fc.string(),
    chart_type: chartTypeArb,
    title: fc.string(),
    currency: fc.string(),
    labels: fc.array(fc.string(), { minLength: len, maxLength: len }),
    values: fc.array(
      fc.double({ noNaN: true, noDefaultInfinity: true }),
      { minLength: len, maxLength: len },
    ),
  }),
);

/** A `reports` entry: an object carrying an S3 `key`. */
const reportArb: fc.Arbitrary<{ key: string }> = fc.record({ key: fc.string() });

/** An `activity` entry: a friendly `status` phrase + a small `label` badge. */
const activityEntryArb: fc.Arbitrary<{ label: string; status: string }> =
  fc.record({ label: fc.string(), status: fc.string() });

/** The three title sources a conversation can have (Req 5.3, 9.x). */
const titleSourceArb: fc.Arbitrary<ConversationItemInput["titleSource"]> =
  fc.constantFrom("pending", "ai", "user");

/** An arbitrary `ConversationItemInput` (note: `sessionId` is derived, not supplied). */
const conversationInputArb: fc.Arbitrary<ConversationItemInput> = fc.record({
  conversationId: fc.string(),
  title: fc.string(),
  titleSource: titleSourceArb,
  accountId: fc.string(),
  createdAt: fc.string(),
  updatedAt: fc.string(),
  messageCount: fc.nat(),
});

describe("Property 9 — conversation items carry all required attributes", () => {
  it("buildConversationItem returns keys + all attributes with a derived sessionId", () => {
    // Feature: cloud-bill-analyst-web-iteration-2, Property 9: Conversation items carry all required attributes — for arbitrary inputs, buildConversationItem(userId, input) returns an item with PK=USER#<userId>, SK=CONV#<conversationId>, GSI1PK=USER#<userId>, GSI1SK=TS#<updatedAt>, and all attributes: conversationId, title, titleSource ∈ {pending,ai,user}, accountId, sessionId, createdAt, updatedAt, messageCount.
    // Validates: Requirements 5.3, 14.1
    fc.assert(
      fc.property(fc.string(), conversationInputArb, (userId, input) => {
        const item = buildConversationItem(userId, input);

        // Keys and GSI1 projection.
        expect(item.PK).toBe(`USER#${userId}`);
        expect(item.SK).toBe(`CONV#${input.conversationId}`);
        expect(item.GSI1PK).toBe(`USER#${userId}`);
        expect(item.GSI1SK).toBe(`TS#${input.updatedAt}`);

        // All required attributes are present and carry the input values.
        expect(item.conversationId).toBe(input.conversationId);
        expect(item.title).toBe(input.title);
        expect(item.titleSource).toBe(input.titleSource);
        expect(["pending", "ai", "user"]).toContain(item.titleSource);
        expect(item.accountId).toBe(input.accountId);
        expect(item.createdAt).toBe(input.createdAt);
        expect(item.updatedAt).toBe(input.updatedAt);
        expect(item.messageCount).toBe(input.messageCount);

        // sessionId is DERIVED from the conversationId (never supplied by caller).
        expect(item.sessionId).toBe(sessionIdForThread(input.conversationId));

        // Every required key is actually present on the object.
        for (const key of [
          "PK",
          "SK",
          "GSI1PK",
          "GSI1SK",
          "conversationId",
          "title",
          "titleSource",
          "accountId",
          "sessionId",
          "createdAt",
          "updatedAt",
          "messageCount",
        ]) {
          expect(Object.prototype.hasOwnProperty.call(item, key)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe("Property 11 — message items carry all required attributes", () => {
  it("buildMessageItem returns keys + all attributes, and handles feedback across absent/up/down", () => {
    // Feature: cloud-bill-analyst-web-iteration-2, Property 11: Message items carry all required attributes — for arbitrary inputs, buildMessageItem(input) returns an item with PK=CONV#<conversationId>, SK beginning with MSG#, and attributes userId, role ∈ {user,assistant}, content, charts (array), reports (array), createdAt; the optional feedback attribute is absent when unset and ∈ {up,down} when set, and optional activity is absent when unset and present when set.
    // Validates: Requirements 5.6, 14.1
    fc.assert(
      fc.property(
        fc.record({
          conversationId: fc.string(),
          userId: fc.string(),
          role: fc.constantFrom<"user" | "assistant">("user", "assistant"),
          content: fc.string(),
          charts: fc.array(chartSpecArb, { maxLength: 4 }),
          reports: fc.array(reportArb, { maxLength: 4 }),
          createdAt: fc.string(),
          // Three-case coverage: undefined (absent), "up", or "down".
          feedback: fc.option(fc.constantFrom<"up" | "down">("up", "down"), {
            nil: undefined,
          }),
          // Optional activity: absent vs present.
          activity: fc.option(
            fc.array(activityEntryArb, { maxLength: 4 }),
            { nil: undefined },
          ),
        }),
        (input) => {
          const built = buildMessageItem(input as MessageItemInput);

          // Keys.
          expect(built.PK).toBe(`CONV#${input.conversationId}`);
          expect(built.SK.startsWith(MSG_PREFIX)).toBe(true);
          expect(built.SK.startsWith("MSG#")).toBe(true);

          // Required attributes carry the input values.
          expect(built.userId).toBe(input.userId);
          expect(built.role).toBe(input.role);
          expect(["user", "assistant"]).toContain(built.role);
          expect(built.content).toBe(input.content);
          expect(Array.isArray(built.charts)).toBe(true);
          expect(built.charts).toEqual(input.charts);
          expect(Array.isArray(built.reports)).toBe(true);
          expect(built.reports).toEqual(input.reports);
          expect(built.createdAt).toBe(input.createdAt);

          // Every always-present key exists on the object.
          for (const key of [
            "PK",
            "SK",
            "userId",
            "role",
            "content",
            "charts",
            "reports",
            "createdAt",
          ]) {
            expect(Object.prototype.hasOwnProperty.call(built, key)).toBe(true);
          }

          // feedback — three-case coverage.
          const hasFeedback = Object.prototype.hasOwnProperty.call(
            built,
            "feedback",
          );
          if (input.feedback === undefined) {
            // Absent input -> the built item has NO feedback key (or it is absent).
            expect(built.feedback).toBeUndefined();
            expect(hasFeedback).toBe(false);
          } else {
            // Present input -> feedback equals the value and is in {up,down}.
            expect(hasFeedback).toBe(true);
            expect(built.feedback).toBe(input.feedback);
            expect(["up", "down"]).toContain(built.feedback);
          }

          // activity — absent vs present.
          const hasActivity = Object.prototype.hasOwnProperty.call(
            built,
            "activity",
          );
          if (input.activity === undefined) {
            expect(built.activity).toBeUndefined();
            expect(hasActivity).toBe(false);
          } else {
            expect(hasActivity).toBe(true);
            expect(built.activity).toEqual(input.activity);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
