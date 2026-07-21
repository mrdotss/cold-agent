"use server";

import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { z } from "zod";

import {
  MAX_CONNECTED_ACCOUNTS,
  canAddConnectedAccount,
} from "@/lib/accounts-limit";
import { auth } from "@/lib/auth";
import { isValidExternalId } from "@/lib/aws/sts";
import { getDb } from "@/lib/db";
import { activeAccount, connectedAccounts } from "@/lib/db/schema";
import {
  toConnectedAccountView,
  type ConnectedAccountView,
} from "@/lib/db/views";
import { encryptSecret } from "@/lib/crypto";
import {
  accountIdFromRoleArn,
  aliasSchema,
  currencySchema,
  roleArnSchema,
  timezoneSchema,
} from "@/lib/validation";

/**
 * Connected-account server actions (Req 3, 4, 5, 17).
 *
 * These actions own the persistence side of the account wizard: creating a
 * connected account (with the External_Id encrypted at rest and the two contract
 * defaults applied), listing/deleting accounts, editing per-account settings, and
 * tracking the active-account selection.
 *
 * ## Boundaries honored here
 *  - Every export resolves the current user via `auth()`; an unauthenticated
 *    caller is rejected (mutations) or treated as owning nothing (reads) rather
 *    than throwing a raw error.
 *  - All input is zod-validated BEFORE any store or AWS call, so malformed input
 *    never produces a side effect (Req 18.6, 18.7).
 *  - Secrets never cross the browser boundary: `role_arn` and the (encrypted)
 *    External_Id stay server-side and callers only ever receive a
 *    {@link ConnectedAccountView} projection (Req 4.6, 5.9).
 *
 * `"use server"` marks every export as a server action; the module only ever runs
 * server-side and safely imports the `server-only` db / crypto / aws modules.
 */

/**
 * The per-user connected-account bound {@link MAX_CONNECTED_ACCOUNTS} lives in
 * the pure `@/lib/accounts-limit` module and is imported above for the guard
 * below. It is intentionally NOT re-exported here: a `"use server"` module may
 * only export async functions, so consumers that need the constant import it
 * directly from `@/lib/accounts-limit` (the single source of truth).
 */

/** Contract default display currency for a new account (Req 4.4, 17.2). */
const DEFAULT_DISPLAY_CURRENCY = "IDR";
/** Contract default timezone for a new account (Req 4.4, 17.2). */
const DEFAULT_TIMEZONE = "Asia/Jakarta";

// ---------------------------------------------------------------------------
// Public result shapes (browser-safe; never carry account secrets)
// ---------------------------------------------------------------------------

/** Raw, unvalidated input accepted by {@link createConnectedAccount}. */
export interface CreateConnectedAccountInput {
  alias: string;
  roleArn: string;
  /** The External_Id generated/tested for the pending connection. */
  externalId: string;
}

/** Result of a {@link createConnectedAccount} call (never throws for expected outcomes). */
export type CreateConnectedAccountResult =
  | { ok: true; account: ConnectedAccountView }
  | { ok: false; message: string };

/** Generic mutation result for delete / update / active-selection actions. */
export type AccountMutationResult =
  | { ok: true }
  | { ok: false; message: string };

/** Raw, unvalidated input accepted by {@link updateAccountSettings}. */
export interface UpdateAccountSettingsInput {
  displayCurrency?: string;
  timezone?: string;
}

/**
 * zod schema for {@link createConnectedAccount} input. `alias`/`roleArn` reuse
 * the shared schemas; `externalId` is validated structurally against the STS
 * ExternalId bounds/charset. Validation happens before any store (Req 18.6/18.7).
 */
const createAccountSchema = z.object({
  alias: aliasSchema,
  roleArn: roleArnSchema,
  externalId: z.string().refine(isValidExternalId, {
    message: "Invalid external id",
  }),
});

/**
 * zod schema for {@link updateAccountSettings} input: currency (ISO 4217) and
 * timezone (IANA) are each optional but validated when present (Req 17.2).
 */
const updateSettingsSchema = z
  .object({
    displayCurrency: currencySchema.optional(),
    timezone: timezoneSchema.optional(),
  })
  .strict();

/** Resolve the authenticated user id, or `null` when unauthenticated. */
async function currentUserId(): Promise<string | null> {
  const session = await auth();
  const userId = session?.user?.id;
  return typeof userId === "string" && userId.length > 0 ? userId : null;
}

