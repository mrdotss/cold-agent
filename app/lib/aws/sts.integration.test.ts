import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * Integration tests for the connection-test wiring (Req 4.1, 4.3).
 *
 * Example/integration tests (NOT property tests): the STS SDK client and the
 * Cost Explorer probe are mocked, so no real AWS call happens.
 *   - Happy path: a valid role ARN + external id → AssumeRole (with the right
 *     RoleArn/ExternalId) then the CE probe → `{ ok: true }`.
 *   - Timeout: the probe hangs past `CONNECTION_TEST_TIMEOUT_MS` → the test
 *     resolves `{ ok: false, category: "timeout" }` (driven with fake timers so
 *     it never actually waits 30s).
 */

const { stsSend, stsDestroy, probeSpy, STSClient, AssumeRoleCommand } =
  vi.hoisted(() => {
    const stsSend = vi.fn();
    const stsDestroy = vi.fn();
    return {
      stsSend,
      stsDestroy,
      probeSpy: vi.fn(),
      // Function expressions (not arrows) so they are usable with `new`.
      STSClient: vi.fn(function () {
        return { send: stsSend, destroy: stsDestroy };
      }),
      AssumeRoleCommand: vi.fn(function (input: unknown) {
        return { input };
      }),
    };
  });

vi.mock("@aws-sdk/client-sts", () => ({
  STSClient,
  AssumeRoleCommand,
}));

vi.mock("@/lib/aws/cost-explorer", () => ({
  probeCostExplorer: probeSpy,
}));

const { testConnection, CONNECTION_TEST_TIMEOUT_MS } = await import(
  "@/lib/aws/sts"
);

const ROLE_ARN = "arn:aws:iam::123456789012:role/CloudBillAnalystReadOnly";
const EXTERNAL_ID = "ext-id-0123456789abcdef";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  stsSend.mockReset();
  stsDestroy.mockReset();
  probeSpy.mockReset();
  STSClient.mockClear();
  AssumeRoleCommand.mockClear();
});

describe("testConnection — happy path (Req 4.1, 4.3)", () => {
  it("assumes the role with RoleArn/ExternalId, runs the CE probe, and resolves { ok: true }", async () => {
    vi.stubEnv("AWS_REGION", "us-east-1");

    stsSend.mockResolvedValue({
      Credentials: {
        AccessKeyId: "AKIAEXAMPLE",
        SecretAccessKey: "secret-example",
        SessionToken: "token-example",
      },
    });
    probeSpy.mockResolvedValue(undefined);

    const result = await testConnection(ROLE_ARN, EXTERNAL_ID);

    expect(result).toEqual({ ok: true });

    // AssumeRole was issued with the exact RoleArn + ExternalId.
    expect(stsSend).toHaveBeenCalledTimes(1);
    const command = stsSend.mock.calls[0][0];
    const input = command.input as Record<string, unknown>;
    expect(input.RoleArn).toBe(ROLE_ARN);
    expect(input.ExternalId).toBe(EXTERNAL_ID);

    // The Cost Explorer probe ran with the assumed credentials.
    expect(probeSpy).toHaveBeenCalledTimes(1);
    expect(probeSpy).toHaveBeenCalledWith({
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "secret-example",
      sessionToken: "token-example",
    });
  });
});

describe("testConnection — timeout (Req 4.3)", () => {
  it("resolves { ok: false, category: 'timeout' } when the probe hangs past the timeout", async () => {
    vi.stubEnv("AWS_REGION", "us-east-1");
    vi.useFakeTimers();

    stsSend.mockResolvedValue({
      Credentials: {
        AccessKeyId: "AKIAEXAMPLE",
        SecretAccessKey: "secret-example",
        SessionToken: "token-example",
      },
    });
    // The probe never settles → only the timeout can resolve the race.
    probeSpy.mockImplementation(() => new Promise<void>(() => {}));

    const pending = testConnection(ROLE_ARN, EXTERNAL_ID);

    // Advance past the 30s bound (flushing microtasks between timers) so the
    // assume-role resolves, the probe is invoked, and the timeout fires —
    // without the test actually waiting 30 real seconds.
    await vi.advanceTimersByTimeAsync(CONNECTION_TEST_TIMEOUT_MS + 1);

    await expect(pending).resolves.toEqual({ ok: false, category: "timeout" });
  });
});
