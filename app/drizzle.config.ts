import { defineConfig } from "drizzle-kit";

/**
 * Drizzle Kit configuration for migration generation/apply.
 *
 * - `dialect: postgresql` — Postgres via node-postgres at runtime.
 * - `schema` — the single source-of-truth schema module.
 * - `out` — generated SQL migrations live under `lib/db/migrations` (never
 *   hand-edited; see structure steering).
 * - `dbCredentials.url` — read from `DATABASE_URL`. Drizzle Kit is a CLI tool
 *   run from `app/`, so the env var is resolved from the process environment
 *   (loaded via `.env`) at command time.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./lib/db/schema.ts",
  out: "./lib/db/migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
  strict: true,
  verbose: true,
});
