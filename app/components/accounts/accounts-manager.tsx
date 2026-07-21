"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  PlusSignIcon,
  CloudIcon,
  Alert02Icon,
  Loading03Icon,
} from "@hugeicons/core-free-icons";

import { AccountList } from "@/components/accounts/account-list";
import { AccountSwitcher } from "@/components/accounts/account-switcher";
import { ConnectAccountWizard } from "@/components/accounts/connect-account-wizard";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  deleteConnectedAccount,
  setActiveAccount,
  updateAccountSettings,
} from "@/lib/actions/accounts";
import { prepareConnection } from "@/lib/actions/prepare-connection";
import type { PreparedConnection } from "@/lib/actions/prepare-connection";
import type { AccountMutationResult } from "@/lib/actions/accounts";
import type { ConnectedAccountView } from "@/lib/db/views";

/**
 * Per-user connected-account limit mirrored from the server action's
 * `MAX_CONNECTED_ACCOUNTS` (Req 5.1, 5.2). Duplicated as a plain client constant
 * because a `"use server"` module may only export async functions — the server
 * remains the authority and rejects an over-limit create regardless.
 */
const MAX_CONNECTED_ACCOUNTS = 10;

export interface AccountsManagerProps {
  /** Server-fetched connected accounts for the signed-in user. */
  initialAccounts: ConnectedAccountView[];
  /** Server-fetched active-account id, or `null` when none is selected. */
  initialActiveId: string | null;
  /**
   * A prepared connection (External_Id + CloudFormation template) seeded on the
   * server to open the wizard without a round-trip. `null` when server-side
   * preparation failed (e.g. a missing env var); the wizard then prepares fresh
   * values on demand and surfaces an error if that also fails.
   */
  preparedConnection: PreparedConnection | null;
}

/**
 * Client orchestrator for the `/accounts` page (Req 5.3–5.7, 17.1–17.3).
 *
 * Owns the interactive account-management state: the list, the active-account
 * selection, the connect-account wizard dialog, and the "pick an active account"
 * prompt. Server truth arrives via props (the page is a server component); this
 * component applies optimistic updates and then calls `router.refresh()` so the
 * server re-reads after each mutation. All secret handling stays server-side —
 * only {@link ConnectedAccountView}s ever reach this component.
 */
