import "@/test/dom-polyfills";
import "@testing-library/jest-dom/vitest";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import type { ChartSpec } from "@/lib/aws/sse";
import type { ChatMessage } from "@/components/chat";

/**
 * Unit tests for the conversation hydration page
 * `app/app/(app)/chat/[id]/page.tsx` (task 12.2; Req 9.4, 9.5, 9.6).
 *
 * ## Approach (documented per the task)
 *
 * The page is an async SERVER component: it `auth()`s, ownership-gates the
 * conversation via `getConversationOwned`, `Promise.all([listMessages,
 * listConnectedAccounts])`, projects the persisted `StoredMessage[]` to
 * `ChatMessage[]` (id/role/content/charts/reports/feedback), seeds suggestions,
 * and renders `<ChatView …>`. `ChatView` is a client component that owns a
 * `fetch`-driven stream hook, so we do NOT exercise it here.
 *
 * Instead we FAKE every boundary the page imports and replace `@/components/chat`
 * with a lightweight `ChatView` stub that (a) records the props it received —
 * so we can assert the persisted transcript reached it as `initialMessages` —
 * and (b) renders each `initialMessages[i].charts` through the REAL
 * `ChartInline`, so we can assert persisted charts actually hydrate into that
 * component (Req 9.6). A zero-message conversation is rendered by the stub as an
 * empty-state marker, mirroring `ChatView`'s intro-empty behavior (Req 9.5).
 *
 * We then invoke the server component directly
 * (`await Page({ params: Promise.resolve({ id }) })`) and `render` its returned
 * element. This validates the hydration mapping end-to-end without depending on
 * the real streaming client or on Recharts' SVG internals.
 *
 * ## What is REAL vs. FAKED
 *
 * - **REAL:** the page handler's own load/projection logic, and `ChartInline`
 *   (imported un-mocked inside the `ChatView` stub) so persisted charts render.
 * - **FAKED:** `@/lib/auth` (session), `@/lib/history/conversations`
 *   (ownership gate), `@/lib/history/messages` (transcript), `@/lib/actions/accounts`
 *   (Postgres account list), `@/lib/suggestions` (deterministic `[]`),
 *   `next/navigation` (`notFound`/`redirect`), and `@/components/chat`
 *   (the `ChatView` stub). No DynamoDB / Postgres / network is touched.
 */

// ---------------------------------------------------------------------------
// Mocked boundaries (hoisted so `vi.mock` factories can reference them).
// ---------------------------------------------------------------------------
const {
  authMock,
  getConversationOwnedMock,
  listMessagesMock,
  listConnectedAccountsMock,
  generateSuggestionsMock,
  notFoundMock,
  redirectMock,
  lastChatViewProps,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  getConversationOwnedMock: vi.fn(),
  listMessagesMock: vi.fn(),
  listConnectedAccountsMock: vi.fn(),
  generateSuggestionsMock: vi.fn(),
  notFoundMock: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  redirectMock: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
  lastChatViewProps: { current: null as null | Record<string, unknown> },
}));

vi.mock("next/navigation", () => ({
  notFound: notFoundMock,
  redirect: redirectMock,
}));
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/lib/history/conversations", () => ({
  getConversationOwned: getConversationOwnedMock,
}));
vi.mock("@/lib/history/messages", () => ({
  listMessages: listMessagesMock,
}));
vi.mock("@/lib/actions/accounts", () => ({
  listConnectedAccounts: listConnectedAccountsMock,
}));
vi.mock("@/lib/suggestions", () => ({
  generateSuggestions: generateSuggestionsMock,
}));

// Replace the chat barrel with a stub ChatView that records its props and
// renders persisted charts via the REAL ChartInline (Req 9.6).
vi.mock("@/components/chat", async () => {
  const React = await import("react");
  const { ChartInline } = await import("@/components/chat/chart-inline");

  function ChatView(props: Record<string, unknown>) {
    lastChatViewProps.current = props;
    const messages = (props.initialMessages as ChatMessage[]) ?? [];

    if (messages.length === 0) {
      // Mirror ChatView's intro empty-state for a zero-message conversation:
      // it renders WITHOUT surfacing an error (Req 9.5).
      return React.createElement(
        "div",
        { "data-testid": "chat-view-stub" },
        React.createElement("div", { "data-testid": "empty-chat" }, "Empty conversation"),
      );
    }

    return React.createElement(
      "div",
      { "data-testid": "chat-view-stub" },
      messages.map((message) =>
        React.createElement(
          "div",
          { key: message.id, "data-testid": `msg-${message.id}` },
          React.createElement("p", null, message.content),
          (message.charts ?? []).map((spec) =>
            React.createElement(ChartInline, { key: spec.id, spec }),
          ),
        ),
      ),
    );
  }

  return { ChatView };
});

import Page from "./page";

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------
const USER_ID = "user_owner_1";
const CONVERSATION_ID = "conv_hydrate_1";
const ACCOUNT_ID = "acct_owned_1";