/**
 * Create and store exactly one connected account for the authenticated user
 * (Req 4.4, 4.6, 4.7, 5.1, 5.2, 17.2).
 *
 * Steps:
 *  1. Require an authenticated user; otherwise reject (persist nothing).
 *  2. Validate `alias` + `roleArn` + `externalId` BEFORE any store; invalid input
 *     is rejected with no side effect (Req 18.6, 18.7).
 *  3. Enforce the per-user count bound: a user already holding
 *     {@link MAX_CONNECTED_ACCOUNTS} accounts is rejected and nothing changes
 *     (Req 5.1, 5.2).
 *  4. Derive the 12-digit `aws_account_id` from the role ARN, encrypt the
 *     External_Id with `APP_ENCRYPTION_KEY`, and insert one row with the contract
 *     defaults (`IDR` / `Asia/Jakarta`) associated to the user (Req 4.4, 4.7).
 *
 * On any failure the store is left unchanged. Returns only a
 * {@link ConnectedAccountView} (never `role_arn` / External_Id — Req 5.9).
 */
export async function createConnectedAccount(
  input: CreateConnectedAccountInput,
): Promise<CreateConnectedAccountResult> {
  const userId = await currentUserId();
  if (userId === null) {
    return { ok: false, message: "You must be signed in to connect an account." };
  }

  const parsed = createAccountSchema.safeParse(input);
  if (!parsed.success) {
    // Reject invalid input before touching the store (Req 18.6, 18.7).
    return { ok: false, message: "Invalid account details." };
  }

  const { alias, roleArn, externalId } = parsed.data;

  try {
    const db = getDb();

    // Enforce the 1..10 count bound: if the user already has the maximum, reject
    // and change nothing (Req 5.1, 5.2).
    const existing = await db
      .select({ id: connectedAccounts.id })
      .from(connectedAccounts)
      .where(eq(connectedAccounts.userId, userId));

    if (!canAddConnectedAccount(existing.length)) {
      return {
        ok: false,
        message: `You can connect at most ${MAX_CONNECTED_ACCOUNTS} accounts.`,
      };
    }

    // Derive display metadata and encrypt the secret at rest (Req 4.4, 4.6).
    const awsAccountId = accountIdFromRoleArn(roleArn);
    const externalIdEnc = encryptSecret(externalId);

    const [created] = await db
      .insert(connectedAccounts)
      .values({
        id: randomUUID(),
        userId,
        alias,
        roleArn,
        externalIdEnc,
        awsAccountId,
        displayCurrency: DEFAULT_DISPLAY_CURRENCY,
        timezone: DEFAULT_TIMEZONE,
      })
      .returning();

    if (created === undefined) {
      return { ok: false, message: "Could not save the account. Please retry." };
    }

    return { ok: true, account: toConnectedAccountView(created) };
  } catch {
    // Store nothing on failure (Req 4.5): surface a generic, secret-free error.
    return { ok: false, message: "Could not save the account. Please retry." };
  }
}

/**
 * List the authenticated user's connected accounts as browser-safe
 * {@link ConnectedAccountView}s (Req 5.9). An unauthenticated caller receives an
 * empty list. Secrets (`role_arn`, External_Id) are never included.
 */
export async function listConnectedAccounts(): Promise<ConnectedAccountView[]> {
  const userId = await currentUserId();
  if (userId === null) {
    return [];
  }

  const db = getDb();
  const rows = await db
    .select()
    .from(connectedAccounts)
    .where(eq(connectedAccounts.userId, userId));

  return rows.map(toConnectedAccountView);
}

/**
 * Delete a connected account the caller OWNS (Req 5.6, 5.7, 5.8).
 *
 * The active-account selection is cleared first when it points at the account
 * being removed, then the row (including its encrypted External_Id) is deleted —
 * both inside one transaction so the two never diverge (Req 5.7). If the account
 * does not exist or is not owned by the caller, an error is returned and nothing
 * changes; any unexpected failure retains the row and returns an error (Req 5.8).
 */
export async function deleteConnectedAccount(
  accountId: string,
): Promise<AccountMutationResult> {
  const userId = await currentUserId();
  if (userId === null) {
    return { ok: false, message: "You must be signed in to remove an account." };
  }
  if (typeof accountId !== "string" || accountId.length === 0) {
    return { ok: false, message: "Account not found." };
  }

  try {
    const db = getDb();

    return await db.transaction(async (tx) => {
      // Ownership gate: confirm the account exists and belongs to this user.
      const [owned] = await tx
        .select({ id: connectedAccounts.id })
        .from(connectedAccounts)
        .where(
          and(
            eq(connectedAccounts.id, accountId),
            eq(connectedAccounts.userId, userId),
          ),
        )
        .limit(1);

      if (owned === undefined) {
        return { ok: false, message: "Account not found." };
      }

      // Clear the active-account selection if it points at this account
      // (Req 5.7). Done explicitly (not only via the FK's ON DELETE SET NULL) so
      // the intent is clear and self-contained.
      await tx
        .update(activeAccount)
        .set({ connectedAccountId: null })
        .where(
          and(
            eq(activeAccount.userId, userId),
            eq(activeAccount.connectedAccountId, accountId),
          ),
        );

      await tx
        .delete(connectedAccounts)
        .where(
          and(
            eq(connectedAccounts.id, accountId),
            eq(connectedAccounts.userId, userId),
          ),
        );

      return { ok: true };
    });
  } catch {
    // Deletion failed: retain the row and report the failure (Req 5.8).
    return { ok: false, message: "Could not remove the account. Please retry." };
  }
}

