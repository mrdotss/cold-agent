import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fc from "fast-check";

import { convPk, msgSk } from "@/lib/history/keys";

/**
 * Property test for message ordering in the DynamoDB message store
 * (`lib/history/messages.ts`, `listMessages`).
 *
 * `listMessages` performs an ownership `GetItem` (via `getConversationOwned`)
 * and then a `QueryCommand` on `PK = CONV#<id>` with `begins_with(SK, "MSG#")`,
 * relying on `ScanIndexForward`'s default (`true`, ascending). Because message
 * sort keys are `MSG#<createdAtIso>#<uuid>`, ascending SK order equals
 * `createdAt`-ascending order — i.e. oldest-first (Req 6.7).
 *
 * Mock strategy
 * -------------
 * `messages.ts` starts with `import "server-only"`; the project's vitest config
 * already aliases `server-only` to a no-op stub, so the module imports cleanly.
 * We mock its two collaborators so the test is deterministic and hits no AWS:
 *   - `@/lib/history/conversations` → `getConversationOwned` returns a non-null
 *     owned conversation, so `listMessages` proceeds past the ownership gate to
 *     the query. Because ownership is mocked HERE (separately), the document
 *     client's `.send` inside `listMessages` only ever receives the
 *     `QueryCommand` — so the fake `.send` can return the query items for any
 *     call.
 *   - `@/lib/aws/dynamo` → `getDocClient()` returns a fake whose `.send` resolves
 *     with `{ Items: <items in ascending SK order> }` (simulating DynamoDB's
 *     `ScanIndexForward = true` behaviour) and no `LastEvaluatedKey` (so the
 *     store's pagination loop runs exactly once); `historyTableName()` returns a
 *     dummy table name.
 *
 * Lexicographic == chronological
 * -------------------------------
 * Each message's `createdAt` is produced with `new Date(ms).toISOString()` for
 * arbitrary DISTINCT `ms` values, constrained to `[0, 253402300799999]` (up to
 * year 9999). Every such timestamp is a fixed-width, 24-char UTC "Zulu" string
 * (`YYYY-MM-DDTHH:mm:ss.sssZ`), so lexicographic ordering of the strings equals
 * chronological ordering. The SKs (`MSG#<iso>#<uuid>`) therefore sort
 * lexicographically in the same order as the timestamps sort chronologically.
 *
 * Ordering assertion
 * ------------------
 * We feed the mocked query the items in ascending SK order (as DynamoDB would),
 * call `listMessages`, and assert the returned `createdAt` sequence is
 * non-decreasing (oldest-first) AND that the returned messages equal the inputs
 * sorted by SK ascending (both `createdAt` and `id`/SK sequences match).
 */

const { sendMock, getDocClient, historyTableName, getConversationOwned } =
  vi.hoisted(() => {
    const sendMock = vi.fn();
    return {
      sendMock,
      getDocClient: vi.fn(() => ({ send: sendMock })),
      historyTableName: vi.fn(() => "test-history-table"),
      getConversationOwned: vi.fn(),
    };
  });

vi.mock("@/lib/aws/dynamo", () => ({
  getDocClient,
  historyTableName,
}));

vi.mock("@/lib/history/conversations", () => ({
  getConversationOwned,
}));

const { listMessages } = await import("@/lib/history/messages");

/** Max epoch-ms that still renders as a 4-digit year (9999-12-31T23:59:59.999Z). */
const MAX_MS = 253402300799999;

interface Seed {
  ms: number;
  uuid: string;
}

/**
 * A list of message seeds with DISTINCT `ms` values so `createdAt` ordering is
 * unambiguous. Uniqueness is keyed on `ms` (the timestamp source).
 */
const seedsArb: fc.Arbitrary<Seed[]> = fc.uniqueArray(
  fc.record({
    ms: fc.integer({ min: 0, max: MAX_MS }),
    uuid: fc.uuid(),
  }),
  { selector: (s) => s.ms, minLength: 0, maxLength: 25 },
);

beforeEach(() => {
  sendMock.mockReset();
  getConversationOwned.mockReset();
});

describe("Property 14 — messages are returned oldest-first", () => {
  it("listMessages returns messages ordered by createdAt ascending", async () => {
    // Feature: cloud-bill-analyst-web-iteration-2, Property 14: Messages are returned oldest-first
    // Validates: Requirements 6.7
    await fc.assert(
      fc.asyncProperty(
        fc.string(),
        fc.string(),
        seedsArb,
        async (userId, conversationId, seeds) => {
          // Reset call counts per iteration (beforeEach only runs once per `it`).
          sendMock.mockClear();
          getConversationOwned.mockClear();

          // Ownership gate passes: return a non-null owned conversation so
          // listMessages proceeds to the query.
          getConversationOwned.mockResolvedValue({
            conversationId,
            accountId: "acct-1",
            titleSource: "user",
          });

          // Build the raw Message_Items with SK = MSG#<iso>#<uuid> and a matching
          // createdAt derived from the same fixed-width Zulu timestamp.
          const items = seeds.map((s) => {
            const iso = new Date(s.ms).toISOString();
            return {
              PK: convPk(conversationId),
              SK: msgSk(iso, s.uuid),
              userId,
              role: "user" as const,
              content: `m-${s.ms}`,
              charts: [],
              reports: [],
              createdAt: iso,
            };
          });

          // Simulate DynamoDB ScanIndexForward=true: items come back in
          // ASCENDING sort-key order. No LastEvaluatedKey -> single page.
          const ascendingItems = [...items].sort((a, b) =>
            a.SK < b.SK ? -1 : a.SK > b.SK ? 1 : 0,
          );
          sendMock.mockResolvedValue({
            Items: ascendingItems,
            LastEvaluatedKey: undefined,
          });

          const result = await listMessages(userId, conversationId);

          // The store proceeded past the ownership gate and queried exactly once.
          expect(sendMock).toHaveBeenCalledTimes(1);
          expect(result).toHaveLength(seeds.length);

          // 1) createdAt sequence is non-decreasing (oldest-first). Because the
          //    Zulu timestamps are fixed-width, chronological == lexicographic,
          //    so parsing back to epoch ms must be monotonically non-decreasing.
          for (let i = 1; i < result.length; i++) {
            const prev = Date.parse(result[i - 1].createdAt);
            const curr = Date.parse(result[i].createdAt);
            expect(prev).toBeLessThanOrEqual(curr);
          }

          // 2) The returned order equals the inputs sorted by SK ascending, both
          //    for createdAt and for the projected id (the SK).
          expect(result.map((m) => m.createdAt)).toEqual(
            ascendingItems.map((it) => it.createdAt),
          );
          expect(result.map((m) => m.id)).toEqual(
            ascendingItems.map((it) => it.SK),
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});
