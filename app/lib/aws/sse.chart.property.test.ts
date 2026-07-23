import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { toKnownEvent, type ChartSpec } from "./sse";

/**
 * Property tests for the `chart` narrowing case added to `toKnownEvent`
 * (Requirements 2.1, 2.2, 2.3, 2.5). These extend the arbitraries in
 * `sse.property.test.ts` with a valid `ChartSpec` generator and a "malformed
 * chart" generator that breaks exactly one chart invariant per case.
 *
 * Numeric `values` are generated with `fc.double({ noNaN: true,
 * noDefaultInfinity: true })`. The validator only checks `typeof === "number"`
 * (so NaN/Infinity would technically pass narrowing), but excluding them keeps
 * the deep-equality oracle in Property 1 clean and unambiguous while still
 * exercising the full range of finite JS numbers the validator accepts.
 */

/** The chart types the validator accepts (kept in sync with `sse.ts`). */
const CHART_TYPES = ["bar", "hbar", "line", "pie"] as const;
const CHART_TYPE_SET: ReadonlySet<string> = new Set(CHART_TYPES);

/** The known top-level event vocabulary (kept in sync with `sse.ts`). */
const KNOWN_TYPES: ReadonlySet<string> = new Set([
  "delta",
  "tool",
  "chart",
  "report_file",
  "error",
  "done",
]);

const chartTypeArb = fc.constantFrom<ChartSpec["chart_type"]>(...CHART_TYPES);

const finiteNumberArb = fc.double({ noNaN: true, noDefaultInfinity: true });

/**
 * A valid `ChartSpec`: `labels` (string[]) and `values` (number[]) always share
 * the same length, generated from a shared length so the equal-length invariant
 * holds by construction.
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

/** Non-object `spec` values (integer/number/string/boolean/null/array). */
const notObjectSpecArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.integer(),
  finiteNumberArb,
  fc.string(),
  fc.boolean(),
  fc.constant(null),
  fc.array(fc.integer()),
);

/**
 * A `chart`-typed event that breaks EXACTLY ONE invariant. Each branch starts
 * from a valid spec (or valid materials) and mutates a single dimension so the
 * event is dropped for exactly one reason.
 */
const malformedChartArb: fc.Arbitrary<unknown> = fc.oneof(
  // (a) spec is not an object.
  notObjectSpecArb.map((spec) => ({ type: "chart", spec })),

  // (b) chart_type is outside the enum (non-enum string or non-string), all
  // other fields left valid and equal-length.
  fc
    .tuple(
      validChartSpecArb,
      fc.oneof(
        fc.string().filter((s) => !CHART_TYPE_SET.has(s)),
        fc.integer(),
      ),
    )
    .map(([spec, badType]) => ({ type: "chart", spec: { ...spec, chart_type: badType } })),

  // (c) labels is not a string array (one element replaced with a number),
  // length kept equal to values so ONLY the labels-type invariant breaks.
  validChartSpecArb
    .filter((s) => s.labels.length > 0)
    .map((spec) => {
      const labels: unknown[] = [...spec.labels];
      labels[0] = 123;
      return { type: "chart", spec: { ...spec, labels } };
    }),

  // (d) values is not a number array (one element replaced with a string),
  // length kept equal to labels so ONLY the values-type invariant breaks.
  validChartSpecArb
    .filter((s) => s.values.length > 0)
    .map((spec) => {
      const values: unknown[] = [...spec.values];
      values[0] = "not-a-number";
      return { type: "chart", spec: { ...spec, values } };
    }),

  // (e) labels.length !== values.length; both remain well-typed arrays.
  fc
    .tuple(fc.nat({ max: 8 }), fc.nat({ max: 8 }))
    .filter(([la, lv]) => la !== lv)
    .chain(([la, lv]) =>
      fc.record({
        id: fc.string(),
        chart_type: chartTypeArb,
        title: fc.string(),
        currency: fc.string(),
        labels: fc.array(fc.string(), { minLength: la, maxLength: la }),
        values: fc.array(finiteNumberArb, { minLength: lv, maxLength: lv }),
      }),
    )
    .map((spec) => ({ type: "chart", spec })),
);

/** A top-level `type` string that is not in the known vocabulary. */
const unknownTypeArb = fc.string().filter((t) => !KNOWN_TYPES.has(t));

describe("toKnownEvent — chart narrowing properties", () => {
  it("narrows a valid chart event to an equal chart event", () => {
    // Feature: cloud-bill-analyst-web-iteration-2, Property 1: Valid chart events narrow to an equal chart event — for any valid ChartSpec, toKnownEvent on a { type: "chart", spec } event returns a chart event whose spec deep-equals the input spec.
    fc.assert(
      fc.property(validChartSpecArb, (spec) => {
        const result = toKnownEvent({ type: "chart", spec });
        expect(result).toEqual({ type: "chart", spec });
        // Spec fields are preserved individually (id, chart_type, title,
        // currency, labels, values) and order within the arrays is kept.
        expect(result).not.toBeNull();
        expect(result!.type).toBe("chart");
        const got = (result as { type: "chart"; spec: ChartSpec }).spec;
        expect(got.id).toBe(spec.id);
        expect(got.chart_type).toBe(spec.chart_type);
        expect(got.title).toBe(spec.title);
        expect(got.currency).toBe(spec.currency);
        expect(got.labels).toEqual(spec.labels);
        expect(got.values).toEqual(spec.values);
      }),
      { numRuns: 200 },
    );
  });

  it("drops a malformed chart event that breaks exactly one invariant", () => {
    // Feature: cloud-bill-analyst-web-iteration-2, Property 2: Malformed chart events are dropped — for any chart-typed event that violates a chart invariant (spec not an object, chart_type outside the enum, labels/values of differing lengths, or non-array labels/values), toKnownEvent returns null.
    fc.assert(
      fc.property(malformedChartArb, (raw) => {
        expect(toKnownEvent(raw)).toBeNull();
      }),
      { numRuns: 300 },
    );
  });

  it("drops any event whose type is unknown, leaving subsequent events unaffected", () => {
    // Feature: cloud-bill-analyst-web-iteration-2, Property 3: Unknown event types are always dropped — for any event whose top-level type is none of delta, tool, chart, report_file, error, done, toKnownEvent returns null, and processing of subsequent events is unaffected.
    fc.assert(
      fc.property(
        unknownTypeArb,
        fc.dictionary(fc.string(), fc.oneof(fc.string(), fc.integer(), fc.boolean())),
        (type, extra) => {
          // Arbitrary extra fields alongside the unknown type must not rescue it.
          const raw = { ...extra, type };
          expect(toKnownEvent(raw)).toBeNull();
        },
      ),
      { numRuns: 200 },
    );

    // A batch of unknown events interleaved with a known `delta` confirms that
    // dropping unknowns does not disturb narrowing of the surrounding events.
    fc.assert(
      fc.property(
        fc.array(unknownTypeArb, { maxLength: 10 }),
        fc.string(),
        (unknownTypes, text) => {
          const raws = [...unknownTypes.map((t) => ({ type: t })), { type: "delta", text }];
          const mapped = raws.map(toKnownEvent);
          for (let i = 0; i < unknownTypes.length; i += 1) {
            expect(mapped[i]).toBeNull();
          }
          expect(mapped[mapped.length - 1]).toEqual({ type: "delta", text });
        },
      ),
      { numRuns: 100 },
    );
  });
});
