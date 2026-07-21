"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { CloudIcon, StarIcon } from "@hugeicons/core-free-icons";

import { AccountSettings } from "@/components/accounts/account-settings";
import { RemoveAccountDialog } from "@/components/accounts/remove-account-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AccountMutationResult } from "@/lib/actions/accounts";
import type { ConnectedAccountView } from "@/lib/db/views";

export interface AccountListProps {
  /** The accounts to display (each row shows alias + masked id — Req 5.3). */
  accounts: ConnectedAccountView[];
  /** The active account id, or `null` when none is selected. */
  activeId: string | null;
  /** Make the given account active (used by the per-row "Set active" control). */
  onSetActive: (accountId: string) => void;
  /** Persist per-account currency/timezone changes. */
  onSaveSettings: (
    accountId: string,
    settings: { displayCurrency: string; timezone: string },
  ) => Promise<AccountMutationResult>;
  /** Remove an account after in-dialog confirmation. */
  onRemove: (accountId: string) => Promise<AccountMutationResult>;
  /** Disable switching controls while a mutation is in flight. */
  busy?: boolean;
}

/**
 * List of a user's connected accounts (Req 5.3).
 *
 * Each row surfaces the account alias and the masked account id (only the last
 * four digits are ever revealed — the mask is produced server-side in the
 * {@link ConnectedAccountView}). The active account is marked with a badge; the
 * rest expose a "Set active" control (Req 5.5). Every row also offers the
 * per-account settings editor (Req 17.x) and a confirm-guarded remove action
 * (Req 5.6).
 */
export function AccountList({
  accounts,
  activeId,
  onSetActive,
  onSaveSettings,
  onRemove,
  busy,
}: AccountListProps) {
  return (
    <ul className="flex flex-col border-t border-border">
      {accounts.map((account) => {
        const isActive = account.id === activeId;
        return (
          <li
            key={account.id}
            className={cn(
              "flex flex-col gap-4 border-b border-border py-5 sm:flex-row sm:items-center sm:justify-between",
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
                  <span className="truncate font-medium">{account.alias}</span>
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

            <div className="flex flex-wrap items-center gap-1.5">
              {isActive ? null : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onSetActive(account.id)}
                  disabled={busy}
                >
                  Set active
                </Button>
              )}
              <AccountSettings account={account} onSave={onSaveSettings} />
              <RemoveAccountDialog
                account={account}
                isActive={isActive}
                onConfirm={onRemove}
                className="text-destructive"
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
