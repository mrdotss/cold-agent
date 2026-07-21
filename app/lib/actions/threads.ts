"use server";

import { randomUUID } from "node:crypto";

import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  connectedAccounts,
  messages,
  threads,
  type MessageRole,
} from "@/lib/db/schema";
import { newSessionId } from "@/lib/session-id";

/**
 * Thread & message server actions / reads (Req 8).
 *
 * A "thread" is one saved chat conversation. At creation it PINS a connected
 * account for its entire lifetime (immutable `connected_account_id`) and is
 * assigned a stable 33–128 char runtime `session_id` (one-to-one with the
 * thread, UNIQUE, never reassigned) so the agent's memory follows the
 * conversation (Req 8.1, 8.3, 8.4).
 *
 * ## Boundaries honored here
 *  - Every export resolves the current user via `auth()`; an unauthenticated
 *    caller is treated as having no threads/messages (creation is rejected,
 *    reads return `null`/`[]`) rather than throwing a raw error.
 *  - Reads are strictly OWNERSHIP-CHECKED: a thread the caller does not own is
 *    indistinguishable from one that does not exist — the row (and its
 *    `session_id`) is never exposed (Req 8.7).
 *  - Callers only ever receive a MINIMAL {@link ThreadView} that excludes the
 *    runtime `session_id` and secret account fields. The chat relay (task 12)
 *    resolves the `session_id` server-side directly from the row.
 *
 * `"use server"` marks every export as a server action; the module only ever
 * runs server-side and safely imports the `server-only` db/auth modules.
 */

// ---------------------------------------------------------------------------
// Public shapes (browser-safe; never carry session_id or account secrets)
// ---------------------------------------------------------------------------

/**
 * Browser-safe projection of a thread. Deliberately EXCLUDES the runtime
 * `session_id` (resolved server-side only) and carries only the pinned
 * connected-account id (an opaque application id, not a secret) plus display
 * metadata.
 */
export type ThreadView = {
  /** Stable thread id (opaque application id). */
  id: string;
  /** The pinned connected-account id, fixed for the thread's lifetime. */
  connectedAccountId: string;
  /** Optional user-facing title (null until set). */
  title: string | null;
  /** Creation timestamp. */
  createdAt: Date;
};

/** Browser-safe projection of a message (no secrets; safe to render). */
export type MessageView = {
  id: string;
  threadId: string;
  role: MessageRole;
  content: string;
  createdAt: Date;
};

/** Raw, unvalidated input accepted by {@link createThread}. */
export interface CreateThreadInput {
  connectedAccountId: string;
}

/** Result of a {@link createThread} call (never throws for expected outcomes). */
export type CreateThreadResult =
  | { ok: true; thread: ThreadView }
  | { ok: false; message: string };

/** zod schema for {@link createThread} input (non-empty account id). */
const createThreadSchema = z.object({
  connectedAccountId: z.string().min(1),
});

/** Map a full thread row to its browser-safe {@link ThreadView}. */
function toThreadView(row: {
  id: string;
  connectedAccountId: string;
  title: string | null;
  createdAt: Date;
}): ThreadView {
  return {
    id: row.id,
    connectedAccountId: row.connectedAccountId,
    title: row.title,
    createdAt: row.createdAt,
  };
}

/**
 * Create a new chat thread for the authenticated user (Req 8.1–8.4, 8.8).
 *
 * Steps:
 *  1. Require an authenticated user; otherwise reject (persist nothing).
 *  2. Validate `connectedAccountId` and verify the account EXISTS and BELONGS to
 *     this user. If the user has zero connected accounts — or the given id is
 *     missing / not owned — reject creation with a "connect an account first"
 *     message and persist NO thread or session id (Req 8.2).
 *  3. Generate a stable `session_id` via {@link newSessionId} (length 33..128)
 *     and insert exactly one thread row pinning the account (Req 8.3, 8.4).
 *
 * Returns a typed result (never throws for expected outcomes) and only ever
 * surfaces the minimal {@link ThreadView} (no `session_id`).
 */
