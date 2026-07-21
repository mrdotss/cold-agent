"use client";

import { useReducer } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ShieldKeyIcon,
  CheckmarkCircle02Icon,
  Cancel01Icon,
} from "@hugeicons/core-free-icons";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  createGate,
  gateReducer,
  isBlocked,
  type GateState,
} from "@/lib/interactions";

/**
 * Inline human-in-the-loop approve/reject gate (design-system §8, ref-7, Req 15).
 *
 * The app injects this before a sensitive action (the first scan of a newly
 * connected account, or a costly export). It BLOCKS the guarded action until the
 * user answers (Req 15.1, 15.2, 15.5). The pure gate state machine from
 * `lib/interactions.ts` models the invariant: a fresh gate is `pending` with
 * zero invocations; the FIRST answer is the only one honored; `approve` invokes
 * the pending action EXACTLY ONCE; `reject` (or no answer) invokes it ZERO times
 * (Req 15.3, 15.4, 15.5).
 *
 * `onApprove` fires exactly once — only on the transition out of `pending` via
 * approve — because the handlers early-return once answered and the controls are
 * disabled after answering. Once answered the prompt is dismissed in place,
 * replaced by a compact resolved status line (Req 15.3, 15.4).
 *
 * Presentational + local state only: it never invokes the runtime itself. The
 * page passes `onApprove` (which runs the guarded invocation) and an optional
 * `onReject` (which cancels the pending action).
 */

export interface ConfirmationGateProps {
  /**
   * Runs the guarded action. Called EXACTLY ONCE, and only when the user
   * approves a still-pending prompt (Req 15.3).
   */
  onApprove: () => void;
  /** Called when the user rejects; the guarded action is cancelled (Req 15.4). */
  onReject?: () => void;
  /** Short title describing what needs confirmation. */
  title?: string;
  /** Longer description of the sensitive action being confirmed. */
  description?: string;
  /** Label for the approve control. */
  approveLabel?: string;
  /** Label for the reject control. */
  rejectLabel?: string;
  className?: string;
}

export function ConfirmationGate({
  onApprove,
  onReject,
  title = "Confirm this action",
  description = "This will run a scan against your connected AWS account.",
  approveLabel = "Approve",
  rejectLabel = "Reject",
  className,
}: ConfirmationGateProps) {
  const [state, dispatch] = useReducer(
    gateReducer,
    undefined as unknown as GateState,
    createGate,
  );

  // Blocked === unanswered. Once answered, both controls lock so the guarded
  // action can be invoked at most once (Req 15.5).
  const pending = isBlocked(state);

  const handleApprove = () => {
    // Guard re-entry: only the first answer from `pending` is honored, so
    // `onApprove` runs exactly once (Req 15.3, 15.5).
    if (!pending) return;
    dispatch({ kind: "approve" });
    onApprove();
  };

  const handleReject = () => {
    if (!pending) return;
    dispatch({ kind: "reject" });
    onReject?.();
  };

  // ---- Resolved (answered) state: prompt dismissed, status shown ----------
  if (!pending) {
    const approved = state.status === "approved";
    return (
      <div
        className={cn(
          "flex items-center gap-2 border border-border bg-card/40 px-3 py-2 text-xs tracking-wide text-muted-foreground",
          className,
        )}
      >
        <HugeiconsIcon
          icon={approved ? CheckmarkCircle02Icon : Cancel01Icon}
          className={cn("size-3.5 shrink-0", approved ? "text-primary" : "text-muted-foreground")}
          aria-hidden
        />
        <span>{approved ? "Approved — running now." : "Cancelled."}</span>
      </div>
    );
  }

  // ---- Pending state: inline approve/reject prompt ------------------------
  return (
    <section
      aria-label="Confirmation required"
      className={cn(
        "flex flex-col gap-3 border border-primary/30 bg-primary/5 p-4",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className="flex size-8 shrink-0 items-center justify-center border border-border bg-card text-primary"
          aria-hidden
        >
          <HugeiconsIcon icon={ShieldKeyIcon} className="size-4" />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-xs font-semibold tracking-widest text-foreground uppercase">
            {title}
          </p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleReject}
          disabled={!pending}
        >
          <HugeiconsIcon icon={Cancel01Icon} data-icon="inline-start" />
          {rejectLabel}
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={handleApprove}
          disabled={!pending}
        >
          <HugeiconsIcon icon={CheckmarkCircle02Icon} data-icon="inline-start" />
          {approveLabel}
        </Button>
      </div>
    </section>
  );
}
