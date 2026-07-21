"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { SparklesIcon } from "@hugeicons/core-free-icons";

import { MIN_CHIPS } from "@/lib/suggestions";
import { cn } from "@/lib/utils";

/**
 * Recommendation-style prompt chips shown in the chat empty state / idle
 * composer (design-system §7, Req 16).
 *
 * Purely presentational: the chips themselves are sourced by
 * `generateSuggestions` (`lib/suggestions.ts`) at the call site (page/server)
 * and handed in via `suggestions`. This component only renders them and reports
 * activation through `onPick` — it never sets composer state or submits.
 *
 * Behavior:
 *  - Renders the given chips as recommendation-style chips that feel
 *    AI-generated (Sparkles line icon, sharp corners, flat surface, Violet
 *    accent on hover/focus) rather than fixed command buttons (Req 16.1).
 *  - Activating a chip (click, Enter, or Space — native `<button>` semantics)
 *    calls `onPick(text)`. The page wires `onPick` to REPLACE the composer's
 *    contents with the chip text and move focus to the composer WITHOUT
 *    submitting (Req 16.2).
 *  - Fallback: when fewer than {@link MIN_CHIPS} chips are supplied, renders
 *    nothing so the empty state / idle composer stays clean and usable for
 *    free-form input (Req 16.4). `generateSuggestions` already returns `[]` in
 *    that case; this is a defensive second guard.
 */

export interface SuggestionsProps {
  /**
   * The prompt chips to present (from `generateSuggestions`). When fewer than
   * {@link MIN_CHIPS} are supplied, the component renders nothing (Req 16.4).
   */
  suggestions: string[];
  /**
   * Called with a chip's prompt text when the user activates it. The page wires
   * this to set the composer value + focus WITHOUT submitting (Req 16.2).
   */
  onPick: (text: string) => void;
  /** Optional accessible label for the chip group. */
  label?: string;
  className?: string;
}

export function Suggestions({
  suggestions,
  onPick,
  label = "Suggested prompts",
  className,
}: SuggestionsProps) {
  // Fallback to no chips when fewer than 3 valid chips are available (Req 16.4).
  if (suggestions.length < MIN_CHIPS) {
    return null;
  }

  return (
    <div
      role="group"
      aria-label={label}
      className={cn("flex flex-col gap-2.5", className)}
    >
      <span className="flex items-center gap-1.5 text-[0.625rem] font-semibold tracking-widest text-muted-foreground uppercase">
        <HugeiconsIcon icon={SparklesIcon} className="size-3" aria-hidden />
        {label}
      </span>

      <ul className="flex flex-wrap gap-2">
        {suggestions.map((text) => (
          <li key={text}>
            <button
              type="button"
              onClick={() => onPick(text)}
              className={cn(
                "group/chip inline-flex items-center gap-1.5 border border-border bg-card/50 px-3 py-1.5 text-left text-sm text-foreground transition-colors outline-none",
                "hover:border-primary/40 hover:bg-primary/5 hover:text-foreground",
                "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30",
              )}
            >
              <HugeiconsIcon
                icon={SparklesIcon}
                className="size-3.5 shrink-0 text-muted-foreground transition-colors group-hover/chip:text-primary"
                aria-hidden
              />
              <span className="min-w-0">{text}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
