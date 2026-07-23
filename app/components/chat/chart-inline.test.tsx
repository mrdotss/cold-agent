import "@/test/dom-polyfills";
import "@testing-library/jest-dom/vitest";

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { ChartInline } from "./chart-inline";
import type { ChartSpec } from "@/lib/aws/sse";

/**
 * Example-based unit tests for `ChartInline` rendering
 * (Requirements 4.2, 4.3, 4.5, 4.6, 4.7).
 *
 * These complement the property tests in `chart-inline.property.test.tsx`
 * (which cover the pure `toChartRows` transform and the one-card-per-spec
 * invariant). Here we assert the concrete rendering contract for a fixed set of
 * hand-written specs.
 *
 * Recharts + jsdom: Recharts' `ResponsiveContainer` sizes itself from a
 * `ResizeObserver`, and jsdom's default (a no-op stub) reports a 0×0 box, so
 * the chart SVG never paints its bars/ticks. To assert the real rendering
 * contract (violet fills, currency-formatted ticks) we install a functional
 * `ResizeObserver` for this file that reports a fixed 320×200 box, so Recharts
 * paints deterministically. This is a standard technique for exercising
 * Recharts under jsdom and keeps the assertions strong and non-flaky.
 */

const CHART_DIMENSION = { width: 320, height: 200 } as const;

beforeAll(() => {
  // A functional ResizeObserver that immediately reports a fixed content box,
  // so Recharts' ResponsiveContainer paints its SVG internals under jsdom.
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

const CHART_TYPES = ["bar", "hbar", "line", "pie"] as const;

/** A well-formed spec with a distinct caption and known currency + values. */
function makeSpec(overrides: Partial<ChartSpec> = {}): ChartSpec {
  return {
    id: "c1",
    chart_type: "bar",
    title: "Top Services by Cost",
    currency: "USD",
    labels: ["Amazon EC2", "Amazon S3", "AWS Lambda"],
    values: [4820.55, 1234.5, 512.25],
    ...overrides,
  };
}

/** Every SVG `<text>` node Recharts painted (axis ticks render as `<text>`). */
function svgText(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("text"))
    .map((node) => node.textContent ?? "")
    .filter((text) => text.length > 0);
}

afterEach(() => {
  cleanup();
});

describe("ChartInline — caption (Req 4.2)", () => {
  it("renders the spec title as the framed card's caption", () => {
    const spec = makeSpec({ title: "June 2026 Spend" });
    const { container } = render(<ChartInline spec={spec} />);

    const card = container.querySelector('[data-slot="chart-inline"]');
    expect(card).not.toBeNull();

    const caption = card!.querySelector('[data-slot="card-title"]');
    expect(caption).not.toBeNull();
    expect(caption!.textContent).toBe("June 2026 Spend");
  });
});

describe("ChartInline — no image element (Req 4.2)", () => {
  it("renders a client-side chart with no <img> element", () => {
    // Charts are client-rendered SVG from the structured spec — never an image,
    // an S3 object, or a presigned URL.
    for (const chartType of CHART_TYPES) {
      const { container } = render(
        <ChartInline spec={makeSpec({ chart_type: chartType })} />,
      );
      expect(container.querySelector("img")).toBeNull();
      // It really did render an SVG chart (not an image or nothing).
      expect(container.querySelector("svg")).not.toBeNull();
      cleanup();
    }
  });
});

describe("ChartInline — one case per chart_type (Req 4.3)", () => {
  it.each(CHART_TYPES)(
    "renders %s without throwing and sets data-chart-type",
    (chartType) => {
      const spec = makeSpec({ chart_type: chartType });

      expect(() => render(<ChartInline spec={spec} />)).not.toThrow();

      const card = document.querySelector('[data-slot="chart-inline"]');
      expect(card).not.toBeNull();
      expect(card).toHaveAttribute("data-chart-type", chartType);

      // The chart branch mounted (not the empty-state placeholder): the shadcn
      // ChartContainer + a painted Recharts SVG surface are present.
      expect(document.querySelector('[data-slot="chart-empty"]')).toBeNull();
      expect(card!.querySelector('[data-slot="chart"]')).not.toBeNull();
      expect(card!.querySelector("svg.recharts-surface")).not.toBeNull();
    },
  );
});

describe("ChartInline — currency-formatted ticks (Req 4.5)", () => {
  it("formats numeric axis ticks with the spec currency (USD)", () => {
    // A vertical bar chart has a numeric Y axis; Recharts paints its ticks as
    // SVG <text> nodes. The component's compact currency formatter turns tick
    // values into strings like "$4.8K", so a "$" currency marker must appear in
    // the painted tick text.
    const { container } = render(
      <ChartInline spec={makeSpec({ chart_type: "bar", currency: "USD" })} />,
    );

    const texts = svgText(container);
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.some((text) => text.includes("$"))).toBe(true);
  });

  it("uses the spec currency symbol, not a hardcoded one (EUR)", () => {
    // Swapping the currency swaps the rendered symbol, proving the axis ticks
    // are formatted from `spec.currency` rather than a fixed locale/currency.
    const { container } = render(
      <ChartInline spec={makeSpec({ chart_type: "bar", currency: "EUR" })} />,
    );

    const joined = svgText(container).join(" ");
    expect(joined).toMatch(/€|EUR/);
    expect(joined).not.toContain("$");
  });
});

describe("ChartInline — preset theme tokens (Req 4.6)", () => {
  it("wires the violet series token (var(--primary)) for the bar chart", () => {
    const { container } = render(
      <ChartInline spec={makeSpec({ chart_type: "bar" })} />,
    );
    // The ChartContainer injects the series color into a <style> block as the
    // preset violet accent. jsdom does not run Recharts' bar enter-animation, so
    // the bar rectangle <path> (and its resolved fill) never paints; the
    // injected style is the reliable, animation-independent proof that the
    // violet series token is applied. Solid token, no gradient.
    const styleText = Array.from(container.querySelectorAll("style"))
      .map((node) => node.textContent ?? "")
      .join("\n");
    expect(styleText).toContain("var(--primary)");
    expect(container.querySelector("linearGradient")).toBeNull();
    expect(container.querySelector("radialGradient")).toBeNull();
  });

  it("uses the violet series token (var(--primary)) for the line stroke", () => {
    const { container } = render(
      <ChartInline spec={makeSpec({ chart_type: "line" })} />,
    );
    expect(container.querySelector('[stroke="var(--primary)"]')).not.toBeNull();
    expect(container.querySelector("linearGradient")).toBeNull();
  });

  it("exposes the stable chart-inline slot on the framed card", () => {
    const { container } = render(<ChartInline spec={makeSpec()} />);
    expect(container.querySelector('[data-slot="chart-inline"]')).not.toBeNull();
  });
});

describe("ChartInline — responsive container (Req 4.7)", () => {
  it("renders the responsive ChartContainer wrapper", () => {
    const { container } = render(<ChartInline spec={makeSpec()} />);

    // The shadcn ChartContainer wrapper …
    expect(container.querySelector('[data-slot="chart"]')).not.toBeNull();
    // … wrapping Recharts' ResponsiveContainer (responsive to container width).
    expect(
      container.querySelector(".recharts-responsive-container"),
    ).not.toBeNull();
  });
});
