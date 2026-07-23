// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConversationRecord } from "@/lib/history/conversations";
import type { StoredMessage } from "@/lib/history/messages";
// The title helpers are PURE (no server-only / AWS deps) — import the REAL
// implementations so expected values are computed exactly as the route does.
import { fallbackTitle, normalizeTitle } from "@/lib/title";

/**
 * Unit tests for the AI conversation-title route
 * (`app/app/api/conversations/[id]/title/route.ts`) — `POST`.
 *
 * ## What is REAL vs. FAKED
 *
 * - **REAL:** the route handler under test runs its actual guard / no-op /
 *   first-prompt-sourcing / retry / fallback / persistence wiring, AND the pure
 *   `@/lib/title` helpers (`normalizeTitle`, `fallbackTitle`) run for real so
 *   assertions compare against their genuine output.
 * - **FAKED:** every side-effecting boundary the route imports — `@/lib/auth`
 *   (`auth`, controls the session), `@/lib/history/conversations`
 *   (`getConversationOwned` / `renameConversation`, DynamoDB spies),
 *   `@/lib/history/messages` (`listMessages`), and `@/lib/aws/bedrock`
 *   (`generateTitle`, a `vi.fn` that scripts the success/throw sequence).
 * - **GUARDED:** `@/lib/aws/agentcore` (`invokeAgentRuntime`) is mocked as a
 *   `vi.fn` purely so the tests can assert the title route NEVER touches the
 *   AgentCore runtime — titles use only the direct Bedrock Converse path
 *   (Req 10.9).
 *
 * Covers Req 10.1 (title derived server-side for a pending conversation),
 * 10.4 (idempotent no-op for a non-pending title — model NOT invoked),
 * 10.5 (AI title persisted with source "ai"), 10.6 (EXACTLY one retry),
 * 10.7 (fallback persisted so the conversation is never left pending), and
 * 10.9 (bedrock-runtime only — AgentCore runtime never invoked).
 */

// ---------------------------------------------------------------------------
// Mocked boundaries (hoisted so `vi.mock` factories can reference them).
// ---------------------------------------------------------------------------
const {
  authMock,
  getConversationOwnedMock,
  renameConversationMock,
  listMessagesMock,
  generateTitleMock,
  invokeAgentRuntimeMock,
  MissingTitleModelConfigError,
} = vi.hoisted(() => {
  class MissingTitleModelConfigError extends Error {
    constructor() {
      super("Missing required environment variable: CBA_TITLE_MODEL_ID");
      this.name = "MissingTitleModelConfigError";
    }
  }
  return {
    authMock: vi.fn(),
    getConversationOwnedMock: vi.fn(),
    renameConversationMock: vi.fn(),
    listMessagesMock: vi.fn(),
    generateTitleMock: vi.fn(),
    invokeAgentRuntimeMock: vi.fn(),
    MissingTitleModelConfigError,
  };
});

vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/lib/history/conversations", () => ({
  getConversationOwned: getConversationOwnedMock,
  renameConversation: renameConversationMock,
}));
vi.mock("@/lib/history/messages", () => ({ listMessages: listMessagesMock }));
vi.mock("@/lib/aws/bedrock", () => ({ generateTitle: generateTitleMock }));
// Mocked ONLY to prove the title route never invokes the AgentCore runtime.
vi.mock("@/lib/aws/agentcore", () => ({
  invokeAgentRuntime: invokeAgentRuntimeMock,
}));

import { POST } from "./route";

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------
const USER_ID = "user_owner_1";
const CONVERSATION_ID = "conv_1";
const FIRST_PROMPT = "How much did I spend on EC2 in June?";

/** Authenticate as the given user, or `null` for an unauthenticated request. */
function signInAs(userId: string | null): void {
  authMock.mockResolvedValue(userId === null ? null : { user: { id: userId } });
}

/** A conversation record fixture as returned by the store. */
function conversationRecord(
  overrides: Partial<ConversationRecord> = {},
): ConversationRecord {
  return {
    conversationId: CONVERSATION_ID,
    title: "",
    titleSource: "pending",
    accountId: "acct_owned_1",
    sessionId: `sess_${"a".repeat(35)}`,
    createdAt: "2026-06-01T12:00:00.000Z",
    updatedAt: "2026-06-01T12:05:00.000Z",
    messageCount: 4,
    ...overrides,
  };
}

