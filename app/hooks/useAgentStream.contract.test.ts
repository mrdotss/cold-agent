// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useAgentStream } from "./useAgentStream";

/**
 * Client/relay CONTRACT test — the CLIENT half (task 3.4, Req 3.6, 3.7).
 *
 * The iteration-2 `/api/chat` relay expects a `{ conversationId, prompt }` body
 * (Req 3.7). This file pins the CLIENT side of that contract: it asserts the
 * `useAgentStream` hook POSTs exactly `{ conversationId, prompt }` — carrying the
 * `conversationId` argument it was constructed with and NOT the iteration-1
 * `threadId` field (Req 3.6) — and that every caller of the hook passes a
 * `conversationId` argument.
 *
 * The RELAY half of the contract (the zod schema accepts `{ conversationId,
 * prompt }` and rejects a body missing either field without invoking the
 * runtime) lives in a sibling NODE-environment file,
 * `app/app/api/chat/route.contract.test.ts`. Two files are used because the two
 * halves need different Vitest environments (jsdom here for `renderHook` + a
 * mocked `fetch`; node there for the route handler), which is the cleanest way
 * to exercise both sides of the same wire contract.
 *
 * The network is faked: `fetch` is stubbed to resolve a non-OK response so
 * `send()` short-circuits (surfacing a redacted error) and completes promptly
 * WITHOUT needing a real SSE body. A plain prompt triggers no `report_file`
 * event, so the background `GET /api/report-url` fetch never fires — the only
 * `fetch` call is the `POST /api/chat` we assert on.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useAgentStream client contract (Req 3.6)", () => {
  it("POSTs { conversationId, prompt } to /api/chat with the constructed conversationId and no threadId", async () => {
    const conversationId = "conv_abc_123";
    const prompt = "some prompt";

    // Resolve a non-OK response with a readable JSON error so `send()` takes the
    // pre-invoke-rejection branch and finishes quickly (no SSE body to stream).
    const fetchMock = vi.fn(async (..._args: unknown[]) => ({
      ok: false,
      body: null,
      json: async () => ({ error: "stop" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useAgentStream(conversationId));

    await act(async () => {
      await result.current.send(prompt);
    });

    // Exactly one network call, and it is the chat relay POST.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/chat");
    expect(init.method).toBe("POST");

    // The POST body is exactly { conversationId, prompt } — carrying the hook's
    // conversationId argument, the prompt, and NOTHING else (no iteration-1
    // `threadId`).
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toEqual({ conversationId, prompt });
    expect(body).not.toHaveProperty("threadId");
    expect(Object.keys(body).sort()).toEqual(["conversationId", "prompt"]);
  });
});

describe("useAgentStream callers pass a conversationId argument (Req 3.6)", () => {
  it("chat-view.tsx invokes useAgentStream with an argument (not zero-arg)", () => {
    // Static source assertion: the sole caller wires a value into the hook's
    // positional `conversationId` parameter. This guards against a caller that
    // renamed the field but dropped the argument.
    // Resolve from the Vitest working directory (the `app/` root) rather than
    // `import.meta.url`, which is not a file-scheme URL under the jsdom transform.
    const source = readFileSync(
      resolve(process.cwd(), "components/chat/chat-view.tsx"),
      "utf8",
    );

    // Matches `useAgentStream(<identifier>)` — a value is passed, not `()`.
    expect(source).toMatch(/useAgentStream\(\s*[A-Za-z_$][\w$.]*\s*\)/);
    // And it is never called with no argument.
    expect(source).not.toMatch(/useAgentStream\(\s*\)/);
  });
});
