"use client";

import * as React from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Copy01Icon, Tick02Icon, Alert02Icon } from "@hugeicons/core-free-icons";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Duration the "Copied" confirmation stays visible before reverting. Kept at or
 * above 2s so the confirmation is clearly perceivable (mirrors the message-copy
 * behavior in Req 14.1).
 */
const COPIED_VISIBLE_MS = 2000;

type CopyState = "idle" | "copied" | "error";

export interface CopyButtonProps {
  /** The exact text written to the clipboard. Never rendered inline. */
  value: string;
  /** Accessible label / visible text for the idle state. */
  label?: string;
  /** Visible text shown after a successful copy. */
  copiedLabel?: string;
  /** When true, render only the icon (label becomes the aria-label). */
  iconOnly?: boolean;
  variant?: React.ComponentProps<typeof Button>["variant"];
  size?: React.ComponentProps<typeof Button>["size"];
  className?: string;
}

/**
 * A small, self-contained copy-to-clipboard control with a confirmation state
 * and graceful failure handling.
 *
 * Presentational + browser-only: it uses the async Clipboard API and announces
 * the outcome through a polite live region so screen-reader users hear the
 * confirmation. It never imports server-only modules and only ever handles the
 * plain string it is handed.
 */
export function CopyButton({
  value,
  label = "Copy",
  copiedLabel = "Copied",
  iconOnly = false,
  variant = "outline",
  size = "sm",
  className,
}: CopyButtonProps) {
  const [state, setState] = React.useState<CopyState>("idle");
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  const resetSoon = React.useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => setState("idle"), COPIED_VISIBLE_MS);
  }, []);

  const onCopy = React.useCallback(async () => {
    try {
      if (
        typeof navigator === "undefined" ||
        navigator.clipboard === undefined
      ) {
        throw new Error("Clipboard API unavailable");
      }
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      // Leave the source content untouched and surface a non-fatal failure.
      setState("error");
    } finally {
      resetSoon();
    }
  }, [value, resetSoon]);

  const icon =
    state === "copied"
      ? Tick02Icon
      : state === "error"
        ? Alert02Icon
        : Copy01Icon;

  const text =
    state === "copied" ? copiedLabel : state === "error" ? "Copy failed" : label;

  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={iconOnly ? (size === "sm" ? "icon-sm" : "icon") : size}
        onClick={onCopy}
        aria-label={iconOnly ? text : undefined}
        data-state={state}
        className={cn(state === "error" && "text-destructive", className)}
      >
        <HugeiconsIcon
          icon={icon}
          data-icon={iconOnly ? undefined : "inline-start"}
        />
        {iconOnly ? null : text}
      </Button>
      <span aria-live="polite" className="sr-only">
        {state === "copied"
          ? `${copiedLabel} to clipboard`
          : state === "error"
            ? "Copy failed"
            : ""}
      </span>
    </>
  );
}
