import "@testing-library/jest-dom/vitest";

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ConfirmationGate } from "./confirmation-gate";

/**
 * Component tests for `ConfirmationGate` (design-system §8, Req 15.3, 15.4).
 *
 * Approve invokes the guarded action EXACTLY ONCE (and repeated activation never
 * invokes it again); reject invokes `onReject` and never `onApprove`.
 */
describe("ConfirmationGate", () => {
  it("invokes onApprove exactly once on approve (Req 15.3)", async () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const user = userEvent.setup();

    render(<ConfirmationGate onApprove={onApprove} onReject={onReject} />);

    await user.click(screen.getByRole("button", { name: /approve/i }));

    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onReject).not.toHaveBeenCalled();
    // The prompt is dismissed in place and shows the approved status line.
    expect(screen.getByText(/running now/i)).toBeInTheDocument();
  });

  it("does not invoke onApprove again once answered (Req 15.3, 15.5)", async () => {
    const onApprove = vi.fn();
    const user = userEvent.setup();

    render(<ConfirmationGate onApprove={onApprove} />);

    const approve = screen.getByRole("button", { name: /approve/i });
    await user.click(approve);

    // After answering the controls are gone; a stale reference cannot re-invoke.
    expect(approve).not.toBeInTheDocument();
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("invokes onReject and never onApprove on reject (Req 15.4)", async () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const user = userEvent.setup();

    render(<ConfirmationGate onApprove={onApprove} onReject={onReject} />);

    await user.click(screen.getByRole("button", { name: /reject/i }));

    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onApprove).not.toHaveBeenCalled();
    // The prompt is dismissed and shows the cancelled status line.
    expect(screen.getByText(/cancelled/i)).toBeInTheDocument();
  });

  it("rejecting then attempting to approve never invokes onApprove (Req 15.4, 15.5)", async () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const user = userEvent.setup();

    render(<ConfirmationGate onApprove={onApprove} onReject={onReject} />);

    await user.click(screen.getByRole("button", { name: /reject/i }));

    // Approve control is no longer present after answering.
    expect(
      screen.queryByRole("button", { name: /approve/i }),
    ).not.toBeInTheDocument();
    expect(onApprove).not.toHaveBeenCalled();
  });
});
