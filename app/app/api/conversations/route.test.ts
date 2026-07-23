// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConnectedAccountView } from "@/lib/db/views";
import type { ConversationRecord } from "@/lib/history/conversations";

/**
 * Unit tests for the conversations collection route
 * (`app/app/api/conversations/route.ts`) — `GET` (list) + `POST` (create).
 *
 * ## What is REAL vs. FAKED
 *
 * - **REAL:** the route handlers under test run their actual guard/validation/
 *   wiring logic, including the zod body schema and the account-ownership check
 *   that verifies the named `accountId` is present in the user's owned accounts.
 * - **FAKED:** every side-effecting boundary the route imports — `@/lib/auth`
 *   (`auth`, controls the session), `@/lib/history/conversations`
 *   (`createConversation` / `listConversations`, DynamoDB store spies), and
 *   `@/lib/actions/accounts` (`listConnectedAccounts`, the Postgres ownership
 *   source). No DynamoDB or Postgres is ever touched.
 *
 * Covers Req 7.2 (auth-guard, 401 before any store access), 7.5 (zod-validate
 * before any store access), 8.1 (create one conversation for an owned account),
 * 8.2 (reject an unowned/zero-account create), and 8.3 (list most-recent-first).
 */

// ---------------------------------------------------------------------------
// Mocked boundaries (hoisted so `vi.mock` factories can reference them).
// ---------------------------------------------------------------------------
const {
  authMock,
  createConversationMock,
  listConversationsMock,
  listConnectedAccountsMock,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  createConversationMock: vi.fn(),
  listConversationsMock: vi.fn(),
  listConnectedAccountsMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/lib/history/conversations", () => ({
  createConversation: createConversationMock,
  listConversations: listConversationsMock,
}));
vi.mock("@/lib/actions/accounts", () => ({
  listConnectedAccounts: listConnectedAccountsMock,
}));

import { GET, POST } from "./route";

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------
const USER_ID = "user_owner_1";
const OWNED_ACCOUNT_ID = "acct_owned_1";

/** Authenticate as the given user, or `null` for an unauthenticated request. */
function signInAs(userId: string | null): void {
  authMock.mockResolvedValue(userId === null ? null : { user: { id: userId } });
}

/** A browser-safe account view fixture (only `id` matters for ownership). */
function accountView(id: string): ConnectedAccountView {
  return {
    id,
    alias: `alias-${id}`,
    maskedAccountId: "••••1234",
    displayCurrency: "USD",
    timezone: "America/New_York",
  };
}

/** A conversation record fixture as returned by the store. */
function conversationRecord(
  overrides: Partial<ConversationRecord> = {},
): ConversationRecord {
  return {
    conversationId: "conv_1",
    title: "June spend",
    titleSource: "ai",
    accountId: OWNED_ACCOUNT_ID,
    sessionId: `sess_${"a".repeat(35)}`,
    createdAt: "2026-06-01T12:00:00.000Z",
    updatedAt: "2026-06-01T12:05:00.000Z",
    messageCount: 4,
    ...overrides,
  };
}

