import "@/test/dom-polyfills";
import "@testing-library/jest-dom/vitest";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { axe } from "vitest-axe";

vi.mock("@/lib/actions/feedback", () => ({
  setMessageFeedback: vi.fn().mockResolvedValue({ ok: true, value: "up" }),
}));

import { expectNoAxeViolations } from "@/test/axe";
import { Composer } from "@/components/chat/composer";
import { MessageActions } from "@/components/chat/message-actions";

/**
 * Accessibility sweep of a representative composed view in BOTH themes
 * (Req 20.6).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HONEST LIMITATION — contrast under jsdom
 * ─────────────────────────────────────────────────────────────────────────────
 * axe-core's `color-contrast` rule needs a real layout + paint engine to read
 * computed foreground/background colors. jsdom has none, so that rule cannot run
 * meaningfully here (axe reports it as `incomplete`, never `pass`). We therefore
 * DO NOT claim contrast is verified by this test.
 *
 * What IS verified here:
 *   1. axe runs across the composed view in a light context AND a `.dark`
 *      context, and reports NO violations for the rules jsdom can evaluate
 *      (roles, accessible names, ARIA state, duplicate ids, etc.).
 * What covers the contrast requirement instead (checkable pieces):
 *   2. The hardened `--ring` token (task 18.2) is asserted, in both theme
 *      blocks, in `app/globals.static.test.ts`.
 *   3. Full 4.5:1 / 3:1 contrast in both themes is validated by manual review /
 *      a browser-based axe run outside jsdom (documented, not asserted here).
 * ─────────────────────────────────────────────────────────────────────────────
 */

const AXE_OPTIONS = { rules: { region: { enabled: false } } } as const;

/** A small composed harness: composer + message actions + sidebar-style links. */
function Harness() {
  return (
    <div>
      {/* Representative custom sidebar links — same focus-visible ring utility
          the real sidebar uses (asserted against source below). */}
      <nav aria-label="Primary">
        <a
          href="/dashboard"
          className="flex items-center gap-3 border-l-2 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Dashboard
        </a>
        <a
          href="/accounts"
          className="flex items-center gap-3 border-l-2 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Accounts
        </a>
      </nav>

      <main>
        <MessageActions
          messageId="m1"
          content="Total spend: $120"
          canRegenerate
          onRegenerate={() => {}}
        />
        <Composer accountCount={1} />
      </main>
    </div>
  );
}

describe("Composed view axe sweep — both themes (Req 20.6)", () => {
  it("has no axe violations in the light theme", async () => {
    const { container } = render(<Harness />);
    const results = await axe(container, AXE_OPTIONS);
    expectNoAxeViolations(results);
  });

  it("has no axe violations in the dark theme (.dark)", async () => {
    const { container } = render(
      <div className="dark">
        <Harness />
      </div>,
    );
    const results = await axe(container, AXE_OPTIONS);
    expectNoAxeViolations(results);
  });
});

describe("Sidebar links/buttons carry a visible focus indicator (Req 20.5, 20.6)", () => {
  it("the real sidebar source uses focus-visible ring utilities on its links and buttons", () => {
    // jsdom can't paint the ring; assert the utility is present at the source of
    // the actual sidebar so the visible focus indicator ships to the browser.
    const sidebar = readFileSync(
      resolve(process.cwd(), "components/app-shell/sidebar.tsx"),
      "utf8",
    );
    const focusVisibleRings = sidebar.match(/focus-visible:ring-2\s+focus-visible:ring-ring/g) ?? [];
    // Nav links, conversation links, brand link, and the new-chat button all
    // opt in — there are several occurrences.
    expect(focusVisibleRings.length).toBeGreaterThanOrEqual(3);
  });
});
