import "@/test/dom-polyfills";
import "@testing-library/jest-dom/vitest";

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ConversationList } from "./conversation-list";
import type { ConversationListItem } from "@/hooks/useConversations";

/**
 * Component tests for the sidebar conversation UX (task 13.5).
 *
 * WHY THIS TESTS `ConversationList` DIRECTLY (not `sidebar.tsx`): all of the
 * interactive behavior the sidebar UX requirements describe — the optimistic
 * "New" control, the single-in-flight create guard, revalidation on settle, the
 * zero-account connect affordance, inline rename, and the pending-title
 * safety-net POST — lives in `ConversationList` (backed by the `useConversations`
 * hook). `sidebar.tsx` (task 13.4) is a thin wrapper that only wires routing
 * (`onCreated` → `router.push`) and toast plumbing (`onError`) around this
 * component. Rendering `ConversationList` with `onCreated`/`onError` as spies
 * exercises the full behavior surface without pulling in Next's router context,
 * so we assert navigation intent via the `onCreated(conversationId)` callback
 * (the exact value the sidebar hands to `router.push('/chat/<id>')`, Req 1.4).
 *
 * FETCH ROUTER: every network path the component reaches is stubbed through a
 * single `vi.stubGlobal("fetch", …)` URL+method router (see `installFetch`):
 *   - POST  /api/conversations            → create (deferrable for the in-flight
 *                                            + placeholder + idle timing tests)
 *   - GET   /api/conversations            → revalidate-on-settle (Req 1.7)
 *   - PATCH /api/conversations/<id>        → rename success / failure (Req 11.4/11.7)
 *   - POST  /api/conversations/<id>/title  → the pending-title safety-net (Req 10.2/10.8)
 * Assertions filter `fetchMock.mock.calls` by URL + method so they are robust to
 * call ordering and to unrelated background calls.
 *
 * Covers Req 1.1, 1.2, 1.3, 1.4, 1.7, 1.8, 10.2, 11.1, 11.3, 11.4, 11.5, 11.7.
 */

// Render Next's <Link> as a plain anchor so the list mounts without an
// App Router context (this component does no routing of its own).
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...rest
  }: {
    children: React.ReactNode;
    href: string | { toString(): string };
  }) => (
    <a href={typeof href === "string" ? href : String(href)} {...rest}>
      {children}
    </a>
  ),
}));

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

const ACCOUNT_ID = "acc-1";

/** Build a client conversation row with sensible, overridable defaults. */
function convo(overrides: Partial<ConversationListItem> = {}): ConversationListItem {
  return {
    conversationId: "conv-existing",
    title: "Existing chat",
    titleSource: "ai",
    accountId: ACCOUNT_ID,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    messageCount: 2,
    ...overrides,
  };
}

/** A promise whose settlement the test body controls (for in-flight timing). */
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type MockResponse = { ok: boolean; json?: () => Promise<unknown> };
type Handler = () => Promise<MockResponse> | MockResponse;

interface FetchHandlers {
  createConversation?: Handler;
  listConversations?: Handler;
  patchConversation?: Handler;
  postTitle?: Handler;
}

const okJson = (body: unknown): MockResponse => ({
  ok: true,
  json: async () => body,
});

/**
 * Install a URL + method fetch router as the global `fetch` and return the mock
 * so tests can inspect the recorded calls.
 */
