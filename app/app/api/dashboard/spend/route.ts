import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import {
  getCurrentMonthSpend,
  resolveActiveAccountId,
} from "@/lib/dashboard";

/**
 * Dashboard spend route (Dashboard, Req 12.1, 12.2, 12.6).
 *
 * `GET /api/dashboard/spend` returns the current-month-to-date spend for the
 * signed-in user's ACTIVE connected account (most recently selected, defaulting
 * to the first account when none is selected — Req 12.1). It exists as a route
 * (rather than only a server-component fetch) so the dashboard's client overview
 * can (re-)run the query on demand for the retry control (Req 12.6) while every
 * secret stays server-side.
 *
 * Responses are a small, fully-redacted discriminated union (always HTTP 200 for
 * the authenticated cases so the client can branch on `status`):
 *   - `{ status: "ok", total, currency }`  — success within 10s (Req 12.2)
 *   - `{ status: "no-accounts" }`          — user has zero accounts; NO CE query (Req 12.5)
 *   - `{ status: "error" }`                — CE query failed or timed out (Req 12.6)
 * Unauthenticated callers get a 401 and no query runs.
 *
 * Pinned to the **Node runtime**: the underlying `getCurrentMonthSpend` uses the
 * AWS SDK (STS + Cost Explorer) and server-only secrets, unavailable on edge.
 */
export const runtime = "nodejs";

/** Discriminated, redacted response shape for the dashboard spend query. */
export type DashboardSpendResponse =
  | { status: "ok"; total: number; currency: string }
  | { status: "no-accounts" }
  | { status: "error" };

/**
 * Resolve the active account and return its month-to-date spend. Rejects
 * unauthenticated callers before any Cost Explorer work; returns a redacted
 * error (never a secret or internal detail) on failure/timeout.
 */
export async function GET(): Promise<NextResponse<DashboardSpendResponse>> {
  const session = await auth();
  const userId = session?.user?.id;
  if (typeof userId !== "string" || userId.length === 0) {
    return NextResponse.json({ status: "error" }, { status: 401 });
  }

  // Req 12.5: with zero connected accounts, do NOT query Cost Explorer.
  const activeAccountId = await resolveActiveAccountId(userId);
  if (activeAccountId === null) {
    return NextResponse.json({ status: "no-accounts" }, { status: 200 });
  }

  const spend = await getCurrentMonthSpend(activeAccountId, userId);
  if (!spend.ok) {
    // Req 12.6: redacted error state (no secrets/internal detail).
    return NextResponse.json({ status: "error" }, { status: 200 });
  }

  return NextResponse.json(
    { status: "ok", total: spend.total, currency: spend.currency },
    { status: 200 },
  );
}
