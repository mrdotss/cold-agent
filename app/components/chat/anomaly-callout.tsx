import { HugeiconsIcon } from "@hugeicons/react";
import { AnalyticsUpIcon, SparklesIcon, TradeUpIcon } from "@hugeicons/core-free-icons";

import { anomalyDisplay } from "@/lib/anomaly-display";
import type { AnomalyAccent } from "@/lib/anomaly-display";
import type { Anomaly, AnomalyKind } from "@/lib/anomaly";
import { cn } from "@/lib/utils";

/**
 * Inline cost-anomaly callout for the chat (Req 13.3, 13.7).
 *
 * Purely presentational: given the anomalies relevant to the current
 * conversation, it renders exactly ONE callout per anomaly. Accents follow the
 * shared mapping (Req 13.3): a spike uses the ROSE accent; a new service or a
 * large month-over-month delta uses the AMBER accent. Callouts are flat, sharp
 * cornered surfaces with a hairline border and a left accent rail, matching the
 * Sera system (HugeIcons line icons, no rounded pills, no gradients).
 *
 * With zero anomalies it renders NOTHING — so when the detector returns `[]` on
 * a Cost Explorer failure, no inline callout appears (Req 13.7).
 *
 * Wiring these into the live chat stream is the chat page's job (a later task);
 * this component provides the presentation + accent mapping the page renders.
 */

/** HugeIcons line icon per classification. */
const ANOMALY_ICON: Record<AnomalyKind, typeof TradeUpIcon> = {
  spike: TradeUpIcon,
  new_service: SparklesIcon,
  large_mom_delta: AnalyticsUpIcon,
};

/** Sera-flavored accent classes with a left rail (`border-l-2`). */
const ACCENT_CLASSES: Record<AnomalyAccent, string> = {
  rose: "border-border border-l-2 border-l-rose-500 bg-rose-50/60 dark:bg-rose-950/30",
  amber: "border-border border-l-2 border-l-amber-500 bg-amber-50/60 dark:bg-amber-950/30",
};

/** Accent-colored icon/label text per family. */
const ACCENT_TEXT: Record<AnomalyAccent, string> = {
  rose: "text-rose-700 dark:text-rose-300",
  amber: "text-amber-800 dark:text-amber-300",
};

/** A short, human-readable summary line for each anomaly kind. */
function anomalyDetailText(anomaly: Anomaly): string {
  const { detail } = anomaly;
  switch (anomaly.kind) {
    case "spike": {
      const ratio = detail.ratio;
      return Number.isFinite(ratio)
        ? `Latest daily cost is ${ratio.toFixed(1)}× its trailing 7-day average.`
        : "Latest daily cost is well above its trailing 7-day average.";
    }
    case "new_service":
      return "Started incurring cost this month with none in the previous full month.";
    case "large_mom_delta": {
      const pct = detail.momRatio;
      return Number.isFinite(pct)
        ? `Up ${Math.round(pct * 100)}% versus the previous full month.`
        : "Up sharply versus the previous full month.";
    }
    default:
      return "";
  }
}

export interface AnomalyCalloutProps {
  /** Anomalies relevant to the conversation (empty renders nothing). */
  anomalies: Anomaly[];
  className?: string;
}

export function AnomalyCallout({ anomalies, className }: AnomalyCalloutProps) {
  // Req 13.3/13.7: only render when at least one anomaly exists.
  if (anomalies.length === 0) {
    return null;
  }

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {anomalies.map((anomaly, index) => {
        const display = anomalyDisplay(anomaly.kind);
        const Icon = ANOMALY_ICON[anomaly.kind];
        return (
          <div
            key={`${anomaly.service}:${anomaly.kind}:${index}`}
            role="note"
            className={cn(
              "flex items-start gap-3 border px-3 py-2.5",
              ACCENT_CLASSES[display.accent],
            )}
          >
            <HugeiconsIcon
              icon={Icon}
              className={cn("mt-0.5 size-4 shrink-0", ACCENT_TEXT[display.accent])}
              aria-hidden
            />
            <div className="flex min-w-0 flex-col gap-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate text-sm font-medium text-foreground">
                  {anomaly.service}
                </span>
                <span
                  className={cn(
                    "text-[0.625rem] font-semibold tracking-widest uppercase",
                    ACCENT_TEXT[display.accent],
                  )}
                >
                  {display.label}
                </span>
              </div>
              <p className="text-sm text-muted-foreground">
                {anomalyDetailText(anomaly)}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
