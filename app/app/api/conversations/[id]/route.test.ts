// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConversationRecord } from "@/lib/history/conversations";
import type { StoredMessage } from "@/lib/history/messages";

/**
 * Unit tests for the per-conversation route
 * (`app/app/api/conversations/[id]/route.ts`) — `GET` (messages + metadata),
 * `PATCH` (rename), `DELETE` (remove).
 *
 * ## What is REAL vs. FAKED
 *
 * - **REAL:** the route handlers under test run their actual auth guard,
 *   ownership gate ordering, the PATCH zod title schema, and their response
 *   shaping.
 * - **FAKED:** every side-effecting boundary the route imports — `@/lib/auth`
 *   (`auth`, controls the session), `@/lib/history/conversations`
 *   (`getConversationOwned` / `renameConversation` / `deleteConversation`,
 *   DynamoDB store spies), and `@/lib/history/messages` (`listMessages`). No
 *   DynamoDB is ever touched.
 *
 * Covers Req 7.2 (auth-guard 401 before any store access), 7.3 (not-owned/absent
 * → bare 404 leaking nothing), 7.5 (zod-validate before any store access), 8.4
 * (get messages oldest-first with charts), 8.5 (rename with titleSource "user"),
 * and 8.6 (delete the conversation).
 */

// ---------------------------------------------------------------------------
// Mocked boundaries (hoisted so `vi.mock` factories can reference them).
// ---------------------------------------------------------------------------
const {
  authMock,
  getConversationOwnedMock,
  renameConversationMock,
  deleteConversationMock,
  listMessagesMock,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  getConversationOwnedMock: vi.fn(),
  renameConversationMock: vi.fn(),
  deleteConversationMock: vi.fn(),
  listMessagesMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/lib/history/conversations", () => ({
  getConversationOwned: getConversationOwnedMock,
  renameConversation: renameConversationMock,
  deleteConversation: deleteConversationMock,
}));
vi.mock("@/lib/history/messages", () => ({ listMessages: listMessagesMock }));

import { DELETE, GET, PATCH } from "./route";

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------
const USER_ID = "user_owner_1";
const CONV_ID = "conv_1";
const SESSION_ID = `sess_${"a".repeat(35)}`;

/** Authenticate as the given user, or `null` for an unauthenticated request. */
function signInAs(userId: string | null): void {
  authMock.mockResolvedValue(userId === null ? null : { user: { id: userId } });
}

/** The dynamic-route context: `params` is a Promise in this Next version. */
function ctx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

/** A conversation record fixture as returned by the store. */
function conversationRecord(
  overrides: Partial<ConversationRecord> = {},
): ConversationRecord {
  return {
    conversationId: CONV_ID,
    title: "June spend",
    titleSource: "ai",
    accountId: "acct_owned_1",
    sessionId: SESSION_ID,
    createdAt: "2026-06-01T12:00:00.000Z",
    updatedAt: "2026-06-01T12:05:00.000Z",
    messageCount: 2,
    ...overrides,
  };
}

/** A stored message fixture (carries its `id`, `charts`, `reports`). */
function storedMessage(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: "MSG#2026-06-01T12:00:00.000Z#uuid-1",
    userId: USER_ID,
    role: "assistant",
    content: "Here is your spend.",
    charts: [],
    reports: [],
    createdAt: "2026-06-01T12:00:00.000Z",
    ...overrides,
  };
}

