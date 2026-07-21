import "@/test/dom-polyfills";
import "@testing-library/jest-dom/vitest";

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";

import { AnomalyBadges } from "./anomaly-badges";
import type { Anomaly } from "@/lib/anomaly";

/**
 * Component tests for `AnomalyBadges` (Req 13.2, 13.3, 13.7).
 *
 * The badges render exactly ONE chip per anomaly, each labelled with its
 * classification (Spike / New service / Large MoM delta — Req 13.2) and carrying
 * the accent the shared mapping produces (Req 13.3): rose for a spike, amber for
 * a new service or a large MoM delta. With zero anomalies the component renders
 * nothing (Req 13.7).
 *
 * Accent is applied as Tailwind color classes on each list item, so we assert
 * against a stable accent indicator (`bg-rose-50` / `bg-amber-50`) rather than
 * the full class string, plus include a small structural snapshot.
 */
describe("AnomalyBadges", () => {
  function anomaly(overrides: Partial<Anomaly> = {}): Anomaly {
    return {
      service: "Amazon EC2",
      kind: "spike",
      detail: { latestDaily: 30, trailing7DayAvg: 10, ratio: 3 },
      ...overrides,
    };
  }

  /** The `<li>` badge elements rendered inside the section. */
  function badgeItems(container: HTMLElement): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>("li"));
  }

  it("renders one badge per anomaly (Req 13.2)", () => {
    const anomalies: Anomaly[] = [
      anomaly({ service: "Amazon EC2", kind: "spike" }),
      anomaly({ service: "Amazon S3", kind: "new_service", detail: { currentMonthCost: 12, previousFullMonthCost: 0 } }),
      anomaly({
        service: "AWS Lambda",
        kind: "large_mom_delta",
        detail: { currentMonthCost: 40, previousFullMonthCost: 10, momRatio: 3 },
      }),
    ];

    const { container } = render(<AnomalyBadges anomalies={anomalies} />);

    expect(badgeItems(container)).toHaveLength(3);
  });

  it("labels each badge with its classification (Req 13.2)", () => {
    const anomalies: Anomaly[] = [
      anomaly({ service: "Amazon EC2", kind: "spike" }),
      anomaly({ service: "Amazon S3", kind: "new_service", detail: { currentMonthCost: 12, previousFullMonthCost: 0 } }),
      anomaly({
        service: "AWS Lambda",
        kind: "large_mom_delta",
        detail: { currentMonthCost: 40, previousFullMonthCost: 10, momRatio: 3 },
      }),
    ];

    const { container } = render(<AnomalyBadges anomalies={anomalies} />);

    const items = badgeItems(container);
    expect(items[0]).toHaveTextContent("Spike");
    expect(items[0]).toHaveTextContent("Amazon EC2");
    expect(items[1]).toHaveTextContent("New service");
    expect(items[1]).toHaveTextContent("Amazon S3");
    expect(items[2]).toHaveTextContent("Large MoM delta");
    expect(items[2]).toHaveTextContent("AWS Lambda");
  });

  it("applies the ROSE accent to a spike badge (Req 13.3)", () => {
    const { container } = render(
      <AnomalyBadges anomalies={[anomaly({ kind: "spike" })]} />,
    );

    const [item] = badgeItems(container);
    expect(item.className).toContain("bg-rose-50");
    expect(item.className).not.toContain("bg-amber-50");
  });

  it("applies the AMBER accent to a new_service badge (Req 13.3)", () => {
    const { container } = render(
      <AnomalyBadges
        anomalies={[
          anomaly({ kind: "new_service", detail: { currentMonthCost: 12, previousFullMonthCost: 0 } }),
        ]}
      />,
    );

    const [item] = badgeItems(container);
    expect(item.className).toContain("bg-amber-50");
    expect(item.className).not.toContain("bg-rose-50");
  });

  it("applies the AMBER accent to a large_mom_delta badge (Req 13.3)", () => {
    const { container } = render(
      <AnomalyBadges
        anomalies={[
          anomaly({
            kind: "large_mom_delta",
            detail: { currentMonthCost: 40, previousFullMonthCost: 10, momRatio: 3 },
          }),
        ]}
      />,
    );

    const [item] = badgeItems(container);
    expect(item.className).toContain("bg-amber-50");
    expect(item.className).not.toContain("bg-rose-50");
  });

  it("renders nothing when there are no anomalies (Req 13.7)", () => {
    const { container } = render(<AnomalyBadges anomalies={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("matches a stable structural snapshot for the three kinds", () => {
    const anomalies: Anomaly[] = [
      anomaly({ service: "Amazon EC2", kind: "spike" }),
      anomaly({ service: "Amazon S3", kind: "new_service", detail: { currentMonthCost: 12, previousFullMonthCost: 0 } }),
      anomaly({
        service: "AWS Lambda",
        kind: "large_mom_delta",
        detail: { currentMonthCost: 40, previousFullMonthCost: 10, momRatio: 3 },
      }),
    ];

    const { container } = render(<AnomalyBadges anomalies={anomalies} />);

    const summary = badgeItems(container).map((li) => ({
      text: li.textContent?.replace(/\s+/g, " ").trim(),
      accent: li.className.includes("bg-rose-50")
        ? "rose"
        : li.className.includes("bg-amber-50")
          ? "amber"
          : "none",
    }));

    expect(summary).toMatchSnapshot();
  });
});
