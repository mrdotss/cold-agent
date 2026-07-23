"use client";

/**
 * Client conversation list for the app shell sidebar (task 13.3).
 *
 * Extracted from `sidebar.tsx` into a self-contained client component backed by
 * the {@link useConversations} hook. It owns the interactive conversation list:
 * the optimistic "New" control, the per-row inline rename, the pending-title
 * skeleton shimmer, and the editorial active-state styling. It deliberately does
 * NO routing itself — navigation is wired by the sidebar (task 13.4) via the
 * callbacks this component exposes (`onCreated`), and rows render as plain links
 * to `/chat/<conversationId>`.
 *
 * TITLE FIRING (extended for task 13.4, Req 10.8): this component also owns the
 * pending-title safety-net. Because it holds the live conversation list, an
 * effect here fires exactly one background `POST /api/conversations/<id>/title`
 * for every conversation it lists that is still `titleSource: "pending"` AND
 * already has at least one message (`messageCount >= 1`) — the case where the
 * first user message was persisted but the title never got generated. A
 * brand-new EMPTY conversation (`messageCount === 0`) is deliberately skipped so
 * the request never races the first user-message write; its title is generated
 * by the chat flow once the first message lands. Each id fires at most once per
 * mount (deduped via a ref).
 *
 * This is a CLIENT module: it must not import any `server-only` module. It talks
 * to the API only indirectly, through {@link useConversations} and a
 * fire-and-forget `fetch` to the title route.
 *
 * Requirements: 1.1, 1.3, 1.8, 10.1, 10.8, 11.1, 11.2, 11.3, 11.4, 11.6.
 */

import * as React from "react";
import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Edit02Icon,
  Loading03Icon,
  Message01Icon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";

import { Input } from "@/components/ui/input";
import {
  useConversations,
  type ConversationListItem,
} from "@/hooks/useConversations";
import { decideRename } from "@/lib/rename";
import { cn } from "@/lib/utils";

/** Maximum length of an inline-rename title field (Req 11.1). */
const RENAME_MAX_LENGTH = 100;

/** Fallback label for a non-pending row whose title is empty. */
const FALLBACK_TITLE = "New conversation";

/** Default label shown for a pending row until its AI title lands (Req 10.1). */
const NEW_CHAT_TITLE = "New Chat";

export interface ConversationListProps {
  /**
   * How many Connected_Accounts the user has. When `0`, the "New" control is
   * disabled and a connect-account affordance is shown (Req 1.8).
   */
  accountCount: number;
  /**
   * The account a new chat is pinned to (the active account, else the first).
   * `null` when there are no accounts; the "New" control is disabled in that
   * case regardless.
   */
  newChatAccountId: string | null;
  /** The currently open conversation id, used to render the active-row border. */
  activeConversationId?: string;
  /** Seed the list from the server layout to avoid an initial fetch flash. */
  initialConversations?: ConversationListItem[];
  /**
   * Called with the persisted `conversationId` after a successful create. The
   * sidebar uses this to navigate to `/chat/<conversationId>` and fire the
   * background title request (task 13.4).
   */
  onCreated?: (conversationId: string) => void;
  /** Surface a redacted, user-facing error (e.g. as a toast) — task 13.4. */
  onError?: (message: string) => void;
}

/**
 * The interactive conversation list. Renders the "Conversations" section header
 * with the optimistic "New" control, then one row per conversation.
 */
