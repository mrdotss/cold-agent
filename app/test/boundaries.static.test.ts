// @vitest-environment node
//
// Static secret-boundary and environment guards (tasks 19.1).
//
// These tests read the repository's source files from disk (Node `fs`) and
// assert structural invariants that keep secrets on the server and out of the
// committed source tree. They are intentionally run in the `node` environment
// (not jsdom) because they only touch the filesystem — no DOM is needed.
//
// Covered requirements:
//   - 18.1  server-only boundary: every AWS/secret-touching module under
//           `lib/aws/*` and `lib/crypto.ts` imports "server-only".
//   - 18.3  no hardcoded AgentCore runtime ARN literal anywhere in source
//           (the ARN must be read from `process.env.CBA_RUNTIME_ARN`).
//   - 19.2  `.env.example` declares exactly the seven required placeholders,
//           and each value is a non-secret placeholder.
//   - 19.3  `.env` is git-ignored (while `.env.example` remains trackable).

import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---- Path resolution (portable; derived from this file's location) --------

/** Directory containing this test file: `<repo>/app/test`. */
const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
/** The Next.js app root: `<repo>/app`. */
const APP_ROOT = path.resolve(TEST_DIR, "..");
/** The monorepo root: `<repo>`. */
const REPO_ROOT = path.resolve(APP_ROOT, "..");

// ---- Small filesystem helpers --------------------------------------------

/** A source file is a `.ts`/`.tsx` file that is NOT a test/spec file. */
function isSourceFile(fileName: string): boolean {
  if (!/\.tsx?$/.test(fileName)) return false;
  // Exclude test fixtures: `*.test.ts`, `*.spec.ts`, and the compound
  // `*.property.test.ts` / `*.integration.test.ts` (all end in `.test.ts`).
  return !/\.(test|spec)\.tsx?$/.test(fileName);
}

/** Recursively collect absolute paths of source files under `dir`. */
function collectSourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Never descend into build/dependency output.
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      out.push(...collectSourceFiles(full));
    } else if (entry.isFile() && isSourceFile(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function read(file: string): string {
  return readFileSync(file, "utf8");
}

// ---- Source-level classifiers --------------------------------------------

/** Matches `import "server-only"` / `import 'server-only';`. */
const SERVER_ONLY_IMPORT = /import\s+["']server-only["']/;
/** Matches any import from an `@aws-sdk/*` package. */
const AWS_SDK_IMPORT = /from\s+["']@aws-sdk\//;
/** Matches an import of the server-only crypto module. */
const CRYPTO_IMPORT = /from\s+["']@\/lib\/crypto["']/;

/**
 * A module "must be server-only" if it touches the AWS SDK or the server-only
 * crypto module (i.e. it does AWS work or handles secrets). This mirrors the
 * conventions steering: anything touching AWS or secrets is a server-only
 * module and must never be importable into a client bundle.
 */
function mustBeServerOnly(source: string): boolean {
  return AWS_SDK_IMPORT.test(source) || CRYPTO_IMPORT.test(source);
}

describe("secret-boundary static guards (Req 18.1)", () => {
  const awsDir = path.join(APP_ROOT, "lib", "aws");
  const awsModules = collectSourceFiles(awsDir);

  it("finds the lib/aws source modules", () => {
    // Sanity: the directory exists and has the modules we expect to guard.
    const names = awsModules.map((f) => path.basename(f)).sort();
    expect(names).toEqual(
      expect.arrayContaining([
        "agentcore.ts",
        "cost-explorer.ts",
        "s3.ts",
        "sts.ts",
        "sse.ts",
        "cfn-template.ts",
      ]),
    );
  });

  it("every AWS/secret-touching module under lib/aws imports server-only", () => {
    const offenders: string[] = [];
    for (const file of awsModules) {
      const source = read(file);
      if (mustBeServerOnly(source) && !SERVER_ONLY_IMPORT.test(source)) {
        offenders.push(path.relative(APP_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the known server-only AWS modules explicitly import server-only", () => {
    // Explicit belt-and-suspenders check for the four modules that perform
    // AWS/secret work, independent of the classifier above.
    for (const name of ["agentcore.ts", "s3.ts", "sts.ts", "cost-explorer.ts"]) {
      const source = read(path.join(awsDir, name));
      expect(
        SERVER_ONLY_IMPORT.test(source),
        `${name} must \`import "server-only"\``,
      ).toBe(true);
    }
  });

  it("the pure helpers (sse.ts, cfn-template.ts) are genuinely client-safe", () => {
    // These are exempt from server-only ONLY because they are pure: no AWS SDK
    // and no secret/crypto access. Verify that here so the exemption is earned.
    for (const name of ["sse.ts", "cfn-template.ts"]) {
      const source = read(path.join(awsDir, name));
      expect(AWS_SDK_IMPORT.test(source), `${name} must not import @aws-sdk/*`).toBe(
        false,
      );
      expect(CRYPTO_IMPORT.test(source), `${name} must not import @/lib/crypto`).toBe(
        false,
      );
    }
  });

  it("lib/crypto.ts imports server-only", () => {
    const source = read(path.join(APP_ROOT, "lib", "crypto.ts"));
    expect(SERVER_ONLY_IMPORT.test(source)).toBe(true);
  });
});

describe("no hardcoded runtime ARN literal (Req 18.3)", () => {
  // The Bedrock AgentCore runtime ARN must be read from
  // `process.env.CBA_RUNTIME_ARN`, never hardcoded in source.
  const RUNTIME_ARN_LITERAL = /arn:aws:bedrock-agentcore:/;
  const SCAN_DIRS = ["lib", "app", "components", "hooks"].map((d) =>
    path.join(APP_ROOT, d),
  );

  it("no source file contains a bedrock-agentcore ARN literal", () => {
    const offenders: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of collectSourceFiles(dir)) {
        if (RUNTIME_ARN_LITERAL.test(read(file))) {
          offenders.push(path.relative(APP_ROOT, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe(".env.example placeholders and .env git-ignore (Req 19.2, 19.3)", () => {
  const REQUIRED_KEYS = [
    "DATABASE_URL",
    "AUTH_SECRET",
    "APP_ENCRYPTION_KEY",
    "AWS_REGION",
    "CBA_RUNTIME_ARN",
    "CBA_RUNTIME_ROLE_ARN",
    "CBA_REPORT_BUCKET",
  ].sort();

  /** Parse `KEY=value` pairs from a dotenv file, ignoring comments/blanks. */
  function parseDotenv(content: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.length === 0 || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      let value = line.slice(eq + 1).trim();
      // Strip a single layer of surrounding quotes.
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      out.set(key, value);
    }
    return out;
  }

  const envExamplePath = path.join(APP_ROOT, ".env.example");
  const envVars = parseDotenv(read(envExamplePath));

  it(".env.example defines exactly the seven required keys", () => {
    expect([...envVars.keys()].sort()).toEqual(REQUIRED_KEYS);
  });

  it("every placeholder value is non-empty and non-secret", () => {
    for (const [key, value] of envVars) {
      expect(value.length, `${key} must have a non-empty placeholder`).toBeGreaterThan(0);
    }
    // Light non-secret check for the two credential-bearing keys: their values
    // must look like placeholders (a `<...>` token or the word "generate"),
    // never a real random secret committed to the repo.
    for (const key of ["AUTH_SECRET", "APP_ENCRYPTION_KEY"]) {
      const value = envVars.get(key) ?? "";
      const placeholderLike = /[<>]/.test(value) || /generate/i.test(value);
      expect(placeholderLike, `${key} must be a placeholder, not a real secret`).toBe(
        true,
      );
    }
  });

  it(".env is git-ignored while .env.example remains trackable", () => {
    // A rule that ignores the `.env` file (not the example).
    const ignoresEnv = new Set([".env", ".env*", ".env.*", "**/.env", "/.env"]);
    const candidatePaths = [
      path.join(REPO_ROOT, ".gitignore"),
      path.join(APP_ROOT, ".gitignore"),
    ].filter((p) => existsSync(p));

    // At least one .gitignore must exist to enforce this.
    expect(candidatePaths.length).toBeGreaterThan(0);

    let ignoresDotEnv = false;
    let keepsExample = false;
    for (const gitignorePath of candidatePaths) {
      const lines = read(gitignorePath)
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith("#"));
      if (lines.some((l) => ignoresEnv.has(l))) ignoresDotEnv = true;
      if (lines.some((l) => l === "!.env.example")) keepsExample = true;
    }

    expect(ignoresDotEnv, ".env must be git-ignored").toBe(true);
    expect(keepsExample, ".env.example must stay trackable via a negation rule").toBe(
      true,
    );
  });
});
