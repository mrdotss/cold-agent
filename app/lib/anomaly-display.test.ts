import { describe, it, expect } from "vitest";

import { anomalyDisplay } from "./anomaly-display";
import type { AnomalyKind } from "./anomaly";

/**
 * Unit tests for the shared anomaly display mapping (Req 13.2, 13.3).
 *
 * `anomaly-display.ts` is the single source of truth for how each
 * {@link AnomalyKind} is labelled and accented, so both the dashboard badges and
 * the inline chat callouts stay in lockstep. We assert the documented
 * label + accent for every kind, and that a spike is ROSE while a new service or
 * large MoM delta is AMBER (Req 13.3).
 */
describe("anomalyDisplay", () => {
  it("maps spike to the Spike label with a rose accent (Req 13.3)", () => {
    expect(anomalyDisplay("spike")).toEqual({ label: "Spike", accent: "rose" });
  });

  it("maps new_service to the New service label with an amber accent (Req 13.3)", () => {
    expect(anomalyDisplay("new_service")).toEqual({
      label: "New service",
      accent: "amber",
    });
  });

  it("maps large_mom_delta to the Large MoM delta label with an amber accent (Req 13.3)", () => {
    expect(anomalyDisplay("large_mom_delta")).toEqual({
      label: "Large MoM delta",
      accent: "amber",
    });
  });

  it("only ever uses rose for a spike; new service + large MoM delta are amber (Req 13.3)", () => {
    const kinds: AnomalyKind[] = ["spike", "new_service", "large_mom_delta"];
    const accents = Object.fromEntries(
      kinds.map((k) => [k, anomalyDisplay(k).accent]),
    );
    expect(accents).toEqual({
      spike: "rose",
      new_service: "amber",
      large_mom_delta: "amber",
    });
  });
});
