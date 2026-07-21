// Opt-in DOM polyfills for COMPONENT tests.
//
// Some Base UI primitives (e.g. the `MessageScroller`) reach for browser APIs
// that jsdom does not implement — `ResizeObserver`, `IntersectionObserver`, and
// element scroll methods. Importing this module from a component test file
// installs no-op stubs so those components mount without crashing.
//
// This is imported PER-FILE (never from the global `test/setup.ts`) so the
// existing non-DOM tests are entirely unaffected. Import it at the very top of
// a `*.test.tsx` component test:
//
//     import "@/test/dom-polyfills";
//
// The stubs are intentionally inert: these tests assert structure/markup and
// ARIA, not real layout or scroll math.

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): unknown[] {
    return [];
  }
}

function install(): void {
  const g = globalThis as unknown as Record<string, unknown>;

  if (typeof g.ResizeObserver === "undefined") {
    g.ResizeObserver = NoopObserver;
  }
  if (typeof g.IntersectionObserver === "undefined") {
    g.IntersectionObserver = NoopObserver;
  }

  if (typeof Element !== "undefined") {
    const proto = Element.prototype as unknown as Record<string, unknown>;
    if (typeof proto.scrollTo !== "function") {
      proto.scrollTo = function scrollTo(): void {};
    }
    if (typeof proto.scrollIntoView !== "function") {
      proto.scrollIntoView = function scrollIntoView(): void {};
    }
  }
}

install();

export {};
