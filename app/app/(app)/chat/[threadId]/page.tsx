import { notFound, redirect } from "next/navigation";

import { ChatView } from "@/components/chat";
import type { ChatMessage } from "@/components/chat";
import { listConnectedAccounts } from "@/lib/actions/accounts";
import { getThread, getThreadMessages } from "@/lib/actions/threads";
import { auth } from "@/lib/auth";
import { generateSuggestions } from "@/lib/suggestions";

/**
 * `/chat/[threadId]` — the agentic chat page (task 14.3; Req 6.1–6.4).
 *
 * A SERVER component: it authenticates the request (redirecting to `/login` when
 * unauthenticated), loads the owned thread (a missing or non-owned thread yields
 * a 404 via {@link notFound}), its persisted messages ordered oldest-first
 * (Req 8.5), the user's connected-account count (which gates the composer —
 * Req 6.1, 6.2), and a set of seed prompt chips. All of that is handed to the
 * client {@link ChatView} container, which owns the streaming + interactivity.
 *
 * The composer's enabled/disabled state is derived from the server-loaded
 * account count: zero accounts renders the disabled connect-account CTA
 * (Req 6.1); ≥1 enables it (Req 6.2). Since account changes happen on
 * `/accounts`, the composer reflects the current count on each load/refresh
 * (Req 6.3, 6.4). All secret handling stays server-side — only browser-safe
 * projections cross to the client.
 */
export default async function ChatThreadPage({
  params,
}: {
  params: Promise<{ threadId: string }>;
}) {
  const { threadId } = await params;

  const session = await auth();
  const userId = session?.user?.id;
  if (typeof userId !== "string" || userId.length === 0) {
    redirect("/login");
  }

  // Ownership-checked load: a missing or non-owned thread is a 404 (Req 8.7).
  const thread = await getThread(threadId);
  if (thread === null) {
    notFound();
  }

  const [messages, accounts] = await Promise.all([
    getThreadMessages(threadId),
    listConnectedAccounts(),
  ]);

  const accountCount = accounts.length;
  const pinnedAccount =
    accounts.find((account) => account.id === thread.connectedAccountId) ?? null;

  const initialMessages: ChatMessage[] = (messages ?? []).map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
  }));

  // Seed the recommendation chips server-side (pure, no secrets). The empty
  // `previous` is fine for the first render; the client varies them thereafter.
  const initialSuggestions = generateSuggestions(
    {
      hasAccount: accountCount > 0,
      accountAlias: pinnedAccount?.alias,
      displayCurrency: pinnedAccount?.displayCurrency,
    },
    [],
  );

  return (
    <ChatView
      threadId={threadId}
      initialMessages={initialMessages}
      accountCount={accountCount}
      accountAlias={pinnedAccount?.alias ?? null}
      initialSuggestions={initialSuggestions}
    />
  );
}
