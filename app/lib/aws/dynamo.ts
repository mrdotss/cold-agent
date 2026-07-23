import "server-only";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { requireEnv } from "@/lib/env";

/**
 * Server-only DynamoDB document client for chat history (Req 5.1, 12.3).
 *
 * This module is the single place that constructs the
 * `DynamoDBDocumentClient` (`@aws-sdk/lib-dynamodb`) over a `DynamoDBClient`
 * (`@aws-sdk/client-dynamodb`) used by the `lib/history/*` access layer. It is
 * `import "server-only"` because it touches AWS credentials and must never be
 * bundled into a client.
 *
 * The client is built lazily and memoized so repeated calls reuse the same
 * instance (one connection pool per server process). The region is read from
 * `process.env.AWS_REGION` via `requireEnv` at first construction.
 *
 * The history table name is read from `process.env.CBA_HISTORY_TABLE` AT CALL
 * TIME and throws `MissingHistoryConfigError` when unset/empty — BEFORE any
 * DynamoDB call is attempted. This check is deliberately separate from
 * `lib/env.ts`'s required-set validation so the app does not hard-fail globally
 * on this one variable (only chat-history operations need it).
 */

/** Memoized document client — one per server process. */
let docClient: DynamoDBDocumentClient | undefined;

/**
 * Thrown when `CBA_HISTORY_TABLE` is unset or empty at call time.
 *
 * Carries only the variable NAME — never any value — so it is safe to log or
 * map to a redacted server-side configuration error (Req 12.3).
 */
export class MissingHistoryConfigError extends Error {
  constructor() {
    super("Missing required environment variable: CBA_HISTORY_TABLE");
    this.name = "MissingHistoryConfigError";
    // Preserve prototype chain for instanceof across transpile targets.
    Object.setPrototypeOf(this, MissingHistoryConfigError.prototype);
  }
}

/**
 * Return the memoized `DynamoDBDocumentClient`, constructing it on first call.
 *
 * The underlying `DynamoDBClient` is configured with the `AWS_REGION` env var.
 * `removeUndefinedValues: true` lets stores omit optional attributes (e.g. an
 * absent `feedback`) without breaking puts/updates.
 */
export function getDocClient(): DynamoDBDocumentClient {
  if (docClient === undefined) {
    const client = new DynamoDBClient({ region: requireEnv("AWS_REGION") });
    docClient = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }
  return docClient;
}

/**
 * Resolve the chat-history table name from `process.env.CBA_HISTORY_TABLE`.
 *
 * @throws {MissingHistoryConfigError} when the variable is unset or empty. This
 *   is thrown before any DynamoDB call so a misconfiguration fails fast without
 *   issuing a request (Req 12.3).
 */
export function historyTableName(): string {
  const value = process.env.CBA_HISTORY_TABLE;
  if (value === undefined || value === "") {
    throw new MissingHistoryConfigError();
  }
  return value;
}
