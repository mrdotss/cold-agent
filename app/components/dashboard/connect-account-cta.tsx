import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import { CloudIcon, PlusSignIcon } from "@hugeicons/core-free-icons";

import { buttonVariants } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

/**
 * Zero-account call-to-action shown in place of the spend overview when the
 * signed-in user has no connected accounts (Req 12.5). Rendering this instead of
 * the {@link SpendOverview} guarantees no Cost Explorer query is issued. The
 * primary action links to the accounts wizard.
 */
export function ConnectAccountCta() {
  return (
    <Empty className="border border-dashed border-border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <HugeiconsIcon icon={CloudIcon} />
        </EmptyMedia>
        <EmptyTitle>No accounts connected</EmptyTitle>
        <EmptyDescription>
          Connect a read-only AWS account to see your month-to-date spend and
          analyze costs. We never ask for access keys.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Link href="/accounts" className={buttonVariants()}>
          <HugeiconsIcon icon={PlusSignIcon} data-icon="inline-start" />
          Connect an account
        </Link>
      </EmptyContent>
    </Empty>
  );
}
