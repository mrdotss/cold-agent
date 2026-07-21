import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { PROPERTY_TEST_RUNS } from "./setup";

describe("test harness smoke", () => {
  it("reverses an array twice to recover the original", () => {
    fc.assert(
      fc.property(fc.array(fc.integer()), (xs) => {
        const roundTrip = [...xs].reverse().reverse();
        expect(roundTrip).toEqual(xs);
      }),
    );
  });

  it("applies the shared >= 100 iteration default", () => {
    let runs = 0;
    fc.assert(
      fc.property(fc.integer(), () => {
        runs += 1;
        return true;
      }),
    );
    expect(PROPERTY_TEST_RUNS).toBeGreaterThanOrEqual(100);
    expect(runs).toBeGreaterThanOrEqual(100);
  });
});
