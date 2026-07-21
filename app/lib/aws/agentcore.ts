import "server-only";

import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from "@aws-sdk/client-bedrock-agentcore";

import { requireEnv } from "@/lib/env";

/**
 * Server-only invocation of the deployed Cloud Bill Analyst AgentCore runtime.
 *
 * This module is the single place that calls `InvokeAgentRuntime`
 * (`@aws-sdk/client-bedrock-agentcore`). It is `import "server-only"` because it
 * touches AWS credentials and receives secret context (`role_arn`,
 * `external_id`) that must never reach the browser.
 *
 * The runtime ARN is ALWAYS read from `process.env.CBA_RUNTIME_ARN` at call time
 * (never hardcoded — Req 18.3). A missing/empty value throws the typed
 * `MissingRuntimeConfigError` and no SDK call is made (Req 18.4). The upstream
 * SSE byte stream is returned unparsed as an `AsyncIterable<Uint8Array>`;
 * parsing/redaction lives in the pure `lib/aws/sse.ts` module.
 */

/** Secret context resolved server-side per connected account (Req 7.1). */
export interface AgentContext {
  /** authenticated app user id — drives memory + report folder key */
  actor_id: string;
  /** secret (server-side only) */
  role_arn: string;
  /** secret, decrypted (server-side only) */
  external_id: string;
  account_alias: string;
  /** default "IDR" */
  display_currency: string;
  /** default "Asia/Jakarta" */
  timezone: string;
}

export interface InvokeParams {
  prompt: string;
  /** 33-128 chars, stable per chat thread for memory continuity */
  sessionId: string;
  context: AgentContext;
}

/**
 * Thrown when `CBA_RUNTIME_ARN` is unset or empty at invoke time.
 *
 * Carries no value — only signals the missing configuration — so it is safe to
 * log or map to a redacted server-side configuration error (Req 18.4, 19.5).
 */
export class MissingRuntimeConfigError extends Error {
  constructor() {
    super("Missing required environment variable: CBA_RUNTIME_ARN");
    this.name = "MissingRuntimeConfigError";
    // Preserve prototype chain for instanceof across transpile targets.
    Object.setPrototypeOf(this, MissingRuntimeConfigError.prototype);
  }
}

/**
 * Invoke the AgentCore runtime and return the upstream SSE byte stream.
 *
 * Reads `process.env.CBA_RUNTIME_ARN` at call time; throws
 * `MissingRuntimeConfigError` (making no SDK call) when it is unset/empty. The
 * request is sent with `contentType: application/json` and
 * `accept: text/event-stream`, carrying the `prompt` and `context` payload and
 * the `runtimeSessionId`. The response body is passed back unchanged as an
 * async byte iterable for the relay to stream to the browser.
 */
export async function invokeAgentRuntime(
  p: InvokeParams,
): Promise<AsyncIterable<Uint8Array>> {
  const runtimeArn = process.env.CBA_RUNTIME_ARN;
  if (runtimeArn === undefined || runtimeArn === "") {
    throw new MissingRuntimeConfigError();
  }

  const client = new BedrockAgentCoreClient({ region: requireEnv("AWS_REGION") });

  const payload = new TextEncoder().encode(
    JSON.stringify({
      prompt: p.prompt,
      context: {
        actor_id: p.context.actor_id,
        role_arn: p.context.role_arn,
        external_id: p.context.external_id,
        account_alias: p.context.account_alias,
        display_currency: p.context.display_currency,
        timezone: p.context.timezone,
      },
    }),
  );

  const res = await client.send(
    new InvokeAgentRuntimeCommand({
      agentRuntimeArn: runtimeArn,
      runtimeSessionId: p.sessionId,
      contentType: "application/json",
      accept: "text/event-stream",
      payload,
    }),
  );

  if (res.response === undefined) {
    throw new Error("AgentCore runtime returned an empty response stream");
  }

  // In the Node runtime the SDK stream is a Readable, which is an async byte
  // iterable. Hand it back unparsed — SSE parsing lives in `lib/aws/sse.ts`.
  return res.response as AsyncIterable<Uint8Array>;
}