export function AccountsManager({
  initialAccounts,
  initialActiveId,
  preparedConnection,
}: AccountsManagerProps) {
  const router = useRouter();

  const [accounts, setAccounts] =
    React.useState<ConnectedAccountView[]>(initialAccounts);
  const [activeId, setActiveId] = React.useState<string | null>(
    initialActiveId,
  );
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);

  // Reconcile with server truth whenever the page re-reads (after
  // `router.refresh()`). This uses the documented "adjust state during render"
  // pattern — comparing the incoming props to the last props we synced from —
  // so a fresh server read replaces any stale optimistic state without an
  // effect and its cascading render.
  const [syncedProps, setSyncedProps] = React.useState({
    accounts: initialAccounts,
    activeId: initialActiveId,
  });
  if (
    syncedProps.accounts !== initialAccounts ||
    syncedProps.activeId !== initialActiveId
  ) {
    setSyncedProps({ accounts: initialAccounts, activeId: initialActiveId });
    setAccounts(initialAccounts);
    setActiveId(initialActiveId);
  }

  // ---- Connect wizard dialog ------------------------------------------------
  const [wizardOpen, setWizardOpen] = React.useState(false);
  const [prepared, setPrepared] = React.useState<PreparedConnection | null>(
    preparedConnection,
  );
  const [preparing, setPreparing] = React.useState(false);
  const [prepareError, setPrepareError] = React.useState<string | null>(null);

  const atLimit = accounts.length >= MAX_CONNECTED_ACCOUNTS;

  const openWizard = React.useCallback(async () => {
    setWizardOpen(true);
    setPrepareError(null);
    // Always mint a fresh External_Id + template for a new connection so two
    // connections never share a secret.
    setPreparing(true);
    try {
      const fresh = await prepareConnection();
      setPrepared(fresh);
    } catch {
      // Fall back to the server-seeded values when a fresh prepare fails; if we
      // have nothing to show, surface a redacted error inside the dialog.
      if (prepared === null) {
        setPrepareError(
          "Couldn't start the connection wizard. Please try again.",
        );
      }
    } finally {
      setPreparing(false);
    }
  }, [prepared]);

  const handleConnected = React.useCallback(
    (account: ConnectedAccountView) => {
      setAccounts((current) =>
        current.some((existing) => existing.id === account.id)
          ? current
          : [...current, account],
      );
      setWizardOpen(false);
      setNotice(null);
      router.refresh();
    },
    [router],
  );

  // ---- Active-account selection (Req 5.5) -----------------------------------
  const handleSetActive = React.useCallback(
    (accountId: string) => {
      const previous = activeId;
      setActiveId(accountId); // optimistic
      setBusy(true);
      setNotice(null);
      void (async () => {
        const result = await setActiveAccount(accountId);
        if (!result.ok) {
          setActiveId(previous);
          setNotice(result.message);
        }
        setBusy(false);
        router.refresh();
      })();
    },
    [activeId, router],
  );

  // ---- Removal (Req 5.6, 5.7, 5.8) ------------------------------------------
  const handleRemove = React.useCallback(
    async (accountId: string): Promise<AccountMutationResult> => {
      const result = await deleteConnectedAccount(accountId);
      if (result.ok) {
        setAccounts((current) =>
          current.filter((account) => account.id !== accountId),
        );
        // Clearing the active selection when the active account is removed
        // (Req 5.7); the server action clears it server-side too.
        setActiveId((current) => (current === accountId ? null : current));
        router.refresh();
      }
      return result;
    },
    [router],
  );

  // ---- Per-account settings (Req 17.2, 17.3) --------------------------------
  const handleSaveSettings = React.useCallback(
    async (
      accountId: string,
      settings: { displayCurrency: string; timezone: string },
    ): Promise<AccountMutationResult> => {
      const result = await updateAccountSettings(accountId, settings);
      if (result.ok) {
        setAccounts((current) =>
          current.map((account) =>
            account.id === accountId
              ? {
                  ...account,
                  displayCurrency: settings.displayCurrency,
                  timezone: settings.timezone,
                }
              : account,
          ),
        );
        router.refresh();
      }
      return result;
    },
    [router],
  );

  const hasAccounts = accounts.length > 0;
  // Req 5.7: with accounts present but nothing active, prompt for a selection.
  const needsActiveSelection = hasAccounts && activeId === null;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-10 sm:px-6">
      <header className="flex flex-col gap-2">
        <p className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
          Connected accounts
        </p>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="font-heading text-3xl">Your AWS accounts</h1>
            <p className="text-sm text-muted-foreground">
              Connect read-only AWS accounts to analyze spend. We never ask for
              access keys.
            </p>
          </div>
          {hasAccounts ? (
            <Button
              type="button"
              onClick={() => void openWizard()}
              disabled={atLimit}
            >
              <HugeiconsIcon icon={PlusSignIcon} data-icon="inline-start" />
              Connect account
            </Button>
          ) : null}
        </div>
        {atLimit ? (
          <p className="text-sm text-muted-foreground">
            You&apos;ve reached the maximum of {MAX_CONNECTED_ACCOUNTS}{" "}
            connected accounts.
          </p>
        ) : null}
      </header>

      {notice ? (
        <Alert variant="destructive">
          <HugeiconsIcon icon={Alert02Icon} />
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      {hasAccounts ? (
        <section className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <span className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
              Active account
            </span>
            <AccountSwitcher
              accounts={accounts}
              activeId={activeId}
              onSelect={handleSetActive}
              disabled={busy}
            />
            {needsActiveSelection ? (
              <p className="text-sm text-destructive">
                No active account is selected. Choose one above before running
                account-scoped actions.
              </p>
            ) : null}
          </div>

          <AccountList
            accounts={accounts}
            activeId={activeId}
            onSetActive={handleSetActive}
            onSaveSettings={handleSaveSettings}
            onRemove={handleRemove}
            busy={busy}
          />
        </section>
      ) : (
        <Empty className="border border-dashed border-border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={CloudIcon} />
            </EmptyMedia>
            <EmptyTitle>No accounts connected</EmptyTitle>
            <EmptyDescription>
              You haven&apos;t connected any AWS accounts yet. Connect one to
              start analyzing your spend and exporting reports.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button type="button" onClick={() => void openWizard()}>
              <HugeiconsIcon icon={PlusSignIcon} data-icon="inline-start" />
              Connect your first account
            </Button>
          </EmptyContent>
        </Empty>
      )}

      <Dialog open={wizardOpen} onOpenChange={setWizardOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Connect an AWS account</DialogTitle>
            <DialogDescription>
              Create a read-only role in your AWS account, then paste its ARN
              back here. No access keys are ever collected.
            </DialogDescription>
          </DialogHeader>

          {preparing ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <HugeiconsIcon
                icon={Loading03Icon}
                className="size-4 animate-spin motion-reduce:animate-none"
              />
              Preparing your connection…
            </div>
          ) : prepared ? (
            <ConnectAccountWizard
              externalId={prepared.externalId}
              template={prepared.template}
              launchStackUrl={prepared.launchStackUrl}
              region={prepared.region}
              onConnected={handleConnected}
            />
          ) : (
            <Alert variant="destructive">
              <HugeiconsIcon icon={Alert02Icon} />
              <AlertTitle>Couldn&apos;t start the wizard</AlertTitle>
              <AlertDescription>
                {prepareError ??
                  "Couldn't start the connection wizard. Please try again."}
              </AlertDescription>
            </Alert>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
