import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Static Sera-token + accessibility guards for `globals.css` (task 18.3).
 *
 * jsdom cannot evaluate `@media` queries or compute real colors, so the theming
 * / reduced-motion / contrast tokens are locked at the SOURCE level here: we read
 * `globals.css` as text and assert the exact preset tokens and the a11y rules the
 * runtime relies on. This is the honest, checkable half of Req 20.1/20.4/20.6/20.8
 * — the parts jsdom cannot exercise are asserted by their presence in the CSS.
 *
 *  - Req 20.1 / 20.8 — Sera preset tokens: 0 radius, Violet `--primary`
 *    (oklch hue ~292), Lora body (`font-serif`) + Noto Serif headings
 *    (`font-heading`) mapped in `@layer base`.
 *  - Req 20.4 — a `prefers-reduced-motion: reduce` block that neutralizes
 *    animation/transition durations.
 *  - Req 20.6 — the focus-ring token (`--ring`) is the hardened zinc-500 value
 *    from task 18.2 (contrast can't be computed under jsdom; the token value is).
 */

// Vitest runs from the `app/` package root, so `globals.css` lives at `app/app`.
const css = readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");

/** Everything inside the top-level `:root { … }` block. */
function rootBlock(source: string): string {
  const start = source.indexOf(":root {");
  expect(start).toBeGreaterThanOrEqual(0);
  const open = source.indexOf("{", start);
  const close = source.indexOf("}", open);
  return source.slice(open + 1, close);
}

/** Everything inside the first `.dark { … }` block. */
function darkBlock(source: string): string {
  const start = source.indexOf(".dark {");
  expect(start).toBeGreaterThanOrEqual(0);
  const open = source.indexOf("{", start);
  const close = source.indexOf("}", open);
  return source.slice(open + 1, close);
}

/** Parse the three oklch channels of a `--var: oklch(L C H …)` declaration. */
function oklch(block: string, name: string): [number, number, number] {
  const match = block.match(
    new RegExp(`${name}\\s*:\\s*oklch\\(\\s*([0-9.]+)\\s+([0-9.]+)\\s+([0-9.]+)`),
  );
  expect(match, `expected ${name} to be an oklch(...) triple`).not.toBeNull();
  const [, l, c, h] = match as RegExpMatchArray;
  return [Number(l), Number(c), Number(h)];
}

describe("globals.css Sera preset tokens (Req 20.1, 20.8)", () => {
  it("uses zero-radius (sharp) corners", () => {
    // Sera preset: Radius "None". The `--radius` base drives every derived
    // radius token, so 0rem here means sharp corners everywhere.
    expect(rootBlock(css)).toMatch(/--radius:\s*0rem\s*;/);
  });

  it("uses a Violet --primary accent (oklch hue ~292) in both themes", () => {
    const [, lightChroma, lightHue] = oklch(rootBlock(css), "--primary");
    const [, darkChroma, darkHue] = oklch(darkBlock(css), "--primary");

    // Violet lives at hue ~292 in oklch; assert a tight band around it and a
    // real (non-grey) chroma so a neutral could never satisfy this.
    expect(lightHue).toBeGreaterThan(288);
    expect(lightHue).toBeLessThan(296);
    expect(lightChroma).toBeGreaterThan(0.1);

    expect(darkHue).toBeGreaterThan(288);
    expect(darkHue).toBeLessThan(296);
    expect(darkChroma).toBeGreaterThan(0.1);
  });

  it("maps body text to Lora (font-serif) and headings to Noto Serif (font-heading) in @layer base", () => {
    // The preset type system: html => font-serif (Lora body),
    // h1–h6 => font-heading (Noto Serif display). `[^}]` already spans newlines,
    // so no dotAll flag is needed.
    expect(css).toMatch(/@layer base\b/);
    expect(css).toMatch(/html\s*\{[^}]*@apply[^}]*font-serif/);
    expect(css).toMatch(/h1,\s*h2,\s*h3,\s*h4,\s*h5,\s*h6\s*\{[^}]*@apply[^}]*font-heading/);
  });

  it("defines both a light (:root) and a dark (.dark) theme block (Req 20.2)", () => {
    expect(css).toContain(":root {");
    expect(css).toContain(".dark {");
    // Light and dark backgrounds differ (near-white vs near-black).
    const [lightBgL] = oklch(rootBlock(css), "--background");
    const [darkBgL] = oklch(darkBlock(css), "--background");
    expect(lightBgL).toBeGreaterThan(0.9);
    expect(darkBgL).toBeLessThan(0.3);
  });
});

describe("globals.css reduced-motion safety net (Req 20.4)", () => {
  it("has a prefers-reduced-motion:reduce block that neutralizes motion", () => {
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);

    // Isolate the reduced-motion block and assert it collapses non-essential
    // animation + transition durations (and disables smooth scroll).
    const start = css.search(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    const block = css.slice(start);
    expect(block).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
    expect(block).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
    expect(block).toMatch(/scroll-behavior:\s*auto\s*!important/);
  });
});

describe("globals.css hardened focus-ring token (Req 20.6)", () => {
  it("uses the darkened zinc-500 --ring value from task 18.2 in both themes", () => {
    // Contrast ratios cannot be computed under jsdom, so we lock the TOKEN that
    // task 18.2 hardened for AA: --ring darkened to zinc-500 (L ~0.552) so a
    // full-opacity focus ring clears 3:1 against the light surfaces.
    const [lightL] = oklch(rootBlock(css), "--ring");
    const [darkL] = oklch(darkBlock(css), "--ring");

    // zinc-500 lightness ≈ 0.552 (not the softer zinc-400 ≈ 0.705).
    expect(lightL).toBeCloseTo(0.552, 2);
    expect(darkL).toBeCloseTo(0.552, 2);
  });
});
