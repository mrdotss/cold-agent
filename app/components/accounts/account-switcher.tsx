"use client";

import * as React from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDataTransferHorizontalIcon } from "@hugeicons/core-free-icons";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { ConnectedAccountView } from "@/lib/db/views";

export interface AccountSwitcherProps {
  /** All of the user's connected accounts (never empty when rendered). */
  accounts: ConnectedAccountView[];
  /** The active account id, or `null` when no account is currently selected. */
  activeId: string | null;
  /** Called with the chosen account id when the user switches the active account. */
  onSelect: (accountId: string) => void;
  /** Disable the control while a switch is in flight. */
  disabled?: boolean;
  className?: string;
}

/**
 * Active-account switcher (Req 5.5, 5.7).
 *
 * A single {@link Select} that reflects the currently active account and lets
 * the user switch it. Selecting an account calls {@link onSelect}, which the
 * parent uses to persist the choice via `setActiveAccount` (server-persisted so
 * it survives across sessions). When `activeId` is `null` — e.g. right after the
 * active account was removed — the trigger shows a "Select an active account"
 * prompt (Req 5.7).
 */
export function AccountSwitcher({
  accounts,
  activeId,
  onSelect,
  disabled,
  className,
}: AccountSwitcherProps) {
  const items = React.useMemo(
    () => accounts.map((account) => ({ label: account.alias, value: account.id })),
    [accounts],
  );

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <HugeiconsIcon
        icon={ArrowDataTransferHorizontalIcon}
        className="size-4 shrink-0 text-muted-foreground"
      />
      <Select
        items={items}
        value={activeId}
        onValueChange={(value) => {
          if (typeof value === "string" && value.length > 0) {
            onSelect(value);
          }
        }}
        disabled={disabled}
      >
        <SelectTrigger
          className="w-64 max-w-full"
          aria-label="Active account"
          data-invalid={activeId === null || undefined}
        >
          <SelectValue>
            {(value: string | null) => {
              const active = accounts.find((account) => account.id === value);
              return active ? (
                <span className="flex items-center gap-2">
                  <span className="truncate">{active.alias}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {active.maskedAccountId}
                  </span>
                </span>
              ) : (
                <span className="text-muted-foreground">
                  Select an active account
                </span>
              );
            }}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  );
}
