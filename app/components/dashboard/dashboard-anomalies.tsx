import { AnomalyBadges } from "@/components/dashboard/anomaly-badges";
import { getAccountAnomalies } from "@/lib/anomaly-detector";

/**
 * Server-side anomaly fetch wrapper for the dashboard (Req 13.1, 13.2, 13.7).
 *
 * An async server component that runs the {@link getAccountAnomalies}
 * Anomaly_Detector server-side (secrets never reach the browser) for the active
 * account and hands the classified result to the presentational
 * {@link AnomalyBadges}. Rendered inside a `<Suspense>` boundary on the page so
 * the up-to-10s detection streams in without blocking the rest of the dashboard.
 *
 * The detector already bounds itself to 10 seconds and degrades to zero
 * anomalies on any Cost Explorer failure/timeout (Req 13.1, 13.7); when it
 * returns `[]`, `AnomalyBadges` renders nothing, so a failure shows no badges.
 */
export interface DashboardAnomaliesProps {
  /** The resolved active account id (most recent selection, default first). */
  activeAccountId: string;
  /** The signed-in user's id (ownership scope for the account read). */
  userId: string;
}

export async function DashboardAnomalies({
  activeAccountId,
  userId,
}: DashboardAnomaliesProps) {
  const anomalies = await getAccountAnomalies(activeAccountId, userId);
  return <AnomalyBadges anomalies={anomalies} />;
}
