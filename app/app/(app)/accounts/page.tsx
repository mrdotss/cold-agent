import { redirect } from "next/navigation";

import { AccountsManager } from "@/components/accounts/accounts-manager";
import { auth } from "@/lib/auth";
import {
  getActiveAccount,
  listConnectedAccounts,
} from "@/lib/actions/accounts";
import {
  prepareConnection,
  type PreparedConnection,
} from "@/lib/actions/prepare-connection";

/**
 * `/accounts` — connect and manage AWS accounts (task 10.3; Req 5.3–5.7,
 * 17.1–17.3).
 *
 * A server component: it authenticates the request, reads the user's connected
 * accounts and active selection, and seeds a prepared connection (External_Id +
 * CloudFormation template) so the wizard opens without a round-trip. All secret
 * material stays server-side — only browser-safe {@link ConnectedAccountView}s
 * and the (intentionally surfaced) External_Id/template cross to the client. The
 * interactive management surface lives in {@link AccountsManager}.
 */
export default async function AccountsPage() {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  const [accounts, active] = await Promise.all([
    listConnectedAccounts(),
    getActiveAccount(),
  ]);

  // Seed the wizard's inputs on the server. A missing env var (e.g.
  // CBA_RUNTIME_ROLE_ARN) must not crash the whole page — the manager can
  // re-prepare on demand and surface a redacted error if that also fails.
  let prepared: PreparedConnection | null = null;
  try {
    prepared = await prepareConnection();
  } catch {
    prepared = null;
  }

  return (
    <AccountsManager
      initialAccounts={accounts}
      initialActiveId={active?.id ?? null}
      preparedConnection={prepared}
    />
  );
}
