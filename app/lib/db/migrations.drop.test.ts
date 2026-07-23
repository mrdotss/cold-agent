// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";

/**
 * Migration + schema guard for dropping the superseded Postgres chat tables
 * (Req 12.5, 12.6). Chat history — including message feedback — now lives in
 * DynamoDB; Postgres retains auth + connected accounts only.
 *
 * These tests assert three things:
 *  1. The generated Drizzle migration SQL issues `DROP` for the three chat
 *     tables (`threads`, `messages`, `message_feedback`).
 *  2. The migration issues NO `DROP` for any retained auth/account table
 *     (`users`, `sessions`, `connected_accounts`, `active_account`,
 *     `login_attempts`).
 *  3. `lib/db/schema.ts` no longer exports the three dropped table definitions
 *     and still exports the retained ones.
 */

// SQL table names (snake_case) for the tables that must be dropped.
const DROPPED_SQL_TABLES = ["threads", "messages", "message_feedback"] as const;

// SQL table names for the tables that must be retained (never dropped).
const RETAINED_SQL_TABLES = [
  "users",
  "sessions",
  "connected_accounts",
  "active_account",
  "login_attempts",
] as const;

const migrationsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "migrations",
);

/**
 * Read and concatenate every generated `.sql` migration under `migrations/`.
 * Globbing the directory (rather than hardcoding a filename) keeps this robust
 * to future migration renames/additions.
 */
function readAllMigrationSql(): string {
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));
  return files
    .map((f) => readFileSync(path.join(migrationsDir, f), "utf8"))
    .join("\n");
}

/**
 * Extract the set of table names targeted by `DROP TABLE` statements. Robust to
 * optional `IF EXISTS`, optional double-quoting, and a trailing `CASCADE`.
 */
function droppedTableNames(sql: string): Set<string> {
  const names = new Set<string>();
  const re = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(sql)) !== null) {
    names.add(match[1]);
  }
  return names;
}

describe("chat-table drop migration (Req 12.5, 12.6)", () => {
  const sql = readAllMigrationSql();
  const dropped = droppedTableNames(sql);

  it("drops exactly the three superseded chat tables", () => {
    for (const table of DROPPED_SQL_TABLES) {
      expect(dropped.has(table), `expected DROP for "${table}"`).toBe(true);
    }
  });

  it("issues no DROP for any retained auth/account table", () => {
    for (const table of RETAINED_SQL_TABLES) {
      expect(dropped.has(table), `unexpected DROP for "${table}"`).toBe(false);
    }
  });

  it("drops nothing beyond the three chat tables", () => {
    expect([...dropped].sort()).toEqual([...DROPPED_SQL_TABLES].sort());
  });
});

describe("schema.ts exports after the drop (Req 12.6)", () => {
  it("no longer exports the three dropped table definitions", () => {
    const s = schema as Record<string, unknown>;
    expect(s.threads).toBeUndefined();
    expect(s.messages).toBeUndefined();
    expect(s.messageFeedback).toBeUndefined();
  });

  it("still exports the retained auth/account table definitions", () => {
    expect(schema.users).toBeDefined();
    expect(schema.sessions).toBeDefined();
    expect(schema.connectedAccounts).toBeDefined();
    expect(schema.activeAccount).toBeDefined();
    expect(schema.loginAttempts).toBeDefined();
  });
});
