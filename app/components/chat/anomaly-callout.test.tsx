import "@/test/dom-polyfills";
import "@testing-library/jest-dom/vitest";

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { AnomalyCallout } from "./anomaly-callout";
import type { Anomaly } from "@/lib/anomaly";

/**
 * Component tests for `AnomalyCallout` (Req 13.3, 13.7).
 *
 * The callout renders exactly ONE inline note per anomaly, labelled with its
 * classification and carrying the accent the shared mapping produces (Req 13.3):
 * a spike uses the ROSE accent (left rail `border-l-rose-500`); a new service or
 * a large MoM delta uses the AMBER accent (`border-l-amber-500`). With zero
 * anomalies it renders nothing (Req 13.7).
 *
 * We assert against the stable left-rail accent indicator rather than the full
 * class string, plus include a small structural snapshot.
 */
describe("AnomalyCallout", () => {
  function anomaly(overrides: Partial<Anomaly> = {}): Anomaly {
    return {
      service: "Amazon EC2",
      kind: "spike",
      detail: { latestDaily: 30, trailing7DayAvg: 10, ratio: 3 },
      ...overrides,
    };
  }

  /** The `role="note"` callout elements. */
  function noteEls(): HTMLElement[] {
    return screen.queryAllByRole("note");
  }

  it("renders one callout per anomaly, each labelled with its classification (Req 13.3)", () => {
    const anomalies: Anomaly[] = [
      anomaly({ service: "Amazon EC2", kind: "spike" }),
      anomaly({ service: "Amazon S3", kind: "new_service", detail: { currentMonthCost: 12, previousFullMonthCost: 0 } }),
      anomaly({
        service: "AWS Lambda",
        kind: "large_mom_delta",
        detail: { currentMonthCost: 40, previousFullMonthCost: 10, momRatio: 3 },
      }),
    ];

    render(<AnomalyCallout anomalies={anomalies} />);

    const notes = noteEls();
    expect(notes).toHaveLength(3);
    expect(notes[0]).toHaveTextContent("Spike");
    expect(notes[0]).toHaveTextContent("Amazon EC2");
    expect(notes[1]).toHaveTextContent("New service");
    expect(notes[1]).toHaveTextContent("Amazon S3");
    expect(notes[2]).toHaveTextContent("Large MoM delta");
    expect(notes[2]).toHaveTextContent("AWS Lambda");
  });

  it("applies the ROSE accent to a spike callout (Req 13.3)", () => {
    render(<AnomalyCallout anomalies={[anomaly({ kind: "spike" })]} />);

    const [note] = noteEls();
    expect(note.className).toContain("border-l-rose-500");
    expect(note.className).not.toContain("border-l-amber-500");
  });

  it("applies the AMBER accent to a new_service callout (Req 13.3)", () => {
    render(
      <AnomalyCallout
        anomalies={[
          anomaly({ kind: "new_service", detail: { currentMonthCost: 12, previousFullMonthCost: 0 } }),
        ]}
      />,
    );

    const [note] = noteEls();
    expect(note.className).toContain("border-l-amber-500");
    expect(note.className).not.toContain("border-l-rose-500");
  });

  it("applies the AMBER accent to a large_mom_delta callout (Req 13.3)", () => {
    render(
      <AnomalyCallout
        anomalies={[
          anomaly({
            kind: "large_mom_delta",
            detail: { currentMonthCost: 40, previousFullMonthCost: 10, momRatio: 3 },
          }),
        ]}
      />,
    );

    const [note] = noteEls();
    expect(note.className).toContain("border-l-amber-500");
    expect(note.className).not.toContain("border-l-rose-500");
  });

  it("renders nothing when there are no anomalies (Req 13.7)", () => {
    const { container } = render(<AnomalyCallout anomalies={[]} />);
    expect(container).toBeEmptyDOMElement();
    expect(noteEls()).toHaveLength(0);
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

    render(<AnomalyCallout anomalies={anomalies} />);

    const summary = noteEls().map((note) => ({
      label: note.className.includes("border-l-rose-500")
        ? "rose"
        : note.className.includes("border-l-amber-500")
          ? "amber"
          : "none",
    }));

    expect(summary).toMatchSnapshot();
  });
});
