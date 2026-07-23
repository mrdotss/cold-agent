"use client";

/**
 * Client-side conversation-list state + optimistic operations for the sidebar.
 *
 * This hook owns the conversation list the sidebar renders and the optimistic
 * create / rename / delete flows that keep it snappy (Req 1, Req 11). The
 * optimistic list transitions are isolated in PURE, exported helpers
 * (`insertPlaceholder`, `reconcileCreated`, `rollbackPlaceholder`,
 * `applyRename`, `rollbackRename`) so they can be property-tested independently
 * of React and the network (task 13.2) — list in, list out, never mutating the
 * input.
 *
 * IMPORTANT: this is a CLIENT module. It must NOT import the server-only
 * conversation store (`lib/history/conversations.ts`, which is
 * `import "server-only"`). Instead it defines its own {@link ConversationListItem}
 * client mirror of the fields the UI needs and talks to the API over `fetch`:
 *   - `GET  /api/conversations`         → `{ conversations: ConversationRecord[] }`
 *   - `POST /api/conversations`         → `{ conversationId }`  (body `{ accountId }`)
 *   - `PATCH /api/conversations/[id]`   → `{ title, titleSource }` (body `{ title }`)
 *   - `DELETE /api/conversations/[id]`  → `{ success }`
 *
 * Implements Requirement 1 (optimistic create without reload) and the sidebar
 * half of Requirement 11 (editable titles) from the
 * cloud-bill-analyst-web-iteration-2 spec.
 */

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Client-safe mirror of the server's `ConversationRecord` — only the fields the
 * sidebar needs. The server-only `sessionId` is deliberately omitted (it never
 * needs to reach the browser). A `pending` placeholder row carries
 * `titleSource: "pending"` plus `pending: true` and a temporary client-side
 * `conversationId` so the list can render a skeleton shimmer while the create
 * request is in flight (Req 1.1, consumed by task 13.3).
 */
export interface ConversationListItem {
  conversationId: string;
  title: string;
  titleSource: "pending" | "ai" | "user";
  accountId: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  /** True only for an optimistic placeholder awaiting its persisted row. */
  pending?: boolean;
}

// ---------------------------------------------------------------------------
// Pure state-transition helpers (property-tested in task 13.2)
//
// Each takes a list and returns a NEW list; none mutate their input or any of
// its elements. They are exported so the property tests can exercise them
// directly, with no React or network involved.
// ---------------------------------------------------------------------------

/**
 * Insert an optimistic placeholder row at the TOP of the list (Req 1.1).
 * Returns a new array; the input list and its rows are untouched.
 */
export function insertPlaceholder(
  list: ConversationListItem[],
  placeholder: ConversationListItem,
): ConversationListItem[] {
  return [placeholder, ...list];
}

/**
 * Remove the optimistic placeholder identified by `placeholderId`, leaving the
 * rest of the list unchanged (Req 1.6). This is the exact inverse of
 * {@link insertPlaceholder} for a freshly inserted placeholder whose temporary
 * id is unique, so `rollbackPlaceholder(insertPlaceholder(list, p), p.id)`
 * restores `list`.
 */
export function rollbackPlaceholder(
  list: ConversationListItem[],
  placeholderId: string,
): ConversationListItem[] {
  return list.filter((row) => row.conversationId !== placeholderId);
}

/**
 * Reconcile the optimistic placeholder with the persisted conversation so the
 * list contains EXACTLY ONE row for the created conversation (Req 1.5).
 *
 * The placeholder (matched by its temporary id) is removed and replaced with
 * `persisted`, inserted at the placeholder's former position (or the top if the
 * placeholder is already gone). Any pre-existing row that already carries the
 * persisted `conversationId` — e.g. one a concurrent revalidate slipped in — is
 * dropped first, so reconciling is idempotent and can never leave a duplicate.
 */
