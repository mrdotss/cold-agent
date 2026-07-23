import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  insertPlaceholder,
  reconcileCreated,
  rollbackPlaceholder,
  applyRename,
  rollbackRename,
  type ConversationListItem,
} from "./useConversations";

/**
 * Property tests for the PURE, framework-free optimistic list-state helpers
 * exported by `useConversations.ts` (Requirement 1: snappy, optimistic
 * conversation sidebar). These helpers are `list in → new list out` with no
 * mutation, so the tests drive them directly — no React, no fetch, no DOM.
 *
 * Property 17 (Req 1.5): `insertPlaceholder` then `reconcileCreated` yields a
 *   list with EXACTLY ONE row for the created conversation and no placeholder
 *   row; reconciling again is idempotent (no duplicate).
 * Property 18 (Req 1.6): `rollbackPlaceholder(insertPlaceholder(list, p), p.id)`
 *   deep-equals the original list; `rollbackRename(applyRename(...), prevTitle)`
 *   restores the row's original title.
 */

const NUM_RUNS = 200;

/** ISO-8601 timestamp arbitrary over a realistic epoch range. */
const isoArb: fc.Arbitrary<string> = fc
  .integer({ min: 0, max: 4102444800000 })
  .map((ms) => new Date(ms).toISOString());

/** `titleSource` union arbitrary. */
const titleSourceArb: fc.Arbitrary<ConversationListItem["titleSource"]> =
  fc.constantFrom(...(["pending", "ai", "user"] as const));

/** The non-id fields of a {@link ConversationListItem}. */
const bodyArb = fc.record({
  title: fc.string(),
  titleSource: titleSourceArb,
  accountId: fc.string(),
  createdAt: isoArb,
  updatedAt: isoArb,
  messageCount: fc.nat({ max: 5000 }),
  pending: fc.option(fc.boolean(), { nil: undefined }),
});

/** A full conversation row with an arbitrary id. */
const listItemArb: fc.Arbitrary<ConversationListItem> = fc.record({
  conversationId: fc.string({ minLength: 1, maxLength: 20 }),
  title: fc.string(),
  titleSource: titleSourceArb,
  accountId: fc.string(),
  createdAt: isoArb,
  updatedAt: isoArb,
  messageCount: fc.nat({ max: 5000 }),
  pending: fc.option(fc.boolean(), { nil: undefined }),
});

/**
 * A list of conversation rows with DISTINCT `conversationId`s so reconcile /
 * rollback reasoning is unambiguous (no accidental id collisions between rows).
 */
const distinctListArb: fc.Arbitrary<ConversationListItem[]> = fc.uniqueArray(
  listItemArb,
  { selector: (row) => row.conversationId, maxLength: 12 },
);

