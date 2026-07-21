"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import {
  AnalyticsUpIcon,
  Alert02Icon,
  CloudIcon,
  FileExportIcon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * The empty-state agent introduction shown before a thread has any messages
 * (design-system §1). Editorial, flat, sharp-cornered: the agent name in the
 * serif display face, a small model badge, a short capability list, and a
 * connected-account chip so the user knows which account the chat is pinned to.
 *
 * Presentational only — the model label and account alias are passed in.
 */

interface Capability {
  icon: typeof AnalyticsUpIcon;
  label: string;
}

const CAPABILITIES: Capability[] = [
  { icon: AnalyticsUpIcon, label: "Analyze spend" },
  { icon: Alert02Icon, label: "Detect anomalies" },
  { icon: FileExportIcon, label: "Export PDF/Excel" },
];

export interface AgentIntroProps {
  /** Model label rendered in the small badge (e.g. "Claude Sonnet"). */
  modelName?: string;
  /**
   * Alias of the connected account this thread is pinned to. When omitted, the
   * account chip is hidden (e.g. before any account is connected).
   */
  accountAlias?: string | null;
  className?: string;
}

export function AgentIntro({
  modelName = "Bedrock AgentCore",
  accountAlias,
  className,
}: AgentIntroProps) {
  return (
    <div
      className={cn(
        "mx-auto flex max-w-xl flex-col items-center gap-6 px-6 py-16 text-center",
        className,
      )}
    >
      <span
        className="flex size-14 items-center justify-center border border-border bg-muted text-foreground"
        aria-hidden
      >
        <HugeiconsIcon icon={SparklesIcon} className="size-6" />
      </span>

      <div className="flex flex-col items-center gap-3">
        <h1 className="font-heading text-3xl font-semibold tracking-wide">
          Cloud Bill Analyst
        </h1>
        <Badge variant="outline" className="border border-border px-2 py-0.5">
          {modelName}
        </Badge>
      </div>

      <p className="text-sm leading-relaxed text-balance text-muted-foreground">
        Ask about your AWS spend in plain language. I query Cost Explorer, flag
        unusual costs, and export polished reports.
      </p>

      <ul className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
        {CAPABILITIES.map((capability) => (
          <li
            key={capability.label}
            className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase"
          >
            <HugeiconsIcon icon={capability.icon} className="size-3.5" aria-hidden />
            {capability.label}
          </li>
        ))}
      </ul>

      {accountAlias ? (
        <div className="flex items-center gap-2 border border-border bg-card/50 px-3 py-1.5 text-xs text-muted-foreground">
          <HugeiconsIcon icon={CloudIcon} className="size-3.5" aria-hidden />
          <span className="font-medium text-foreground">{accountAlias}</span>
        </div>
      ) : null}
    </div>
  );
}
