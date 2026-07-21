import type { AnomalyKind } from "@/lib/anomaly";

/**
 * Browser-safe presentation metadata for cost anomalies (Req 13.2, 13.3).
 *
 * This is the single source of truth for how each {@link AnomalyKind} is
 * labelled and accented, shared by the dashboard badges and the inline chat
 * callouts so the two stay in lockstep. It is a PURE, dependency-free map (it
 * imports only the `AnomalyKind` type from the pure classifier), so both server
 * and client components may use it.
 *
 * Accent mapping (Req 13.3): a spike uses the ROSE accent; a new service or a
 * large month-over-month delta uses the AMBER accent.
 */

/** Accent color family used for an anomaly. */
export type AnomalyAccent = "rose" | "amber";

/** Display metadata for one anomaly classification. */
export interface AnomalyDisplay {
  /** Human-readable classification label shown in badges/callouts. */
  label: string;
  /** Accent family: rose for spikes, amber otherwise (Req 13.3). */
  accent: AnomalyAccent;
}

/** Map each classification to its label + accent. */
const ANOMALY_DISPLAY: Record<AnomalyKind, AnomalyDisplay> = {
  spike: { label: "Spike", accent: "rose" },
  new_service: { label: "New service", accent: "amber" },
  large_mom_delta: { label: "Large MoM delta", accent: "amber" },
};

/** Return the label + accent for an anomaly classification. */
export function anomalyDisplay(kind: AnomalyKind): AnomalyDisplay {
  return ANOMALY_DISPLAY[kind];
}