function installFetch(handlers: FetchHandlers = {}) {
  const {
    createConversation = () => okJson({ conversationId: "conv_new" }),
    listConversations = () => okJson({ conversations: [] }),
    patchConversation = () => okJson({ title: "renamed", titleSource: "user" }),
    postTitle = () => ({ ok: true }),
  } = handlers;

  const fetchMock = vi.fn((input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const method = (init?.method ?? "GET").toUpperCase();

    if (url === "/api/conversations" && method === "POST") {
      return Promise.resolve(createConversation());
    }
    if (url === "/api/conversations" && method === "GET") {
      return Promise.resolve(listConversations());
    }
    if (/^\/api\/conversations\/[^/]+\/title$/.test(url) && method === "POST") {
      return Promise.resolve(postTitle());
    }
    if (/^\/api\/conversations\/[^/]+$/.test(url) && method === "PATCH") {
      return Promise.resolve(patchConversation());
    }
    throw new Error(`Unrouted fetch in test: ${method} ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Filter recorded fetch calls by HTTP method and a URL predicate. */
function callsMatching(
  fetchMock: ReturnType<typeof installFetch>,
  method: string,
  match: (url: string) => boolean,
) {
  return fetchMock.mock.calls.filter((call) => {
    const [input, init] = call as [unknown, RequestInit | undefined];
    const url = typeof input === "string" ? input : String(input);
    const m = (init?.method ?? "GET").toUpperCase();
    return m === method.toUpperCase() && match(url);
  });
}

const newButton = () => screen.getByRole("button", { name: "New chat" });

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

// ---------------------------------------------------------------------------
// Req 1.1 / 1.2 / 1.3 / 1.4 / 1.7 — the optimistic "New" control
// ---------------------------------------------------------------------------

describe("ConversationList — New control (Req 1.1, 1.2, 1.3, 1.4, 1.7)", () => {
  it("inserts a pending placeholder at the TOP before the create settles (Req 1.1)", async () => {
    // A deferred create keeps the request in flight so we can observe the
    // optimistic placeholder before it resolves.
    const deferred = createDeferred<MockResponse>();
    installFetch({ createConversation: () => deferred.promise });
    const user = userEvent.setup();

    render(
      <ConversationList
        accountCount={1}
        newChatAccountId={ACCOUNT_ID}
        initialConversations={[convo()]}
        onCreated={vi.fn()}
        onError={vi.fn()}
      />,
    );

    await user.click(newButton());

    // The placeholder renders with the "New Chat" default label…
    const placeholder = await screen.findByText("New Chat");
    // …and it sits ABOVE the pre-existing row (inserted at the top of the list).
    const existing = screen.getByText("Existing chat");
    expect(
      placeholder.compareDocumentPosition(existing) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // Settle so the pending create work does not leak past the test.
    deferred.resolve(okJson({ conversationId: "conv_new" }));
    await waitFor(() => expect(newButton()).not.toBeDisabled());
  });

  it("returns 'New' to idle (re-enabled, not spinning) after the create settles (Req 1.2)", async () => {
    const deferred = createDeferred<MockResponse>();
    const { container } = renderWithFetch({
      createConversation: () => deferred.promise,
    });
    const user = userEvent.setup();

    await user.click(newButton());

    // In flight: the control is busy (disabled) and shows a spinner.
    expect(newButton()).toBeDisabled();
    expect(container.querySelector(".animate-spin")).not.toBeNull();

    deferred.resolve(okJson({ conversationId: "conv_new" }));

    // On settle it flips back to idle: re-enabled and no longer spinning.
    await waitFor(() => expect(newButton()).not.toBeDisabled());
    expect(container.querySelector(".animate-spin")).toBeNull();
  });

  it("fires POST /api/conversations exactly once for two rapid 'New' clicks (Req 1.3)", async () => {
    // Deferred create so BOTH clicks land while the first request is in flight.
    const deferred = createDeferred<MockResponse>();
    const fetchMock = installFetch({ createConversation: () => deferred.promise });

    render(
      <ConversationList
        accountCount={1}
        newChatAccountId={ACCOUNT_ID}
        initialConversations={[]}
        onCreated={vi.fn()}
        onError={vi.fn()}
      />,
    );

    // fireEvent lets both clicks fire back-to-back against the single-in-flight
    // guard while the create promise is still pending.
    fireEvent.click(newButton());
    fireEvent.click(newButton());

    const createPosts = callsMatching(
      fetchMock,
      "POST",
      (url) => url === "/api/conversations",
    );
    expect(createPosts).toHaveLength(1);

    deferred.resolve(okJson({ conversationId: "conv_new" }));
    await waitFor(() => expect(newButton()).not.toBeDisabled());
  });

  it("calls onCreated with the persisted conversationId on success (Req 1.4)", async () => {
    const onCreated = vi.fn();
    renderWithFetch(
      { createConversation: () => okJson({ conversationId: "conv_new" }) },
      { onCreated },
    );
    const user = userEvent.setup();

    await user.click(newButton());

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("conv_new"));
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it("revalidates the list with a GET /api/conversations after the create settles (Req 1.7)", async () => {
    const fetchMock = installFetch({
      createConversation: () => okJson({ conversationId: "conv_new" }),
      listConversations: () => okJson({ conversations: [] }),
    });
    const user = userEvent.setup();

    render(
      <ConversationList
        accountCount={1}
        newChatAccountId={ACCOUNT_ID}
        initialConversations={[]}
        onCreated={vi.fn()}
        onError={vi.fn()}
      />,
    );

    await user.click(newButton());

    await waitFor(() => {
      const listGets = callsMatching(
        fetchMock,
        "GET",
        (url) => url === "/api/conversations",
      );
      expect(listGets.length).toBeGreaterThanOrEqual(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Req 1.8 — zero accounts
// ---------------------------------------------------------------------------

describe("ConversationList — zero accounts (Req 1.8)", () => {
  it("disables 'New' and shows the connect-account affordance when accountCount === 0", () => {
    installFetch();

    render(
      <ConversationList
        accountCount={0}
        newChatAccountId={null}
        initialConversations={[]}
        onCreated={vi.fn()}
        onError={vi.fn()}
      />,
    );

    expect(newButton()).toBeDisabled();

    const affordance = screen.getByRole("link", {
      name: /connect an account to start a chat/i,
    });
    expect(affordance).toHaveAttribute("href", "/accounts");
  });
});

// ---------------------------------------------------------------------------
// Req 11.1 / 11.3 / 11.4 / 11.7 — inline rename
// ---------------------------------------------------------------------------

describe("ConversationList — inline rename (Req 11.1, 11.3, 11.4, 11.7)", () => {
  it("opens an input pre-filled with the current title on rename (Req 11.1)", async () => {
    installFetch();
    const user = userEvent.setup();

    render(
      <ConversationList
        accountCount={1}
        newChatAccountId={ACCOUNT_ID}
        initialConversations={[convo({ title: "Existing chat" })]}
        onCreated={vi.fn()}
        onError={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Rename conversation: Existing chat" }),
    );

    const input = screen.getByRole("textbox", { name: "Conversation title" });
    expect(input).toHaveValue("Existing chat");
  });

  it("restores the displayed title when the edit is cancelled with Escape (Req 11.3)", async () => {
    const fetchMock = installFetch();
    const user = userEvent.setup();

    render(
      <ConversationList
        accountCount={1}
        newChatAccountId={ACCOUNT_ID}
        initialConversations={[convo({ title: "Existing chat" })]}
        onCreated={vi.fn()}
        onError={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Rename conversation: Existing chat" }),
    );

    const input = screen.getByRole("textbox", { name: "Conversation title" });
    await user.type(input, " and more{Escape}");

    // The field closes and the original title is shown again…
    await waitFor(() =>
      expect(
        screen.queryByRole("textbox", { name: "Conversation title" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Existing chat")).toBeInTheDocument();
    // …and no PATCH was ever sent.
    expect(
      callsMatching(fetchMock, "PATCH", (url) =>
        url.startsWith("/api/conversations/"),
      ),
    ).toHaveLength(0);
  });

  it("PATCHes and updates the row on a successful Enter rename (Req 11.4)", async () => {
    const fetchMock = installFetch({
      patchConversation: () => okJson({ title: "Renamed", titleSource: "user" }),
    });
    const user = userEvent.setup();

    render(
      <ConversationList
        accountCount={1}
        newChatAccountId={ACCOUNT_ID}
        initialConversations={[
          convo({ conversationId: "conv-existing", title: "Existing chat" }),
        ]}
        onCreated={vi.fn()}
        onError={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Rename conversation: Existing chat" }),
    );

    const input = screen.getByRole("textbox", { name: "Conversation title" });
    await user.clear(input);
    await user.type(input, "Renamed{Enter}");

    // The row now shows the new title without a reload.
    await waitFor(() =>
      expect(screen.getByText("Renamed")).toBeInTheDocument(),
    );

    // Exactly one PATCH to the row's route carrying the trimmed title.
    const patches = callsMatching(fetchMock, "PATCH", (url) =>
      url.startsWith("/api/conversations/conv-existing"),
    );
    expect(patches).toHaveLength(1);
    const [, init] = patches[0] as [unknown, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ title: "Renamed" });
  });

  it("restores the previous title and calls onError when the PATCH fails (Req 11.7)", async () => {
    const onError = vi.fn();
    installFetch({ patchConversation: () => ({ ok: false }) });
    const user = userEvent.setup();

    render(
      <ConversationList
        accountCount={1}
        newChatAccountId={ACCOUNT_ID}
        initialConversations={[convo({ title: "Existing chat" })]}
        onCreated={vi.fn()}
        onError={onError}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Rename conversation: Existing chat" }),
    );

    const input = screen.getByRole("textbox", { name: "Conversation title" });
    await user.clear(input);
    await user.type(input, "Doomed rename{Enter}");

    // The failed rename rolls back to the previous title and surfaces an error.
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0][0]).toEqual(expect.any(String));
    await waitFor(() =>
      expect(screen.getByText("Existing chat")).toBeInTheDocument(),
    );
    expect(screen.queryByText("Doomed rename")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Req 10.2 / 10.8 / 11.5 — pending-title safety-net POST
// ---------------------------------------------------------------------------

describe("ConversationList — pending-title safety-net (Req 10.2, 10.8, 11.5)", () => {
  it("does NOT fire the background title POST for a pending conversation with messageCount 0", async () => {
    const fetchMock = installFetch();

    render(
      <ConversationList
        accountCount={1}
        newChatAccountId={ACCOUNT_ID}
        initialConversations={[
          convo({
            conversationId: "conv-empty",
            titleSource: "pending",
            messageCount: 0,
          }),
        ]}
        onCreated={vi.fn()}
        onError={vi.fn()}
      />,
    );

    // Let any mount effect flush; the safety-net must stay silent because the
    // first user-message write may still be racing (Req 10.2).
    await Promise.resolve();

    expect(
      callsMatching(fetchMock, "POST", (url) => url.endsWith("/title")),
    ).toHaveLength(0);
  });

  it("fires the background title POST exactly once for a pending conversation with messageCount >= 1 (Req 10.8)", async () => {
    const fetchMock = installFetch();

    render(
      <ConversationList
        accountCount={1}
        newChatAccountId={ACCOUNT_ID}
        initialConversations={[
          convo({
            conversationId: "conv-pending",
            titleSource: "pending",
            messageCount: 1,
          }),
        ]}
        onCreated={vi.fn()}
        onError={vi.fn()}
      />,
    );

    await waitFor(() => {
      const titlePosts = callsMatching(fetchMock, "POST", (url) =>
        url.endsWith("/title"),
      );
      expect(titlePosts).toHaveLength(1);
    });

    const titlePosts = callsMatching(fetchMock, "POST", (url) =>
      url.endsWith("/title"),
    );
    const [url] = titlePosts[0] as [string, RequestInit | undefined];
    expect(url).toBe("/api/conversations/conv-pending/title");
  });

  it("does NOT fire the title POST for a user-titled conversation (Req 11.5)", async () => {
    const fetchMock = installFetch();

    render(
      <ConversationList
        accountCount={1}
        newChatAccountId={ACCOUNT_ID}
        initialConversations={[
          convo({
            conversationId: "conv-user",
            title: "My renamed chat",
            titleSource: "user",
            messageCount: 3,
          }),
        ]}
        onCreated={vi.fn()}
        onError={vi.fn()}
      />,
    );

    await Promise.resolve();

    expect(
      callsMatching(fetchMock, "POST", (url) => url.endsWith("/title")),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Shared render helper for the create-flow tests
// ---------------------------------------------------------------------------

/**
 * Render `ConversationList` with one connected account, an empty seeded list,
 * and the given fetch handlers. Returns RTL's render result plus the spies.
 */
function renderWithFetch(
  handlers: FetchHandlers = {},
  props: Partial<React.ComponentProps<typeof ConversationList>> = {},
) {
  installFetch(handlers);
  const onCreated = props.onCreated ?? vi.fn();
  const onError = props.onError ?? vi.fn();
  return render(
    <ConversationList
      accountCount={props.accountCount ?? 1}
      newChatAccountId={
        props.newChatAccountId === undefined ? ACCOUNT_ID : props.newChatAccountId
      }
      activeConversationId={props.activeConversationId}
      initialConversations={props.initialConversations ?? []}
      onCreated={onCreated}
      onError={onError}
    />,
  );
}
