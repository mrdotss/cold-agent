import "@/test/dom-polyfills";
import "@testing-library/jest-dom/vitest";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Mock the feedback server action so these component tests exercise the UI
// wiring only — the pure feedback state machine is property-tested separately.
vi.mock("@/lib/actions/feedback", () => ({
  setMessageFeedback: vi.fn(),
}));

import { MessageActions } from "./message-actions";
import { setMessageFeedback } from "@/lib/actions/feedback";

const mockedSetFeedback = vi.mocked(setMessageFeedback);

/**
 * Component tests for `MessageActions` (Req 14.1, 14.2, 14.3, 14.4, 14.8).
 *
 * Covers copy success + confirmation (14.1), copy failure indication (14.2),
 * regenerate enabled/disabled behavior (14.3, 14.4), and the feedback vote's
 * optimistic-then-retained behavior on server-action rejection (14.8).
 */
describe("MessageActions", () => {
  /**
   * jsdom has no clipboard. Install a spyable `writeText` per test so we can
   * resolve or reject it independently.
   */
  function installClipboard(): ReturnType<typeof vi.fn> {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    return writeText;
  }

  beforeEach(() => {
    mockedSetFeedback.mockReset();
    mockedSetFeedback.mockResolvedValue({ ok: true, value: "up" });
  });

  afterEach(() => {
    // Remove the clipboard override so tests stay isolated.
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("copies content and shows a confirmation state (Req 14.1)", async () => {
    // Install AFTER setup so user-event's own clipboard stub doesn't replace it.
    const user = userEvent.setup();
    const writeText = installClipboard();

    render(<MessageActions messageId="m1" content="Total spend: $120" />);

    await user.click(screen.getByRole("button", { name: "Copy message" }));

    // The exact message text is written verbatim to the clipboard.
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("Total spend: $120");

    // A perceivable confirmation state is shown (label + data-state).
    const copied = await screen.findByRole("button", {
      name: "Copied to clipboard",
    });
    expect(copied).toHaveAttribute("data-state", "copied");
    // The polite live region announces the copy for AT users.
    expect(
      screen.getByText("Message copied to clipboard", { selector: "span" }),
    ).toBeInTheDocument();
  });

  it("shows a copy-failed indication and leaves content unchanged (Req 14.2)", async () => {
    const user = userEvent.setup();
    const writeText = installClipboard();
    writeText.mockRejectedValueOnce(new Error("denied"));

    render(<MessageActions messageId="m1" content="Total spend: $120" />);

    await user.click(screen.getByRole("button", { name: "Copy message" }));

    // writeText was attempted with the original content (content is not mutated).
    expect(writeText).toHaveBeenCalledWith("Total spend: $120");

    const failed = await screen.findByRole("button", { name: "Copy failed" });
    expect(failed).toHaveAttribute("data-state", "error");
  });

  it("invokes onRegenerate when canRegenerate is true (Req 14.3)", async () => {
    const onRegenerate = vi.fn();
    const user = userEvent.setup();

    render(
      <MessageActions
        messageId="m1"
        content="answer"
        canRegenerate
        onRegenerate={onRegenerate}
      />,
    );

    const regenerate = screen.getByRole("button", {
      name: "Regenerate response",
    });
    expect(regenerate).toBeEnabled();

    await user.click(regenerate);
    expect(onRegenerate).toHaveBeenCalledTimes(1);
  });

  it("disables regenerate and never invokes it when canRegenerate is false (Req 14.4)", async () => {
    const onRegenerate = vi.fn();
    const user = userEvent.setup();

    render(
      <MessageActions
        messageId="m1"
        content="answer"
        canRegenerate={false}
        onRegenerate={onRegenerate}
      />,
    );

    const regenerate = screen.getByRole("button", {
      name: "Regenerate response",
    });
    expect(regenerate).toBeDisabled();

    await user.click(regenerate);
    expect(onRegenerate).not.toHaveBeenCalled();
  });

  it("persists a thumbs-up vote via the server action (Req 14.5)", async () => {
    const user = userEvent.setup();
    render(<MessageActions messageId="m1" content="answer" />);

    const up = screen.getByRole("button", { name: "Thumbs up" });
    await user.click(up);

    expect(mockedSetFeedback).toHaveBeenCalledTimes(1);
    expect(mockedSetFeedback).toHaveBeenCalledWith("m1", "up");

    // The optimistic vote is reflected as selected.
    expect(
      await screen.findByRole("button", { name: "Remove thumbs up" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("retains the prior state and surfaces an error when persistence fails (Req 14.8)", async () => {
    mockedSetFeedback.mockResolvedValueOnce({ ok: false, message: "nope" });
    const user = userEvent.setup();

    render(<MessageActions messageId="m1" content="answer" />);

    await user.click(screen.getByRole("button", { name: "Thumbs up" }));

    expect(mockedSetFeedback).toHaveBeenCalledWith("m1", "up");

    // The vote does not stick: it rolls back to unselected, and an error shows.
    expect(await screen.findByText("Couldn't save")).toBeInTheDocument();
    const up = screen.getByRole("button", { name: "Thumbs up" });
    expect(up).toHaveAttribute("aria-pressed", "false");
  });
});