/**
 * Update the per-account display currency and/or timezone for an account the
 * caller OWNS (Req 17.2). Both fields are optional but validated when present
 * (ISO 4217 currency, IANA timezone). A no-op update (no fields) succeeds. If the
 * account is missing or not owned, an error is returned and nothing changes.
 */
export async function updateAccountSettings(
  accountId: string,
  settings: UpdateAccountSettingsInput,
): Promise<AccountMutationResult> {
  const userId = await currentUserId();
  if (userId === null) {
    return { ok: false, message: "You must be signed in to update settings." };
  }
  if (typeof accountId !== "string" || accountId.length === 0) {
    return { ok: false, message: "Account not found." };
  }

  const parsed = updateSettingsSchema.safeParse(settings);
  if (!parsed.success) {
    // Reject invalid currency/timezone before persisting (Req 17.2, 18.6).
    return { ok: false, message: "Invalid account settings." };
  }

  const update: { displayCurrency?: string; timezone?: string } = {};
  if (parsed.data.displayCurrency !== undefined) {
    update.displayCurrency = parsed.data.displayCurrency;
  }
  if (parsed.data.timezone !== undefined) {
    update.timezone = parsed.data.timezone;
  }

  try {
    const db = getDb();

    // Nothing to change: still confirm ownership so a missing/unowned account is
    // reported rather than silently succeeding.
    if (Object.keys(update).length === 0) {
      const [owned] = await db
        .select({ id: connectedAccounts.id })
        .from(connectedAccounts)
        .where(
          and(
            eq(connectedAccounts.id, accountId),
            eq(connectedAccounts.userId, userId),
          ),
        )
        .limit(1);
      return owned === undefined
        ? { ok: false, message: "Account not found." }
        : { ok: true };
    }

    // Ownership-scoped update: the `where` restricts to the caller's own row, so
    // a non-owned/absent account updates nothing and is reported as not found.
    const updated = await db
      .update(connectedAccounts)
      .set(update)
      .where(
        and(
          eq(connectedAccounts.id, accountId),
          eq(connectedAccounts.userId, userId),
        ),
      )
      .returning({ id: connectedAccounts.id });

    if (updated.length === 0) {
      return { ok: false, message: "Account not found." };
    }

    return { ok: true };
  } catch {
    return { ok: false, message: "Could not update settings. Please retry." };
  }
}

/**
 * Set the caller's active connected account (Req 5.5). Ownership is verified,
 * then the per-user `active_account` row is upserted so the selection persists
 * across sessions until the user chooses a different account. An account that is
 * missing or not owned is rejected and the selection is unchanged.
 */
export async function setActiveAccount(
  accountId: string,
): Promise<AccountMutationResult> {
  const userId = await currentUserId();
  if (userId === null) {
    return { ok: false, message: "You must be signed in to select an account." };
  }
  if (typeof accountId !== "string" || accountId.length === 0) {
    return { ok: false, message: "Account not found." };
  }

  try {
    const db = getDb();

    const [owned] = await db
      .select({ id: connectedAccounts.id })
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.id, accountId),
          eq(connectedAccounts.userId, userId),
        ),
      )
      .limit(1);

    if (owned === undefined) {
      return { ok: false, message: "Account not found." };
    }

    // Upsert the per-user selection (userId is the PK), persisting it across
    // sessions until the user selects a different account (Req 5.5).
    await db
      .insert(activeAccount)
      .values({ userId, connectedAccountId: accountId })
      .onConflictDoUpdate({
        target: activeAccount.userId,
        set: { connectedAccountId: accountId },
      });

    return { ok: true };
  } catch {
    return { ok: false, message: "Could not select the account. Please retry." };
  }
}

/**
 * Read the caller's active connected account as a browser-safe
 * {@link ConnectedAccountView}, or `null` when unauthenticated, no selection has
 * been made, or the selection was cleared (e.g. the active account was removed).
 * Secrets are never included (Req 5.9).
 */
export async function getActiveAccount(): Promise<ConnectedAccountView | null> {
  const userId = await currentUserId();
  if (userId === null) {
    return null;
  }

  const db = getDb();
  const [row] = await db
    .select({ account: connectedAccounts })
    .from(activeAccount)
    .innerJoin(
      connectedAccounts,
      eq(activeAccount.connectedAccountId, connectedAccounts.id),
    )
    .where(eq(activeAccount.userId, userId))
    .limit(1);

  return row === undefined ? null : toConnectedAccountView(row.account);
}