export function ConversationList({
  accountCount,
  newChatAccountId,
  activeConversationId,
  initialConversations,
  onCreated,
  onError,
}: ConversationListProps) {
  const { conversations, isCreating, create, rename } = useConversations({
    initialConversations,
    onError,
  });

  // Exactly one row may be in inline-rename mode at a time (Req 11.1).
  const [editingId, setEditingId] = React.useState<string | null>(null);

  // Pending-title safety-net (task 13.4, Req 10.8). For every listed
  // conversation still `pending` that already has at least one message, fire
  // exactly one background POST /api/conversations/<id>/title to (re)generate
  // its title — fire-and-forget, errors swallowed (the title route itself falls
  // back so a conversation is never left pending). Deduped per id per mount via
  // a ref so the request fires at most once. Empty conversations
  // (messageCount 0) — including a just-created row — are skipped so the request
  // never races the first user-message write.
  const firedTitleIdsRef = React.useRef<Set<string>>(new Set());
  React.useEffect(() => {
    for (const conversation of conversations) {
      if (
        conversation.titleSource === "pending" &&
        conversation.messageCount >= 1 &&
        !firedTitleIdsRef.current.has(conversation.conversationId)
      ) {
        firedTitleIdsRef.current.add(conversation.conversationId);
        void fetch(
          `/api/conversations/${encodeURIComponent(
            conversation.conversationId,
          )}/title`,
          { method: "POST" },
        ).catch(() => {
          // Fire-and-forget: a failed safety-net POST is intentionally ignored.
        });
      }
    }
  }, [conversations]);

  const hasAccounts = accountCount > 0;
  const canCreate = hasAccounts && newChatAccountId !== null;

  const handleNewChat = React.useCallback(() => {
    // Single-in-flight guard is enforced in the hook (Req 1.3); this early-out
    // just avoids a no-op call when creation is impossible/busy.
    if (!canCreate || isCreating || newChatAccountId === null) return;
    void (async () => {
      const conversationId = await create(newChatAccountId);
      if (conversationId !== null) onCreated?.(conversationId);
    })();
  }, [canCreate, isCreating, newChatAccountId, create, onCreated]);

  const handleCommitRename = React.useCallback(
    (id: string, value: string) => {
      // decideRename applies the SAME accept/reject rule the hook enforces:
      // non-empty after trim → PATCH with the trimmed title (Req 11.2); empty
      // after trim → discard, send nothing (Req 11.6).
      const decision = decideRename(value);
      if (decision.accept) void rename(id, decision.title);
      setEditingId(null);
    },
    [rename],
  );

  const handleCancelRename = React.useCallback(() => setEditingId(null), []);

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center justify-between px-1">
        <span className="text-[0.65rem] font-semibold tracking-[0.2em] text-muted-foreground uppercase">
          Conversations
        </span>
        <button
          type="button"
          onClick={handleNewChat}
          disabled={!canCreate || isCreating}
          title={
            hasAccounts
              ? "Start a new chat"
              : "Connect an account to start a chat"
          }
          aria-label="New chat"
          className="inline-flex items-center gap-1 text-[0.65rem] font-semibold tracking-widest text-muted-foreground uppercase transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none"
        >
          <HugeiconsIcon
            icon={isCreating ? Loading03Icon : PlusSignIcon}
            className={cn(
              "size-3.5",
              isCreating && "animate-spin motion-reduce:animate-none",
            )}
          />
          New
        </button>
      </div>

      {/* Zero-account connect affordance (Req 1.8): the "New" control above is
          disabled; this points the user at the accounts wizard. */}
      {!hasAccounts ? (
        <Link
          href="/accounts"
          className="flex items-center gap-2 border border-dashed border-border px-3 py-2 text-xs text-muted-foreground transition-colors duration-200 hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
        >
          <HugeiconsIcon icon={PlusSignIcon} className="size-3.5 shrink-0" />
          Connect an account to start a chat
        </Link>
      ) : null}

      <nav
        aria-label="Conversations"
        className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto"
      >
        {conversations.length > 0 ? (
          conversations.map((conversation) => (
            <ConversationRow
              key={conversation.conversationId}
              conversation={conversation}
              active={conversation.conversationId === activeConversationId}
              isEditing={editingId === conversation.conversationId}
              onStartRename={() => setEditingId(conversation.conversationId)}
              onCommitRename={handleCommitRename}
              onCancelRename={handleCancelRename}
            />
          ))
        ) : (
          <p className="px-3 py-2 text-sm text-muted-foreground">
            No conversations yet.
          </p>
        )}
      </nav>
    </section>
  );
}

