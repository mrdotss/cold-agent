import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/lib/auth";
import {
  invokeAgentRuntime,
  type AgentContext,
} from "@/lib/aws/agentcore";
import {
  parseSseChunk,
  redactForBrowser,
  toKnownEvent,
  type SseEvent,
} from "@/lib/aws/sse";
import { decryptSecret } from "@/lib/crypto";
import { getDb } from "@/lib/db";
import { connectedAccounts, threads } from "@/lib/db/schema";
import { resolveCurrencyAndTimezone } from "@/lib/invocation-context";

/**
 * Chat SSE relay route (Req 6.5, 7.1–7.11, 18.4).
 *
 * `POST /api/chat` invokes the deployed AgentCore runtime for a chat thread and
 * relays its Server-Sent-Events stream to the browser. It runs on the **Node
 * runtime** (Req 7.2) because it reaches Postgres (`pg`), decrypts the pinned
 * account's External_Id with Node crypto, and streams the AWS SDK response —
 * none of which is available on edge.
 *
 * ## Secret boundary
 * `role_arn` and the decrypted External_Id are resolved SERVER-SIDE from the
 * thread's pinned Connected_Account (Req 7.4) and passed only into the
 * invocation `context`. Every byte written to the browser is first passed
 * through {@link redactForBrowser}, so no relayed event can carry `role_arn`,
 * External_Id, or AWS credentials.
 *
 * ## Two failure regimes
 *  - **Pre-invoke rejections** return a normal JSON error status and NEVER open
 *    the SSE stream: no authenticated session → 401 (Req 7.10); thread not found
 *    / not owned → 404 (Req 8.7); no pinned Connected_Account (or zero accounts)
 *    → 400 (Req 6.5, 7.11), leaving the composer's text untouched.
 *  - **Invoke-start failure** happens once the stream has opened: exactly one
 *    redacted `error` event is emitted, then the stream closes (Req 7.8).
 */
export const runtime = "nodejs";

/** Inactivity window: close the stream after 120s with no upstream event (Req 7.6). */
const INACTIVITY_TIMEOUT_MS = 120_000;

/** Request body accepted by `POST /api/chat`. */
const chatBodySchema = z.object({
  threadId: z.string().min(1),
  prompt: z.string().min(1),
});

/**
 * Generic, secret-free message emitted as the single `error` event when the
 * runtime invocation fails to start (Req 7.8). It intentionally names no
 * `role_arn`, External_Id, AWS credential, or runtime ARN.
 */
const INVOKE_START_ERROR_MESSAGE =
  "The assistant could not be reached. Please try again.";

/**
 * Relay a chat prompt to the Agent_Runtime as an SSE stream.
 *
 * Pre-invoke guards run first and short-circuit to JSON errors without opening a
 * stream. Once the invocation starts, the response is a `text/event-stream` with
 * buffering disabled that forwards only the known event vocabulary, in order,
 * until a `done`/`error` event or a 120s stall.
 */
