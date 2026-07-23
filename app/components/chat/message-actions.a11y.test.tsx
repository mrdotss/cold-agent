import "@/test/dom-polyfills";
import "@testing-library/jest-dom/vitest";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";

import { expectNoAxeViolations } from "@/test/axe";
import { MessageActions } from "./message-actions";

/**
 * Keyboard-traversal, accessible-name, and axe checks for {@link MessageActions}
 * (Req 20.5, 20.6).
 *
 * Every action is an icon-only button, so each MUST carry an accessible name and
 * be reachable by Tab. We assert both here. Contrast (Req 20.6) is not computable
 * under jsdom (see `a11y-themes.axe.test.tsx`); axe still validates roles/names/
 * ARIA and we assert no violations.
 */

const AXE_OPTIONS = { rules: { region: { enabled: false } } } as const;

describe("MessageActions keyboard + accessible names (Req 20.5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("makes every action Tab-reachable in order with an accessible name", async () => {
    const user = userEvent.setup();

    render(
      <MessageActions
        conversationId="c1"
        messageId="m1"
        content="Total spend: $120"
        canRegenerate
        onRegenerate={vi.fn()}
      />,
    );

    const copy = screen.getByRole("button", { name: "Copy message" });
    const regenerate = screen.getByRole("button", {
      name: "Regenerate response",
    });
    const up = screen.getByRole("button", { name: "Thumbs up" });
    const down = screen.getByRole("button", { name: "Thumbs down" });

    // None of the icon-only controls has an empty accessible name.
    for (const control of [copy, regenerate, up, down]) {
      expect(control).toHaveAccessibleName();
    }

    // Tab order follows DOM order: copy → regenerate → up → down.
    await user.tab();
    expect(copy).toHaveFocus();
    await user.tab();
    expect(regenerate).toHaveFocus();
    await user.tab();
    expect(up).toHaveFocus();
    await user.tab();
    expect(down).toHaveFocus();
  });

  it("activates the focused vote via the keyboard (Space/Enter) (Req 20.5)", async () => {
    const user = userEvent.setup();

    // A chosen vote persists through the feedback route via `fetch`; stub it ok
    // so the optimistic activation is retained (persistence itself is covered in
    // message-actions.feedback.test.tsx).
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    render(
      <MessageActions conversationId="c1" messageId="m1" content="answer" />,
    );

    const up = screen.getByRole("button", { name: "Thumbs up" });
    up.focus();
    expect(up).toHaveFocus();

    await user.keyboard("{Enter}");

    // Activation flips the pressed state (the pure state machine is tested
    // elsewhere; here we only confirm keyboard activation works).
    expect(
      await screen.findByRole("button", { name: "Remove thumbs up" }),
    ).toHaveAttribute("aria-pressed", "true");
  });
});

describe("MessageActions axe (Req 20.6 — roles/names/ARIA; contrast noted)", () => {
  it("has no axe violations", async () => {
    const { container } = render(
      <MessageActions
        conversationId="c1"
        messageId="m1"
        content="answer"
        canRegenerate
        onRegenerate={vi.fn()}
      />,
    );
    const results = await axe(container, AXE_OPTIONS);
    expectNoAxeViolations(results);
  });
});
