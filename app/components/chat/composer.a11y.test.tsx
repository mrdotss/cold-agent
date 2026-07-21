import "@/test/dom-polyfills";
import "@testing-library/jest-dom/vitest";

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";

import { expectNoAxeViolations } from "@/test/axe";
import { Composer } from "./composer";

/**
 * Keyboard-traversal, focus, and axe checks for the {@link Composer} (Req 20.5,
 * 20.6).
 *
 * Req 20.5 is fully exercisable under jsdom: we Tab through the enabled composer
 * and assert the textarea, attach, and send controls receive focus in order and
 * that Enter submits. Focus indicators are delivered by `focus-visible:` ring
 * utilities (asserted via className, since jsdom paints no pixels).
 *
 * Req 20.6 (contrast) CANNOT be truly computed by axe under jsdom — it has no
 * layout/paint engine, so the `color-contrast` rule is a no-op/incomplete here.
 * We therefore run axe for every OTHER rule (roles, names, ARIA) and assert no
 * violations; the token-level contrast guarantee is asserted separately in
 * `app/globals.static.test.ts`. See `a11y-themes.axe.test.tsx` for the full note.
 */

// axe's region rule is about whole-page landmark structure and fires against an
// isolated component harness; disable it (and rely on the real page for that).
const AXE_OPTIONS = { rules: { region: { enabled: false } } } as const;

describe("Composer keyboard traversal + focus (Req 20.5)", () => {
  it("moves focus textarea → attach → send in Tab order and submits on Enter", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();

    render(<Composer accountCount={1} onSend={onSend} />);

    const textarea = screen.getByRole("textbox", { name: "Message" });
    const attach = screen.getByRole("button", { name: "Attach a file" });
    const send = screen.getByRole("button", { name: "Send message" });

    // First Tab lands on the textarea.
    await user.tab();
    expect(textarea).toHaveFocus();

    // Type so the send control becomes enabled (and thus tabbable).
    await user.keyboard("Scan this month's spend");
    expect(send).toBeEnabled();

    await user.tab();
    expect(attach).toHaveFocus();

    await user.tab();
    expect(send).toHaveFocus();
  });

  it("submits the trimmed prompt when Enter is pressed in the textarea", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();

    render(<Composer accountCount={1} onSend={onSend} />);

    const textarea = screen.getByRole("textbox", { name: "Message" });
    await user.click(textarea);
    await user.keyboard("  Break down by service  ");
    await user.keyboard("{Enter}");

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("Break down by service");
    // The field is cleared after submit.
    expect(textarea).toHaveValue("");
  });

  it("Shift+Enter inserts a newline instead of submitting", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();

    render(<Composer accountCount={1} onSend={onSend} />);

    const textarea = screen.getByRole("textbox", { name: "Message" });
    await user.click(textarea);
    await user.keyboard("line one");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    await user.keyboard("line two");

    expect(onSend).not.toHaveBeenCalled();
    expect(textarea).toHaveValue("line one\nline two");
  });

  it("exposes a keyboard-reachable connect CTA with a visible focus ring when disabled (Req 6.1, 20.5)", async () => {
    const user = userEvent.setup();

    render(<Composer accountCount={0} connectHref="/accounts" />);

    const cta = screen.getByRole("link", {
      name: /connect an account to start/i,
    });

    // Reachable via Tab and carries a focus-visible ring utility.
    await user.tab();
    expect(cta).toHaveFocus();
    expect(cta.className).toMatch(/focus-visible:(ring|border)/);
  });
});

describe("Composer axe (Req 20.6 — roles/names/ARIA; contrast noted)", () => {
  it("has no axe violations in the enabled state", async () => {
    const { container } = render(<Composer accountCount={1} />);
    const results = await axe(container, AXE_OPTIONS);
    expectNoAxeViolations(results);
  });

  it("has no axe violations in the disabled connect-CTA state", async () => {
    const { container } = render(<Composer accountCount={0} />);
    const results = await axe(container, AXE_OPTIONS);
    expectNoAxeViolations(results);
  });
});
