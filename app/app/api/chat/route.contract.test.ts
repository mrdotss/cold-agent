// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Client/relay CONTRACT test — the RELAY half (task 3.4, Req 3.7).
 *
 * Companion to the CLIENT half in `app/hooks/useAgentStream.contract.test.ts`.
 * Where that file pins what `useAgentStream` SENDS (`{ conversationId, prompt }`,
 * Req 3.6), this file pins what `POST /api/chat` ACCEPTS: its zod body schema
 * requires a `conversationId` string and a `prompt` string, rejects a body
 * missing either with a typed 400 error, and does so WITHOUT invoking the
 * AgentCore runtime (Req 3.7).
 *
 * This runs in the NODE environment (the route handler reaches Postgres/crypto
 * on the Node runtime), separate from the jsdom client half — hence two files.
 *
 * ## What is REAL vs FAKED
 * The route handler + its real zod schema run for real. The side-effecting
 * boundaries are faked so validation is the only thing under test:
 * - `@/lib/auth` — a signed-in session so body validation is REACHED (auth runs
 *   before body parse; an unauthenticated request would 401 before the schema).
 * - `@/lib/aws/agentcore` (`invokeAgentRuntime`) — a spy we assert is NEVER
 *   called on a rejected body.
 * - `@/lib/history/conversations` (`getConversationOwned`) — lets us prove a
 *   VALID body passes the schema by advancing to the ownership gate (→ 404).
 * - `@/lib/history/messages`, `@/lib/db`, `@/lib/crypto` — inert stubs so the
 *   module imports cleanly.
 */

const {
  authMock,
  invokeAgentRuntimeMock,
  getConversationOwnedMock,
  appendMessageMock,
  getDbMock,
  decryptSecretMock,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  invokeAgentRuntimeMock: vi.fn(),
  getConversationOwnedMock: vi.fn(),
  appendMessageMock: vi.fn(),
  getDbMock: vi.fn(),
  decryptSecretMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/lib/aws/agentcore", () => ({ invokeAgentRuntime: invokeAgentRuntimeMock }));
vi.mock("@/lib/history/conversations", () => ({
  getConversationOwned: getConversationOwnedMock,
}));
vi.mock("@/lib/history/messages", () => ({ appendMessage: appendMessageMock }));
vi.mock("@/lib/db", () => ({ getDb: getDbMock }));
vi.mock("@/lib/crypto", () => ({ decryptSecret: decryptSecretMock }));
// NOTE: `@/lib/aws/sse` and `@/lib/invocation-context` are intentionally REAL
// (pure, client-safe) — they are not on the validation path here.

import { POST } from "./route";

const USER_ID = "user_contract_1";

/** A `POST /api/chat` request carrying a JSON body. */
function chatRequest(body: unknown): Request {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Signed in so validation is REACHED (auth runs before the body is parsed).
  authMock.mockResolvedValue({ user: { id: USER_ID } });
});

describe("POST /api/chat zod schema rejects a body missing a field (Req 3.7)", () => {
  it("rejects a body missing conversationId with a typed 400 and does not invoke the runtime", async () => {
    const response = await POST(chatRequest({ prompt: "hi" }));

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: unknown };
    expect(typeof body.error).toBe("string");

    // Rejected before the ownership gate and before any invocation.
    expect(getConversationOwnedMock).not.toHaveBeenCalled();
    expect(invokeAgentRuntimeMock).not.toHaveBeenCalled();
  });

  it("rejects a body missing prompt with a typed 400 and does not invoke the runtime", async () => {
    const response = await POST(chatRequest({ conversationId: "c1" }));

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: unknown };
    expect(typeof body.error).toBe("string");

    expect(getConversationOwnedMock).not.toHaveBeenCalled();
    expect(invokeAgentRuntimeMock).not.toHaveBeenCalled();
  });

  it("rejects empty-string conversationId/prompt (min(1)) with a 400 and no invoke", async () => {
    const emptyConversation = await POST(
      chatRequest({ conversationId: "", prompt: "hi" }),
    );
    expect(emptyConversation.status).toBe(400);

    const emptyPrompt = await POST(
      chatRequest({ conversationId: "c1", prompt: "" }),
    );
    expect(emptyPrompt.status).toBe(400);

    expect(invokeAgentRuntimeMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/chat zod schema accepts { conversationId, prompt } (Req 3.7)", () => {
  it("passes validation for a valid body (advances past the schema to the ownership gate, not a 400)", async () => {
    // A valid body clears the schema; let the ownership gate resolve to a
    // not-owned/missing conversation (404) to PROVE the body was accepted —
    // the response is not a schema 400.
    getConversationOwnedMock.mockResolvedValue(null);

    const response = await POST(
      chatRequest({ conversationId: "c1", prompt: "hi" }),
    );

    // Not a schema rejection: it got past body validation.
    expect(response.status).not.toBe(400);
    expect(response.status).toBe(404);

    // The ownership gate was reached with the parsed fields, and no runtime
    // invocation happened (a not-owned conversation never invokes).
    expect(getConversationOwnedMock).toHaveBeenCalledWith(USER_ID, "c1");
    expect(invokeAgentRuntimeMock).not.toHaveBeenCalled();
  });
});
