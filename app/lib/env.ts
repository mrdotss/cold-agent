import "server-only";

/**
 * Server-only environment access.
 *
 * Values are read from `process.env` AT CALL TIME (not at module load) so this
 * works with Next.js request-time evaluation. The seven variables below are the
 * authoritative set the app reads (see `.env.example`).
 *
 * A `MissingEnvError` is thrown when a required variable is absent OR empty. The
 * error message names the offending variable by NAME ONLY and never includes any
 * value, so it is safe to log/return (Req 19.4, 19.5). Each throw references
 * exactly one variable.
 */

export const REQUIRED_ENV_VARS = [
  "DATABASE_URL",
  "AUTH_SECRET",
  "APP_ENCRYPTION_KEY",
  "AWS_REGION",
  "CBA_RUNTIME_ARN",
  "CBA_RUNTIME_ROLE_ARN",
  "CBA_REPORT_BUCKET",
] as const;

export type RequiredEnvVar = (typeof REQUIRED_ENV_VARS)[number];

export type Env = Record<RequiredEnvVar, string>;

/**
 * Thrown when a required environment variable is missing or empty.
 * Carries the variable name only — no value is captured or exposed.
 */
export class MissingEnvError extends Error {
  readonly variableName: RequiredEnvVar;

  constructor(variableName: RequiredEnvVar) {
    super(`Missing required environment variable: ${variableName}`);
    this.name = "MissingEnvError";
    this.variableName = variableName;
    // Preserve prototype chain for instanceof across transpile targets.
    Object.setPrototypeOf(this, MissingEnvError.prototype);
  }
}

/**
 * Read a single required env var at request time.
 * @throws {MissingEnvError} if the variable is absent or an empty string.
 */
export function requireEnv(name: RequiredEnvVar): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    // Record exactly one log entry naming the missing/empty variable. Only the
    // variable NAME is logged — never any value — so nothing sensitive leaks
    // into logs (Req 19.5).
    console.error(`Missing required environment variable: ${name}`);
    throw new MissingEnvError(name);
  }
  return value;
}

/**
 * Read and validate all seven required env vars at request time.
 * @throws {MissingEnvError} for the first variable found absent or empty.
 */
export function getEnv(): Env {
  const env = {} as Env;
  for (const name of REQUIRED_ENV_VARS) {
    env[name] = requireEnv(name);
  }
  return env;
}