export async function POST(request: Request): Promise<Response> {
  // Req 7.10: no valid session → reject WITHOUT invoking and WITHOUT any SSE.
  const session = await auth();
  const userId = session?.user?.id;
  if (typeof userId !== "string" || userId.length === 0) {
    return NextResponse.json({ error: "You must be signed in." }, { status: 401 });
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const parsed = chatBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "A thread id and a non-empty message are required." },
      { status: 400 },
    );
  }
  const { threadId, prompt } = parsed.data;

  const db = getDb();

  // Load the thread with an OWNER check (Req 8.7). A non-owned/missing thread is
  // indistinguishable — its session id is never exposed.
  const [thread] = await db
    .select({
      sessionId: threads.sessionId,
      connectedAccountId: threads.connectedAccountId,
    })
    .from(threads)
    .where(and(eq(threads.id, threadId), eq(threads.userId, userId)))
    .limit(1);

  if (thread === undefined) {
    return NextResponse.json({ error: "Chat not found." }, { status: 404 });
  }

  // Resolve the pinned Connected_Account server-side (Req 7.4, 7.11). If it is
  // missing (or the user has zero accounts) reject with a connect-account error
  // WITHOUT invoking; the client keeps the composed text (Req 6.5).
  const [account] = await db
    .select({
      roleArn: connectedAccounts.roleArn,
      externalIdEnc: connectedAccounts.externalIdEnc,
      displayCurrency: connectedAccounts.displayCurrency,
      timezone: connectedAccounts.timezone,
      alias: connectedAccounts.alias,
    })
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.id, thread.connectedAccountId),
        eq(connectedAccounts.userId, userId),
      ),
    )
    .limit(1);

  if (account === undefined) {
    return NextResponse.json(
      { error: "Connect an AWS account to start chatting." },
      { status: 400 },
    );
  }

  // Decrypt the External_Id server-side (never sent to the browser). A failure
  // here is a server-side configuration problem — surface a redacted 500 before
  // any stream opens rather than leaking details.
  let externalId: string;
  try {
    externalId = decryptSecret(account.externalIdEnc);
  } catch {
    return NextResponse.json(
      { error: "The connected account could not be used. Please reconnect it." },
      { status: 500 },
    );
  }

  const { displayCurrency, timezone } = resolveCurrencyAndTimezone(account);

  const context: AgentContext = {
    actor_id: userId, // Req 7.3
    role_arn: account.roleArn, // secret — server-side only (Req 7.4)
    external_id: externalId, // secret — server-side only (Req 7.4)
    account_alias: account.alias,
    display_currency: displayCurrency, // Req 7.5
    timezone, // Req 7.5
  };

  // Stable, per-thread runtime session id (Req 7.9). Use the thread's persisted
  // value verbatim — never regenerate.
  const runtimeSessionId = thread.sessionId;

  const encoder = new TextEncoder();

  /** Redact, then serialize a known event as an SSE `data:` frame. */
  function frame(event: SseEvent): Uint8Array {
    return encoder.encode(`data: ${JSON.stringify(redactForBrowser(event))}\n\n`);
  }

  let upstreamIterator: AsyncIterator<Uint8Array> | undefined;
  let cancelled = false;
  // Guards the single invoke-start error event (Req 7.8) and prevents any
  // duplicate terminal error.
  let errorEmitted = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let upstream: AsyncIterable<Uint8Array>;
      try {
        // Req 7.1: accept=text/event-stream lives inside the module; the ARN is
        // read from process.env.CBA_RUNTIME_ARN at call time (Req 18.4).
        upstream = await invokeAgentRuntime({
          prompt,
          sessionId: runtimeSessionId,
          context,
        });
      } catch {
        // Req 7.8: invoke failed to start — emit exactly one redacted error, close.
        if (!errorEmitted) {
          errorEmitted = true;
          controller.enqueue(frame({ type: "error", message: INVOKE_START_ERROR_MESSAGE }));
        }
        controller.close();
        return;
      }

      upstreamIterator = upstream[Symbol.asyncIterator]();
      const decoder = new TextDecoder();
      let buffer = "";
      let finished = false;

      try {
        while (!finished && !cancelled) {
          // Race the next upstream chunk against the inactivity timeout so a
          // stalled stream is closed after 120s of silence (Req 7.6).
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timeout = new Promise<{ timeout: true }>((resolve) => {
            timer = setTimeout(() => resolve({ timeout: true }), INACTIVITY_TIMEOUT_MS);
          });

          let next: IteratorResult<Uint8Array> | { timeout: true };
          try {
            next = await Promise.race([upstreamIterator.next(), timeout]);
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }

          if ("timeout" in next) {
            // Stall: stop relaying and close the stream.
            break;
          }
          if (next.done === true) {
            break;
          }

          buffer += decoder.decode(next.value, { stream: true });
          const { events, rest } = parseSseChunk(buffer);
          buffer = rest;

          for (const raw of events) {
            const known = toKnownEvent(raw);
            if (known === null) continue; // Req 7.7: drop unknown events, keep going.

            if (known.type === "error") errorEmitted = true;
            controller.enqueue(frame(known)); // Req 7.6: forward in received order.

            if (known.type === "done" || known.type === "error") {
              finished = true; // Req 7.6: close once done/error is forwarded.
              break;
            }
          }
        }
      } catch {
        // Unexpected mid-stream failure: surface a single redacted error (if we
        // have not already forwarded one) so the browser is never left hanging.
        if (!errorEmitted) {
          errorEmitted = true;
          try {
            controller.enqueue(frame({ type: "error", message: INVOKE_START_ERROR_MESSAGE }));
          } catch {
            // Controller already closed — nothing to do.
          }
        }
      } finally {
        // Best-effort release of the upstream iterator.
        try {
          await upstreamIterator?.return?.();
        } catch {
          // Ignore teardown errors.
        }
        controller.close();
      }
    },
    async cancel() {
      // Client disconnected: stop the loop and release the upstream stream.
      cancelled = true;
      try {
        await upstreamIterator?.return?.();
      } catch {
        // Ignore teardown errors.
      }
    },
  });

  // Req 7.2: Node-runtime SSE response with buffering disabled so each event
  // flushes to the browser promptly (<1s).
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
