"use client";

import * as React from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert02Icon, RefreshIcon } from "@hugeicons/core-free-icons";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * Redacted response shape returned by `GET /api/dashboard/spend`. Duplicated as
 * a browser-safe literal union so this client component never imports the
 * `server-only` dashboard module.
 */
type SpendResponse =
  | { status: "ok"; total: number; currency: string }
  | { status: "no-accounts" }
  | { status: "error" };

/** UI phase for the overview. */
type Phase = "loading" | "ok" | "error";

/** Data shown once the query succeeds. */
interface SpendData {
  total: number;
  currency: string;
}

export interface SpendOverviewProps {
  /**
   * Fallback currency label (the active account's `displayCurrency`) used for
   * the section caption before the query resolves. The authoritative currency
   * comes back with a successful query.
   */
  currency: string;
}

/**
 * Format an amount with the account's display currency. Falls back to a plain
 * number plus the raw currency label when the code is not a valid ISO 4217
 * currency that `Intl` recognizes.
 */
function formatAmount(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    const number = new Intl.NumberFormat(undefined, {
      maximumFractionDigits: 2,
    }).format(amount);
    return `${number} ${currency}`;
  }
}

/** Human-readable label for the current calendar month, e.g. "June 2025". */
function currentMonthLabel(): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric",
  }).format(new Date());
}

/**
 * Client spend overview for the dashboard (Req 12.2, 12.3, 12.6).
 *
 * On mount — and on every retry — it fetches `GET /api/dashboard/spend`, which
 * runs the Cost Explorer query server-side (secrets never reach the browser).
 * It renders exactly one of three states in place of the overview:
 *   - **loading**: a skeleton placeholder while the query runs (Req 12.3);
 *   - **success**: the current-month-to-date total in the account's display
 *     currency (Req 12.2);
 *   - **error**: a redacted failure message with a Retry control that re-runs
 *     the query (Req 12.6).
 *
 * Status changes are announced through an `aria-live="polite"` region so the
 * transition from loading to a result is conveyed to assistive tech.
 */
export function SpendOverview({ currency }: SpendOverviewProps) {
  const [phase, setPhase] = React.useState<Phase>("loading");
  const [data, setData] = React.useState<SpendData | null>(null);
  // Bumped by the retry control to re-run the effect (Req 12.6).
  const [reloadKey, setReloadKey] = React.useState(0);

  // Fetch the spend on mount and whenever `reloadKey` changes. All state updates
  // happen inside the async IIFE *after* an `await` (guarded by `ignore` so a
  // unmounted/superseded run can't set state), so no setState runs synchronously
  // in the effect body.
  React.useEffect(() => {
    let ignore = false;
    void (async () => {
      try {
        const response = await fetch("/api/dashboard/spend", {
          cache: "no-store",
        });
        if (ignore) return;
        if (!response.ok) {
          setPhase("error");
          return;
        }
        const body = (await response.json()) as SpendResponse;
        if (ignore) return;
        if (body.status === "ok") {
          setData({ total: body.total, currency: body.currency });
          setPhase("ok");
        } else {
          // "no-accounts" should not happen here (the page only mounts this
          // component when accounts exist) — treat it, like any other non-ok
          // outcome, as a redacted error the user can retry.
          setPhase("error");
        }
      } catch {
        if (!ignore) setPhase("error");
      }
    })();
    return () => {
      ignore = true;
    };
  }, [reloadKey]);

  // Retry control (Req 12.6): reset to the loading state and re-trigger the
  // effect. Runs from a user event, so these synchronous setStates are fine.
  const retry = React.useCallback(() => {
    setData(null);
    setPhase("loading");
    setReloadKey((key) => key + 1);
  }, []);

  const captionCurrency = data?.currency ?? currency;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Spend this month</CardTitle>
        <CardDescription>
          {currentMonthLabel()} to date{" "}
          <span className="text-muted-foreground/80">
            · {captionCurrency}
          </span>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div aria-live="polite" aria-busy={phase === "loading"}>
          {phase === "loading" ? (
            <>
              <span className="sr-only">Loading spend overview…</span>
              <div className="flex flex-col gap-2" aria-hidden>
                <div className="h-10 w-48 max-w-full animate-pulse bg-muted motion-reduce:animate-none" />
                <div className="h-4 w-32 animate-pulse bg-muted motion-reduce:animate-none" />
              </div>
            </>
          ) : null}

          {phase === "ok" && data !== null ? (
            <div className="flex flex-col gap-1">
              <span className="font-heading text-4xl tracking-tight tabular-nums">
                {formatAmount(data.total, data.currency)}
              </span>
              <span className="text-sm text-muted-foreground">
                Total spend for {currentMonthLabel()} so far.
              </span>
            </div>
          ) : null}

          {phase === "error" ? (
            <Alert variant="destructive">
              <HugeiconsIcon icon={Alert02Icon} />
              <AlertTitle>Couldn&apos;t load your spend</AlertTitle>
              <AlertDescription className="flex flex-col items-start gap-3">
                <span>
                  We couldn&apos;t retrieve this month&apos;s spend. Please try
                  again.
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={retry}
                >
                  <HugeiconsIcon icon={RefreshIcon} data-icon="inline-start" />
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
