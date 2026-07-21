"use client";

import { useId, useState, type KeyboardEvent } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { PlugSocketIcon, PlusSignIcon, SentIcon } from "@hugeicons/core-free-icons";

import { isComposerEnabled } from "@/lib/composer";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { cn } from "@/lib/utils";

/**
 * The chat composer (Req 6, design-system §9): a text input with an attach
 * affordance and a circular send button.
 *
 * Availability is gated on the connected-account count (Req 6.1, 6.2):
 *  - zero accounts  → a fully DISABLED state that prevents text entry and
 *    submission, showing a keyboard-reachable "Connect an account to start" CTA.
 *  - ≥1 account     → an enabled composer that accepts text and submission.
 *
 * Presentational only: it owns the draft text locally (or reflects a controlled
 * `value`) and calls `onSend` with the trimmed text. Submit is disabled while
 * the field is empty or a turn is in flight (`busy`). The page (task 14.3)
 * derives `accountCount`/`busy` and supplies `onSend`.
 */

export interface ComposerProps {
  /**
   * Number of connected accounts. Zero renders the disabled connect-CTA state;
   * ≥1 enables the composer. Ignored when `disabled` is set explicitly.
   */
  accountCount?: number;
  /** Explicit disable override (wins over `accountCount`). */
  disabled?: boolean;
  /** True while a turn streams — keeps the field usable but blocks re-submit. */
  busy?: boolean;
  /** Called with the trimmed prompt text when the user submits. */
  onSend?: (text: string) => void;
  /** Invoked when the attach affordance is activated (attachments are future). */
  onAttach?: () => void;
  /** Where the connect-account CTA links (defaults to the accounts page). */
  connectHref?: string;
  /** Optional click handler for the CTA (used when no `connectHref` is given). */
  onConnectAccount?: () => void;
  placeholder?: string;
  /** Controlled draft value (optional; falls back to internal state). */
  value?: string;
  /** Change handler for the controlled draft value. */
  onValueChange?: (value: string) => void;
  className?: string;
}

export function Composer({
  accountCount = 0,
  disabled,
  busy = false,
  onSend,
  onAttach,
  connectHref = "/accounts",
  onConnectAccount,
  placeholder = "Ask about your AWS spend…",
  value,
  onValueChange,
  className,
}: ComposerProps) {
  const textareaId = useId();
  const [internalText, setInternalText] = useState("");

  const isControlled = value !== undefined;
  const text = isControlled ? value : internalText;

  const isDisabled = !isComposerEnabled(accountCount, { disabled });

  const setText = (next: string) => {
    if (!isControlled) setInternalText(next);
    onValueChange?.(next);
  };

  const canSubmit = !isDisabled && !busy && text.trim().length > 0;

  const submit = () => {
    if (!canSubmit) return;
    onSend?.(text.trim());
    setText("");
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter submits; Shift+Enter inserts a newline.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  // ---- Disabled state: connect-account CTA (Req 6.1) ----------------------
  if (isDisabled) {
    return (
      <div className={cn("border border-border bg-card/40", className)}>
        <Empty className="border-0 py-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={PlugSocketIcon} />
            </EmptyMedia>
            <EmptyTitle>Connect an account</EmptyTitle>
            <EmptyDescription>
              Chat unlocks once you connect a read-only AWS account.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            {connectHref ? (
              <Button render={<a href={connectHref} />}>
                <HugeiconsIcon icon={PlugSocketIcon} data-icon="inline-start" />
                Connect an account to start
              </Button>
            ) : (
              <Button type="button" onClick={onConnectAccount}>
                <HugeiconsIcon icon={PlugSocketIcon} data-icon="inline-start" />
                Connect an account to start
              </Button>
            )}
          </EmptyContent>
        </Empty>
      </div>
    );
  }

  // ---- Enabled state (Req 6.2) --------------------------------------------
  return (
    <div
      className={cn(
        "flex flex-col gap-2 border border-border bg-card/60 p-2 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/50",
        className,
      )}
    >
      <label htmlFor={textareaId} className="sr-only">
        Message
      </label>
      <textarea
        id={textareaId}
        rows={2}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className="max-h-48 min-h-11 w-full resize-none bg-transparent px-2 py-1.5 text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
      />

      <div className="flex items-center justify-between">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onAttach}
          aria-label="Attach a file"
        >
          <HugeiconsIcon icon={PlusSignIcon} />
        </Button>

        <Button
          type="button"
          size="icon"
          onClick={submit}
          disabled={!canSubmit}
          aria-label="Send message"
          className="rounded-full"
        >
          <HugeiconsIcon icon={SentIcon} />
        </Button>
      </div>
    </div>
  );
}
