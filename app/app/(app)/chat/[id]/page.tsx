import { notFound, redirect } from "next/navigation";

import { ChatView } from "@/components/chat";
import type { ChatMessage } from "@/components/chat";
import { listConnectedAccounts } from "@/lib/actions/accounts";
import { auth } from "@/lib/auth";
import { getConversationOwned } from "@/lib/history/conversations";
import { listMessages } from "@/lib/history/messages";
import { generateSuggestions } from "@/lib/suggestions";

/**
 * `/chat/[id]` — the agentic chat page (task 12.1; Req 9.4, 9.5, 9.6).
 *
 * A SERVER component: it authenticates the request (redirecting to `/login` when
 * unauthenticated), then loads the conversation from DynamoDB addressed by its
 * `conversationId` (the `[id]` route param). Loading mirrors the GET route
 * `app/api/conversations/[id]/route.ts`: the ownership-gated
 * {@link getConversationOwned} read runs FIRST and a `null` result (absent or
 * not owned) yields a 404 via {@link notFound} (Req 9.4); then
 * {@link listMessages} returns the persisted transcript oldest-first — each
 * {@link StoredMessage} carrying its `id` (`MSG#…` sort key), `role`, `content`,
 * `charts`, `reports`, and optional `feedback`.
 *
 * Chat history lives entirely in DynamoDB (auth + connected accounts stay in
 * Postgres). The stores are `server-only`, which is fine here because this is a
 * server component. Each StoredMessage is projected to a {@link ChatMessage}
 * carrying its content AND its persisted `ChartSpec`s (rendered client-side by
 * the same `ChartInline`), report keys, and thumbs `feedback` so the reopened
 * transcript reproduces charts and feedback state (Req 9.6).
 *
 * A zero-message conversation hydrates with `initialMessages: []`; `ChatView`
 * renders its intro empty state without surfacing an error (Req 9.5).
 *
 * The composer's enabled/disabled state is derived from the server-loaded
 * connected-account count: zero accounts renders the disabled connect-account
 * CTA; ≥1 enables it. The intro chip is pinned to the account the conversation
 * was created against (`conversation.accountId`) — matched against the user's
 * connected accounts for its alias/currency. All secret handling stays
 * server-side — only browser-safe projections cross to the client.
 */
export default async function ChatConversationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const session = await auth();
  const userId = session?.user?.id;
  if (typeof userId !== "string" || userId.length === 0) {
    redirect("/login");
  }

  // Ownership-gated load: an absent or non-owned conversation is a 404 (Req 9.4).
  const conversation = await getConversationOwned(userId, id);
  if (conversation === null) {
    notFound();
  }

  const [messages, accounts] = await Promise.all([
    listMessages(userId, id),
    listConnectedAccounts(),
  ]);

  const accountCount = accounts.length;
  // Pin the intro chip to the account this conversation was created against.
  const pinnedAccount =
    accounts.find((account) => account.id === conversation.accountId) ?? null;

  // Hydrate the transcript: content + persisted charts + report keys + feedback,
  // so reopening reproduces inline charts and thumbs state (Req 9.6). A zero-
  // message conversation yields `[]`, which ChatView renders as the intro empty
  // state without error (Req 9.5).
  const initialMessages: ChatMessage[] = messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    charts: message.charts,
    reports: message.reports,
    feedback: message.feedback,
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
      threadId={id}
      initialMessages={initialMessages}
      accountCount={accountCount}
      accountAlias={pinnedAccount?.alias ?? null}
      initialSuggestions={initialSuggestions}
    />
  );
}