describe("Property 17: optimistic create reconciles to exactly one row", () => {
  it("insertPlaceholder + reconcileCreated leaves exactly one persisted row, no placeholder, and is idempotent", () => {
    // Feature: cloud-bill-analyst-web-iteration-2, Property 17: Optimistic create reconciles to exactly one row
    // Validates: Requirements 1.5
    const scenarioArb = distinctListArb.chain((list) => {
      const ids = list.map((row) => row.conversationId);
      const idSet = new Set(ids);
      return fc
        .record({
          placeholderId: fc
            .string({ minLength: 1, maxLength: 24 })
            .filter((id) => !idSet.has(id)),
          placeholderBody: bodyArb,
          persistedBody: bodyArb,
          freshPersistedId: fc.string({ minLength: 1, maxLength: 24 }),
          // Force the "a duplicate persisted row already exists" case sometimes,
          // exercising reconcile's existing-duplicate drop path.
          reuseExisting: fc.boolean(),
          reuseIndex: fc.nat(),
        })
        .map((r) => {
          const reuse = r.reuseExisting && ids.length > 0;
          let persistedId = reuse
            ? ids[r.reuseIndex % ids.length]
            : r.freshPersistedId;
          // The one hard invariant the property needs: the persisted id must
          // differ from the placeholder id (otherwise "no placeholder row"
          // becomes ambiguous). A fresh id colliding with an existing list id
          // is fine — it simply becomes another duplicate-drop case.
          if (persistedId === r.placeholderId) {
            persistedId = `${persistedId}-x`;
          }
          return { list, r, persistedId };
        });
    });

    fc.assert(
      fc.property(scenarioArb, ({ list, r, persistedId }) => {
        const placeholder: ConversationListItem = {
          ...r.placeholderBody,
          conversationId: r.placeholderId,
          titleSource: "pending",
          pending: true,
        };
        const persisted: ConversationListItem = {
          ...r.persistedBody,
          conversationId: persistedId,
        };

        const listSnapshot = structuredClone(list);

        const inserted = insertPlaceholder(list, placeholder);
        const reconciled = reconcileCreated(
          inserted,
          placeholder.conversationId,
          persisted,
        );

        // EXACTLY ONE row bears the persisted conversation id.
        const persistedMatches = reconciled.filter(
          (row) => row.conversationId === persisted.conversationId,
        );
        expect(persistedMatches).toHaveLength(1);
        expect(persistedMatches[0]).toEqual(persisted);

        // The placeholder id is gone entirely.
        expect(
          reconciled.some(
            (row) => row.conversationId === placeholder.conversationId,
          ),
        ).toBe(false);

        // Idempotence: reconciling again creates no duplicate and is stable.
        const reconciledAgain = reconcileCreated(
          reconciled,
          placeholder.conversationId,
          persisted,
        );
        expect(
          reconciledAgain.filter(
            (row) => row.conversationId === persisted.conversationId,
          ),
        ).toHaveLength(1);
        expect(reconciledAgain).toEqual(reconciled);

        // Purity: helpers return new arrays and never mutate the input list.
        expect(inserted).not.toBe(list);
        expect(reconciled).not.toBe(inserted);
        expect(list).toEqual(listSnapshot);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("Property 18: optimistic rollback restores the prior list", () => {
  it("rollbackPlaceholder undoes insertPlaceholder for a unique placeholder id", () => {
    // Feature: cloud-bill-analyst-web-iteration-2, Property 18: Optimistic rollback restores the prior list
    // Validates: Requirements 1.6
    const scenarioArb = distinctListArb.chain((list) => {
      const idSet = new Set(list.map((row) => row.conversationId));
      return fc
        .record({
          placeholderId: fc
            .string({ minLength: 1, maxLength: 24 })
            .filter((id) => !idSet.has(id)),
          placeholderBody: bodyArb,
        })
        .map((r) => ({ list, r }));
    });

    fc.assert(
      fc.property(scenarioArb, ({ list, r }) => {
        const placeholder: ConversationListItem = {
          ...r.placeholderBody,
          conversationId: r.placeholderId,
          titleSource: "pending",
          pending: true,
        };
        const listSnapshot = structuredClone(list);

        const inserted = insertPlaceholder(list, placeholder);
        const rolledBack = rollbackPlaceholder(
          inserted,
          placeholder.conversationId,
        );

        // Rolling back a freshly inserted, unique placeholder restores the list.
        expect(rolledBack).toEqual(list);

        // Purity: new arrays, input untouched.
        expect(rolledBack).not.toBe(list);
        expect(list).toEqual(listSnapshot);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("rollbackRename restores the original title after applyRename", () => {
    // Feature: cloud-bill-analyst-web-iteration-2, Property 18: Optimistic rollback restores the prior list
    // Validates: Requirements 1.6
    const scenarioArb = distinctListArb.chain((list) => {
      // Pick a target id from the list when non-empty; otherwise use an id that
      // is guaranteed absent so applyRename/rollbackRename are both no-ops.
      const idSet = new Set(list.map((row) => row.conversationId));
      const absentIdArb = fc
        .string({ minLength: 1, maxLength: 24 })
        .filter((id) => !idSet.has(id));
      const targetIdArb =
        list.length > 0
          ? fc.constantFrom(...list.map((row) => row.conversationId))
          : absentIdArb;
      return fc
        .record({
          targetId: targetIdArb,
          newTitle: fc.string(),
        })
        .map((r) => ({ list, r }));
    });

    fc.assert(
      fc.property(scenarioArb, ({ list, r }) => {
        const target = list.find(
          (row) => row.conversationId === r.targetId,
        );
        // prevTitle is the row's ORIGINAL title (or irrelevant when absent).
        const prevTitle = target?.title ?? "";
        const listSnapshot = structuredClone(list);

        const applied = applyRename(list, r.targetId, r.newTitle);
        const restored = rollbackRename(applied, r.targetId, prevTitle);

        // Restoring the original title fully reverts the optimistic edit.
        expect(restored).toEqual(list);

        // Purity: applyRename returns a new array and never mutates the input.
        expect(applied).not.toBe(list);
        expect(list).toEqual(listSnapshot);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
