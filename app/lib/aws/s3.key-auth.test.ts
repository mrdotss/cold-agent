import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { keyBelongsToActor, REPORT_PREFIX } from "./s3";

// A path segment that is non-empty and contains no "/", so positive and
// negative classes stay clean (an actor id / filename is a single segment).
const segment = () =>
  fc.string({ minLength: 1 }).filter((s) => !s.includes("/"));

describe("report key authorization property", () => {
  it("keyBelongsToActor authorizes IFF the key has the exact cloud-bill-analyst/reports/<actorId>/<filename> shape", () => {
    // Feature: cloud-bill-analyst-web, Property 23: Report key authorization

    // POSITIVE: any valid actor id + any valid single-segment filename yields a
    // key that belongs to that actor.
    fc.assert(
      fc.property(segment(), segment(), (actorId, filename) => {
        const key = `${REPORT_PREFIX}${actorId}/${filename}`;
        expect(keyBelongsToActor(actorId, key)).toBe(true);
      }),
      { numRuns: 200 },
    );

    // NEGATIVE: a key minted for a DIFFERENT actor id must not authorize.
    fc.assert(
      fc.property(segment(), segment(), segment(), (actorId, actorId2, file) => {
        fc.pre(actorId !== actorId2);
        const key = `${REPORT_PREFIX}${actorId2}/${file}`;
        expect(keyBelongsToActor(actorId, key)).toBe(false);
      }),
      { numRuns: 200 },
    );

    // NEGATIVE: prefix-only / missing filename segment.
    fc.assert(
      fc.property(segment(), (actorId) => {
        expect(keyBelongsToActor(actorId, `${REPORT_PREFIX}${actorId}`)).toBe(false);
        expect(keyBelongsToActor(actorId, `${REPORT_PREFIX}${actorId}/`)).toBe(false);
      }),
      { numRuns: 200 },
    );

    // NEGATIVE: substring/prefix spoof — `<actorId>-evil/...` must not match.
    fc.assert(
      fc.property(segment(), segment(), (actorId, file) => {
        const key = `${REPORT_PREFIX}${actorId}-evil/${file}`;
        expect(keyBelongsToActor(actorId, key)).toBe(false);
      }),
      { numRuns: 200 },
    );

    // NEGATIVE: nested subpath — an extra segment after the actor id, and the
    // actor id buried below another actor's folder, must not match.
    fc.assert(
      fc.property(segment(), segment(), segment(), (actorId, sub, file) => {
        const extraSegment = `${REPORT_PREFIX}${actorId}/${sub}/${file}`;
        expect(keyBelongsToActor(actorId, extraSegment)).toBe(false);
      }),
      { numRuns: 200 },
    );

    fc.assert(
      fc.property(segment(), segment(), segment(), (actorId, other, file) => {
        fc.pre(other !== actorId);
        const buried = `${REPORT_PREFIX}${other}/${actorId}/${file}`;
        expect(keyBelongsToActor(actorId, buried)).toBe(false);
      }),
      { numRuns: 200 },
    );

    // NEGATIVE: keys that don't start with REPORT_PREFIX.
    fc.assert(
      fc.property(segment(), segment(), (actorId, file) => {
        const key = `not-the-prefix/${actorId}/${file}`;
        fc.pre(!key.startsWith(REPORT_PREFIX));
        expect(keyBelongsToActor(actorId, key)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });
});