/** A valid persisted chart spec that should hydrate into `ChartInline`. */
const CHART_SPEC: ChartSpec = {
  id: "chart-1",
  chart_type: "bar",
  title: "Top 5 Services by Cost — June 2026",
  currency: "USD",
  labels: ["Amazon EC2", "Amazon S3", "AWS Lambda"],
  values: [4820.55, 1200.1, 300.5],
};

/** Owned conversation record returned by the ownership gate. */
function ownedConversation() {
  return {
    conversationId: CONVERSATION_ID,
    title: "June spend",
    titleSource: "ai" as const,
    accountId: ACCOUNT_ID,
    sessionId: `sess_${"a".repeat(35)}`,
    createdAt: "2026-06-01T12:00:00.000Z",
    updatedAt: "2026-06-01T12:05:00.000Z",
    messageCount: 2,
  };
}

/** A browser-safe connected-account view matching the conversation's account. */
function accountView(id: string) {
  return {
    id,
    alias: `alias-${id}`,
    maskedAccountId: "••••1234",
    displayCurrency: "USD",
    timezone: "America/New_York",
  };
}

/** Render the server component by awaiting it and mounting its element. */
async function renderPage(id: string = CONVERSATION_ID) {
  const element = await Page({ params: Promise.resolve({ id }) });
  return render(element);
}

beforeEach(() => {
  vi.clearAllMocks();
  lastChatViewProps.current = null;

  // Sensible signed-in / owned defaults; individual tests override the messages.
  authMock.mockResolvedValue({ user: { id: USER_ID } });
  getConversationOwnedMock.mockResolvedValue(ownedConversation());
  listConnectedAccountsMock.mockResolvedValue([accountView(ACCOUNT_ID)]);
  generateSuggestionsMock.mockReturnValue([]);
});

// ---------------------------------------------------------------------------
// Req 9.4 / 9.6 — persisted charts hydrate and render via ChartInline.
// ---------------------------------------------------------------------------
describe("chat/[id] hydration — persisted charts (Req 9.4, 9.6)", () => {
  it("hydrates an assistant turn's persisted ChartSpecs and renders them via ChartInline", async () => {
    listMessagesMock.mockResolvedValue([
      {
        id: "MSG#2026-06-01T12:00:00.000Z#u1",
        userId: USER_ID,
        role: "user",
        content: "Show my top services by cost",
        charts: [],
        reports: [],
        createdAt: "2026-06-01T12:00:00.000Z",
      },
      {
        id: "MSG#2026-06-01T12:00:01.000Z#a1",
        userId: USER_ID,
        role: "assistant",
        content: "Here are your top services.",
        charts: [CHART_SPEC],
        reports: [],
        createdAt: "2026-06-01T12:00:01.000Z",
      },
    ]);

    const { container } = await renderPage();

    // The transcript reached ChatView as initialMessages, carrying the chart.
    const props = lastChatViewProps.current!;
    const initialMessages = props.initialMessages as ChatMessage[];
    expect(initialMessages).toHaveLength(2);
    const assistant = initialMessages.find((m) => m.role === "assistant")!;
    expect(assistant.charts).toEqual([CHART_SPEC]);

    // The persisted chart hydrated into a real ChartInline card, captioned with
    // the spec title, and rendered client-side (no <img>, no presign) (Req 9.6).
    const chartCards = container.querySelectorAll('[data-slot="chart-inline"]');
    expect(chartCards).toHaveLength(1);
    expect(chartCards[0]).toHaveAttribute("data-chart-type", "bar");
    expect(screen.getByText(CHART_SPEC.title)).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();

    // Ownership-gated read ran for the signed-in user + conversation id.
    expect(getConversationOwnedMock).toHaveBeenCalledWith(USER_ID, CONVERSATION_ID);
    expect(listMessagesMock).toHaveBeenCalledWith(USER_ID, CONVERSATION_ID);
    expect(notFoundMock).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Req 9.5 — an empty conversation hydrates to [] and renders without error.
// ---------------------------------------------------------------------------
describe("chat/[id] hydration — empty conversation (Req 9.5)", () => {
  it("renders a zero-message conversation without surfacing an error", async () => {
    listMessagesMock.mockResolvedValue([]);

    let rendered: ReturnType<typeof render> | undefined;
    // Rendering the empty conversation must not throw (Req 9.5).
    await expect(
      (async () => {
        rendered = await renderPage();
      })(),
    ).resolves.toBeUndefined();

    const { container } = rendered!;

    // Hydrated to an empty transcript, no charts, no error surfaced.
    const props = lastChatViewProps.current!;
    expect(props.initialMessages).toEqual([]);
    expect(screen.getByTestId("empty-chat")).toBeInTheDocument();
    expect(container.querySelector('[data-slot="chart-inline"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();

    expect(getConversationOwnedMock).toHaveBeenCalledWith(USER_ID, CONVERSATION_ID);
    expect(notFoundMock).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });
});
