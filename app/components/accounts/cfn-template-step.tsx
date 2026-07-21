"use client";

import * as React from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Download04Icon, LinkSquare02Icon } from "@hugeicons/core-free-icons";

import { CopyButton } from "@/components/accounts/copy-button";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface CfnTemplateStepProps {
  /**
   * The CloudFormation template text, generated server-side (it needs the
   * runtime role ARN + region and must not be built in the browser). Rendered
   * verbatim as copyable inline text and offered as a file download.
   */
  template: string;
  /**
   * A ready-made "Launch Stack" AWS console deep link, built server-side with
   * `launchStackUrl(templateUrl, region)`. When omitted, a region-scoped
   * console fallback link to the create-stack screen is shown instead.
   */
  launchStackUrl?: string;
  /** AWS region used to build the console fallback link (e.g. `us-east-1`). */
  region?: string;
  /** Download file name. Defaults to a `.json` template name. */
  fileName?: string;
  /** Optional step index shown in the eyebrow label (e.g. 2). */
  stepNumber?: number;
  className?: string;
}

/**
 * Build a region-scoped CloudFormation "create stack" console URL used as a
 * fallback when no pre-hosted `launchStackUrl` is supplied. It opens the console
 * where the user can upload the template downloaded from this step.
 */
function consoleCreateStackUrl(region?: string): string {
  const host =
    region && region.length > 0
      ? `${region}.console.aws.amazon.com`
      : "console.aws.amazon.com";
  const query = region && region.length > 0 ? `?region=${region}` : "";
  return `https://${host}/cloudformation/home${query}#/stacks/create`;
}

/**
 * Wizard step 2 — present the CloudFormation template (Req 3.2, 3.3).
 *
 * Provides the template three ways:
 *  - copyable inline text (with a copy-confirmation control);
 *  - a downloadable file (an in-browser Blob download);
 *  - a "Launch Stack" AWS console deep link.
 *
 * Purely presentational: the template + launch URL arrive as props (generated
 * server-side), so no server env or server-only module is touched here.
 */
export function CfnTemplateStep({
  template,
  launchStackUrl,
  region,
  fileName = "cloud-bill-analyst-role.json",
  stepNumber,
  className,
}: CfnTemplateStepProps) {
  const onDownload = React.useCallback(() => {
    const blob = new Blob([template], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }, [template, fileName]);

  const launchHref = launchStackUrl ?? consoleCreateStackUrl(region);

  return (
    <section className={cn("flex flex-col gap-4", className)}>
      <header className="flex flex-col gap-1">
        <p className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
          {stepNumber ? `Step ${stepNumber} · ` : ""}Create the role
        </p>
        <h3 className="font-heading text-lg">
          Run this CloudFormation template in your AWS account
        </h3>
        <p className="text-sm text-muted-foreground">
          It provisions a read-only role granting only Cost Explorer reads, with
          a trust policy locked to this app and your External ID. Launch it in
          the console, or copy / download the template to run it your own way.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <a
          href={launchHref}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(buttonVariants({ variant: "default", size: "sm" }))}
        >
          <HugeiconsIcon icon={LinkSquare02Icon} data-icon="inline-start" />
          Launch Stack
        </a>
        <CopyButton value={template} label="Copy template" size="sm" />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onDownload}
        >
          <HugeiconsIcon icon={Download04Icon} data-icon="inline-start" />
          Download
        </Button>
      </div>

      <div className="border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
            {fileName}
          </span>
        </div>
        <pre
          className="max-h-80 overflow-auto p-4 text-xs leading-relaxed"
          tabIndex={0}
          aria-label="CloudFormation template"
        >
          <code className="font-mono">{template}</code>
        </pre>
      </div>
    </section>
  );
}
