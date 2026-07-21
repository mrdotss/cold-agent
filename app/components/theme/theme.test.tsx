import "@/test/dom-polyfills";
import "@testing-library/jest-dom/vitest";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ThemeProvider } from "@/components/theme-provider";
import { ThemeToggle } from "@/components/theme/theme-toggle";

/**
 * Theme behavior tests (Req 20.2, 20.3).
 *
 * These render the REAL {@link ThemeProvider} (next-themes, `attribute="class"`,
 * `defaultTheme="system"`, `enableSystem`) with the {@link ThemeToggle} so we
 * exercise the actual wiring rather than a stub:
 *
 *  - Req 20.2 — with no in-app override, the theme follows the OS
 *    `prefers-color-scheme`. jsdom has no `matchMedia`, so we install a
 *    controllable mock and assert next-themes resolves to the matching theme.
 *  - Req 20.3 — selecting a theme applies it (class on `<html>`) AND persists it
 *    (next-themes writes the `theme` key to `localStorage`); a pre-seeded value
 *    is honored on mount, which is exactly how the choice survives a reload.
 *
 * `matchMedia` is mocked PER-FILE (never in the global setup) so the rest of the
 * suite is unaffected.
 */

/** Install a `matchMedia` mock that reports the given dark-scheme preference. */
function mockMatchMedia(prefersDark: boolean): void {
  window.matchMedia = vi.fn().mockImplementation((query: string) => {
    const isDarkQuery = query.includes("prefers-color-scheme: dark");
    return {
      matches: isDarkQuery ? prefersDark : !prefersDark,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
  });
}

/**
 * jsdom's built-in `localStorage` is unreliable under this harness (it can be
 * file-backed / partially stubbed), so install a clean in-memory Storage that
 * next-themes reads/writes deterministically.
 */
function installMemoryStorage(): void {
  let store: Record<string, string> = {};
  const storage: Storage = {
    getItem: (key) => (key in store ? store[key] : null),
    setItem: (key, value) => {
      store[key] = String(value);
    },
    removeItem: (key) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
    key: (index) => Object.keys(store)[index] ?? null,
    get length() {
      return Object.keys(store).length;
    },
  };
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });
}

function resetThemeEnvironment(): void {
  installMemoryStorage();
  document.documentElement.className = "";
  document.documentElement.removeAttribute("style");
}

describe("Theme (next-themes) OS preference + persistence", () => {
  beforeEach(() => {
    resetThemeEnvironment();
  });

  afterEach(() => {
    resetThemeEnvironment();
    vi.restoreAllMocks();
  });

  it("follows the OS dark preference when no in-app override is set (Req 20.2)", async () => {
    mockMatchMedia(true);

    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );

    // With defaultTheme="system" + a dark OS preference and nothing stored,
    // next-themes applies the `dark` class to <html>.
    await waitFor(() =>
      expect(document.documentElement).toHaveClass("dark"),
    );
    // No explicit override has been chosen: the stored value is either unset or
    // the "system" sentinel (never a concrete light/dark override).
    expect(localStorage.getItem("theme")).not.toBe("light");
    expect(localStorage.getItem("theme")).not.toBe("dark");
  });

  it("follows the OS light preference when no in-app override is set (Req 20.2)", async () => {
    mockMatchMedia(false);

    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );

    await waitFor(() =>
      expect(document.documentElement).not.toHaveClass("dark"),
    );
  });

  it("applies and persists an explicit theme selection (Req 20.3)", async () => {
    // OS prefers dark; the user overrides to light via the toggle.
    mockMatchMedia(true);
    const user = userEvent.setup();

    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );

    // Resolved theme is dark → toggle offers "Switch to light theme".
    const toggle = await screen.findByRole("button", {
      name: "Switch to light theme",
    });
    await user.click(toggle);

    // The selection is applied (class flips off `dark`)…
    await waitFor(() =>
      expect(document.documentElement).not.toHaveClass("dark"),
    );
    // …and persisted so it survives a reload within the session.
    await waitFor(() => expect(localStorage.getItem("theme")).toBe("light"));
  });

  it("honors a previously persisted selection on mount over the OS preference (Req 20.3)", async () => {
    // Simulate a reload: OS prefers light, but the user previously chose dark.
    mockMatchMedia(false);
    localStorage.setItem("theme", "dark");

    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );

    // The stored override wins over the OS preference.
    await waitFor(() =>
      expect(document.documentElement).toHaveClass("dark"),
    );
  });
});
