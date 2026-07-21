"use client";

import { CfnTemplateStep } from "@/components/accounts/cfn-template-step";
import { ConnectAccountForm } from "@/components/accounts/connect-account-form";
import { ExternalIdStep } from "@/components/accounts/external-id-step";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import type { ConnectedAccountView } from "@/lib/db/views";

export interface ConnectAccountWizardProps {
  /** External_Id generated server-side (see `prepareConnection`). */
  externalId: string;
  /** CloudFormation template text generated server-side. */
  template: string;
  /** Optional pre-built "Launch Stack" console deep link. */
  launchStackUrl?: string;
  /** AWS region for the console fallback link. */
  region?: string;
  /** Called with the browser-safe view once the account is stored. */
  onConnected?: (account: ConnectedAccountView) => void;
  className?: string;
}

/**
 * Presentational composition of the three account-connection wizard steps:
 *   1. show the generated External_Id;
 *   2. present the CloudFormation template (copy / download / launch);
 *   3. collect + test + store the role ARN and alias.
 *
 * All server-generated inputs (External_Id, template, launch URL, region) arrive
 * as props, so this tree contains no server-only imports and no env reads. The
 * `/accounts` page (task 10.3) is responsible for fetching those inputs (via the
 * `prepareConnection` server action) and wiring `onConnected`.
 */
export function ConnectAccountWizard({
  externalId,
  template,
  launchStackUrl,
  region,
  onConnected,
  className,
}: ConnectAccountWizardProps) {
  return (
    <div className={cn("flex flex-col gap-8", className)}>
      <ExternalIdStep externalId={externalId} stepNumber={1} />
      <Separator />
      <CfnTemplateStep
        template={template}
        launchStackUrl={launchStackUrl}
        region={region}
        stepNumber={2}
      />
      <Separator />
      <ConnectAccountForm
        externalId={externalId}
        onConnected={onConnected}
        stepNumber={3}
      />
    </div>
  );
}
