import "server-only";

import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";

import { requireEnv } from "@/lib/env";
import { roleArnSchema } from "@/lib/validation";

/**
 * Server-only STS integration.
 *
 * This module assumes a customer's read-only cross-account role using the
 * account's `external_id` as the `sts:ExternalId` trust condition value, and
 * exposes a connection test that combines the assume-role with a minimal Cost
 * Explorer probe (Req 4.1–4.3, 4.5).
 *
 * `server-only` guarantees the module can never be pulled into a client bundle:
 * it handles `role_arn` / `external_id` (secrets) and issues AWS SDK calls, all
 * of which must stay server-side.
 *
 * ### Cross-account trust alignment
 * The onboarding CloudFormation trusts `CBA_RUNTIME_ROLE_ARN` (the AgentCore
 * runtime execution role) as the sole principal under the `sts:ExternalId`
 * condition. In production the web app is deployed with an AWS identity that can
 * assume that runtime role, and role-chains through it before assuming the
 * customer role, so the assume-role caller matches the CFN trust principal.
 *
 * Per the task scope this implementation keeps the caller identity ambient: it
 * uses the default AWS credential provider chain (env / profile / task role) and
 * the `AWS_REGION` env var. A full role-chaining step (assume
 * `CBA_RUNTIME_ROLE_ARN` first) can be layered in later without changing this
 * module's public contract.
 */

/** Temporary credentials returned by a successful AssumeRole. */
export interface AssumedCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

/**
 * Categorized outcome of {@link testConnection}. On success `ok` is `true` and
 * `category` is omitted. On failure `ok` is `false` and `category` names the
 * failure class WITHOUT exposing the External_Id, role credentials, or any
 * internal identifier (Req 4.5).
 */
export interface ConnectionTestResult {
  ok: boolean;
  category?: "invalid_input" | "assume_failed" | "query_failed" | "timeout";
}

/** STS ExternalId length bounds (inclusive), per Req 3.1 / 4.x. */
export const EXTERNAL_ID_MIN_LENGTH = 16;
export const EXTERNAL_ID_MAX_LENGTH = 1224;

/**
 * STS `ExternalId` permitted charset: `[\w+=,.@:/-]` (AWS spec). Values produced
 * by `newExternalId` (base64url) are a strict subset of this.
 */
const EXTERNAL_ID_REGEX = /^[\w+=,.@:/-]+$/;

/** The connection test must complete (assume + query) within 30 seconds (Req 4.3). */
export const CONNECTION_TEST_TIMEOUT_MS = 30_000;

/** Session name attached to the assume-role call (no secrets). */
const ROLE_SESSION_NAME = "cloud-bill-analyst-web";

/**
 * Returns whether `externalId` is structurally valid: a string within the
 * inclusive [16, 1224] length bound and using only STS-permitted characters.
 * Used to reject malformed input BEFORE any STS call (Req 4.2).
 */
export function isValidExternalId(externalId: string): boolean {
  return (
    typeof externalId === "string" &&
    externalId.length >= EXTERNAL_ID_MIN_LENGTH &&
    externalId.length <= EXTERNAL_ID_MAX_LENGTH &&
    EXTERNAL_ID_REGEX.test(externalId)
  );
}

/**
 * Reject clearly invalid `roleArn` / `externalId` input before touching STS.
 * Returns `true` iff both are well-formed. Pure and side-effect free.
 */
function isValidAssumeInput(roleArn: string, externalId: string): boolean {
  return roleArnSchema.safeParse(roleArn).success && isValidExternalId(externalId);
}

/** Build an STS client using the ambient identity and configured region. */
function stsClient(): STSClient {
  return new STSClient({ region: requireEnv("AWS_REGION") });
}

/**
 * Assume a customer's read-only role using the account's External_Id as the
 * `sts:ExternalId` trust condition value, returning temporary credentials.
 *
 * @throws {Error} if input is malformed (before any STS call) or if STS
 *   `AssumeRole` fails / returns no credentials. Errors intentionally carry no
 *   secret material.
 */
export async function assumeReadOnlyRole(
  roleArn: string,
  externalId: string,
): Promise<AssumedCreds> {
  if (!isValidAssumeInput(roleArn, externalId)) {
    throw new Error("Invalid role ARN or external id");
  }

  const client = stsClient();
  try {
    const response = await client.send(
      new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: ROLE_SESSION_NAME,
        ExternalId: externalId,
      }),
    );

    const creds = response.Credentials;
    if (
      creds?.AccessKeyId === undefined ||
      creds.SecretAccessKey === undefined ||
      creds.SessionToken === undefined
    ) {
      throw new Error("AssumeRole returned incomplete credentials");
    }

    return {
      accessKeyId: creds.AccessKeyId,
      secretAccessKey: creds.SecretAccessKey,
      sessionToken: creds.SessionToken,
    };
  } finally {
    client.destroy();
  }
}

/**
 * Test a pending connection end-to-end (Req 4.1–4.3, 4.5):
 *   1. Validate `roleArn` / `externalId` — on failure return
 *      `{ ok: false, category: "invalid_input" }` and perform ZERO STS calls
 *      (Req 4.2).
 *   2. AssumeRole with the External_Id.
 *   3. Run a minimal 1-day, DAILY, single-metric `GetCostAndUsage`.
 * The combined assume + query must finish within 30s or the result is
 * `{ ok: false, category: "timeout" }` (Req 4.3).
 *
 * Never throws to the caller and never exposes secrets: every failure is mapped
 * to a coarse `category` only (Req 4.5).
 */
export async function testConnection(
  roleArn: string,
  externalId: string,
): Promise<ConnectionTestResult> {
  // Req 4.2: validate BEFORE any assume-role; no STS call on invalid input.
  if (!isValidAssumeInput(roleArn, externalId)) {
    return { ok: false, category: "invalid_input" };
  }

  // Lazy import keeps the STS <-> Cost Explorer modules decoupled and avoids a
  // load-time cycle; both are server-only.
  const { probeCostExplorer } = await import("@/lib/aws/cost-explorer");

  const run = async (): Promise<ConnectionTestResult> => {
    let creds: AssumedCreds;
    try {
      creds = await assumeReadOnlyRole(roleArn, externalId);
    } catch {
      return { ok: false, category: "assume_failed" };
    }

    try {
      await probeCostExplorer(creds);
    } catch {
      return { ok: false, category: "query_failed" };
    }

    return { ok: true };
  };

  return withTimeout(run(), CONNECTION_TEST_TIMEOUT_MS, {
    ok: false,
    category: "timeout",
  });
}

/**
 * Resolve with `promise` if it settles within `ms`, otherwise resolve with
 * `onTimeout`. The timer is always cleared so the process does not hang.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
