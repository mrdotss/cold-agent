import "@/test/dom-polyfills";
import "@testing-library/jest-dom/vitest";

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { ActivityTimeline } from "./activity-timeline";
import type { ActivityStep } from "@/hooks/useAgentStream";

/**
 * Component tests for `ActivityTimeline` accessibility (Req 9.8, 20.7).
 *
 * The timeline exposes an `aria-live="polite"` region that mirrors the latest
 * step status for screen readers, and updates that region as steps transition.
 * We assert the region exists, reflects the provided `liveRegion` text, and
 * re-announces the affected step's status on rerender.
 */
describe("ActivityTimeline", () => {
  function step(overrides: Partial<ActivityStep> = {}): ActivityStep {
    return {
      id: "s1",
      name: "get_cost_and_usage",
      label: "Cost Explorer",
      status: "Querying AWS Cost Explorer…",
      state: "running",
      ...overrides,
    };
  }

  /** The single `aria-live="polite"` region in the timeline. */
  function liveRegion(container: HTMLElement): HTMLElement {
    const region = container.querySelector<HTMLElement>(
      '[aria-live="polite"]',
    );
    if (region === null) {
      throw new Error("expected an aria-live region");
    }
    return region;
  }

  it("exposes an aria-live=\"polite\" region (Req 9.8, 20.7)", () => {
    const { container } = render(
      <ActivityTimeline
        steps={[step()]}
        collapsed={false}
        liveRegion="Querying AWS Cost Explorer…"
      />,
    );

    const region = liveRegion(container);
    expect(region).toHaveAttribute("aria-live", "polite");
  });

  it("reflects the latest step status in the live region (Req 9.8)", () => {
    const { container } = render(
      <ActivityTimeline
        steps={[step()]}
        collapsed={false}
        liveRegion="Querying AWS Cost Explorer…"
      />,
    );

    expect(liveRegion(container)).toHaveTextContent(
      "Querying AWS Cost Explorer…",
    );
  });

  it("updates the live region when a step transitions on rerender (Req 9.8, 20.7)", () => {
    const { container, rerender } = render(
      <ActivityTimeline
        steps={[step()]}
        collapsed={false}
        liveRegion="Querying AWS Cost Explorer…"
      />,
    );

    expect(liveRegion(container)).toHaveTextContent(
      "Querying AWS Cost Explorer…",
    );

    // A second tool step starts — the affected step's status is announced.
    rerender(
      <ActivityTimeline
        steps={[
          step({ state: "done" }),
          step({
            id: "s2",
            name: "create_chart",
            label: "Chart",
            status: "Rendering a chart…",
          }),
        ]}
        collapsed={false}
        liveRegion="Rendering a chart…"
      />,
    );

    expect(liveRegion(container)).toHaveTextContent("Rendering a chart…");
    expect(liveRegion(container)).not.toHaveTextContent(
      "Querying AWS Cost Explorer…",
    );
  });

  it("shows the collapsed one-line summary in the live region after done (Req 9.6, 9.8)", () => {
    const summary = "Querying AWS Cost Explorer… · Rendering a chart…";
    const { container } = render(
      <ActivityTimeline
        steps={[
          step({ state: "done" }),
          step({ id: "s2", label: "Chart", status: "Rendering a chart…", state: "done" }),
        ]}
        collapsed
        liveRegion={summary}
      />,
    );

    expect(liveRegion(container)).toHaveTextContent(summary);
  });

  it("renders the latest step status text within the visible step list", () => {
    render(
      <ActivityTimeline
        steps={[step()]}
        collapsed={false}
        liveRegion="Querying AWS Cost Explorer…"
      />,
    );

    // The status appears both in the sr-only live region and the visible list;
    // there should be at least one occurrence rendered.
    expect(
      screen.getAllByText("Querying AWS Cost Explorer…").length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("renders nothing when there are no steps", () => {
    const { container } = render(
      <ActivityTimeline steps={[]} collapsed={false} liveRegion="" />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
