import {
  boolean,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Single Drizzle schema for the Cloud Bill Analyst web app (design "Data
 * Models"). SQL migrations are generated with `drizzle-kit` (never hand-edited).
 *
 * Conventions:
 *  - Every id / foreign-key column is `text` (application-generated ids double
 *    as opaque strings; `users.id` is also the agent `actor_id`).
 *  - Timestamps are `timestamptz` (`withTimezone: true`) and default to now at
 *    the database layer.
 *  - Secret columns (`connected_accounts.role_arn`, `external_id_enc`) live here
 *    but are NEVER projected to the browser — see `ConnectedAccountView`.
 *
 * This module is pure schema metadata (no secret access), so it is safe to
 * import from both server and tooling (`drizzle.config.ts`) contexts.
 */

/**
 * `users` (Req 1, 2.6). `id` is used as the agent `actor_id`. `email` is stored
 * as entered; `email_normalized` (`trim().toLowerCase()`) is UNIQUE to enforce
 * case-insensitive uniqueness. `password_hash` holds an argon2 hash only —
 * plaintext is never stored.
 */
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  emailNormalized: text("email_normalized").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * `sessions` (Auth.js Drizzle adapter shape; Req 2). DB-backed sessions:
 * `session_token` PK, `user_id` FK, `expires` timestamptz. A 30-day max lifetime
 * is enforced via `expires` at creation; expired rows are deleted and treated as
 * unauthenticated.
 */
export const sessions = pgTable("sessions", {
  sessionToken: text("session_token").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { withTimezone: true }).notNull(),
});

/**
 * `connected_accounts` (Req 4, 5, 17). One read-only cross-account AWS role per
 * row. `role_arn` and `external_id_enc` are SECRETS resolved server-side only;
 * `external_id_enc` is AES-256-GCM ciphertext (plaintext never stored).
 * `aws_account_id` is the 12-digit id extracted from `role_arn` for masked
 * display. `display_currency` / `timezone` default to `IDR` / `Asia/Jakarta`.
 * Per-user count (1–10) is enforced at the application layer.
 */
export const connectedAccounts = pgTable("connected_accounts", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  alias: text("alias").notNull(),
  roleArn: text("role_arn").notNull(),
  externalIdEnc: text("external_id_enc").notNull(),
  awsAccountId: text("aws_account_id").notNull(),
  displayCurrency: text("display_currency").notNull().default("IDR"),
  timezone: text("timezone").notNull().default("Asia/Jakarta"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * `active_account` (Req 5.5, 5.7). Persists the active selection per user across
 * sessions. `connected_account_id` is nullable and cleared (set null) when the
 * active account is removed.
 */
export const activeAccount = pgTable("active_account", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  connectedAccountId: text("connected_account_id").references(
    () => connectedAccounts.id,
    { onDelete: "set null" },
  ),
});

/**
 * `login_attempts` (Req 2.9). Failed attempts in the trailing 15-minute window
 * are counted; >= 5 failures locks that normalized email for 15 minutes.
 */
export const loginAttempts = pgTable("login_attempts", {
  id: text("id").primaryKey(),
  emailNormalized: text("email_normalized").notNull(),
  success: boolean("success").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// Inferred row types (convenience for callers)
// ---------------------------------------------------------------------------

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;

export type ConnectedAccount = typeof connectedAccounts.$inferSelect;
export type NewConnectedAccount = typeof connectedAccounts.$inferInsert;

export type ActiveAccount = typeof activeAccount.$inferSelect;
export type NewActiveAccount = typeof activeAccount.$inferInsert;

export type LoginAttempt = typeof loginAttempts.$inferSelect;
export type NewLoginAttempt = typeof loginAttempts.$inferInsert;
