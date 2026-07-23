import "@/test/dom-polyfills";
import "@testing-library/jest-dom/vitest";

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import * as fc from "fast-check";

import { ChartInline, toChartRows } from "./chart-inline";
import type { ChartSpec } from "@/lib/aws/sse";

/**
 * Property tests for the inline-chart transform and rendering
 * (Requirements 4.1, 4.4, 4.8, 4.9, 4.10).
 *
 * Property 6 exercises the PURE `toChartRows` transform across many valid
 * specs, plus the empty (Req 4.8) and single-pair (Req 4.9) boundaries.
 *
 * Property 7 renders N `ChartInline` components for N specs and asserts one
 * framed chart card appears per spec, in order. Recharts is driven through the
 * app's `ChartContainer`, which supplies a fixed `initialDimension`
 * (320×200) so `ResponsiveContainer` renders deterministically in jsdom
 * (no 0-size flakiness). To stay robust against Recharts' SVG internals we
 * assert only on the outer `data-slot="chart-inline"` card wrapper (which
 * renders regardless), its `data-chart-type`, and the serif `card-title`
 * caption — the stable contract the component sets.
 */

/** The chart types the component accepts (kept in sync with `ChartSpec`). */
const CHART_TYPES = ["bar", "hbar", "line", "pie"] as const;

const chartTypeArb = fc.constantFrom<ChartSpec["chart_type"]>(...CHART_TYPES);

/** Finite numbers so `rows[i].value === values[i]` compares cleanly. */
const finiteNumberArb = fc.double({ noNaN: true, noDefaultInfinity: true });

/**
 * A valid `ChartSpec`: `labels` (string[]) and `values` (number[]) always share
 * the same length, generated from a shared length so the equal-length invariant
 * that `toKnownEvent` guarantees holds by construction. `minLength: 0` includes
 * the empty-labels boundary (Req 4.8).
 */
const validChartSpecArb: fc.Arbitrary<ChartSpec> = fc
  .nat({ max: 12 })
  .chain((len) =>
    fc.record({
      id: fc.string(),
      chart_type: chartTypeArb,
      title: fc.string(),
      currency: fc.string(),
      labels: fc.array(fc.string(), { minLength: len, maxLength: len }),
      values: fc.array(finiteNumberArb, { minLength: len, maxLength: len }),
    }),
  );

/** A valid spec with a distinct, non-empty title, for order-by-caption checks. */
function specWithIndex(chartType: ChartSpec["chart_type"], index: number): ChartSpec {
  const len = (index % 4) + 1;
  return {
    id: `c${index}`,
    chart_type: chartType,
    title: `Chart Caption ${index}`,
    currency: "USD",
    labels: Array.from({ length: len }, (_, i) => `Label ${index}-${i}`),
    values: Array.from({ length: len }, (_, i) => (index + 1) * 100 + i),
  };
}