export async function createThread(
  input: CreateThreadInput,
): Promise<CreateThreadResult> {
  const session = await auth();
  const userId = session?.user?.id;
  if (typeof userId !== "string" || userId.length === 0) {
    return { ok: false, message: "You must be signed in to start a chat." };
  }

  const parsed = createThreadSchema.safeParse(input);
  if (!parsed.success) {
    // A missing/blank account id is handled the same as "no account": at least
    // one connected account is required (Req 8.2).
    return {
      ok: false,
      message: "Connect at least one AWS account to start a chat.",
    };
  }

  const db = getDb();

  // Verify the account exists AND is owned by this user (Req 8.1, 8.2). This
  // single ownership-scoped lookup also covers the zero-accounts case: a user
  // with no accounts can never match, so creation is rejected.
  const [account] = await db
    .select({ id: connectedAccounts.id })
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.id, parsed.data.connectedAccountId),
        eq(connectedAccounts.userId, userId),
      ),
    )
    .limit(1);

  if (account === undefined) {
    return {
      ok: false,
      message: "Connect at least one AWS account to start a chat.",
    };
  }

  // Persist exactly one thread pinning the account, with a stable session id
  // (Req 8.3, 8.4). The session id is generated once here and never updated.
  const id = randomUUID();
  const sessionId = newSessionId();
  const [created] = await db
    .insert(threads)
    .values({
      id,
      userId,
      connectedAccountId: account.id,
      sessionId,
    })
    .returning({
      id: threads.id,
      connectedAccountId: threads.connectedAccountId,
      title: threads.title,
      createdAt: threads.createdAt,
    });

  if (created === undefined) {
    return { ok: false, message: "Could not create the chat. Please retry." };
  }

  return { ok: true, thread: toThreadView(created) };
}

/**
 * Fetch a single thread the caller OWNS (Req 8.7).
 *
 * Returns the minimal {@link ThreadView} when the thread exists and belongs to
 * the authenticated user, or `null` when the caller is unauthenticated, the
 * thread does not exist, or it belongs to another user. A non-owned thread is
 * indistinguishable from a missing one and its `session_id`/row is never
 * exposed.
 */
export async function getThread(threadId: string): Promise<ThreadView | null> {
  const session = await auth();
  const userId = session?.user?.id;
  if (typeof userId !== "string" || userId.length === 0) {
    return null;
  }
  if (typeof threadId !== "string" || threadId.length === 0) {
    return null;
  }

  const db = getDb();
  const [row] = await db
    .select({
      id: threads.id,
      connectedAccountId: threads.connectedAccountId,
      title: threads.title,
      createdAt: threads.createdAt,
    })
    .from(threads)
    .where(and(eq(threads.id, threadId), eq(threads.userId, userId)))
    .limit(1);

  return row === undefined ? null : toThreadView(row);
}

/**
 * Read the messages of a thread the caller OWNS, ordered by `created_at`
 * ascending (oldest first) (Req 8.5, 8.6, 8.7).
 *
 * Returns:
 *  - an ordered {@link MessageView} array for an owned thread (an empty array
 *    for an owned thread with no messages — no error, Req 8.6); or
 *  - `null` when the caller is unauthenticated, the thread does not exist, or it
 *    belongs to another user (access denied; no messages/`session_id` leaked,
 *    Req 8.7).
 */
export async function getThreadMessages(
  threadId: string,
): Promise<MessageView[] | null> {
  const session = await auth();
  const userId = session?.user?.id;
  if (typeof userId !== "string" || userId.length === 0) {
    return null;
  }
  if (typeof threadId !== "string" || threadId.length === 0) {
    return null;
  }

  const db = getDb();

  // Ownership gate: confirm the thread exists and belongs to this user before
  // returning any messages (Req 8.7).
  const [owned] = await db
    .select({ id: threads.id })
    .from(threads)
    .where(and(eq(threads.id, threadId), eq(threads.userId, userId)))
    .limit(1);

  if (owned === undefined) {
    return null;
  }

  // Owned: return messages oldest-first. An empty thread yields `[]` (Req 8.6).
  const rows = await db
    .select({
      id: messages.id,
      threadId: messages.threadId,
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.threadId, threadId))
    .orderBy(asc(messages.createdAt));

  return rows;
}

/**
 * List the authenticated user's threads, newest first (Req 8.8, 8.9).
 *
 * Scoped strictly to the current user; an unauthenticated caller receives an
 * empty list. Only minimal {@link ThreadView}s are returned (no `session_id`).
 */
export async function listThreads(): Promise<ThreadView[]> {
  const session = await auth();
  const userId = session?.user?.id;
  if (typeof userId !== "string" || userId.length === 0) {
    return [];
  }

  const db = getDb();
  const rows = await db
    .select({
      id: threads.id,
      connectedAccountId: threads.connectedAccountId,
      title: threads.title,
      createdAt: threads.createdAt,
    })
    .from(threads)
    .where(eq(threads.userId, userId))
    .orderBy(asc(threads.createdAt));

  return rows.map(toThreadView);
}
