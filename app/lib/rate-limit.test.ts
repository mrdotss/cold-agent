import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  isLockedOutFromFailures,
  FAILED_ATTEMPT_THRESHOLD,
  LOCKOUT_WINDOW_MS,
} from "@/lib/rate-limit";

describe("isLockedOutFromFailures property", () => {
  it("is locked at `now` IFF >= 5 failures fall within [now - 15min, now]", () => {
    // Feature: cloud-bill-analyst-web, Property 5: Login rate-limit lockout
    // Validates: Requirements 2.9
    //
    // For any sequence of failed-attempt timestamps for a single normalized
    // email, the account is locked at instant `now` iff at least
    // FAILED_ATTEMPT_THRESHOLD (5) of those failures fall within the inclusive
    // trailing window [now - LOCKOUT_WINDOW_MS, now]. We generate `now` and an
    // arbitrary number of failure timestamps at offsets that straddle both
    // window boundaries (older than 15min, inside the window, and in the future
    // after `now`) so both the locked and unlocked outcomes are exercised.

    fc.assert(
      fc.property(
        // `now` as an epoch-ms instant (bounded to keep dates sane).
        fc.integer({ min: 0, max: 4_102_444_800_000 }),
        // Offsets (ms) of each failure relative to `now`. The range straddles
        // both boundaries: below -LOCKOUT_WINDOW_MS (aged out), inside the
        // window, and above 0 (in the future). Padding of one minute past each
        // edge guarantees out-of-window samples occur.
        fc.array(
          fc.integer({ min: -LOCKOUT_WINDOW_MS - 60_000, max: 60_000 }),
          { minLength: 0, maxLength: 40 },
        ),
        (nowMs, offsets) => {
          const now = new Date(nowMs);
          const failureTimestamps = offsets.map(
            (offset) => new Date(nowMs + offset),
          );

          // Independent oracle: count failures inside the inclusive window.
          const windowStartMs = nowMs - LOCKOUT_WINDOW_MS;
          const countInWindow = failureTimestamps.reduce((count, ts) => {
            const ms = ts.getTime();
            return ms >= windowStartMs && ms <= nowMs ? count + 1 : count;
          }, 0);

          const expected = countInWindow >= FAILED_ATTEMPT_THRESHOLD;
          expect(isLockedOutFromFailures(failureTimestamps, now)).toBe(expected);
        },
      ),
    );
  });

  it("counts failures exactly on both inclusive boundaries", () => {
    // Feature: cloud-bill-analyst-web, Property 5: Login rate-limit lockout
    // Validates: Requirements 2.9
    //
    // Explicit boundary coverage: the window [now - 15min, now] is inclusive on
    // both ends, so failures landing exactly on `now` and exactly on
    // `now - LOCKOUT_WINDOW_MS` must count toward the threshold.
    const now = new Date("2025-06-15T12:00:00.000Z");
    const nowMs = now.getTime();

    // Threshold-1 on the newest edge + 1 on the oldest edge = threshold total.
    const onNow = Array.from(
      { length: FAILED_ATTEMPT_THRESHOLD - 1 },
      () => new Date(nowMs),
    );
    const onWindowStart = new Date(nowMs - LOCKOUT_WINDOW_MS);
    expect(
      isLockedOutFromFailures([...onNow, onWindowStart], now),
    ).toBe(true);

    // One millisecond past either edge falls outside the window, dropping the
    // qualifying count below the threshold.
    const justAfterNow = new Date(nowMs + 1);
    const justBeforeWindow = new Date(nowMs - LOCKOUT_WINDOW_MS - 1);
    expect(
      isLockedOutFromFailures(
        [...onNow, justAfterNow, justBeforeWindow],
        now,
      ),
    ).toBe(false);
  });
});
