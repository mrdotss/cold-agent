import { redirect } from "next/navigation";

import { AppShell } from "@/components/app-shell/sidebar";
import {
  getActiveAccount,
  listConnectedAccounts,
} from "@/lib/actions/accounts";
import { listThreads } from "@/lib/actions/threads";
import { auth } from "@/lib/auth";

/**
 * Guarded authenticated shell layout for the `(app)` route group (task 17.2;
 * Req 2.4, 2.5, 5.4, 8.9).
 *
 * A SERVER component that:
 *  - Guards the group: any request without a valid authenticated session is
 *    redirected to `/login` before any data is read (Req 2.4).
 *  - Loads the browser-safe shell data server-side — the user's connected
 *    accounts, the active-account selection, and the user's OWN threads
 *    (Req 8.9) — passing only projections that exclude secrets and the runtime
 *    session id.
 *  - Renders the persistent {@link AppShell} (sidebar + content) around every
 *    page in the group (`dashboard`, `chat/[threadId]`, `accounts`). The
 *    sidebar hosts the account switcher, thread list, and sign-out control
 *    (wired to the `logout` server action — Req 2.5).
 *
 * Secrets never reach the client: `listConnectedAccounts`/`getActiveAccount`
 * return {@link ConnectedAccountView}s and `listThreads` returns
 * {@link ThreadView}s, none of which carry `role_arn`, the External_Id, or the
 * `session_id`.
 */
export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await auth();
  const userId = session?.user?.id;
  if (typeof userId !== "string" || userId.length === 0) {
    redirect("/login");
  }

  const [accounts, active, threads] = await Promise.all([
    listConnectedAccounts(),
    getActiveAccount(),
    listThreads(),
  ]);

  return (
    <AppShell
      userEmail={session?.user?.email ?? null}
      accounts={accounts}
      activeId={active?.id ?? null}
      threads={threads}
    >
      {children}
    </AppShell>
  );
}
