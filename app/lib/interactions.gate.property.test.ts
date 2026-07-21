import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  gateReducer,
  createGate,
  isBlocked,
  canInvoke,
  type GateAction,
  type GateState,
} from "./interactions";

// Feature: cloud-bill-analyst-web, Property 27: For any sequence of approve/reject actions from a fresh gate, the action is invoked exactly once iff the first answer is approve (else zero), invocations never exceed 1, and the gate is blocked only while pending.
describe("gateReducer — confirmation-gate state machine (Property 27)", () => {
  const action: fc.Arbitrary<GateAction> = fc.oneof(
    fc.constant<GateAction>({ kind: "approve" }),
    fc.constant<GateAction>({ kind: "reject" }),
  );

  it("invokes exactly once iff the first answer is approve; blocked only while pending; invocations never exceed 1", () => {
    // Validates: Requirements 15.1, 15.2, 15.3, 15.4, 15.5
    fc.assert(
      fc.property(fc.array(action, { maxLength: 10 }), (actions) => {
        // Fresh gate starts pending with nothing invoked (Req 15.1, 15.2, 15.5).
        const initial = createGate();
        expect(initial.status).toBe("pending");
        expect(initial.invocations).toBe(0);

        // Fold step by step so we can assert step-wise invariants.
        let state: GateState = initial;
        for (const a of actions) {
          const prev = state;
          const next = gateReducer(prev, a);

          // isBlocked at every step === (status === "pending").
          expect(isBlocked(prev)).toBe(prev.status === "pending");

          // Once answered, subsequent steps are no-ops (Req 15.3, 15.4, 15.5).
          if (prev.status !== "pending") {
            expect(next.status).toBe(prev.status);
            expect(next.invocations).toBe(prev.invocations);
          }

          // invocations is non-decreasing and never exceeds 1 at every step.
          expect(next.invocations).toBeGreaterThanOrEqual(prev.invocations);
          expect(next.invocations).toBeLessThanOrEqual(1);

          state = next;
        }

        const final = state;

        // Expected invocation count is driven entirely by the FIRST answer.
        const firstAnswer = actions[0];
        const expectedInvocations =
          firstAnswer && firstAnswer.kind === "approve" ? 1 : 0;

        expect(final.invocations).toBe(expectedInvocations);
        expect(final.invocations).toBeLessThanOrEqual(1);
        expect(isBlocked(final)).toBe(final.status === "pending");

        if (!firstAnswer) {
          // No actions: still pending, blocked, not invokable (Req 15.1, 15.2, 15.5).
          expect(final.status).toBe("pending");
          expect(isBlocked(final)).toBe(true);
          expect(canInvoke(final)).toBe(false);
          expect(final.invocations).toBe(0);
        } else if (firstAnswer.kind === "approve") {
          // First answer approve: approved, invoked once, unblocked (Req 15.3).
          expect(final.status).toBe("approved");
          expect(canInvoke(final)).toBe(true);
          expect(isBlocked(final)).toBe(false);
          expect(final.invocations).toBe(1);
        } else {
          // First answer reject: rejected, never invoked, unblocked (Req 15.4, 15.5).
          expect(final.status).toBe("rejected");
          expect(canInvoke(final)).toBe(false);
          expect(isBlocked(final)).toBe(false);
          expect(final.invocations).toBe(0);
        }
      }),
    );
  });
});
