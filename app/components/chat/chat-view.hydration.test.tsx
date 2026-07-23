import "@/test/dom-polyfills";
import "@testing-library/jest-dom/vitest";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { ChatView } from "./chat-view";
import type { ChatMessage } from "./types";
import type { ChartSpec } from "@/lib/aws/sse";

/**
 * Unit tests for conversation HYDRATION on reopen (task 12.2; Req 9.4, 9.5, 9.6).
 *
 * ## What is under test — and why ChatView (client), not the page (server)
 *
 * The `/chat/[id]` server page (task 12.1) authenticates, loads the persisted
 * transcript from DynamoDB, and projects each `StoredMessage → ChatMessage`
 * `{ id, role, content, charts, reports, feedback }` before handing the array to
 * `<ChatView initialMessages=... />`. Testing that server component directly is
 * awkward (it awaits `auth()` + the `server-only` history stores). The faithful,
 * stable contract to lock down is the CLIENT RENDER PATH the page feeds:
 * given the exact `ChatMessage[]` shape the page produces, `ChatView` (which
 * composes `MessageList`) must
 *
 *   1. render each persisted assistant turn's `message.charts` via the same
 *      `ChartInline` used for live turns (this is what task 4.3 wired), and
 *   2. render a zero-message conversation as the intro empty state WITHOUT
 *      surfacing an error (Req 9.5).
 *
 * So these tests render `ChatView` with hand-built `initialMessages` — exactly
 * what the page's `messages.map(...)` yields — and assert the rendered DOM.
 *
 * ## jsdom / Recharts handling
 *
 * `ChartInline` renders a Recharts chart whose `ResponsiveContainer` sizes from a
 * `ResizeObserver`; jsdom's default no-op stub reports 0×0 so the SVG never
 * paints. Mirroring `chart-inline.test.tsx`, we install a functional
 * `ResizeObserver` reporting a fixed 320×200 box so the chart paints
 * deterministically. `@/test/dom-polyfills` supplies the other browser APIs the
 * Base UI `MessageScroller` needs under jsdom (IntersectionObserver + element
 * scroll methods); it only installs a ResizeObserver when one is absent, so our
 * functional observer (installed in `beforeAll`) wins.
 *
 * ## Feedback persistence
 *
 * The persisted assistant turn renders a `MessageActions` bar whose thumbs
 * up/down persist via the feedback ROUTE (`fetch`), not a server action or
 * Postgres. Hydration rendering does not exercise that path, so no module mock
 * is needed here.
 */

const CHART_DIMENSION = { width: 320, height: 200 } as const;

beforeAll(() => {
  // Functional ResizeObserver reporting a fixed content box so Recharts'
  // ResponsiveContainer paints its SVG internals under jsdom.
  class SizedResizeObserver {
    private readonly callback: ResizeObserverCallback;

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }

    observe(target: Element): void {
      const contentRect = {
        ...CHART_DIMENSION,
        top: 0,
        left: 0,
        right: CHART_DIMENSION.width,
        bottom: CHART_DIMENSION.height,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRectReadOnly;

      this.callback(
        [{ target, contentRect } as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }

    unobserve(): void {}
    disconnect(): void {}
  }

  (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
    SizedResizeObserver as unknown as typeof ResizeObserver;
});

afterEach(() => {
  cleanup();
});

/** A persisted bar-chart spec, as the page would hydrate onto an assistant turn. */
function makeChartSpec(overrides: Partial<ChartSpec> = {}): ChartSpec {
  return {
    id: "c1",
    chart_type: "bar",
    title: "Top Services",
    currency: "USD",
    labels: ["EC2", "S3"],
    values: [100, 50],
    ...overrides,
  };
}

describe("ChatView hydration — persisted charts render via ChartInline (Req 9.4, 9.6)", () => {
  it("renders a ChartInline card for a hydrated assistant turn's persisted chart", () => {
    // The exact ChatMessage[] shape the server page projects from stored
    // DynamoDB messages: an assistant turn carrying one persisted ChartSpec.
    const initialMessages: ChatMessage[] = [
      {
        id: "MSG#2026-06-01T00:00:00.000Z#abc",
        role: "assistant",
        content: "Top services",
        charts: [makeChartSpec()],
      },
    ];

    render(
      <ChatView
        threadId="conv-1"
        initialMessages={initialMessages}
        accountCount={1}
        initialSuggestions={[]}
      />,
    );

    // The persisted chart hydrates through the SAME ChartInline card used for
    // live turns: a framed card tagged with the chart type and captioned title.
    const card = document.querySelector('[data-slot="chart-inline"]');
    expect(card).not.toBeNull();
    expect(card).toHaveAttribute("data-chart-type", "bar");

    const caption = card!.querySelector('[data-slot="card-title"]');
    expect(caption).not.toBeNull();
    expect(caption!.textContent).toBe("Top Services");

    // It really rendered a client-side chart (not an image / presigned object).
    expect(card!.querySelector("img")).toBeNull();
    expect(card!.querySelector("svg")).not.toBeNull();

    // The assistant prose hydrated alongside the chart.
    expect(screen.getByText("Top services")).toBeInTheDocument();
  });
});

describe("ChatView hydration — empty conversation shows intro, no error (Req 9.5)", () => {
  it("renders the intro empty state and surfaces no error for a zero-message conversation", () => {
    render(
      <ChatView
        threadId="conv-empty"
        initialMessages={[]}
        accountCount={1}
        initialSuggestions={["Scan this month's spend"]}
      />,
    );

    // No error is surfaced (the error alert uses role="alert").
    expect(screen.queryByRole("alert")).toBeNull();

    // The AgentIntro empty state renders (its serif heading names the agent).
    expect(screen.getByText("Cloud Bill Analyst")).toBeInTheDocument();

    // And no chart card is present for an empty transcript.
    expect(document.querySelector('[data-slot="chart-inline"]')).toBeNull();
  });
});
