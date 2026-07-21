import { HugeiconsIcon } from "@hugeicons/react";
import { AnalyticsUpIcon, SparklesIcon, TradeUpIcon } from "@hugeicons/core-free-icons";

import { anomalyDisplay } from "@/lib/anomaly-display";
import type { AnomalyAccent } from "@/lib/anomaly-display";
import type { Anomaly, AnomalyKind } from "@/lib/anomaly";
import { cn } from "@/lib/utils";

/**
 * Dashboard anomaly badges (Req 13.2, 13.7).
 *
 * Purely presentational: given the anomalies detected for the active account, it
 * renders exactly ONE badge per anomaly, each labelling its classification
 * (spike / new service / large MoM delta). Accents follow the shared mapping
 * (Req 13.3): rose for a spike, amber for a new service or large MoM delta —
 * flat, sharp-cornered chips with a hairline border, in keeping with the Sera
 * system (no rounded pills, HugeIcons line icons only).
 *
 * When there are zero anomalies (including the CE-failure case, where the
 * detector returns `[]` — Req 13.7) this renders NOTHING, so the dashboard shows
 * no anomaly section at all.
 */

/** HugeIcons line icon per classification. */
const ANOMALY_ICON: Record<AnomalyKind, typeof TradeUpIcon> = {
  spike: TradeUpIcon,
  new_service: SparklesIcon,
  large_mom_delta: AnalyticsUpIcon,
};

/** Sera-flavored accent classes (sharp corners, hairline border, flat fill). */
const ACCENT_CLASSES: Record<AnomalyAccent, string> = {
  rose: "border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300",
  amber:
    "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300",
};

export interface AnomalyBadgesProps {
  /** Anomalies detected for the active account (empty renders nothing). */
  anomalies: Anomaly[];
  className?: string;
}

export function AnomalyBadges({ anomalies, className }: AnomalyBadgesProps) {
  // Req 13.2/13.7: only render when at least one anomaly exists.
  if (anomalies.length === 0) {
    return null;
  }

  return (
    <section className={cn("flex flex-col gap-4", className)} aria-label="Cost anomalies">
      <span className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
        Cost anomalies
      </span>
      <ul className="flex flex-wrap gap-2">
        {anomalies.map((anomaly, index) => {
          const display = anomalyDisplay(anomaly.kind);
          const Icon = ANOMALY_ICON[anomaly.kind];
          return (
            <li
              // Multiple anomalies can share a service across kinds, so key on
              // both service and kind (plus index as a final tiebreaker).
              key={`${anomaly.service}:${anomaly.kind}:${index}`}
              className={cn(
                "inline-flex items-center gap-2 border px-2.5 py-1 text-xs",
                ACCENT_CLASSES[display.accent],
              )}
            >
              <HugeiconsIcon icon={Icon} className="size-3.5 shrink-0" aria-hidden />
              <span className="font-medium">{anomaly.service}</span>
              <span className="text-[0.625rem] font-semibold tracking-widest uppercase opacity-80">
                {display.label}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
