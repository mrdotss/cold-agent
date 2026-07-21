import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import { CloudIcon, StarIcon } from "@hugeicons/core-free-icons";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ConnectedAccountView } from "@/lib/db/views";

export interface DashboardAccountsProps {
  /** The signed-in user's connected accounts (browser-safe views). */
  accounts: ConnectedAccountView[];
  /** The resolved active account id (most recent selection, default first). */
  activeId: string | null;
}

/**
 * Read-only list of the user's connected accounts for the dashboard (Req 12.4).
 *
 * Purely presentational: each row shows the alias and the masked account id
 * (only the last four digits are ever revealed — the mask is produced
 * server-side in {@link ConnectedAccountView}), with the active account marked by
 * a badge. Management (switch/settings/removal) lives on `/accounts`, linked from
 * the header.
 */
export function DashboardAccounts({
  accounts,
  activeId,
}: DashboardAccountsProps) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
          Connected accounts
        </span>
        <Link
          href="/accounts"
          className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
        >
          Manage accounts
        </Link>
      </div>

      <ul className="flex flex-col border-t border-border">
        {accounts.map((account) => {
          const isActive = account.id === activeId;
          return (
            <li
              key={account.id}
              className={cn(
                "flex items-center justify-between gap-3 border-b border-border py-4",
                isActive && "bg-accent/40",
              )}
            >
              <div className="flex min-w-0 items-center gap-3">
                <span
                  className="flex size-9 shrink-0 items-center justify-center bg-muted text-muted-foreground"
                  aria-hidden
                >
                  <HugeiconsIcon icon={CloudIcon} className="size-4" />
                </span>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">
                      {account.alias}
                    </span>
                    {isActive ? (
                      <Badge variant="secondary" className="gap-1">
                        <HugeiconsIcon icon={StarIcon} className="size-3" />
                        Active
                      </Badge>
                    ) : null}
                  </div>
                  <span className="font-mono text-xs text-muted-foreground">
                    {account.maskedAccountId}
                  </span>
                </div>
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">
                {account.displayCurrency}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
