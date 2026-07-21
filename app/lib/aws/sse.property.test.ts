import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { parseSseChunk, toKnownEvent, type SseEvent } from "./sse";

/**
 * Each generated item carries the raw upstream payload plus the oracle:
 * `expected` is the canonical `SseEvent` a valid payload maps to, or `null`
 * when the payload is unknown/malformed and must be dropped.
 */
type Item = { raw: unknown; expected: SseEvent | null };

// --- Known-event arbitraries: raw payload + its canonical expected output. ---

const deltaArb: fc.Arbitrary<Item> = fc.string().map((text) => ({
  raw: { type: "delta", text },
  expected: { type: "delta", text },
}));

const toolStartArb: fc.Arbitrary<Item> = fc
  .record({
    id: fc.string(),
    name: fc.string(),
    label: fc.string(),
    status: fc.string(),
  })
  .map(({ id, name, label, status }) => ({
    raw: { type: "tool", phase: "start", id, name, label, status },
    expected: { type: "tool", phase: "start", id, name, label, status },
  }));

const toolEndArb: fc.Arbitrary<Item> = fc
  .record({ id: fc.string(), name: fc.string() })
  .map(({ id, name }) => ({
    raw: { type: "tool", phase: "end", id, name },
    expected: { type: "tool", phase: "end", id, name },
  }));

const reportFileArb: fc.Arbitrary<Item> = fc
  .record({ key: fc.string(), bucket: fc.string() })
  .map(({ key, bucket }) => ({
    raw: { type: "report_file", key, bucket },
    expected: { type: "report_file", key, bucket },
  }));

const errorArb: fc.Arbitrary<Item> = fc.string().map((message) => ({
  raw: { type: "error", message },
  expected: { type: "error", message },
}));

const doneArb: fc.Arbitrary<Item> = fc.constant({
  raw: { type: "done" },
  expected: { type: "done" },
} as Item);

const knownArb: fc.Arbitrary<Item> = fc.oneof(
  deltaArb,
  toolStartArb,
  toolEndArb,
  reportFileArb,
  errorArb,
  doneArb,
);

// --- Unknown/malformed arbitraries: raw payload with expected === null. ---

const unknownArb: fc.Arbitrary<Item> = fc.oneof(
  // Unknown event type.
  fc.record({ type: fc.constant("heartbeat"), ts: fc.integer() }).map((raw) => ({ raw, expected: null })),
  // delta missing/invalid text.
  fc.constant({ raw: { type: "delta" }, expected: null } as Item),
  fc.integer().map((text) => ({ raw: { type: "delta", text }, expected: null })),
  // tool with an unrecognized phase.
  fc.record({ type: fc.constant("tool"), phase: fc.constant("weird") }).map((raw) => ({ raw, expected: null })),
  // tool start missing required string fields.
  fc.constant({ raw: { type: "tool", phase: "start", id: "x" }, expected: null } as Item),
  // tool end missing name.
  fc.constant({ raw: { type: "tool", phase: "end", id: "x" }, expected: null } as Item),
  // report_file missing bucket.
  fc.string().map((key) => ({ raw: { type: "report_file", key }, expected: null })),
  // error missing message.
  fc.constant({ raw: { type: "error" }, expected: null } as Item),
  // Objects with no type / random shape.
  fc.dictionary(fc.string(), fc.integer()).map((raw) => ({ raw: { ...raw, type: undefined }, expected: null })),
  // Non-record JSON values.
  fc.oneof(fc.integer(), fc.string(), fc.constant(null), fc.array(fc.integer())).map((raw) => ({ raw, expected: null })),
);

const itemArb: fc.Arbitrary<Item> = fc.oneof(
  { weight: 3, arbitrary: knownArb },
  { weight: 2, arbitrary: unknownArb },
);

describe("SSE relay filtering and ordering property", () => {
  it("preserves known-event order, drops unknown, and round-trips through parseSseChunk", () => {
    // Feature: cloud-bill-analyst-web, Property 16: For any sequence of upstream SSE events, filtering through toKnownEvent preserves the order of known events and drops unknown ones, and parseSseChunk parses serialized events back in order.
    fc.assert(
      fc.property(fc.array(itemArb, { maxLength: 40 }), (items) => {
        const raws = items.map((i) => i.raw);
        const expecteds = items.map((i) => i.expected);

        // Element-wise mapping: covers BOTH ordering (index preserved) and
        // filtering (unknown/malformed map to null).
        const mapped = raws.map(toKnownEvent);
        expect(mapped).toEqual(expecteds);

        // Dropping the nulls preserves the relative order of the known events.
        const filtered = mapped.filter((e) => e !== null);
        const expectedKnown = expecteds.filter((e): e is SseEvent => e !== null);
        expect(filtered).toEqual(expectedKnown);

        // Round-trip: serialize the known events as SSE data blocks, parse them
        // back, and confirm we recover the same events in the same order with
        // no trailing remainder.
        const buffer = expectedKnown.map((e) => `data:${JSON.stringify(e)}\n\n`).join("");
        const { events, rest } = parseSseChunk(buffer);
        expect(rest).toBe("");
        expect(events.map(toKnownEvent)).toEqual(expectedKnown);
      }),
    );
  });
});
