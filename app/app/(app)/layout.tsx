import { redirect } from "next/navigation";

import { AppShell } from "@/components/app-shell/sidebar";
import type { ConversationListItem } from "@/hooks/useConversations";
import {
  getActiveAccount,
  listConnectedAccounts,
} from "@/lib/actions/accounts";
import { auth } from "@/lib/auth";
import { listConversations } from "@/lib/history/conversations";

/**
 * Guarded authenticated shell layout for the `(app)` route group (task 17.2;
 * Req 2.4, 2.5, 5.4, 8.9).
 *
 * A SERVER component that:
 *  - Guards the group: any request without a valid authenticated session is
 *    redirected to `/login` before any data is read (Req 2.4).
 *  - Loads the browser-safe shell data server-side — the user's connected
 *    accounts, the active-account selection, and the user's OWN conversations
 *    (Req 8.9) — passing only projections that exclude secrets and the runtime
 *    session id.
 *  - Renders the persistent {@link AppShell} (sidebar + content) around every
 *    page in the group (`dashboard`, `chat/[threadId]`, `accounts`). The
 *    sidebar hosts the account switcher, thread list, and sign-out control
 *    (wired to the `logout` server action — Req 2.5).
 *
 * Secrets never reach the client: `listConnectedAccounts`/`getActiveAccount`
 * return {@link ConnectedAccountView}s and the DynamoDB `listConversations`
 * records are projected to browser-safe {@link ConversationListItem}s (the
 * server-only `sessionId` is dropped), none of which carry `role_arn`, the
 * External_Id, or the runtime session id.
 */
export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await auth();
  const userId = session?.user?.id;
  if (typeof userId !== "string" || userId.length === 0) {
    redirect("/login");
  }

  const [accounts, active, conversations] = await Promise.all([
    listConnectedAccounts(),
    getActiveAccount(),
    listConversations(userId),
  ]);

  // Project the DynamoDB conversation records into browser-safe list items,
  // dropping the server-only `sessionId` before it can reach the client.
  const initialConversations: ConversationListItem[] = conversations.map(
    (conversation) => ({
      conversationId: conversation.conversationId,
      title: conversation.title,
      titleSource: conversation.titleSource,
      accountId: conversation.accountId,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      messageCount: conversation.messageCount,
    }),
  );

  return (
    <AppShell
      userEmail={session?.user?.email ?? null}
      accounts={accounts}
      activeId={active?.id ?? null}
      initialConversations={initialConversations}
    >
      {children}
    </AppShell>
  );
}
