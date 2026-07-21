import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * Integration tests for the AgentCore invocation wiring (Req 7.1, 7.2, 7.3).
 *
 * These are example/integration tests (NOT property tests): they mock the
 * `@aws-sdk/client-bedrock-agentcore` SDK so no real AWS call is made, and
 * assert that `invokeAgentRuntime` builds the `InvokeAgentRuntimeCommand` with
 * the correct `accept`, `agentRuntimeArn`, `runtimeSessionId`, and a JSON
 * `context` payload — and that the mocked response stream is returned unchanged.
 */

const { send, InvokeAgentRuntimeCommand, BedrockAgentCoreClient } = vi.hoisted(
  () => {
    const send = vi.fn();
    return {
      send,
      // Function expressions (not arrows) so they are usable with `new`.
      // Capture the command input so tests can assert on the wired request.
      InvokeAgentRuntimeCommand: vi.fn(function (input: unknown) {
        return { input };
      }),
      BedrockAgentCoreClient: vi.fn(function () {
        return { send };
      }),
    };
  },
);

vi.mock("@aws-sdk/client-bedrock-agentcore", () => ({
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
}));

const { invokeAgentRuntime, MissingRuntimeConfigError } = await import(
  "@/lib/aws/agentcore"
);

const RUNTIME_ARN =
  "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/cloud_bill_analyst-Dn7a652NZj";

const CONTEXT = {
  actor_id: "user-abc-123",
  role_arn: "arn:aws:iam::210987654321:role/CloudBillAnalystReadOnly",
  external_id: "ext-id-0123456789abcdef",
  account_alias: "Prod Billing",
  display_currency: "IDR",
  timezone: "Asia/Jakarta",
} as const;

function decodePayload(payload: unknown): { prompt: string; context: Record<string, unknown> } {
  const bytes = payload as Uint8Array;
  return JSON.parse(new TextDecoder().decode(bytes));
}

afterEach(() => {
  vi.unstubAllEnvs();
  send.mockReset();
  InvokeAgentRuntimeCommand.mockClear();
  BedrockAgentCoreClient.mockClear();
});

describe("invokeAgentRuntime — command wiring (Req 7.1, 7.2, 7.3)", () => {
  it("sends an InvokeAgentRuntimeCommand with the env ARN, session id, SSE accept and context payload", async () => {
    vi.stubEnv("CBA_RUNTIME_ARN", RUNTIME_ARN);
    vi.stubEnv("AWS_REGION", "us-east-1");

    // A minimal async byte iterable stands in for the SDK response stream.
    const stream: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        yield new TextEncoder().encode("data: {}\n\n");
      },
    };
    send.mockResolvedValue({ response: stream });

    const sessionId = "s".repeat(40); // stable, 33-128 chars

    const returned = await invokeAgentRuntime({
      prompt: "Scan this month's spend",
      sessionId,
      context: { ...CONTEXT },
    });

    // The returned value is exactly the mocked response stream, unparsed.
    expect(returned).toBe(stream);

    // Exactly one SDK send, with the command the module built.
    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0][0];
    const input = command.input as Record<string, unknown>;

    expect(input.agentRuntimeArn).toBe(RUNTIME_ARN);
    expect(input.runtimeSessionId).toBe(sessionId);
    expect(input.accept).toBe("text/event-stream");
    expect(input.contentType).toBe("application/json");

    const decoded = decodePayload(input.payload);
    expect(decoded.prompt).toBe("Scan this month's spend");
    expect(decoded.context).toEqual({
      actor_id: CONTEXT.actor_id,
      role_arn: CONTEXT.role_arn,
      external_id: CONTEXT.external_id,
      account_alias: CONTEXT.account_alias,
      display_currency: CONTEXT.display_currency,
      timezone: CONTEXT.timezone,
    });
  });

  it("throws MissingRuntimeConfigError and makes no SDK call when CBA_RUNTIME_ARN is empty", async () => {
    vi.stubEnv("CBA_RUNTIME_ARN", "");
    vi.stubEnv("AWS_REGION", "us-east-1");

    await expect(
      invokeAgentRuntime({
        prompt: "hi",
        sessionId: "s".repeat(40),
        context: { ...CONTEXT },
      }),
    ).rejects.toBeInstanceOf(MissingRuntimeConfigError);

    expect(send).not.toHaveBeenCalled();
  });

  it("throws MissingRuntimeConfigError and makes no SDK call when CBA_RUNTIME_ARN is unset", async () => {
    vi.stubEnv("CBA_RUNTIME_ARN", undefined);
    vi.stubEnv("AWS_REGION", "us-east-1");

    await expect(
      invokeAgentRuntime({
        prompt: "hi",
        sessionId: "s".repeat(40),
        context: { ...CONTEXT },
      }),
    ).rejects.toBeInstanceOf(MissingRuntimeConfigError);

    expect(send).not.toHaveBeenCalled();
  });
});
