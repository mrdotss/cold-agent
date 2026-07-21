import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Resolve the `@/*` alias from tsconfig so tests can import app modules.
    tsconfigPaths: true,
    alias: {
      // `server-only` throws when imported outside a React Server Component
      // (i.e. under Vitest/jsdom). Server-only pure modules (`lib/crypto.ts`,
      // `lib/env.ts`) are directly testable, so stub it out to a no-op.
      "server-only": fileURLToPath(
        new URL("./test/server-only-stub.ts", import.meta.url),
      ),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    include: ["**/*.{test,spec,property.test}.{ts,tsx}"],
    exclude: ["node_modules", ".next", "dist"],
  },
});
