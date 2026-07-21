"use client";

import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";

/**
 * Renders assistant prose as GitHub-flavored markdown (Req 10.2).
 *
 * The agent replies with cost tables and inline `code`, so this supports at
 * minimum GFM tables and inline code chips. `react-markdown` builds a syntax
 * tree and is tolerant of malformed/incomplete markdown — a half-streamed table
 * or an unclosed fence renders as accumulated text rather than throwing (Req
 * 10.7), which is exactly what we want while `delta` events are still arriving.
 *
 * Presentational only: it takes the accumulated text string and styles the
 * output with the Sera tokens (serif headings, hairline-bordered tables, flat
 * `bg-muted` inline chips, sharp corners — no rounded pills, no gradients).
 */

const REMARK_PLUGINS = [remarkGfm];

/** Sera-flavored element overrides: editorial, flat, hairline-bordered. */
const markdownComponents: Components = {
  p: ({ className, ...props }) => (
    <p className={cn("my-3 first:mt-0 last:mb-0", className)} {...props} />
  ),
  h1: ({ className, ...props }) => (
    <h1
      className={cn(
        "font-heading mt-6 mb-3 text-xl font-semibold tracking-wide first:mt-0",
        className,
      )}
      {...props}
    />
  ),
  h2: ({ className, ...props }) => (
    <h2
      className={cn(
        "font-heading mt-6 mb-3 text-lg font-semibold tracking-wide first:mt-0",
        className,
      )}
      {...props}
    />
  ),
  h3: ({ className, ...props }) => (
    <h3
      className={cn(
        "font-heading mt-5 mb-2 text-base font-semibold tracking-wide first:mt-0",
        className,
      )}
      {...props}
    />
  ),
  ul: ({ className, ...props }) => (
    <ul
      className={cn("my-3 ml-5 list-disc space-y-1 marker:text-muted-foreground", className)}
      {...props}
    />
  ),
  ol: ({ className, ...props }) => (
    <ol
      className={cn("my-3 ml-5 list-decimal space-y-1 marker:text-muted-foreground", className)}
      {...props}
    />
  ),
  li: ({ className, ...props }) => (
    <li className={cn("leading-relaxed", className)} {...props} />
  ),
  a: ({ className, ...props }) => (
    <a
      className={cn(
        "font-medium text-primary underline underline-offset-4 hover:text-primary/80",
        className,
      )}
      target="_blank"
      rel="noreferrer noopener"
      {...props}
    />
  ),
  blockquote: ({ className, ...props }) => (
    <blockquote
      className={cn(
        "my-3 border-l-2 border-border pl-4 text-muted-foreground italic",
        className,
      )}
      {...props}
    />
  ),
  hr: ({ className, ...props }) => (
    <hr className={cn("my-4 border-border", className)} {...props} />
  ),
  // GitHub-flavored markdown tables (Req 10.2): flat, hairline-bordered, scroll
  // horizontally on overflow so wide cost tables never break the layout.
  table: ({ className, ...props }) => (
    <div className="my-4 w-full overflow-x-auto border border-border">
      <table className={cn("w-full border-collapse text-sm", className)} {...props} />
    </div>
  ),
  thead: ({ className, ...props }) => (
    <thead className={cn("bg-muted/60", className)} {...props} />
  ),
  th: ({ className, ...props }) => (
    <th
      className={cn(
        "border-b border-border px-3 py-2 text-left text-xs font-semibold tracking-wide uppercase",
        className,
      )}
      {...props}
    />
  ),
  td: ({ className, ...props }) => (
    <td
      className={cn("border-b border-border px-3 py-2 align-top tabular-nums", className)}
      {...props}
    />
  ),
  tr: ({ className, ...props }) => (
    <tr className={cn("last:*:border-b-0", className)} {...props} />
  ),
  pre: ({ className, ...props }) => (
    <pre
      className={cn(
        "my-3 overflow-x-auto border border-border bg-muted/60 p-3 font-mono text-xs leading-relaxed",
        className,
      )}
      {...props}
    />
  ),
  code: ({ className, children, ...props }) => {
    // Fenced/block code carries a `language-*` class; leave it bare so the
    // `pre` wrapper styles it. Inline code becomes a flat `bg-muted` chip.
    const isBlock = /language-/.test(className ?? "");
    if (isBlock) {
      return (
        <code className={cn("font-mono", className)} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code
        className={cn(
          "bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-foreground",
          className,
        )}
        {...props}
      >
        {children}
      </code>
    );
  },
};

export interface AssistantMarkdownProps {
  /** Accumulated assistant text (may be mid-stream / incomplete). */
  content: string;
  className?: string;
}

function AssistantMarkdownImpl({ content, className }: AssistantMarkdownProps) {
  return (
    <div className={cn("text-sm leading-relaxed text-foreground", className)}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={markdownComponents}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

/**
 * Memoized so unrelated re-renders (e.g. a spinner tick elsewhere) don't reparse
 * the markdown; it only re-renders when the accumulated text actually grows.
 */
export const AssistantMarkdown = memo(AssistantMarkdownImpl);