interface ConversationRowProps {
  conversation: ConversationListItem;
  active: boolean;
  isEditing: boolean;
  onStartRename: () => void;
  onCommitRename: (id: string, value: string) => void;
  onCancelRename: () => void;
}

/**
 * A single conversation row. Three visual modes:
 *  - `titleSource: "pending"` → a skeleton shimmer bar in place of the title
 *    (Req 10.1);
 *  - editing → an inline text field pre-filled + focused, max 100 chars
 *    (Req 11.1); Enter commits (Req 11.2 / empty-discard Req 11.6), Escape
 *    cancels (Req 11.3), blur cancels;
 *  - otherwise → a link to `/chat/<conversationId>` with the active-state left
 *    border, plus a rename affordance.
 */
function ConversationRow({
  conversation,
  active,
  isEditing,
  onStartRename,
  onCommitRename,
  onCancelRename,
}: ConversationRowProps) {
  const { conversationId, title, titleSource } = conversation;
  const isPending = titleSource === "pending";
  const href = `/chat/${conversationId}`;
  // A pending row shows a readable "New Chat" default until the AI-generated
  // summary lands after the first prompt (Req 10.1); a non-pending row with an
  // empty title falls back to the generic label.
  const displayTitle = isPending
    ? NEW_CHAT_TITLE
    : title.trim().length > 0
      ? title
      : FALLBACK_TITLE;

  if (isEditing) {
    return (
      <div className="border-l-2 border-primary bg-muted px-3 py-1.5">
        <RenameField
          initialTitle={title}
          onCommit={(value) => onCommitRename(conversationId, value)}
          onCancel={onCancelRename}
        />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group/row flex items-center gap-2 border-l-2 pr-1 transition-colors duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
        active
          ? "border-primary bg-muted text-foreground"
          : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground",
      )}
    >
      <Link
        href={href}
        aria-current={active ? "page" : undefined}
        className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <HugeiconsIcon
          icon={Message01Icon}
          className="size-4 shrink-0 text-muted-foreground"
        />
        <span
          className={cn("truncate", isPending && "text-muted-foreground")}
          aria-busy={isPending ? "true" : undefined}
        >
          {displayTitle}
        </span>
      </Link>

      {/* Rename affordance — hidden until the row is hovered/focused to keep the
          list quiet, but always keyboard-reachable. Disabled while pending. */}
      {!isPending ? (
        <button
          type="button"
          onClick={onStartRename}
          aria-label={`Rename conversation: ${displayTitle}`}
          title="Rename"
          className="inline-flex size-6 shrink-0 items-center justify-center text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/row:opacity-100 motion-reduce:transition-none"
        >
          <HugeiconsIcon icon={Edit02Icon} className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

interface RenameFieldProps {
  initialTitle: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}

/**
 * The inline editable title field (Req 11.1–11.3, 11.6). Pre-filled with the
 * current title, focused (and its text selected) on mount, capped at 100 chars.
 * Enter commits, Escape cancels, blur cancels. Empty-after-trim on commit is
 * handled by the caller via {@link decideRename} (send nothing — Req 11.6).
 */
function RenameField({ initialTitle, onCommit, onCancel }: RenameFieldProps) {
  const [value, setValue] = React.useState(initialTitle);
  // Select the pre-filled text once, the first time the field is focused, so
  // the user can immediately overtype the current title (Req 11.1).
  const selectedOnceRef = React.useRef(false);

  return (
    <Input
      // Focus the field as soon as it mounts on entering rename mode (Req 11.1).
      // `autoFocus` is reliable here because the field only ever mounts in
      // response to the user activating rename.
      autoFocus
      value={value}
      maxLength={RENAME_MAX_LENGTH}
      aria-label="Conversation title"
      onFocus={(event) => {
        if (selectedOnceRef.current) return;
        selectedOnceRef.current = true;
        event.currentTarget.select();
      }}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onCommit(value);
        } else if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
      onBlur={onCancel}
      className="h-7 border-b-input text-sm"
    />
  );
}
