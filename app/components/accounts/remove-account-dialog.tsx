"use client";

import * as React from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Delete02Icon, Loading03Icon } from "@hugeicons/core-free-icons";

import { RedactedError } from "@/components/accounts/redacted-error";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { AccountMutationResult } from "@/lib/actions/accounts";
import type { ConnectedAccountView } from "@/lib/db/views";

type RemoveState = "idle" | "pending" | "error";

export interface RemoveAccountDialogProps {
  /** The account proposed for removal. */
  account: ConnectedAccountView;
  /** Whether this account is the currently active one (shown as a warning). */
  isActive: boolean;
  /**
   * Perform the deletion (server action wrapper). Returns the mutation result so
   * a failure can be surfaced without closing the dialog (Req 5.8).
   */
  onConfirm: (accountId: string) => Promise<AccountMutationResult>;
  className?: string;
}

/**
 * Confirmation dialog for removing a connected account (Req 5.6, 5.7, 5.8).
 *
 * Removal is a two-step action: the user opens this dialog and must explicitly
 * confirm before {@link onConfirm} deletes the record (including its encrypted
 * External_Id). While the delete is in flight the controls are disabled; on
 * success the dialog closes and the parent reflects the deletion; on failure the
 * dialog stays open and shows a redacted error so the user can retry (Req 5.8).
 * When the account is the active one, the copy warns that the active selection
 * will be cleared (Req 5.7).
 */
export function RemoveAccountDialog({
  account,
  isActive,
  onConfirm,
  className,
}: RemoveAccountDialogProps) {
  const [open, setOpen] = React.useState(false);
  const [state, setState] = React.useState<RemoveState>("idle");
  const [error, setError] = React.useState<string | undefined>(undefined);

  // Clear any prior failure whenever the dialog opens or closes, in the open
  // handler rather than an effect.
  const handleOpenChange = React.useCallback((next: boolean) => {
    setOpen(next);
    setState("idle");
    setError(undefined);
  }, []);

  const onRemove = React.useCallback(async () => {
    setState("pending");
    setError(undefined);
    const result = await onConfirm(account.id);
    if (result.ok) {
      setOpen(false);
    } else {
      setState("error");
      setError(result.message);
    }
  }, [account.id, onConfirm]);

  const removing = state === "pending";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className={className}
            aria-label={`Remove ${account.alias}`}
          />
        }
      >
        <HugeiconsIcon icon={Delete02Icon} data-icon="inline-start" />
        Remove
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove account</DialogTitle>
          <DialogDescription>
            This permanently removes <strong>{account.alias}</strong> (
            {account.maskedAccountId}) and its stored connection secret. This
            can&apos;t be undone.
            {isActive
              ? " It's your active account, so you'll need to pick a new active account afterward."
              : ""}
          </DialogDescription>
        </DialogHeader>

        {state === "error" ? (
          <RedactedError title="Couldn't remove account" message={error} />
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={removing}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => void onRemove()}
            disabled={removing}
          >
            {removing ? (
              <HugeiconsIcon
                icon={Loading03Icon}
                data-icon="inline-start"
                className="animate-spin motion-reduce:animate-none"
              />
            ) : null}
            {removing ? "Removing…" : "Remove account"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