/** A stored user message fixture (only role/content matter to the route). */
function userMessage(content: string): StoredMessage {
  return {
    id: `MSG#2026-06-01T12:00:01.000Z#uuid`,
    userId: USER_ID,
    role: "user",
    content,
    charts: [],
    reports: [],
    createdAt: "2026-06-01T12:00:01.000Z",
  };
}

/** A `POST` request carrying a JSON `{ firstPrompt }` body. */
function postWithBody(firstPrompt: string): Request {
  return new Request(
    `http://localhost/api/conversations/${CONVERSATION_ID}/title`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ firstPrompt }),
    },
  );
}

/** A `POST` request with NO body (drives the `listMessages` sourcing path). */
function postWithoutBody(): Request {
  return new Request(
    `http://localhost/api/conversations/${CONVERSATION_ID}/title`,
    { method: "POST" },
  );
}

/** The dynamic-route context — `params` is a Promise in this Next version. */
function routeContext(id: string = CONVERSATION_ID): {
  params: Promise<{ id: string }>;
} {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  signInAs(USER_ID);
});

// ---------------------------------------------------------------------------
// Req 10.4 — idempotent no-op for a non-pending title: NO rename, model NOT
// invoked, whether the existing title came from the user or a prior AI run.
// ---------------------------------------------------------------------------
describe("title route — idempotent no-op for non-pending (Req 10.4)", () => {
  it("returns 200 and makes NO rename / NO generateTitle for a user-sourced title", async () => {
    getConversationOwnedMock.mockResolvedValue(
      conversationRecord({ title: "My renamed thread", titleSource: "user" }),
    );

    const response = await POST(postWithBody(FIRST_PROMPT), routeContext());

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      title?: string;
      titleSource?: string;
    };
    expect(body).toEqual({ title: "My renamed thread", titleSource: "user" });

    expect(generateTitleMock).not.toHaveBeenCalled();
    expect(renameConversationMock).not.toHaveBeenCalled();
    // Never invokes the AgentCore runtime (Req 10.9).
    expect(invokeAgentRuntimeMock).not.toHaveBeenCalled();
  });

  it("returns 200 and makes NO rename / NO generateTitle for an already-ai title", async () => {
    getConversationOwnedMock.mockResolvedValue(
      conversationRecord({ title: "June EC2 spend", titleSource: "ai" }),
    );

    const response = await POST(postWithBody(FIRST_PROMPT), routeContext());

    expect(response.status).toBe(200);
    expect(generateTitleMock).not.toHaveBeenCalled();
    expect(renameConversationMock).not.toHaveBeenCalled();
    expect(invokeAgentRuntimeMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Req 10.1, 10.5 — a pending conversation gets an AI title persisted with
// source "ai", normalized via the real normalizeTitle.
// ---------------------------------------------------------------------------
describe("title route — ai-source persistence (Req 10.1, 10.5)", () => {
  it("persists normalizeTitle(result) with source \"ai\" when generateTitle succeeds", async () => {
    getConversationOwnedMock.mockResolvedValue(
      conversationRecord({ titleSource: "pending" }),
    );
    // A raw completion the model might return (quoted + trailing punctuation).
    const rawModelTitle = '"June EC2 Spend Overview"';
    generateTitleMock.mockResolvedValue(rawModelTitle);

    const response = await POST(postWithBody(FIRST_PROMPT), routeContext());

    expect(response.status).toBe(200);
    const expectedTitle = normalizeTitle(rawModelTitle);
    const body = (await response.json()) as {
      title?: string;
      titleSource?: string;
    };
    expect(body).toEqual({ title: expectedTitle, titleSource: "ai" });

    expect(generateTitleMock).toHaveBeenCalledTimes(1);
    expect(generateTitleMock).toHaveBeenCalledWith(FIRST_PROMPT);
    expect(renameConversationMock).toHaveBeenCalledTimes(1);
    expect(renameConversationMock).toHaveBeenCalledWith(
      USER_ID,
      CONVERSATION_ID,
      expectedTitle,
      "ai",
    );
    expect(invokeAgentRuntimeMock).not.toHaveBeenCalled();
  });

  it("sources the first prompt from listMessages when the body omits it", async () => {
    getConversationOwnedMock.mockResolvedValue(
      conversationRecord({ titleSource: "pending" }),
    );
    listMessagesMock.mockResolvedValue([
      userMessage(FIRST_PROMPT),
      userMessage("a later user turn"),
    ]);
    generateTitleMock.mockResolvedValue("June EC2 Spend");

    const response = await POST(postWithoutBody(), routeContext());

    expect(response.status).toBe(200);
    expect(listMessagesMock).toHaveBeenCalledWith(USER_ID, CONVERSATION_ID);
    // The FIRST user message content is what gets summarized.
    expect(generateTitleMock).toHaveBeenCalledWith(FIRST_PROMPT);
    expect(renameConversationMock).toHaveBeenCalledWith(
      USER_ID,
      CONVERSATION_ID,
      normalizeTitle("June EC2 Spend"),
      "ai",
    );
    expect(invokeAgentRuntimeMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Req 10.6 — EXACTLY one retry: throw once, then succeed → 2 calls, ai title.
// ---------------------------------------------------------------------------
describe("title route — single retry (Req 10.6)", () => {
  it("retries generateTitle exactly once then persists the (normalized) success", async () => {
    getConversationOwnedMock.mockResolvedValue(
      conversationRecord({ titleSource: "pending" }),
    );
    generateTitleMock
      .mockRejectedValueOnce(new Error("transient converse failure"))
      .mockResolvedValueOnce("Some Title");

    const response = await POST(postWithBody(FIRST_PROMPT), routeContext());

    expect(response.status).toBe(200);
    // Called exactly twice: initial attempt + one retry.
    expect(generateTitleMock).toHaveBeenCalledTimes(2);
    expect(renameConversationMock).toHaveBeenCalledTimes(1);
    expect(renameConversationMock).toHaveBeenCalledWith(
      USER_ID,
      CONVERSATION_ID,
      normalizeTitle("Some Title"),
      "ai",
    );
    expect(invokeAgentRuntimeMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Req 10.7 — fallback on the second failure: never left pending; the fallback
// title is persisted with source "ai".
// ---------------------------------------------------------------------------
describe("title route — fallback after both attempts fail (Req 10.7)", () => {
  it("persists fallbackTitle(firstPrompt) with source \"ai\" when generateTitle throws twice", async () => {
    getConversationOwnedMock.mockResolvedValue(
      conversationRecord({ titleSource: "pending" }),
    );
    generateTitleMock
      .mockRejectedValueOnce(new Error("failure 1"))
      .mockRejectedValueOnce(new Error("failure 2"));

    const response = await POST(postWithBody(FIRST_PROMPT), routeContext());

    expect(response.status).toBe(200);
    expect(generateTitleMock).toHaveBeenCalledTimes(2);

    const expectedFallback = fallbackTitle(FIRST_PROMPT);
    const body = (await response.json()) as {
      title?: string;
      titleSource?: string;
    };
    // Never left pending — persisted as "ai" with the derived fallback title.
    expect(body).toEqual({ title: expectedFallback, titleSource: "ai" });
    expect(renameConversationMock).toHaveBeenCalledTimes(1);
    expect(renameConversationMock).toHaveBeenCalledWith(
      USER_ID,
      CONVERSATION_ID,
      expectedFallback,
      "ai",
    );
    expect(invokeAgentRuntimeMock).not.toHaveBeenCalled();
  });

  it("falls back when the model id is missing (MissingTitleModelConfigError)", async () => {
    getConversationOwnedMock.mockResolvedValue(
      conversationRecord({ titleSource: "pending" }),
    );
    // Both the initial attempt and the retry throw the config error (Req 12.4).
    generateTitleMock.mockRejectedValue(new MissingTitleModelConfigError());

    const response = await POST(postWithBody(FIRST_PROMPT), routeContext());

    expect(response.status).toBe(200);
    expect(generateTitleMock).toHaveBeenCalledTimes(2);

    const expectedFallback = fallbackTitle(FIRST_PROMPT);
    expect(renameConversationMock).toHaveBeenCalledTimes(1);
    expect(renameConversationMock).toHaveBeenCalledWith(
      USER_ID,
      CONVERSATION_ID,
      expectedFallback,
      "ai",
    );
    expect(invokeAgentRuntimeMock).not.toHaveBeenCalled();
  });
});