/** A `PATCH /api/conversations/[id]` request with a JSON body. */
function patchRequest(body: unknown): Request {
  return new Request(`http://localhost/api/conversations/${CONV_ID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Req 7.2 — auth guard: unauthenticated callers rejected BEFORE any store.
// ---------------------------------------------------------------------------
describe("per-conversation route — auth guard (Req 7.2)", () => {
  it("GET returns 401 and never reads the store when unauthenticated", async () => {
    signInAs(null);

    const response = await GET(new Request("http://localhost"), ctx(CONV_ID));

    expect(response.status).toBe(401);
    expect(getConversationOwnedMock).not.toHaveBeenCalled();
    expect(listMessagesMock).not.toHaveBeenCalled();
  });

  it("PATCH returns 401 and never reads/writes the store when unauthenticated", async () => {
    signInAs(null);

    const response = await PATCH(patchRequest({ title: "New title" }), ctx(CONV_ID));

    expect(response.status).toBe(401);
    expect(getConversationOwnedMock).not.toHaveBeenCalled();
    expect(renameConversationMock).not.toHaveBeenCalled();
  });

  it("DELETE returns 401 and never reads/writes the store when unauthenticated", async () => {
    signInAs(null);

    const response = await DELETE(new Request("http://localhost"), ctx(CONV_ID));

    expect(response.status).toBe(401);
    expect(getConversationOwnedMock).not.toHaveBeenCalled();
    expect(deleteConversationMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Req 7.3 — not-owned/absent conversation → bare 404 that leaks nothing.
// ---------------------------------------------------------------------------
describe("per-conversation route — ownership gate (Req 7.3)", () => {
  it("GET returns 404 and lists no messages for a not-owned/absent conversation", async () => {
    signInAs(USER_ID);
    getConversationOwnedMock.mockResolvedValue(null);

    const response = await GET(new Request("http://localhost"), ctx(CONV_ID));

    expect(response.status).toBe(404);
    expect(listMessagesMock).not.toHaveBeenCalled();

    // Leaks no conversation attribute — only a bare error string.
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["error"]);
    expect(JSON.stringify(body)).not.toContain(SESSION_ID);
  });

  it("PATCH returns 404 and renames nothing for a not-owned/absent conversation", async () => {
    signInAs(USER_ID);
    getConversationOwnedMock.mockResolvedValue(null);

    const response = await PATCH(patchRequest({ title: "New title" }), ctx(CONV_ID));

    expect(response.status).toBe(404);
    expect(renameConversationMock).not.toHaveBeenCalled();
  });

  it("DELETE returns 404 and deletes nothing for a not-owned/absent conversation", async () => {
    signInAs(USER_ID);
    getConversationOwnedMock.mockResolvedValue(null);

    const response = await DELETE(new Request("http://localhost"), ctx(CONV_ID));

    expect(response.status).toBe(404);
    expect(deleteConversationMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Req 7.5 — PATCH zod-validates the title BEFORE any store access.
// ---------------------------------------------------------------------------
describe("per-conversation route — PATCH title validation (Req 7.5)", () => {
  it("returns 400 for a whitespace-only title and never touches the store", async () => {
    signInAs(USER_ID);

    const response = await PATCH(patchRequest({ title: "   " }), ctx(CONV_ID));

    expect(response.status).toBe(400);
    expect(getConversationOwnedMock).not.toHaveBeenCalled();
    expect(renameConversationMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a title over 100 chars and never touches the store", async () => {
    signInAs(USER_ID);

    const response = await PATCH(
      patchRequest({ title: "x".repeat(101) }),
      ctx(CONV_ID),
    );

    expect(response.status).toBe(400);
    expect(getConversationOwnedMock).not.toHaveBeenCalled();
    expect(renameConversationMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a missing title and never touches the store", async () => {
    signInAs(USER_ID);

    const response = await PATCH(patchRequest({}), ctx(CONV_ID));

    expect(response.status).toBe(400);
    expect(getConversationOwnedMock).not.toHaveBeenCalled();
    expect(renameConversationMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Req 8.4 — GET returns the owned conversation's messages (oldest-first,
// including persisted charts) plus the conversation metadata.
// ---------------------------------------------------------------------------
describe("per-conversation route — GET happy path (Req 8.4)", () => {
  it("returns 200 with metadata and the store's messages (oldest-first, incl. charts)", async () => {
    signInAs(USER_ID);
    getConversationOwnedMock.mockResolvedValue(conversationRecord());

    const oldest = storedMessage({
      id: "MSG#2026-06-01T12:00:00.000Z#uuid-1",
      role: "user",
      content: "Scan June spend",
      createdAt: "2026-06-01T12:00:00.000Z",
    });
    const newer = storedMessage({
      id: "MSG#2026-06-01T12:00:05.000Z#uuid-2",
      role: "assistant",
      content: "Top services this month:",
      charts: [
        {
          id: "c1",
          chart_type: "bar",
          title: "Top 5 Services",
          currency: "USD",
          labels: ["EC2", "S3"],
          values: [100, 50],
        },
      ],
      createdAt: "2026-06-01T12:00:05.000Z",
    });
    // The store returns messages oldest-first (ascending SK).
    listMessagesMock.mockResolvedValue([oldest, newer]);

    const response = await GET(new Request("http://localhost"), ctx(CONV_ID));

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      conversation: {
        conversationId: string;
        title: string;
        titleSource: string;
        accountId: string;
        messageCount: number;
      };
      messages: StoredMessage[];
    };

    // Metadata for client hydration (sessionId is NOT exposed).
    expect(body.conversation).toEqual({
      conversationId: CONV_ID,
      title: "June spend",
      titleSource: "ai",
      accountId: "acct_owned_1",
      messageCount: 2,
    });
    expect(JSON.stringify(body.conversation)).not.toContain(SESSION_ID);

    // Messages preserved oldest-first with their persisted charts.
    expect(body.messages.map((m) => m.id)).toEqual([oldest.id, newer.id]);
    expect(body.messages[1].charts).toHaveLength(1);
    expect(body.messages[1].charts[0].chart_type).toBe("bar");

    expect(listMessagesMock).toHaveBeenCalledWith(USER_ID, CONV_ID);
  });
});

// ---------------------------------------------------------------------------
// Req 8.5 — PATCH renames an owned conversation with titleSource "user".
// ---------------------------------------------------------------------------
describe("per-conversation route — PATCH happy path (Req 8.5)", () => {
  it("returns 200 and renames with titleSource \"user\" (trimmed title)", async () => {
    signInAs(USER_ID);
    getConversationOwnedMock.mockResolvedValue(conversationRecord());
    renameConversationMock.mockResolvedValue(undefined);

    const response = await PATCH(
      patchRequest({ title: "  My renamed thread  " }),
      ctx(CONV_ID),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      title?: string;
      titleSource?: string;
    };
    expect(body.title).toBe("My renamed thread");
    expect(body.titleSource).toBe("user");

    // Persisted for the session user with the trimmed title and "user" source.
    expect(renameConversationMock).toHaveBeenCalledTimes(1);
    expect(renameConversationMock).toHaveBeenCalledWith(
      USER_ID,
      CONV_ID,
      "My renamed thread",
      "user",
    );
  });
});

// ---------------------------------------------------------------------------
// Req 8.6 — DELETE removes an owned conversation.
// ---------------------------------------------------------------------------
describe("per-conversation route — DELETE happy path (Req 8.6)", () => {
  it("returns 200 { success: true } and deletes the owned conversation", async () => {
    signInAs(USER_ID);
    getConversationOwnedMock.mockResolvedValue(conversationRecord());
    deleteConversationMock.mockResolvedValue(undefined);

    const response = await DELETE(new Request("http://localhost"), ctx(CONV_ID));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { success?: boolean };
    expect(body.success).toBe(true);

    expect(deleteConversationMock).toHaveBeenCalledTimes(1);
    expect(deleteConversationMock).toHaveBeenCalledWith(USER_ID, CONV_ID);
  });
});
