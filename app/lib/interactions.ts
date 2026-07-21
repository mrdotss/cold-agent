// Cloud Bill Analyst (Web) — pure interaction state machines.
//
// This module is intentionally PURE and dependency-free (no React, no `server-only`,
// no AWS SDK, no I/O). It encodes the logic that the UI and the chat relay later
// drive so the same reducers can be exercised directly by property tests
// (Property 26 — message feedback, Property 27 — confirmation gate).
//
// Every function here is a total, non-mutating pure function: it returns a fresh
// value and is defined for all inputs.

// ---------------------------------------------------------------------------
// A. Message feedback state machine (Req 14.5, 14.6, 14.8)
// ---------------------------------------------------------------------------

/** The two feedback values that can be persisted for a message. */
export type FeedbackValue = "up" | "down";

/**
 * The per-message feedback that is persisted. `null` means no feedback has been
 * recorded — the default, unselected state (Req 14.8).
 */
export type FeedbackState = FeedbackValue | null;

/** Activate a feedback control (thumbs-up or thumbs-down) on a message. */
export type FeedbackAction = { kind: "activate"; value: FeedbackValue };

/**
 * Reduce a feedback action against the current feedback state.
 *
 * Rules:
 *  - At most ONE value is stored at any time — the state is a single value or null
 *    (Req 14.5).
 *  - Activating a value DIFFERENT from the current one replaces it: submitting a
 *    feedback value replaces any previously stored value (Req 14.5).
 *  - Activating the value EQUAL to the current one clears it back to `null`:
 *    toggling the currently stored value returns the message to the no-feedback
 *    state (Req 14.6).
 *  - From `null`, activating `v` stores `v`.
 *
 * Pure and total: never mutates its inputs and is defined for every state/action.
 */
export function feedbackReducer(
  state: FeedbackState,
  action: FeedbackAction,
): FeedbackState {
  switch (action.kind) {
    case "activate":
      // Toggling the currently stored value removes it (Req 14.6); otherwise the
      // submitted value replaces whatever was there before (Req 14.5).
      return state === action.value ? null : action.value;
    default:
      return state;
  }
}

/**
 * The displayed state equals the stored state (Req 14.8): the stored value is shown
 * as selected, and when nothing is stored both controls are unselected. This helper
 * answers "is `value` the selected control?" for a given state.
 */
export function isSelected(state: FeedbackState, value: FeedbackValue): boolean {
  return state === value;
}

// ---------------------------------------------------------------------------
// B. Confirmation-gate state machine (Req 15.1–15.5)
// ---------------------------------------------------------------------------

/**
 * Lifecycle of an inline approve/reject gate:
 *  - `pending`  — awaiting the user's answer; the pending action is blocked.
 *  - `approved` — the user approved; the pending action was invoked exactly once.
 *  - `rejected` — the user rejected; the pending action was cancelled, never invoked.
 */
export type GateStatus = "pending" | "approved" | "rejected";

export interface GateState {
  status: GateStatus;
  /**
   * Count of times the pending action has been invoked. The gate itself models the
   * (side-effecting) invocation by counting: `approve` from `pending` increments it
   * to exactly 1; every other transition leaves it unchanged. The invariant is that
   * `invocations` is 1 iff exactly one approve was honored (the first answer), and 0
   * otherwise (Req 15.3, 15.4, 15.5).
   */
  invocations: number;
}

/** Answer a confirmation-gate prompt. */
export type GateAction = { kind: "approve" } | { kind: "reject" };

/** A fresh gate: pending, nothing invoked yet (Req 15.1, 15.2, 15.5). */
export function createGate(): GateState {
  return { status: "pending", invocations: 0 };
}

/**
 * Reduce a gate action against the current gate state.
 *
 * Rules (Property 27):
 *  - Only the FIRST answer is honored, and only from `pending`. This guarantees the
 *    pending action is invoked exactly once iff exactly one approve reaches the gate
 *    while it is still pending.
 *  - `approve` from `pending`  -> `approved`, invocations incremented to 1: the
 *    pending action is invoked EXACTLY ONCE and the prompt is dismissed (Req 15.3).
 *  - `reject`  from `pending`  -> `rejected`, invocations stays 0: the action is
 *    cancelled and never invoked (Req 15.4).
 *  - Any action once already answered (approved or rejected) is a NO-OP: invocations
 *    can never exceed 1, and a rejected gate can never be invoked (Req 15.3–15.5).
 *
 * Pure and total: never mutates its inputs and is defined for every state/action.
 */
export function gateReducer(state: GateState, action: GateAction): GateState {
  // Once answered, the gate is locked: further approve/reject actions are no-ops.
  if (state.status !== "pending") {
    return state;
  }

  switch (action.kind) {
    case "approve":
      // First approve from pending: invoke exactly once (Req 15.3).
      return { status: "approved", invocations: state.invocations + 1 };
    case "reject":
      // Reject cancels the action; it is never invoked (Req 15.4).
      return { status: "rejected", invocations: state.invocations };
    default:
      return state;
  }
}

/**
 * True WHILE the prompt is unanswered. The pending action stays blocked and is never
 * invoked until the user answers (Req 15.1, 15.2, 15.5).
 */
export function isBlocked(state: GateState): boolean {
  return state.status === "pending";
}

/**
 * Whether the (modeled) invocation has occurred for this gate: true iff the gate was
 * approved and the pending action was invoked exactly once (Req 15.3). Reject and the
 * still-pending state both yield false.
 */
export function canInvoke(state: GateState): boolean {
  return state.status === "approved" && state.invocations === 1;
}
