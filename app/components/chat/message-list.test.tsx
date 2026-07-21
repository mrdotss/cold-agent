import "@/test/dom-polyfills";
import "@testing-library/jest-dom/vitest";

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { MessageList } from "./message-list";
import type { ChatMessage } from "./types";

/**
 * Component tests for `MessageList` alignment (Req 10.4, 10.5).
 *
 * User turns render as RIGHT-aligned bubbles (`Message align="end"`), assistant
 * turns render as LEFT-aligned prose (`Message align="start"`). The `Message`
 * primitive exposes its alignment through `data-slot="message"` +
 * `data-align`, so we assert against that stable contract rather than brittle
 * class strings.
 */
describe("MessageList", () => {
  function messageEls(container: HTMLElement): HTMLElement[] {
    return Array.from(
      container.querySelectorAll<HTMLElement>('[data-slot="message"]'),
    );
  }

  it("renders a user turn right-aligned (Req 10.4)", () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "What did I spend on EC2?" },
    ];

    const { container } = render(<MessageList messages={messages} />);

    const messages_ = messageEls(container);
    expect(messages_).toHaveLength(1);
    expect(messages_[0]).toHaveAttribute("data-align", "end");
    // The user's text is rendered.
    expect(screen.getByText("What did I spend on EC2?")).toBeInTheDocument();
  });

  it("renders an assistant turn left-aligned (Req 10.5)", () => {
    const messages: ChatMessage[] = [
      { id: "a1", role: "assistant", content: "You spent **$120** on EC2." },
    ];

    const { container } = render(<MessageList messages={messages} />);

    const messages_ = messageEls(container);
    expect(messages_).toHaveLength(1);
    expect(messages_[0]).toHaveAttribute("data-align", "start");
    expect(screen.getByText(/You spent/)).toBeInTheDocument();
  });

  it("aligns each turn by role in a mixed conversation (Req 10.4, 10.5)", () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "Break down by service" },
      { id: "a1", role: "assistant", content: "Here is the breakdown." },
      { id: "u2", role: "user", content: "Export as PDF" },
    ];

    const { container } = render(<MessageList messages={messages} />);

    const aligns = messageEls(container).map((el) =>
      el.getAttribute("data-align"),
    );
    expect(aligns).toEqual(["end", "start", "end"]);
  });

  it("renders assistant markdown content as a real table (Req 10.2 via MessageList)", () => {
    const messages: ChatMessage[] = [
      {
        id: "a1",
        role: "assistant",
        content: "| Service | Cost |\n| --- | --- |\n| EC2 | $120 |",
      },
    ];

    render(<MessageList messages={messages} />);

    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("renders the in-progress assistant turn left-aligned while streaming", () => {
    const { container } = render(
      <MessageList messages={[]} isStreaming streamingText="Analyzing spend…" />,
    );

    const messages_ = messageEls(container);
    expect(messages_).toHaveLength(1);
    expect(messages_[0]).toHaveAttribute("data-align", "start");
    expect(screen.getByText(/Analyzing spend/)).toBeInTheDocument();
  });
});
