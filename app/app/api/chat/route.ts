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
  type ChartSpec,
  type SseEvent,
} from "@/lib/aws/sse";
import { decryptSecret } from "@/lib/crypto";
import { getDb } from "@/lib/db";
import { connectedAccounts } from "@/lib/db/schema";
import { getConversationOwned } from "@/lib/history/conversations";
import { appendMessage } from "@/lib/history/messages";
import { resolveCurrencyAndTimezone } from "@/lib/invocation-context";

/**
 * Chat SSE relay route (Req 6.5, 7.1–7.11, 9.1–9.7, 18.4).
 *
 * `POST /api/chat` invokes the deployed AgentCore runtime for a conversation and
 * relays its Server-Sent-Events stream to the browser. It runs on the **Node
 * runtime** (Req 7.2) because it reaches Postgres (`pg`), decrypts the pinned
 * account's External_Id with Node crypto, streams the AWS SDK response, and
 * persists chat history to DynamoDB — none of which is available on edge.
 *
 * ## Ownership + secret boundary
 * The conversation is loaded from DynamoDB with an ownership gate
 * ({@link getConversationOwned}); a missing/not-owned conversation is a 404 that
 * leaks nothing (Req 8.7). Its `accountId` selects the pinned Connected_Account,
 * whose `role_arn` and decrypted External_Id are resolved SERVER-SIDE (Req 7.4)
 * and passed only into the invocation `context`. Every byte written to the
 * browser is first passed through {@link redactForBrowser}, so no relayed event
 * can carry `role_arn`, External_Id, or AWS credentials.
 *
 * ## Persistence (Req 9.1–9.7)
 * The USER message is persisted BEFORE the runtime is invoked (Req 9.1). While
 * relaying, the server ALSO accumulates the assistant's text, charts, reports,
 * and an activity summary; the ASSISTANT message is persisted in the stream's
 * `start()` finally path (Req 9.2, 9.3) so a turn whose browser navigated away
 * (its fetch aborted → stream `cancel()`) is still saved. The empty-text turn is
 * skipped (Req 9.7).
 *
 * ## Two failure regimes
 *  - **Pre-invoke rejections** return a normal JSON error status and NEVER open
 *    the SSE stream: no authenticated session → 401 (Req 7.10); conversation not
 *    found / not owned → 404 (Req 8.7); no pinned Connected_Account (or zero
 *    accounts) → 400 (Req 6.5, 7.11), leaving the composer's text untouched;
 *    External_Id decrypt failure → redacted 500.
 *  - **Invoke-start failure** happens once the stream has opened: exactly one
 *    redacted `error` event is emitted, then the stream closes (Req 7.8).
 */
export const runtime = "nodejs";

/** Inactivity window: close the stream after 120s with no upstream event (Req 7.6). */
const INACTIVITY_TIMEOUT_MS = 120_000;

/** Request body accepted by `POST /api/chat`. */
const chatBodySchema = z.object({
  conversationId: z.string().min(1),
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
      { error: "A conversation id and a non-empty message are required." },
      { status: 400 },
    );
  }
  const { conversationId, prompt } = parsed.data;

  // Load the conversation from DynamoDB with an OWNER check (Req 8.7). A
  // non-owned/missing conversation is indistinguishable — its session id and
  // pinned account are never exposed.
  const conversation = await getConversationOwned(userId, conversationId);
  if (conversation === null) {
    return NextResponse.json({ error: "Chat not found." }, { status: 404 });
  }

  // The runtime session id is the value derived + stored at creation
  // (sessionIdForThread(conversationId)); use it verbatim, never regenerate (Req 7.9).
  const runtimeSessionId = conversation.sessionId;
  const accountId = conversation.accountId;

  const db = getDb();

  // Resolve the pinned Connected_Account server-side BY the conversation's
  // accountId (Req 7.4, 7.11). If it is missing (or the user has zero accounts)
  // reject with a connect-account error WITHOUT invoking; the client keeps the
  // composed text (Req 6.5).
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
        eq(connectedAccounts.id, accountId),
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

  // Persist the USER message BEFORE invoking the runtime (Req 9.1). Ownership was
  // gated above; appendMessage re-checks it internally, which is fine.
  await appendMessage(userId, conversationId, {
    userId,
    role: "user",
    content: prompt,
    charts: [],
    reports: [],
    createdAt: new Date().toISOString(),
  });

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

  // Server-side accumulation for the persisted ASSISTANT message (Req 9.2, 9.3).
  // Captured in this closure so the stream's finally path can persist even when
  // the client disconnected (its fetch aborted → stream `cancel()`).
  let assistantText = "";
  const charts: ChartSpec[] = [];
  const reports: { key: string }[] = [];
  const activity: { label: string; status: string }[] = [];

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

            // Accumulate server-side for the persisted assistant message
            // (Req 9.2, 9.3) — independent of whether the client stays connected.
            switch (known.type) {
              case "delta":
                assistantText += known.text;
                break;
              case "chart":
                charts.push(known.spec);
                break;
              case "report_file":
                reports.push({ key: known.key });
                break;
              case "tool":
                if (known.phase === "start") {
                  activity.push({ label: known.label, status: known.status });
                }
                break;
              default:
                break;
            }

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

        // Persist the ASSISTANT message here — NOT gated on the client remaining
        // connected — so a turn whose browser navigated away is still saved
        // (Req 9.2, 9.3). Skip when no text was produced (turn aborted before any
        // delta, Req 9.7). Wrapped so a persistence failure never throws into the
        // stream teardown.
        if (assistantText.length > 0) {
          try {
            await appendMessage(userId, conversationId, {
              userId,
              role: "assistant",
              content: assistantText,
              charts,
              reports,
              activity,
              createdAt: new Date().toISOString(),
            });
          } catch {
            // Ignore persistence errors — never break stream teardown (Req 9.3).
          }
        }

        controller.close();
      }
    },
    async cancel() {
      // Client disconnected: stop the loop and release the upstream stream. The
      // `start()` finally still runs and persists the accumulated assistant
      // message (disconnect-safe, Req 9.2, 9.3).
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
