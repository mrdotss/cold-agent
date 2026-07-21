// Test stub for the `server-only` package.
//
// The real `server-only` module throws when imported outside a React Server
// Component (which is what happens under Vitest/jsdom). Server-only modules
// such as `lib/crypto.ts` and `lib/env.ts` are pure and directly testable, so
// we alias `server-only` to this empty no-op module in the Vitest config.
export {};
