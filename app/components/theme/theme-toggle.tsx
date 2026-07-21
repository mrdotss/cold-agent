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
 * reloads within the session and the default follows the OS `prefers-color-scheme`
 * (the provider is configured with `defaultTheme="system"` + `enableSystem`).
 *
 * Renders HugeIcons line-style sun/moon glyphs only (Sera preset icon rule). To
 * avoid a hydration mismatch — the server has no knowledge of the resolved
 * theme — the reflected icon/label is only rendered after mount; before then a
 * neutral, non-announcing placeholder keeps layout stable.
 */
const emptySubscribe = () => () => {};

export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  // `true` only after client hydration (server + first client render return
  // `false`), so the theme-reflecting markup is deferred without a
  // setState-in-effect. Avoids a hydration mismatch on the resolved theme.
  const mounted = React.useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );

  const isDark = resolvedTheme === "dark";

  if (!mounted) {
    // Placeholder preserves footprint without asserting a theme pre-hydration.
    return (
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        aria-hidden="true"
        tabIndex={-1}
        disabled
        className={className}
      >
        <HugeiconsIcon icon={Sun03Icon} />
      </Button>
    );
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="icon-sm"
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      title={isDark ? "Switch to light theme" : "Switch to dark theme"}
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className={cn(className)}
    >
      <HugeiconsIcon icon={isDark ? Sun03Icon : Moon02Icon} />
    </Button>
  );
}
