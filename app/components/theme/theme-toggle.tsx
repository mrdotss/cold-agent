"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import { HugeiconsIcon } from "@hugeicons/react";
import { Moon02Icon, Sun03Icon } from "@hugeicons/core-free-icons";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Light/dark theme toggle (task 18.1; Req 20.2, 20.3).
 *
 * Uses next-themes so the choice is persisted (localStorage) across page
 * reloads within the session and the default follows the OS
 * `prefers-color-scheme` (the provider is configured with
 * `defaultTheme="system"` + `enableSystem`). Renders HugeIcons line-style
 * sun/moon glyphs only (Sera preset icon rule).
 *
 * ## Hydration safety
 *
 * The resolved theme is unknown on the server, so a theme-dependent icon/label
 * cannot be rendered during SSR without risking a hydration mismatch. Rather
 * than swapping the whole element after mount (which changes serialized
 * attributes like `disabled`/`aria-hidden` and triggers the "attributes didn't
 * match" warning), we render ONE stable, always-enabled `<button>` whose
 * hydration-serialized attributes never change. Only the icon glyph and the
 * accessible name — plain content/attribute *values* — become theme-aware after
 * mount. `mounted` starts `false` on both the server and the first client
 * (hydration) render via `useSyncExternalStore`'s server snapshot, so the two
 * match exactly; the theme-aware values then appear in a normal post-hydration
 * re-render, which React does not diff against the SSR HTML.
 */
const emptySubscribe = () => () => {};

/** Neutral, theme-agnostic label used until the resolved theme is known. */
const NEUTRAL_LABEL = "Toggle theme";

export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  // `true` only after client hydration (server + first client render return
  // `false`), so the theme-reflecting icon/label is deferred without a
  // setState-in-effect and without a structural hydration mismatch.
  const mounted = React.useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );

  const isDark = resolvedTheme === "dark";

  // Before mount, render a stable neutral label + a fixed icon so the SSR and
  // first client render are identical. After mount, reflect the resolved theme.
  const label = mounted
    ? isDark
      ? "Switch to light theme"
      : "Switch to dark theme"
    : NEUTRAL_LABEL;
  const icon = mounted ? (isDark ? Sun03Icon : Moon02Icon) : Sun03Icon;

  return (
    <Button
      type="button"
      variant="outline"
      size="icon-sm"
      aria-label={label}
      title={label}
      onClick={() => {
        // No-op until the resolved theme is known (JS isn't attached during
        // hydration anyway); afterwards, flip between light and dark.
        if (!mounted) return;
        setTheme(isDark ? "light" : "dark");
      }}
      className={cn(className)}
    >
      <HugeiconsIcon icon={icon} />
    </Button>
  );
}