/** A `POST /api/conversations` request with a JSON body. */
function postRequest(body: unknown): Request {
  return new Request("http://localhost/api/conversations", {
    method: "POST",
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
describe("conversations collection — auth guard (Req 7.2)", () => {
  it("GET returns 401 and never queries the store when unauthenticated", async () => {
    signInAs(null);

    const response = await GET();

    expect(response.status).toBe(401);
    expect(listConversationsMock).not.toHaveBeenCalled();
  });

  it("POST returns 401 and touches no store when unauthenticated", async () => {
    signInAs(null);

    const response = await POST(postRequest({ accountId: OWNED_ACCOUNT_ID }));

    expect(response.status).toBe(401);
    expect(listConnectedAccountsMock).not.toHaveBeenCalled();
    expect(createConversationMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Req 7.5 — zod-validate the POST body BEFORE any store access.
// ---------------------------------------------------------------------------
describe("conversations collection — POST body validation (Req 7.5)", () => {
  it("returns 400 for a missing accountId and never touches the store", async () => {
    signInAs(USER_ID);

    const response = await POST(postRequest({}));

    expect(response.status).toBe(400);
    expect(listConnectedAccountsMock).not.toHaveBeenCalled();
    expect(createConversationMock).not.toHaveBeenCalled();
  });

  it("returns 400 for an empty accountId and never touches the store", async () => {
    signInAs(USER_ID);

    const response = await POST(postRequest({ accountId: "" }));

    expect(response.status).toBe(400);
    expect(listConnectedAccountsMock).not.toHaveBeenCalled();
    expect(createConversationMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Req 8.1 — create one conversation pinned to an owned account → 201.
// ---------------------------------------------------------------------------
describe("conversations collection — POST create happy path (Req 8.1)", () => {
  it("returns 201 { conversationId } and creates the conversation for the owned account", async () => {
    signInAs(USER_ID);
    listConnectedAccountsMock.mockResolvedValue([
      accountView("acct_other"),
      accountView(OWNED_ACCOUNT_ID),
    ]);
    createConversationMock.mockResolvedValue(
      conversationRecord({ conversationId: "conv_new", titleSource: "pending" }),
    );

    const response = await POST(postRequest({ accountId: OWNED_ACCOUNT_ID }));

    expect(response.status).toBe(201);
    const body = (await response.json()) as { conversationId?: string };
    expect(body.conversationId).toBe("conv_new");

    // Created exactly once, pinned to the session user + named account (Req 7.1, 8.1).
    expect(createConversationMock).toHaveBeenCalledTimes(1);
    expect(createConversationMock).toHaveBeenCalledWith(USER_ID, OWNED_ACCOUNT_ID);
  });
});

// ---------------------------------------------------------------------------
// Req 8.2 — reject a create for an unowned account or zero accounts.
// ---------------------------------------------------------------------------
describe("conversations collection — POST account-ownership rejection (Req 8.2)", () => {
  it("returns 400 and creates nothing when the accountId is not owned", async () => {
    signInAs(USER_ID);
    listConnectedAccountsMock.mockResolvedValue([accountView("acct_other")]);

    const response = await POST(postRequest({ accountId: OWNED_ACCOUNT_ID }));

    expect(response.status).toBe(400);
    expect(createConversationMock).not.toHaveBeenCalled();
  });

  it("returns 400 and creates nothing when the user owns zero accounts", async () => {
    signInAs(USER_ID);
    listConnectedAccountsMock.mockResolvedValue([]);

    const response = await POST(postRequest({ accountId: OWNED_ACCOUNT_ID }));

    expect(response.status).toBe(400);
    expect(createConversationMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Req 8.3 — list the user's conversations, most-recently-updated first.
// ---------------------------------------------------------------------------
describe("conversations collection — GET list happy path (Req 8.3)", () => {
  it("returns 200 with the user's conversations in store order (most-recent-first)", async () => {
    signInAs(USER_ID);
    const recent = conversationRecord({
      conversationId: "conv_recent",
      updatedAt: "2026-06-02T09:00:00.000Z",
    });
    const older = conversationRecord({
      conversationId: "conv_older",
      updatedAt: "2026-06-01T09:00:00.000Z",
    });
    // The store returns them already sorted most-recent-first (GSI1 desc).
    listConversationsMock.mockResolvedValue([recent, older]);

    const response = await GET();

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      conversations: ConversationRecord[];
    };
    expect(body.conversations.map((c) => c.conversationId)).toEqual([
      "conv_recent",
      "conv_older",
    ]);

    // Listed for exactly the session user (Req 7.1).
    expect(listConversationsMock).toHaveBeenCalledTimes(1);
    expect(listConversationsMock).toHaveBeenCalledWith(USER_ID);
  });
});
