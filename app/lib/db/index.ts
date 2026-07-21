import "server-only";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { requireEnv } from "@/lib/env";
import * as schema from "@/lib/db/schema";

/**
 * Server-only Postgres client (node-postgres `Pool` + Drizzle).
 *
 * `server-only` guarantees this module can never be pulled into a client bundle
 * (it reads `DATABASE_URL` and opens DB connections). `DATABASE_URL` is read at
 * CALL TIME via `requireEnv` (not at module load), so request-time evaluation
 * works and a missing/empty value throws a typed `MissingEnvError` naming the
 * variable (no value leaked).
 *
 * The `Pool` is created lazily and memoized across requests. In development,
 * Next.js hot-reload re-evaluates modules, so the pool is cached on `globalThis`
 * to avoid exhausting connections with duplicate pools.
 */

const globalForDb = globalThis as unknown as {
  __cbaPgPool?: Pool;
};

/** Lazily create (or reuse) the shared connection pool. */
function getPool(): Pool {
  if (globalForDb.__cbaPgPool === undefined) {
    globalForDb.__cbaPgPool = new Pool({
      connectionString: requireEnv("DATABASE_URL"),
    });
  }
  return globalForDb.__cbaPgPool;
}

/** Drizzle database type bound to the app schema. */
export type Database = ReturnType<typeof createDb>;

function createDb() {
  return drizzle(getPool(), { schema });
}

const globalForDrizzle = globalThis as unknown as {
  __cbaDb?: Database;
};

/**
 * The shared Drizzle client. Access lazily via {@link getDb} so the underlying
 * pool (and env read) is deferred to first use.
 */
export function getDb(): Database {
  if (globalForDrizzle.__cbaDb === undefined) {
    globalForDrizzle.__cbaDb = createDb();
  }
  return globalForDrizzle.__cbaDb;
}

export { schema };
