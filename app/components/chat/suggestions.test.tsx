import "@testing-library/jest-dom/vitest";

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Suggestions } from "./suggestions";
import { MIN_CHIPS } from "@/lib/suggestions";

/**
 * Component tests for `Suggestions` (Req 16.2, 16.4).
 *
 * Activating a chip calls `onPick` with the chip text and never submits (16.2);
 * with fewer than {@link MIN_CHIPS} chips the component renders nothing (16.4).
 */
describe("Suggestions", () => {
  const chips = [
    "Scan this month's spend",
    "Where did costs spike?",
    "Break down spend by service",
  ];

  it("calls onPick with the chip text on activation and does not submit (Req 16.2)", async () => {
    const onPick = vi.fn();
    const onSubmit = vi.fn();
    const user = userEvent.setup();

    // Wrap in a form so any accidental submit would be observable.
    render(
      <form onSubmit={onSubmit}>
        <Suggestions suggestions={chips} onPick={onPick} />
      </form>,
    );

    await user.click(
      screen.getByRole("button", { name: "Where did costs spike?" }),
    );

    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith("Where did costs spike?");
    // Chips are type="button": activation must not submit the surrounding form.
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("renders every supplied chip as a button (Req 16.2)", () => {
    const onPick = vi.fn();
    render(<Suggestions suggestions={chips} onPick={onPick} />);

    for (const text of chips) {
      expect(screen.getByRole("button", { name: text })).toBeInTheDocument();
    }
  });

  it("renders nothing when fewer than MIN_CHIPS chips are supplied (Req 16.4)", () => {
    const onPick = vi.fn();
    const tooFew = chips.slice(0, MIN_CHIPS - 1);

    const { container } = render(
      <Suggestions suggestions={tooFew} onPick={onPick} />,
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
  });

  it("renders nothing for an empty chip list (Req 16.4)", () => {
    const { container } = render(
      <Suggestions suggestions={[]} onPick={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
