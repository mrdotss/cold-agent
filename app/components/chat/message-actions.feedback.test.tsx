import "@/test/dom-polyfills";
import "@testing-library/jest-dom/vitest";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { MessageActions } from "./message-actions";

/**
 * Component tests for the assistant-turn FEEDBACK UI (Req 14.2, 14.4, 14.5),
 * covering the wiring introduced in task 12.3: the 👍/👎 controls now persist a
 * chosen vote through the message-feedback ROUTE
 * (`PATCH /api/conversations/[id]/messages/[messageId]/feedback`) — never a
 * Postgres/server action and never DynamoDB directly.
 *
 * These assert three things:
 *  1. Hydration — each turn's persisted `feedback` (`up`/`down`/`null`) is shown
 *     as the selected control on first render (Req 14.2/14.5 display contract).
 *  2. Submit — clicking a control issues a single `fetch` to the feedback route
 *     with method `PATCH` and body `{ feedback: <value> }`, addressed by the
 *     conversation id and the URL-encoded message id. `fetch` is the ONLY
 *     persistence path (no Postgres/server action) (Req 14.4, 14.5).
 *  3. Optimistic + reconcile — the chosen control activates immediately, and a
 *     failed response (non-ok or rejected) rolls it back to the previous state
 *     and surfaces the subtle "Couldn't save" error (Req 14.5).
 *
 * We stub the global `fetch` per test with `vi.stubGlobal` so we can control the
 * ok/failure outcome and inspect the call. A deferred promise lets the failure
 * test observe the optimistic state deterministically before the request
 * settles. The component never imports `@/lib/actions/feedback`, so asserting
 * `fetch` is the persistence path is sufficient to prove no server action /
 * Postgres call is made (Req 14.5).
 */

const CONVERSATION_ID = "conv-42";
// A realistic DynamoDB sort key with characters that MUST be URL-encoded
// (`#`, `:`), so the route addressing is exercised for real.
const MESSAGE_ID = "MSG#2026-06-01T12:00:00Z#a1b2";

/** A promise whose resolution/rejection we control from the test body. */
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe("MessageActions feedback — hydration (Req 14.2, 14.5)", () => {
  // No network is involved in hydration; a throwing stub proves it.
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("fetch must not be called during hydration");
      }),
    );
  });

  it("shows thumbs-up active and thumbs-down neutral when feedback is 'up'", () => {
    render(
      <MessageActions
        conversationId={CONVERSATION_ID}
        messageId={MESSAGE_ID}
        content="answer"
        initialFeedback="up"
      />,
    );

    const up = screen.getByRole("button", { name: "Remove thumbs up" });
    const down = screen.getByRole("button", { name: "Thumbs down" });
    expect(up).toHaveAttribute("aria-pressed", "true");
    expect(down).toHaveAttribute("aria-pressed", "false");
  });

  it("shows thumbs-down active and thumbs-up neutral when feedback is 'down'", () => {
    render(
      <MessageActions
        conversationId={CONVERSATION_ID}
        messageId={MESSAGE_ID}
        content="answer"
        initialFeedback="down"
      />,
    );

    const up = screen.getByRole("button", { name: "Thumbs up" });
    const down = screen.getByRole("button", { name: "Remove thumbs down" });
    expect(up).toHaveAttribute("aria-pressed", "false");
    expect(down).toHaveAttribute("aria-pressed", "true");
  });

  it("shows both controls neutral when feedback is null", () => {
    render(
      <MessageActions
        conversationId={CONVERSATION_ID}
        messageId={MESSAGE_ID}
        content="answer"
        initialFeedback={null}
      />,
    );

    const up = screen.getByRole("button", { name: "Thumbs up" });
    const down = screen.getByRole("button", { name: "Thumbs down" });
    expect(up).toHaveAttribute("aria-pressed", "false");
    expect(down).toHaveAttribute("aria-pressed", "false");
  });
});

describe("MessageActions feedback — submit via the feedback route (Req 14.4, 14.5)", () => {
  it("PATCHes the feedback route with the chosen value and no server action", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <MessageActions
        conversationId={CONVERSATION_ID}
        messageId={MESSAGE_ID}
        content="answer"
        initialFeedback={null}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Thumbs up" }));

    // Exactly one persistence call — and it is the feedback ROUTE via fetch.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    // The URL is the feedback route, addressed by the conversation id and the
    // URL-encoded message id (never Postgres / a server action endpoint).
    expect(url).toContain(
      `/api/conversations/${encodeURIComponent(CONVERSATION_ID)}/messages/`,
    );
    expect(url).toContain(`${encodeURIComponent(MESSAGE_ID)}/feedback`);
    expect(url).toContain("%23"); // the '#' in the sort key was encoded

    // Method + body carry the chosen vote.
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ feedback: "up" });

    // The optimistic vote is reflected as active.
    expect(
      await screen.findByRole("button", { name: "Remove thumbs up" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("sends { feedback: 'down' } when the down control is chosen", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <MessageActions
        conversationId={CONVERSATION_ID}
        messageId={MESSAGE_ID}
        content="answer"
        initialFeedback={null}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Thumbs down" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ feedback: "down" });

    expect(
      await screen.findByRole("button", { name: "Remove thumbs down" }),
    ).toHaveAttribute("aria-pressed", "true");
  });
});

describe("MessageActions feedback — optimistic + reconcile (Req 14.5)", () => {
  it("activates optimistically then rolls back and shows an error on a failed response", async () => {
    // A deferred lets us observe the optimistic state before the request settles.
    const deferred = createDeferred<{ ok: boolean }>();
    const fetchMock = vi.fn(() => deferred.promise);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <MessageActions
        conversationId={CONVERSATION_ID}
        messageId={MESSAGE_ID}
        content="answer"
        initialFeedback={null}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Thumbs up" }));

    // Optimistic: the up control is immediately active while the request is
    // still in flight.
    expect(
      screen.getByRole("button", { name: "Remove thumbs up" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The response comes back non-ok → reconcile by rolling back.
    deferred.resolve({ ok: false });

    // The subtle error appears and the vote returns to the previous (neutral)
    // state.
    expect(await screen.findByText("Couldn't save")).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Thumbs up" }),
      ).toHaveAttribute("aria-pressed", "false");
    });
  });

  it("rolls back and shows an error when the request rejects (network failure)", async () => {
    const deferred = createDeferred<{ ok: boolean }>();
    const fetchMock = vi.fn(() => deferred.promise);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <MessageActions
        conversationId={CONVERSATION_ID}
        messageId={MESSAGE_ID}
        content="answer"
        initialFeedback={null}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Thumbs up" }));

    // Optimistic activation before the rejection settles.
    expect(
      screen.getByRole("button", { name: "Remove thumbs up" }),
    ).toHaveAttribute("aria-pressed", "true");

    deferred.reject(new Error("network down"));

    expect(await screen.findByText("Couldn't save")).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Thumbs up" }),
      ).toHaveAttribute("aria-pressed", "false");
    });
  });
});
