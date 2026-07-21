"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { ShieldKeyIcon } from "@hugeicons/core-free-icons";

import { CopyButton } from "@/components/accounts/copy-button";
import { cn } from "@/lib/utils";

export interface ExternalIdStepProps {
  /**
   * The External_Id generated server-side for this pending connection. It is
   * surfaced intentionally: the user places it in their CloudFormation trust
   * condition (`sts:ExternalId`). No other secret is ever exposed here.
   */
  externalId: string;
  /** Optional step index shown in the eyebrow label (e.g. 1). */
  stepNumber?: number;
  className?: string;
}

/**
 * Wizard step 1 — present the generated External_Id.
 *
 * The value is displayed clearly (with a one-click copy) alongside a short
 * explanation of what it is for. It is a per-account shared secret used only in
 * the role trust condition, so it is safe (and necessary) to show here.
 */
export function ExternalIdStep({
  externalId,
  stepNumber,
  className,
}: ExternalIdStepProps) {
  return (
    <section className={cn("flex flex-col gap-4", className)}>
      <header className="flex flex-col gap-1">
        <p className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
          {stepNumber ? `Step ${stepNumber} · ` : ""}Your External ID
        </p>
        <h3 className="font-heading text-lg">
          A unique secret ties the role to you
        </h3>
        <p className="text-sm text-muted-foreground">
          We generated this External ID for this connection. The CloudFormation
          template below already includes it, so you normally don&apos;t need to
          copy it by hand — but keep it handy if you build the role manually.
        </p>
      </header>

      <div className="flex flex-col gap-3 border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <HugeiconsIcon
            icon={ShieldKeyIcon}
            className="size-5 shrink-0 text-muted-foreground"
          />
          <code
            className="truncate font-mono text-sm break-all"
            data-testid="external-id-value"
          >
            {externalId}
          </code>
        </div>
        <CopyButton
          value={externalId}
          label="Copy ID"
          className="shrink-0 self-start sm:self-auto"
        />
      </div>
    </section>
  );
}
