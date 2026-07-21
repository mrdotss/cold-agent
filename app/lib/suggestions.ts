/**
 * Recommendation-style prompt-chip generation for the chat empty state / idle
 * composer (Requirement 16).
 *
 * This module is PURE and deterministic (no I/O, no AWS SDK, no secrets, no
 * randomness), which is why it deliberately does NOT `import "server-only"`:
 * given the same `ctx` and `previous` it always returns the same chips, so it
 * can be property-tested directly (Properties 28 and 29).
 *
 * Contract:
 *  - Returns between 3 and 6 chips whenever at least 3 valid chips are
 *    available; each chip is a distinct, non-empty string of 1..120 characters
 *    (Req 16.1 / Property 28).
 *  - At least half of the returned chips differ in wording from `previous`
 *    (the chips shown on the immediately preceding render within the same
 *    thread) (Req 16.3 / Property 29).
 *  - Returns `[]` when fewer than 3 valid chips can be formed (Req 16.4).
 */

/** Bounds fixed by Requirement 16.1. */
export const MIN_CHIPS = 3;
export const MAX_CHIPS = 6;
export const MAX_CHIP_LENGTH = 120;

/**
 * Lightweight, browser-safe context used to phrase and rotate the suggestions.
 * Everything is optional except `hasAccount`; nothing here is a secret.
 */
export interface SuggestionCtx {
  /**
   * Whether the user has at least one connected AWS account. When false the
   * pool leans toward onboarding-style prompts; when true it leans toward
   * spend-analysis prompts.
   */
  hasAccount: boolean;
  /** ISO-4217 display currency (e.g. `IDR`, `USD`) used to phrase some chips. */
  displayCurrency?: string;
  /** Human-friendly connected-account alias used to phrase some chips. */
  accountAlias?: string;
  /**
   * Optional deterministic rotation seed (e.g. a per-thread render counter).
   * Varying it rotates the wording between renders. When omitted a stable
   * offset is derived from `previous`.
   */
  seed?: number;
}

/**
 * Normalize a candidate into a valid chip or `null`.
 *
 * A chip is valid when, after trimming, it is non-empty and its length does not
 * exceed {@link MAX_CHIP_LENGTH}. Over-long candidates are dropped rather than
 * silently truncated so the pool never emits awkward, cut-off wording.
 */
function toValidChip(candidate: string): string | null {
  const trimmed = candidate.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_CHIP_LENGTH) return null;
  return trimmed;
}

/**
 * Build the ordered pool of distinct candidate chips for the given context.
 *
 * The pool is intentionally large (>= 14 distinct phrasings) so the half-novel
 * rule (Req 16.3) is always satisfiable: a preceding render shows at most
 * {@link MAX_CHIPS} (6) chips, so at least `pool.length - 6 >= 8` novel chips
 * remain available on any subsequent render.
 */
function buildPool(ctx: SuggestionCtx): string[] {
  const currency = toValidChip(ctx.displayCurrency ?? "")?.toUpperCase();
  const alias = toValidChip(ctx.accountAlias ?? "");

  const analysisChips: string[] = [
    "Scan this month's spend",
    "Where did costs spike?",
    "Break down spend by service",
    "Compare this month to last month",
    "Forecast next month's bill",
    "Show my top 5 services by cost",
    "Any unused or idle resources?",
    "Export this month as a PDF report",
    "Export a spend breakdown to Excel",
    "What changed since last week?",
    "Show a daily cost trend chart",
    "Which region costs the most?",
    "Flag any unusual spending",
    "Summarize my current AWS bill",
    alias ? `Analyze spend for ${alias}` : "Analyze my connected account",
    currency ? `Show my total spend in ${currency}` : "Show my month-to-date total",
  ];

  const onboardingChips: string[] = [
    "How do I connect an AWS account?",
    "What can Cloud Bill Analyst do?",
    "Is my AWS access read-only?",
    "What permissions do you need?",
    "How do you keep my account secure?",
    "Walk me through connecting an account",
    "What reports can you generate?",
    "How does cost anomaly detection work?",
    "Which AWS costs can you analyze?",
    "Do you ever store my AWS keys?",
    "How do I export a PDF report?",
    "What happens after I connect an account?",
    "Can you detect spending spikes?",
    "Show me an example cost breakdown",
  ];

  const raw = ctx.hasAccount ? analysisChips : onboardingChips;

  // Validate and de-duplicate while preserving order.
  const seen = new Set<string>();
  const pool: string[] = [];
  for (const candidate of raw) {
    const chip = toValidChip(candidate);
    if (chip === null || seen.has(chip)) continue;
    seen.add(chip);
    pool.push(chip);
  }
  return pool;
}

/**
 * Deterministic, non-negative 32-bit hash of a string (FNV-1a variant). Used to
 * derive a stable rotation offset from `previous` when no explicit `seed` is
 * supplied, so wording still varies between renders.
 */
function hashString(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Generate 3..6 recommendation-style prompt chips (Requirement 16).
 *
 * Selection strategy:
 *  1. Build a large pool of distinct, length-valid chips for the context.
 *  2. If fewer than {@link MIN_CHIPS} exist, return `[]` (Req 16.4).
 *  3. Derive a deterministic rotation offset from `ctx.seed` (or a hash of
 *     `previous`) and rotate the pool so wording varies per render.
 *  4. Choose a target count in [3, 6], clamped to the pool size and varied by
 *     the same offset.
 *  5. Partition the rotated pool into "novel" (not in `previous`) and "repeat"
 *     (in `previous`) chips, then fill the result novel-first. This maximizes
 *     novelty and guarantees at least `ceil(count / 2)` novel chips whenever
 *     the pool provides that many novel candidates — which it always does here,
 *     since the pool has >= 14 distinct chips and a preceding render has at most
 *     6 (Req 16.3).
 *
 * @param ctx - Lightweight context used to phrase and rotate chips.
 * @param previous - The chips presented on the immediately preceding render for
 *   the same thread (empty for the first render).
 * @returns 3..6 distinct chips (each 1..120 chars), or `[]` when fewer than 3
 *   valid chips are available.
 */
export function generateSuggestions(ctx: SuggestionCtx, previous: string[]): string[] {
  const pool = buildPool(ctx);
  if (pool.length < MIN_CHIPS) return [];

  const previousSet = new Set(previous);

  // Deterministic rotation offset: explicit seed wins, else derive from previous.
  const rawSeed =
    ctx.seed !== undefined && Number.isFinite(ctx.seed)
      ? Math.abs(Math.trunc(ctx.seed))
      : hashString(previous.join("\u0000"));
  const offset = rawSeed % pool.length;

  // Rotate the pool so the starting window shifts between renders.
  const rotated = [...pool.slice(offset), ...pool.slice(0, offset)];

  // Target count in [MIN_CHIPS, MAX_CHIPS], clamped to what the pool can supply.
  const upper = Math.min(MAX_CHIPS, pool.length);
  const span = upper - MIN_CHIPS + 1; // number of valid counts
  const count = MIN_CHIPS + (rawSeed % span);

  // Partition rotated pool into novel vs repeat, preserving rotated order.
  const novel: string[] = [];
  const repeat: string[] = [];
  for (const chip of rotated) {
    if (previousSet.has(chip)) repeat.push(chip);
    else novel.push(chip);
  }

  // Fill novel-first so at least ceil(count/2) chips are new whenever available.
  const selected = [...novel, ...repeat].slice(0, count);
  return selected;
}
