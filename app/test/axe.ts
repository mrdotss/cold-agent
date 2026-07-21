import { expect } from "vitest";
import type { AxeResults } from "axe-core";

/**
 * Type-safe assertion that an axe run produced no violations.
 *
 * `vitest-axe` ships a `toHaveNoViolations` matcher, but its published typings
 * export the matcher as a type (not a value) and its `extend-expect` entry is a
 * no-op at runtime, so wiring the matcher is unreliable. Asserting directly on
 * `results.violations` is equivalent, fully typed, and gives a readable failure.
 *
 * NOTE (jsdom limitation): axe-core's `color-contrast` rule needs a real paint
 * engine to read computed colors, which jsdom lacks — it is reported as
 * `incomplete`, never `pass`. This assertion therefore validates the rules jsdom
 * CAN evaluate (roles, accessible names, ARIA, duplicate ids, …). True contrast
 * is covered by the hardened token assertions in `app/globals.static.test.ts`
 * plus manual/browser review.
 */
export function expectNoAxeViolations(results: AxeResults): void {
  if (results.violations.length > 0) {
    const summary = results.violations
      .map((violation) => {
        const targets = violation.nodes
          .map((node) => node.target.join(", "))
          .join("; ");
        return `- [${violation.impact ?? "n/a"}] ${violation.id}: ${violation.help} (at ${targets})`;
      })
      .join("\n");
    throw new Error(`Expected no axe violations but found:\n${summary}`);
  }
  expect(results.violations).toHaveLength(0);
}
