// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { MissingEnvError, requireEnv, type RequiredEnvVar } from "./env";

/**
 * Unit tests for server-only env access error handling.
 *
 * Validates: Requirements 18.4, 19.4, 19.5
 *  - 19.4: with a required variable present and non-empty, `requireEnv` returns
 *    the value and produces no env-related error.
 *  - 18.4 / 19.4: a missing OR empty required variable throws a typed
 *    `MissingEnvError` whose message names the variable and contains no value.
 *  - 19.5: a single failed `requireEnv` records exactly ONE log entry naming the
 *    variable, with no environment variable values in the error or the log.
 */

// A distinctive fake secret used to prove no value ever leaks into an error or
// a log line. It must never appear in any thrown message or logged argument.
const FAKE_SECRET = "s3cr3t-VALUE-should-never-be-logged-9f2a";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("requireEnv", () => {
  it("returns the value when the variable is present and non-empty (Req 19.4)", () => {
    vi.stubEnv("DATABASE_URL", "postgres://user:pass@host:5432/cba");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(requireEnv("DATABASE_URL")).toBe(
      "postgres://user:pass@host:5432/cba",
    );
    // A successful read is not an env error and must not be logged.
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("throws a typed MissingEnvError naming the variable when it is unset (Req 18.4)", () => {
    // Ensure the variable is genuinely absent.
    vi.stubEnv("CBA_REPORT_BUCKET", undefined as unknown as string);

    let caught: unknown;
    try {
      requireEnv("CBA_REPORT_BUCKET");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(MissingEnvError);
    const err = caught as MissingEnvError;
    expect(err.variableName).toBe("CBA_REPORT_BUCKET");
    // The message names the variable...
    expect(err.message).toContain("CBA_REPORT_BUCKET");
  });

  it("throws MissingEnvError naming the variable when it is an empty string (Req 18.4)", () => {
    vi.stubEnv("AUTH_SECRET", "");

    expect(() => requireEnv("AUTH_SECRET")).toThrow(MissingEnvError);
    expect(() => requireEnv("AUTH_SECRET")).toThrow(/AUTH_SECRET/);
  });

  it("records exactly one log entry naming the variable for a single failed read, with no value (Req 19.5)", () => {
    vi.stubEnv("APP_ENCRYPTION_KEY", "");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => requireEnv("APP_ENCRYPTION_KEY")).toThrow(MissingEnvError);

    // Exactly one log entry for one failed requireEnv call.
    expect(errorSpy).toHaveBeenCalledTimes(1);

    const loggedArgs = errorSpy.mock.calls[0];
    const loggedText = loggedArgs.map(String).join(" ");
    // The log names the variable...
    expect(loggedText).toContain("APP_ENCRYPTION_KEY");
    // ...and never includes the (empty) value marker beyond the name. No other
    // env values are present because only the name is passed.
    expect(loggedText).not.toContain("=");
  });

  it("does not leak another variable's value into the error or the log (secret-safety)", () => {
    // A different, present variable holds a fake secret value.
    vi.stubEnv("DATABASE_URL", FAKE_SECRET);
    // The variable we ask for is missing.
    vi.stubEnv("CBA_RUNTIME_ARN", undefined as unknown as string);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    let caught: unknown;
    try {
      requireEnv("CBA_RUNTIME_ARN");
    } catch (error) {
      caught = error;
    }

    const err = caught as MissingEnvError;
    // The thrown error never contains the unrelated secret value.
    expect(err.message).not.toContain(FAKE_SECRET);
    expect(JSON.stringify(err)).not.toContain(FAKE_SECRET);

    // The log line never contains the unrelated secret value either.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const loggedText = errorSpy.mock.calls
      .flat()
      .map(String)
      .join(" ");
    expect(loggedText).not.toContain(FAKE_SECRET);
    // It does name the requested (missing) variable.
    expect(loggedText).toContain("CBA_RUNTIME_ARN");
  });

  it("does not dump process.env: the error message contains only the variable name (secret-safety)", () => {
    // Populate several vars with fake secret values; none should surface.
    const populated: Array<[RequiredEnvVar, string]> = [
      ["DATABASE_URL", `${FAKE_SECRET}-db`],
      ["AUTH_SECRET", `${FAKE_SECRET}-auth`],
      ["AWS_REGION", `${FAKE_SECRET}-region`],
    ];
    for (const [name, value] of populated) {
      vi.stubEnv(name, value);
    }
    vi.stubEnv("CBA_RUNTIME_ROLE_ARN", "");

    vi.spyOn(console, "error").mockImplementation(() => {});

    let caught: unknown;
    try {
      requireEnv("CBA_RUNTIME_ROLE_ARN");
    } catch (error) {
      caught = error;
    }

    const err = caught as MissingEnvError;
    expect(err.message).toBe(
      "Missing required environment variable: CBA_RUNTIME_ROLE_ARN",
    );
    // None of the unrelated secret values leaked in.
    for (const [, value] of populated) {
      expect(err.message).not.toContain(value);
    }
  });
});
