import { Suspense } from "react";
import { redirect } from "next/navigation";

import { ConnectAccountCta } from "@/components/dashboard/connect-account-cta";
import { DashboardAccounts } from "@/components/dashboard/dashboard-accounts";
import { DashboardAnomalies } from "@/components/dashboard/dashboard-anomalies";
import { SpendOverview } from "@/components/dashboard/spend-overview";
import { listConnectedAccounts } from "@/lib/actions/accounts";
import { auth } from "@/lib/auth";
import { resolveActiveAccountId } from "@/lib/dashboard";

/**
 * `/dashboard` — spend overview + connected accounts (task 16.1; Req 12.1–12.6).
 *
 * A server component that authenticates the request (redirecting to `/login`
 * when unauthenticated) and loads the user's connected accounts. It then renders
 * one of two shapes:
 *
 *   - **Zero accounts** → a connect-account call-to-action in place of the spend
 *     overview, and NO Cost Explorer query is issued (Req 12.5).
 *   - **≥1 account** → the {@link SpendOverview} (which fetches the current
 *     month-to-date total server-side, with its own loading/error/retry states —
 *     Req 12.2, 12.3, 12.6) plus the read-only {@link DashboardAccounts} list
 *     (Req 12.4).
 *
 * The active account (most recently selected, defaulting to the first) is
 * resolved server-side via {@link resolveActiveAccountId}; the spend route
 * resolves it the same way, so the account marked "Active" here is the one whose
 * spend is shown. All secret handling stays server-side — only browser-safe
 * account views ever reach the client.
 */
export default async function DashboardPage() {
  const session = await auth();
  const userId = session?.user?.id;
  if (typeof userId !== "string" || userId.length === 0) {
    redirect("/login");
  }

  const accounts = await listConnectedAccounts();
  const hasAccounts = accounts.length > 0;

  // Resolve the active account only when the user has at least one; this matches
  // the spend route's resolution so the "Active" badge and the queried account
  // agree.
  const activeId = hasAccounts ? await resolveActiveAccountId(userId) : null;
  const activeCurrency =
    accounts.find((account) => account.id === activeId)?.displayCurrency ??
    accounts[0]?.displayCurrency ??
    "USD";

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-10 sm:px-6">
      <header className="flex flex-col gap-2">
        <p className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
          Dashboard
        </p>
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-3xl">Overview</h1>
          <p className="text-sm text-muted-foreground">
            Your current-month spend and connected AWS accounts at a glance.
          </p>
        </div>
      </header>

      {hasAccounts ? (
        <>
          <SpendOverview currency={activeCurrency} />
          {activeId !== null ? (
            // Anomaly detection runs server-side with its own 10s budget and
            // degrades to zero on any CE failure (Req 13.1, 13.7). Stream it in
            // behind Suspense so it never blocks the spend overview or account
            // list; nothing renders until (and unless) anomalies are found.
            <Suspense fallback={null}>
              <DashboardAnomalies activeAccountId={activeId} userId={userId} />
            </Suspense>
          ) : null}
          <DashboardAccounts accounts={accounts} activeId={activeId} />
        </>
      ) : (
        <ConnectAccountCta />
      )}
    </div>
  );
}