export function reconcileCreated(
  list: ConversationListItem[],
  placeholderId: string,
  persisted: ConversationListItem,
): ConversationListItem[] {
  const placeholderIndex = list.findIndex(
    (row) => row.conversationId === placeholderId,
  );

  // Drop the placeholder AND any existing duplicate of the persisted row.
  const withoutPlaceholderOrDuplicate = list.filter(
    (row) =>
      row.conversationId !== placeholderId &&
      row.conversationId !== persisted.conversationId,
  );

  const insertAt =
    placeholderIndex === -1
      ? 0
      : Math.min(placeholderIndex, withoutPlaceholderOrDuplicate.length);

  return [
    ...withoutPlaceholderOrDuplicate.slice(0, insertAt),
    persisted,
    ...withoutPlaceholderOrDuplicate.slice(insertAt),
  ];
}

/**
 * Optimistically apply a rename to the row identified by `id` (Req 11.2). Only
 * the `title` is changed; `titleSource` is intentionally left untouched so a
 * failed rename can be reverted by restoring the title alone (see
 * {@link rollbackRename}). The row's persisted `titleSource: "user"` is applied
 * from the PATCH response once the request succeeds.
 */
export function applyRename(
  list: ConversationListItem[],
  id: string,
  title: string,
): ConversationListItem[] {
  return list.map((row) =>
    row.conversationId === id ? { ...row, title } : row,
  );
}

/**
 * Restore a row's previous title after a failed rename (Req 11.7). Because
 * {@link applyRename} changes only the title, restoring `prevTitle` fully
 * reverts the optimistic edit.
 */
