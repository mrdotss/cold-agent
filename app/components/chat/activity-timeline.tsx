"use client";

import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  CheckmarkCircle02Icon,
  StopIcon,
} from "@hugeicons/core-free-icons";

import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type { ActivityStep } from "@/hooks/useAgentStream";

/**
 * The live "what the agent is doing" timeline — the signature agentic element
 * (Req 9). It renders `StreamState.steps` in received order; each step shows a
 * status indicator, the event's friendly `status` text, and a `label` badge:
 *
 *  - a spinner while `state === "running"` (Req 9.5)
 *  - a check-mark once `state === "done"` (Req 9.3)
 *  - a stopped indicator when `state === "stopped"` after an error (Req 9.7)
 *
 * On `done` the hook sets `collapsed`, so the timeline folds into a one-line
 * summary with a control to re-expand the full list (Req 9.6). An
 * `aria-live="polite"` region mirrors the latest step status for screen readers
 * (Req 9.8). The reducer owns all state transitions; this component is a pure
 * projection of them.
 */

const SUMMARY_SEPARATOR = " · ";

/** Text shown for a step: its status, falling back to its label. */
function stepText(step: ActivityStep): string {
  return step.status.length > 0 ? step.status : step.label;
}

function StepIndicator({ state }: { state: ActivityStep["state"] }) {
  if (state === "done") {
    return (
      <HugeiconsIcon
        icon={CheckmarkCircle02Icon}
        className="size-4 text-primary"
        aria-hidden
      />
    );
  }
  if (state === "stopped") {
    return (
      <HugeiconsIcon
        icon={StopIcon}
        className="size-4 text-muted-foreground"
        aria-hidden
      />
    );
  }
  // running — respect prefers-reduced-motion: the icon stays, the spin stops.
  return <Spinner className="size-4 text-muted-foreground motion-reduce:animate-none" />;
}

export interface ActivityTimelineProps {
  /** Timeline steps in received order (from `StreamState.steps`). */
  steps: ActivityStep[];
  /** True once a `done` event collapsed the timeline (from `StreamState`). */
  collapsed: boolean;
  /** Latest status text for the `aria-live` region (from `StreamState.liveRegion`). */
  liveRegion: string;
  className?: string;
}

export function ActivityTimeline({
  steps,
  collapsed,
  liveRegion,
  className,
}: ActivityTimelineProps) {
  // Local-only view preference: lets the user re-expand a collapsed summary
  // (Req 9.6) without touching the reducer's canonical `collapsed` flag.
  const [expanded, setExpanded] = useState(false);

  if (steps.length === 0) {
    return null;
  }

  const showList = !collapsed || expanded;
  const summary = steps.map(stepText).join(SUMMARY_SEPARATOR);

  return (
    <section
      aria-label="Agent activity"
      className={cn("border border-border bg-card/40", className)}
    >
      {/* Screen-reader announcement of the latest step status (Req 9.8). */}
      <div aria-live="polite" className="sr-only">
        {liveRegion}
      </div>

      {collapsed ? (
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={showList}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs tracking-wide text-muted-foreground uppercase transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30"
        >
          <HugeiconsIcon
            icon={showList ? ArrowUp01Icon : ArrowDown01Icon}
            className="size-3.5 shrink-0"
            aria-hidden
          />
          <span className="min-w-0 flex-1 truncate normal-case">
            {showList ? "Activity" : summary}
          </span>
        </button>
      ) : (
        <div className="flex items-center gap-2 px-3 py-2 text-xs font-semibold tracking-widest text-muted-foreground uppercase">
          Working
        </div>
      )}

      {showList ? (
        <ol className="flex flex-col border-t border-border">
          {steps.map((step) => (
            <li
              key={step.id}
              className="flex items-center gap-3 px-3 py-2.5 not-last:border-b not-last:border-border/60"
            >
              <span className="flex size-4 shrink-0 items-center justify-center">
                <StepIndicator state={step.state} />
              </span>
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-sm",
                  step.state === "stopped"
                    ? "text-muted-foreground line-through"
                    : "text-foreground",
                )}
              >
                {stepText(step)}
              </span>
              {step.label.length > 0 ? (
                <Badge variant="secondary" className="shrink-0">
                  {step.label}
                </Badge>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