describe("toChartRows — chart-row transform properties", () => {
  it("pairs each label with its value by index", () => {
    // Feature: cloud-bill-analyst-web-iteration-2, Property 6: Chart rows pair labels with values by index — for a valid ChartSpec, toChartRows(spec) returns an array of length spec.labels.length where rows[i] === { name: spec.labels[i], value: spec.values[i] } for every index.
    fc.assert(
      fc.property(validChartSpecArb, (spec) => {
        const rows = toChartRows(spec);
        expect(rows).toHaveLength(spec.labels.length);
        for (let i = 0; i < spec.labels.length; i += 1) {
          expect(rows[i]).toEqual({ name: spec.labels[i], value: spec.values[i] });
          expect(rows[i].name).toBe(spec.labels[i]);
          expect(rows[i].value).toBe(spec.values[i]);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("returns [] for empty labels (Req 4.8)", () => {
    // Feature: cloud-bill-analyst-web-iteration-2, Property 6: Chart rows pair labels with values by index — the empty-labels boundary yields an empty rows array.
    fc.assert(
      fc.property(
        fc.record({
          id: fc.string(),
          chart_type: chartTypeArb,
          title: fc.string(),
          currency: fc.string(),
        }),
        (base) => {
          const spec: ChartSpec = { ...base, labels: [], values: [] };
          expect(toChartRows(spec)).toEqual([]);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("returns exactly one row for a single label/value pair (Req 4.9)", () => {
    // Feature: cloud-bill-analyst-web-iteration-2, Property 6: Chart rows pair labels with values by index — a single-pair spec yields exactly one row.
    fc.assert(
      fc.property(
        fc.record({
          id: fc.string(),
          chart_type: chartTypeArb,
          title: fc.string(),
          currency: fc.string(),
          label: fc.string(),
          value: finiteNumberArb,
        }),
        ({ label, value, ...base }) => {
          const spec: ChartSpec = { ...base, labels: [label], values: [value] };
          const rows = toChartRows(spec);
          expect(rows).toHaveLength(1);
          expect(rows[0]).toEqual({ name: label, value });
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("ChartInline — one inline chart rendered per spec, in order", () => {
  function chartCards(container: HTMLElement): HTMLElement[] {
    return Array.from(
      container.querySelectorAll<HTMLElement>('[data-slot="chart-inline"]'),
    );
  }

  it("renders one framed chart card per spec, preserving order (Req 4.1, 4.10)", () => {
    // Feature: cloud-bill-analyst-web-iteration-2, Property 7: One inline chart is rendered per spec, in order — rendering a set of specs produces one chart per spec in order (match by the data-chart-type attribute and the caption title the component sets).
    fc.assert(
      fc.property(
        fc.array(chartTypeArb, { minLength: 1, maxLength: 6 }),
        (chartTypes) => {
          const specs = chartTypes.map((t, i) => specWithIndex(t, i));

          const { container, unmount } = render(
            <>
              {specs.map((spec) => (
                <ChartInline key={spec.id} spec={spec} />
              ))}
            </>,
          );

          try {
            const cards = chartCards(container);
            // Exactly one framed card per spec.
            expect(cards).toHaveLength(specs.length);

            // Cards appear in the same order as the specs: chart_type + caption.
            cards.forEach((card, i) => {
              expect(card).toHaveAttribute("data-chart-type", specs[i].chart_type);
              const title = card.querySelector<HTMLElement>('[data-slot="card-title"]');
              expect(title).not.toBeNull();
              expect(title!.textContent).toBe(specs[i].title);
            });
          } finally {
            unmount();
          }
        },
      ),
      { numRuns: 30 },
    );
  });

  it("renders a single chart card for a single spec (Req 4.1)", () => {
    // Feature: cloud-bill-analyst-web-iteration-2, Property 7: One inline chart is rendered per spec, in order — a single ChartInline yields exactly one framed card captioned with its title.
    const spec = specWithIndex("bar", 0);
    const { container, unmount } = render(<ChartInline spec={spec} />);
    try {
      const cards = chartCards(container);
      expect(cards).toHaveLength(1);
      expect(cards[0]).toHaveAttribute("data-chart-type", "bar");
      const title = cards[0].querySelector<HTMLElement>('[data-slot="card-title"]');
      expect(title!.textContent).toBe(spec.title);
    } finally {
      unmount();
    }
  });

  it("renders one card with an empty-state placeholder for an empty spec (Req 4.8, 4.10)", () => {
    // Feature: cloud-bill-analyst-web-iteration-2, Property 7: One inline chart is rendered per spec, in order — an empty-labels spec still renders exactly one framed card (with a chart-empty placeholder, no throw).
    const spec: ChartSpec = {
      id: "empty",
      chart_type: "pie",
      title: "Empty Chart",
      currency: "USD",
      labels: [],
      values: [],
    };
    const { container, unmount } = render(<ChartInline spec={spec} />);
    try {
      const cards = chartCards(container);
      expect(cards).toHaveLength(1);
      expect(
        container.querySelector('[data-slot="chart-empty"]'),
      ).not.toBeNull();
    } finally {
      unmount();
    }
  });
});
