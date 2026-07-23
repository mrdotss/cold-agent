// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit tests for the message-feedback route — `PATCH`/`POST`
 * `/api/conversations/[id]/messages/[messageId]/feedback` (Req 14.2, 14.3, 14.5).
 *
 * ## Scope & environment
 *
 * These run in the **node** environment (see the `@vitest-environment node`
 * docblock): the code under test is a server-side App Router handler that gates
 * on the session and reaches DynamoDB via `server-only` libs, so there is no DOM
 * rendering here.
 *
 * ## What is REAL vs. FAKED
 *
 * - **REAL:** the route handler itself (`PATCH`/`POST` → `handleFeedback`) — the
 *   auth → zod → ownership gate ordering, the `zod` enum body validation, and the
 *   `decodeURIComponent` of the `[messageId]` path segment before the write.
 * - **FAKED:** every side-effecting boundary — `@/lib/auth` (`auth`, controls the
 *   signed-in user), `@/lib/history/conversations` (`getConversationOwned`, the
 *   ownership gate) and `@/lib/history/messages` (`setMessageFeedback`, the single
 *   DynamoDB write path). No real AWS/DynamoDB is ever touched (hermetic).
 *
 * The assertions prove the guardrails: an invalid body is a 400 that never
 * touches DynamoDB (Req 14.2); an owner's submit issues the feedback write with
 * the DECODED `MSG#…` sort key (Req 14.2, 14.5); unauthenticated is 401 and
 * non-owner is 404, each writing nothing (Req 14.3).
 */

// Mocked boundaries (hoisted so `vi.mock` factories can reference them).
const { authMock, getConversationOwnedMock, setMessageFeedbackMock } =
  vi.hoisted(() => ({
    authMock: vi.fn(),
    getConversationOwnedMock: vi.fn(),
    setMessageFeedbackMock: vi.fn(),
  }));

vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/lib/history/conversations", () => ({
  getConversationOwned: getConversationOwnedMock,
}));
vi.mock("@/lib/history/messages", () => ({
  setMessageFeedback: setMessageFeedbackMock,
}));

import { PATCH, POST } from "./route";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_ID = "user_owner_1";
const CONV_ID = "11111111-1111-4111-8111-111111111111";

/** The message's `MSG#<createdAtIso>#<uuid>` sort key, before URL-encoding. */
const MESSAGE_SK = "MSG#2026-06-01T12:00:00.000Z#abc-123";
/** How the client sends it in the path (`#` → `%23`, `:` → `%3A`). */
const MESSAGE_ID_ENCODED = encodeURIComponent(MESSAGE_SK);

/** A minimal owned-conversation record returned by the ownership gate. */
const OWNED_CONVERSATION = { id: CONV_ID, userId: USER_ID };

/** Authenticate as the given user (or unauthenticate with `null`). */
function signInAs(userId: string | null): void {
  authMock.mockResolvedValue(userId === null ? null : { user: { id: userId } });
}

/** Build a feedback request with a JSON body (matching the route contract). */
function feedbackRequest(body: unknown): Request {
  return new Request(
    `http://localhost/api/conversations/${CONV_ID}/messages/${MESSAGE_ID_ENCODED}/feedback`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

/** The `context` arg the App Router passes: `params` is a Promise. */
function paramsContext(messageId: string = MESSAGE_ID_ENCODED) {
  return { params: Promise.resolve({ id: CONV_ID, messageId }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// The route exports PATCH and POST with identical behavior; run the shared cases
// against both verbs.
const handlers: Array<[string, typeof PATCH]> = [
  ["PATCH", PATCH],
  ["POST", POST],
];

describe.each(handlers)(
  "%s /api/conversations/[id]/messages/[messageId]/feedback",
  (_verb, handler) => {
    // -----------------------------------------------------------------------
    // Unauthenticated → 401, no DynamoDB access (Req 14.3)
    // -----------------------------------------------------------------------
    it("returns 401 for an unauthenticated caller and writes nothing", async () => {
      signInAs(null);

      const res = await handler(feedbackRequest({ feedback: "up" }), paramsContext());

      expect(res.status).toBe(401);
      // No ownership check and no feedback write on the unauth path.
      expect(getConversationOwnedMock).not.toHaveBeenCalled();
      expect(setMessageFeedbackMock).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // Invalid body → 400 BEFORE any DynamoDB access (Req 14.2)
    // -----------------------------------------------------------------------
    it("rejects a feedback value other than up/down with 400 and never touches DynamoDB", async () => {
      signInAs(USER_ID);

      const res = await handler(
        feedbackRequest({ feedback: "sideways" }),
        paramsContext(),
      );

      expect(res.status).toBe(400);
      // zod rejects before the ownership gate and the write (Req 14.2).
      expect(getConversationOwnedMock).not.toHaveBeenCalled();
      expect(setMessageFeedbackMock).not.toHaveBeenCalled();
    });

    it("rejects a missing feedback field with 400 and never touches DynamoDB", async () => {
      signInAs(USER_ID);

      const res = await handler(feedbackRequest({}), paramsContext());

      expect(res.status).toBe(400);
      expect(getConversationOwnedMock).not.toHaveBeenCalled();
      expect(setMessageFeedbackMock).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // Non-owner → 404, no write (Req 14.3)
    // -----------------------------------------------------------------------
    it("returns 404 when the user does not own the conversation and writes nothing", async () => {
      signInAs(USER_ID);
      getConversationOwnedMock.mockResolvedValue(null);

      const res = await handler(
        feedbackRequest({ feedback: "down" }),
        paramsContext(),
      );

      expect(res.status).toBe(404);
      // Ownership was checked, but the feedback write never ran (Req 14.3).
      expect(getConversationOwnedMock).toHaveBeenCalledWith(USER_ID, CONV_ID);
      expect(setMessageFeedbackMock).not.toHaveBeenCalled();
    });
  },
);

// ---------------------------------------------------------------------------
// Owner happy path — the single feedback write with the DECODED SK
// (Req 14.2, 14.5). Asserted per verb to confirm both behave identically.
// ---------------------------------------------------------------------------
describe.each(handlers)(
  "%s — owner submit issues the feedback write",
  (_verb, handler) => {
    it.each(["up", "down"] as const)(
      "writes feedback=%s for an owned conversation using the decoded MSG# sort key",
      async (feedback) => {
        signInAs(USER_ID);
        getConversationOwnedMock.mockResolvedValue(OWNED_CONVERSATION);
        setMessageFeedbackMock.mockResolvedValue(undefined);

        const res = await handler(
          feedbackRequest({ feedback }),
          paramsContext(),
        );

        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({ ok: true });

        // Ownership gate ran first.
        expect(getConversationOwnedMock).toHaveBeenCalledWith(USER_ID, CONV_ID);

        // The single Message_Feedback write was issued with (userId, id, DECODED
        // messageSk, feedback). The URL-encoded "%23" must be decoded back to
        // the "MSG#…" sort key before it reaches DynamoDB (Req 14.2, 14.5).
        expect(setMessageFeedbackMock).toHaveBeenCalledTimes(1);
        expect(setMessageFeedbackMock).toHaveBeenCalledWith(
          USER_ID,
          CONV_ID,
          MESSAGE_SK,
          feedback,
        );
        // Guard against passing the still-encoded segment through by mistake.
        const [, , passedSk] = setMessageFeedbackMock.mock.calls[0];
        expect(passedSk).toBe(MESSAGE_SK);
        expect(passedSk).not.toContain("%23");
      },
    );
  },
);