export function rollbackRename(
  list: ConversationListItem[],
  id: string,
  prevTitle: string,
): ConversationListItem[] {
  return list.map((row) =>
    row.conversationId === id ? { ...row, title: prevTitle } : row,
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** A generic, secret-free message surfaced when a network call fails. */
const CREATE_ERROR_MESSAGE = "Could not start a new conversation. Please try again.";
const RENAME_ERROR_MESSAGE = "Could not rename the conversation. Please try again.";
const DELETE_ERROR_MESSAGE = "Could not delete the conversation. Please try again.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Mint a unique client-side temporary id for an optimistic placeholder. */
function tempConversationId(): string {
  const rand =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `pending-${rand}`;
}

/**
 * Project a raw API conversation payload into a client {@link ConversationListItem},
 * dropping the server-only `sessionId` and any other extra fields. Returns
 * `null` for a payload missing the fields the UI needs.
 */
function toListItem(value: unknown): ConversationListItem | null {
  if (!isRecord(value)) return null;
  const { conversationId, title, titleSource, accountId, createdAt, updatedAt } =
    value;
  if (
    typeof conversationId !== "string" ||
    typeof title !== "string" ||
    (titleSource !== "pending" && titleSource !== "ai" && titleSource !== "user") ||
    typeof accountId !== "string" ||
    typeof createdAt !== "string" ||
    typeof updatedAt !== "string"
  ) {
    return null;
  }
  return {
    conversationId,
    title,
    titleSource,
    accountId,
    createdAt,
    updatedAt,
    messageCount:
      typeof value.messageCount === "number" ? value.messageCount : 0,
  };
}

/**
 * Merge a freshly revalidated server list with the local list, preserving any
 * still-in-flight placeholder rows the server does not yet know about so a
 * background revalidate never yanks a pending "New" row out from under the user
 * (Req 1.7). The server list is authoritative for every persisted row.
 */
function mergeRevalidated(
  local: ConversationListItem[],
  server: ConversationListItem[],
): ConversationListItem[] {
  const serverIds = new Set(server.map((row) => row.conversationId));
  const stillPending = local.filter(
    (row) => row.pending === true && !serverIds.has(row.conversationId),
  );
  return [...stillPending, ...server];
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/** Options accepted by {@link useConversations}. */
export interface UseConversationsOptions {
  /** Seed the list (e.g. from a server component) to avoid an initial flash. */
  initialConversations?: ConversationListItem[];
  /**
   * Called with a redacted, user-facing message whenever an operation fails and
   * rolls back. The toast UI itself lives in task 13.3; this hook only surfaces
   * the signal (via this callback and the `error` field).
   */
  onError?: (message: string) => void;
}

/** What {@link useConversations} exposes to the sidebar. */
export interface UseConversations {
  /** The conversation list, most-recently-updated first (placeholders on top). */
  conversations: ConversationListItem[];
  /** True during the initial (or a manual) list load. */
  isLoading: boolean;
  /**
   * True from the instant a create starts until it settles. Flips back to false
   * IMMEDIATELY on settle (before the background revalidate finishes) so the
   * "New" control returns to idle within 200 ms and is never stuck spinning
   * (Req 1.2). Also gates the single-in-flight create guard (Req 1.3).
   */
  isCreating: boolean;
  /** The last redacted error message, or `null`. Cleared by `clearError`. */
  error: string | null;
  /** Clear the current `error` signal. */
  clearError: () => void;
  /** Re-fetch the list from the server (Req 1.7). */
  revalidate: () => Promise<void>;
  /**
   * Optimistically create a conversation pinned to `accountId`: insert a
   * placeholder at the top, POST, reconcile to exactly one persisted row on
   * success (or roll back on failure), then always revalidate (Req 1.1, 1.5,
   * 1.6, 1.7). Enforces a single in-flight create (Req 1.3). Resolves with the
   * new `conversationId` on success, or `null` on failure / when a create is
   * already in flight.
   */
  create: (accountId: string) => Promise<string | null>;
  /**
   * Optimistically rename `id` to `title`, PATCH, and roll back on failure
   * (Req 11.2, 11.7). A blank-after-trim title is ignored (Req 11.6 — the field
   * UX also guards this in task 13.3).
   */
  rename: (id: string, title: string) => Promise<void>;
  /** Optimistically remove `id`, DELETE, and roll back on failure (Req 8.6). */
  remove: (id: string) => Promise<void>;
}

/**
 * React hook driving the conversation sidebar's list + optimistic operations.
 */
export function useConversations(
  options: UseConversationsOptions = {},
): UseConversations {
  const { initialConversations, onError } = options;

  const [conversations, setConversations] = useState<ConversationListItem[]>(
    initialConversations ?? [],
  );
  const [isLoading, setIsLoading] = useState(initialConversations === undefined);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Single-in-flight create guard. A ref (not state) so the lock takes effect
  // SYNCHRONOUSLY at the top of `create`, closing the window where a rapid
  // double-click or StrictMode double-invoke could fire a second create before
  // a re-render flips `isCreating` (Req 1.3).
  const creatingRef = useRef(false);

  // Mirror the latest list in a ref so `rename`/`remove` can snapshot the prior
  // state for rollback without adding it to their `useCallback` deps (keeping
  // the callbacks stable) and without reading state inside a functional update.
  const conversationsRef = useRef(conversations);
  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  // Keep the latest onError in a ref so callbacks stay stable across renders.
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const surfaceError = useCallback((message: string) => {
    setError(message);
    onErrorRef.current?.(message);
  }, []);

  const clearError = useCallback(() => setError(null), []);

  const revalidate = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch("/api/conversations", { method: "GET" });
      if (!res.ok) return;
      const data: unknown = await res.json();
      if (!isRecord(data) || !Array.isArray(data.conversations)) return;
      const server = data.conversations
        .map(toListItem)
        .filter((row): row is ConversationListItem => row !== null);
      setConversations((current) => mergeRevalidated(current, server));
    } catch {
      // Revalidate is best-effort; a failure leaves the current list in place.
    }
  }, []);

  // Initial load unless the caller seeded the list.
  useEffect(() => {
    if (initialConversations !== undefined) return;
    let cancelled = false;
    void (async () => {
      await revalidate();
      if (!cancelled) setIsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [initialConversations, revalidate]);

  // Revalidate when another part of the app signals a server-side change to the
  // conversation list — e.g. the chat page firing after the first turn once its
  // AI title has been generated (Req 10.2, 10.8). Decoupled via a window event
  // so the chat page can refresh the sidebar without shared state or a full
  // reload; `mergeRevalidated` preserves any in-flight optimistic placeholder.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onRefresh = () => {
      void revalidate();
    };
    window.addEventListener("conversations:refresh", onRefresh);
    return () => window.removeEventListener("conversations:refresh", onRefresh);
  }, [revalidate]);

  const create = useCallback(
    async (accountId: string): Promise<string | null> => {
      // (0) Single-in-flight guard (Req 1.3): ignore a second concurrent create.
      if (creatingRef.current) return null;
      creatingRef.current = true;
      setIsCreating(true);

      const tempId = tempConversationId();
      const now = new Date().toISOString();
      const placeholder: ConversationListItem = {
        conversationId: tempId,
        title: "",
        titleSource: "pending",
        accountId,
        createdAt: now,
        updatedAt: now,
        messageCount: 0,
        pending: true,
      };

      // (1) Optimistic placeholder at the top (Req 1.1).
      setConversations((list) => insertPlaceholder(list, placeholder));

      let createdId: string | null = null;
      try {
        const res = await fetch("/api/conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accountId }),
        });
        if (!res.ok) throw new Error("create failed");

        const data: unknown = await res.json();
        if (!isRecord(data) || typeof data.conversationId !== "string") {
          throw new Error("malformed create response");
        }
        createdId = data.conversationId;

        // (2) Reconcile the placeholder to EXACTLY ONE persisted row (Req 1.5).
        const persisted: ConversationListItem = {
          conversationId: data.conversationId,
          title: "",
          titleSource: "pending",
          accountId,
          createdAt: now,
          updatedAt: now,
          messageCount: 0,
        };
        setConversations((list) =>
          reconcileCreated(list, tempId, persisted),
        );
      } catch {
        // (3) Roll back the placeholder, surface an error, leave the rest as-is
        // (Req 1.6).
        setConversations((list) => rollbackPlaceholder(list, tempId));
        surfaceError(CREATE_ERROR_MESSAGE);
        createdId = null;
      } finally {
        // (4) Return "New" to idle IMMEDIATELY on settle (Req 1.2)…
        creatingRef.current = false;
        setIsCreating(false);
        // …then ALWAYS revalidate in the background (Req 1.7) without blocking
        // the idle transition.
        void revalidate();
      }

      return createdId;
    },
    [revalidate, surfaceError],
  );

  const rename = useCallback(
    async (id: string, title: string): Promise<void> => {
      const trimmed = title.trim();
      // A blank-after-trim title sends no request (Req 11.6).
      if (trimmed.length === 0) return;

      const previous = conversationsRef.current.find(
        (row) => row.conversationId === id,
      );
      if (previous === undefined) return;
      const prevTitle = previous.title;

      // Optimistic title update (Req 11.2).
      setConversations((list) => applyRename(list, id, trimmed));

      try {
        const res = await fetch(
          `/api/conversations/${encodeURIComponent(id)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: trimmed }),
          },
        );
        if (!res.ok) throw new Error("rename failed");

        const data: unknown = await res.json();
        const nextTitle =
          isRecord(data) && typeof data.title === "string"
            ? data.title
            : trimmed;
        const nextSource =
          isRecord(data) &&
          (data.titleSource === "user" ||
            data.titleSource === "ai" ||
            data.titleSource === "pending")
            ? (data.titleSource as ConversationListItem["titleSource"])
            : "user";
        setConversations((list) =>
          list.map((row) =>
            row.conversationId === id
              ? { ...row, title: nextTitle, titleSource: nextSource }
              : row,
          ),
        );
      } catch {
        // Restore the previously displayed title + surface an error (Req 11.7).
        setConversations((list) => rollbackRename(list, id, prevTitle));
        surfaceError(RENAME_ERROR_MESSAGE);
      }
    },
    [surfaceError],
  );

  const remove = useCallback(
    async (id: string): Promise<void> => {
      // Snapshot for rollback before the optimistic removal.
      const snapshot = conversationsRef.current;

      // Optimistic removal (Req 8.6).
      setConversations((list) =>
        list.filter((row) => row.conversationId !== id),
      );

      try {
        const res = await fetch(
          `/api/conversations/${encodeURIComponent(id)}`,
          { method: "DELETE" },
        );
        if (!res.ok) throw new Error("delete failed");
      } catch {
        // Restore the list and surface an error, keeping state consistent.
        setConversations(snapshot);
        surfaceError(DELETE_ERROR_MESSAGE);
      }
    },
    [surfaceError],
  );

  return {
    conversations,
    isLoading,
    isCreating,
    error,
    clearError,
    revalidate,
    create,
    rename,
    remove,
  };
}
