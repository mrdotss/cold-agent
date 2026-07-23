/**
 * Pure, client-safe title helpers for AI-generated Conversation titles (Req 10).
 *
 * This module is intentionally free of `server-only`, `@aws-sdk`, and any DOM or
 * environment dependency so the normalization and fallback rules can be imported
 * and property-tested in isolation, and reused on either side of the wire. The
 * Title_Service route uses {@link normalizeTitle} to clean the Bedrock model's
 * completion (Req 10.3) and {@link fallbackTitle} to derive a title directly from
 * the first user prompt when the model fails (Req 10.7).
 *
 * Both functions are total: they never throw, and for empty/whitespace-only input
 * they return the empty string. Every title they produce satisfies the same
 * invariant — at most 6 words, no surrounding quotation marks, and no trailing
 * punctuation.
 */

/** Maximum number of whitespace-separated words a produced title may contain. */
const MAX_WORDS = 6;

/**
 * Quotation marks stripped from the ends of a title: straight single/double,
 * backtick, curly/smart quotes, and guillemets.
 */
const QUOTE_CHARS = "\"'`\u201C\u201D\u2018\u2019\u00AB\u00BB\u2039\u203A";

/**
 * Trailing punctuation removed from the end of a title: sentence punctuation plus
 * the quote characters above (so `Top services".` collapses cleanly).
 */
const TRAILING_PUNCT = ".,!?;:\u2026" + QUOTE_CHARS;

/** Leading characters trimmed off the front of a title (surrounding quotes). */
const LEADING_STRIP = new RegExp(`^[${escapeForClass(QUOTE_CHARS)}\\s]+`);

/** Trailing characters trimmed off the end of a title (quotes + punctuation). */
const TRAILING_STRIP = new RegExp(`[${escapeForClass(TRAILING_PUNCT)}\\s]+$`);

/**
 * Collapse runs of whitespace to single spaces, strip surrounding quotes and
 * trailing punctuation, and constrain the result to at most {@link MAX_WORDS}
 * words. Shared by both exported helpers so every title-producing path yields the
 * same clean, short shape. Never throws; returns `""` for empty input.
 */
function toShortTitle(raw: string): string {
  if (typeof raw !== "string") return "";

  // Collapse all whitespace (incl. tabs/newlines) to single spaces and trim.
  let text = raw.replace(/\s+/g, " ").trim();
  if (text === "") return "";

  // Peel surrounding quotes/whitespace off both ends until stable.
  let previous: string;
  do {
    previous = text;
    text = text.replace(LEADING_STRIP, "").replace(TRAILING_STRIP, "");
  } while (text !== previous);
  if (text === "") return "";

  // Keep at most the first MAX_WORDS whitespace-separated tokens.
  const words = text.split(" ").filter((w) => w.length > 0);
  text = words.slice(0, MAX_WORDS).join(" ");

  // Re-strip trailing punctuation exposed after truncation, then any surrounding
  // quotes left once the tail was removed.
  text = text.replace(TRAILING_STRIP, "").replace(LEADING_STRIP, "");
  return text;
}

/**
 * Normalize a raw Title_Model completion into a clean, short title (Req 10.3).
 *
 * Strips surrounding quotation marks (straight and smart) and trailing
 * punctuation, collapses whitespace, and constrains the result to at most 6
 * words. Never throws; returns `""` for empty or whitespace-only input.
 */
export function normalizeTitle(raw: string): string {
  return toShortTitle(raw);
}

/**
 * Derive a fallback title from the first user prompt when the Title_Model fails
 * (Req 10.7).
 *
 * Trims and collapses whitespace and keeps at most the first 6 words, also
 * stripping surrounding quotes and trailing punctuation so the fallback shares
 * the same clean shape as a normalized model title. Never throws; returns `""`
 * for empty or whitespace-only input.
 */
export function fallbackTitle(firstPrompt: string): string {
  return toShortTitle(firstPrompt);
}

/** Escape characters that are special inside a regex character class. */
function escapeForClass(chars: string): string {
  return chars.replace(/[\\\]^-]/g, "\\$&");
}
