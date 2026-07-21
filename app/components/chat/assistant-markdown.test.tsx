import "@testing-library/jest-dom/vitest";

import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";

import { AssistantMarkdown } from "./assistant-markdown";

/**
 * Component tests for `AssistantMarkdown` (Req 10.2).
 *
 * The agent replies with GitHub-flavored markdown cost tables + inline `code`
 * chips, so we assert the real DOM shape (a `<table>` with rows/cells, a
 * `<code>` chip) and that malformed mid-stream markdown renders without throwing
 * while preserving its text (Req 10.7 tolerance).
 */
describe("AssistantMarkdown", () => {
  it("renders a GFM markdown table as a real <table> with rows and cells (Req 10.2)", () => {
    const table = [
      "| Service | Cost |",
      "| --- | --- |",
      "| EC2 | $120.50 |",
      "| S3 | $8.30 |",
    ].join("\n");

    const { container } = render(<AssistantMarkdown content={table} />);

    // A real table element with the accessible table role.
    const tableEl = screen.getByRole("table");
    expect(tableEl).toBeInTheDocument();
    expect(container.querySelector("table")).not.toBeNull();

    // Header cells come through as column headers.
    const columnHeaders = within(tableEl).getAllByRole("columnheader");
    expect(columnHeaders.map((c) => c.textContent)).toEqual(["Service", "Cost"]);

    // Body rows: 1 header row + 2 data rows = 3 rows total.
    const rows = within(tableEl).getAllByRole("row");
    expect(rows).toHaveLength(3);

    // The data cells preserve their values.
    const dataCells = within(tableEl).getAllByRole("cell");
    expect(dataCells.map((c) => c.textContent)).toEqual([
      "EC2",
      "$120.50",
      "S3",
      "$8.30",
    ]);
  });

  it("renders inline `code` as a <code> chip (Req 10.2)", () => {
    const { container } = render(
      <AssistantMarkdown content={"Run the `get_cost_and_usage` tool now."} />,
    );

    const code = container.querySelector("code");
    expect(code).not.toBeNull();
    expect(code).toHaveTextContent("get_cost_and_usage");
    // Inline chips are not wrapped in a <pre> block.
    expect(code?.closest("pre")).toBeNull();
  });

  it("does not throw on an unterminated table and preserves the text (Req 10.7)", () => {
    // A half-streamed table: header + delimiter but a truncated final row.
    const partial = "| Service | Cost |\n| --- | --- |\n| EC2 | $12";

    expect(() =>
      render(<AssistantMarkdown content={partial} />),
    ).not.toThrow();

    // The accumulated text is preserved even while the markdown is incomplete.
    expect(screen.getByText(/Service/)).toBeInTheDocument();
    expect(screen.getByText(/EC2/)).toBeInTheDocument();
  });

  it("does not throw on an unclosed code fence and preserves the text (Req 10.7)", () => {
    const unclosed = "Here is a snippet:\n```ts\nconst total = sum(costs)";

    const { container } = render(<AssistantMarkdown content={unclosed} />);

    expect(container).toBeInTheDocument();
    expect(screen.getByText(/Here is a snippet:/)).toBeInTheDocument();
    // The fenced content still shows up somewhere in the output.
    expect(container.textContent).toContain("const total = sum(costs)");
  });

  it("renders empty content without throwing", () => {
    expect(() => render(<AssistantMarkdown content="" />)).not.toThrow();
  });
});
