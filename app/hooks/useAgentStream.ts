"use client";

/**
 * Client stream state + network wiring: maps AgentCore SSE events to the chat
 * UI's activity timeline + streamed answer.
 *
 * The event reduction is isolated in a PURE, deterministic reducer
 * (`streamReducer`) so it can be property-tested independently of the network
 * (no React, no fetch, no I/O). The reducer and its state types stay as
 * top-level, framework-free exports so Vitest can import them directly.
 *
 * The network wiring lives in the `useAgentStream(threadId)` hook at the bottom
 * of this file (task 14.1): it POSTs to `/api/chat`, reads the SSE response body
 * with a `ReadableStream` reader + `TextDecoder`, splits `data:` frames with a
 * small CLIENT-SAFE parser (never importing the server-only relay internals),
 * dispatches each event through `streamReducer` in received order, and presigns
 * each `report_file` key via `GET /api/report-url` so the download card can
 * render only once its URL resolves (Req 11.5).
 *
 * Implements Requirement 9 (activity timeline) + Requirement 10.1/10.7
 * (delta append) + Requirement 11.5 (presigned report card) from the
 * cloud-bill-analyst-web spec.
 */

import { useCallback, useReducer } from "react";

// Type-only import: erased at compile time, so this pulls no server-side
// runtime into the client bundle. The browser trusts the relay's already
// redacted + filtered event vocabulary.
import type { SseEvent } from "@/lib/aws/sse";

/** A single step in the live activity timeline (one `tool` event stream). */
export interface ActivityStep {
  id: string;
  name: string;
  label: string;
  status: string;
  /** Visual indicator: spinner while running, check on done, cleared if stopped. */
  state: "running" | "done" | "stopped";
}

/** The reducer's complete UI state for one in-progress (or finished) turn. */
export interface StreamState {
  /** Accumulated `delta` text, in received order (Req 10.1). */
  assistantText: string;
  /** Timeline steps in received/insertion order (Req 9.1). */
  steps: ActivityStep[];
  /**
   * `report_file` markers, in received order. Each begins with just its `key`;
   * `url`/`fileType` are attached later once the server-side presign resolves
   * (Req 11.5). The download card must render only once `url` is present — the
   * marker alone is not enough.
   */
  reports: ResolvedReport[];
  phase: "idle" | "streaming" | "done" | "error";
  /** True once a `done` event collapses the timeline into a one-line summary. */
  collapsed: boolean;
  errorMessage?: string;
  /**
   * Text for the `aria-live="polite"` region (Req 9.8). Also holds the ordered
   * one-line summary after `done` (Req 9.6).
   */
  liveRegion: string;
}

/**
 * A `report_file` marker plus its (eventually) resolved presigned download URL.
 * `url`/`fileType` are `undefined` until `GET /api/report-url` returns (Req 11.5).
 */
export interface ResolvedReport {
  key: string;
  url?: string;
  fileType?: string;
}

/**
 * Actions the reducer accepts:
 *  - `event`     — a forwarded SSE event (folded into the timeline/answer).
 *  - `reportUrl` — a resolved presigned URL attached to a pending `report_file`
 *    marker once its `GET /api/report-url` call returns (Req 11.5).
 *  - `reset`     — clear state at the start of a new `send` turn.
 */
export type StreamAction =
  | { kind: "event"; event: SseEvent }
  | { kind: "reportUrl"; key: string; url: string; fileType?: string }
  | { kind: "reset" };

/** Separator used to join step summaries into the collapsed one-line summary. */
const SUMMARY_SEPARATOR = " · ";

/** Build a fresh, independent initial state (fresh arrays each call). */
export function createInitialStreamState(): StreamState {
  return {
    assistantText: "",
    steps: [],
    reports: [],
    phase: "idle",
    collapsed: false,
    liveRegion: "",
  };
}

/** Convenience constant for consumers; the reducer never mutates state. */
export const initialStreamState: StreamState = createInitialStreamState();

/** The text shown/announced for a step: its status, falling back to its label. */
function stepSummaryText(step: ActivityStep): string {
  return step.status.length > 0 ? step.status : step.label;
}

/**
 * Pure reducer implementing Requirement 9 (timeline) + Requirement 10.1/10.7
 * (delta append). Always returns a new state object and never mutates its
 * input; unknown/unhandled events return the state unchanged.
 */
export function streamReducer(s: StreamState, a: StreamAction): StreamState {
  if (a.kind === "reset") {
    return createInitialStreamState();
  }

  if (a.kind === "reportUrl") {
    // Attach the resolved presigned URL to the first pending marker with this
    // key that has not been resolved yet (Req 11.5). If no such marker exists
    // (unexpected), leave state unchanged.
    const targetIndex = s.reports.findIndex(
      (report) => report.key === a.key && report.url === undefined,
    );
    if (targetIndex === -1) {
      return s;
    }
    const reports = s.reports.slice();
    reports[targetIndex] = {
      ...reports[targetIndex],
      url: a.url,
      fileType: a.fileType,
    };
    return { ...s, reports };
  }

  const event = a.event;

  switch (event.type) {
    case "delta": {
      // Append delta text in order; never discard prior content, even if the
      // markdown so far is malformed (Req 10.1, 10.7).
      return {
        ...s,
        assistantText: s.assistantText + event.text,
        phase: "streaming",
      };
    }

    case "tool": {
      if (event.phase === "start") {
        const existingIndex = s.steps.findIndex((step) => step.id === event.id);

        if (existingIndex === -1) {
          // New id → append a running step below existing steps (Req 9.1).
          const newStep: ActivityStep = {
            id: event.id,
            name: event.name,
            label: event.label,
            status: event.status,
            state: "running",
          };
          return {
            ...s,
            steps: [...s.steps, newStep],
            phase: "streaming",
            liveRegion: stepSummaryText(newStep),
          };
        }

        // Existing id → update label + status in place, keep running (Req 9.2).
        const updatedStep: ActivityStep = {
          ...s.steps[existingIndex],
          label: event.label,
          status: event.status,
        };
        const steps = s.steps.slice();
        steps[existingIndex] = updatedStep;
        return {
          ...s,
          steps,
          phase: "streaming",
          liveRegion: stepSummaryText(updatedStep),
        };
      }

      // phase === "end"
      const matchIndex = s.steps.findIndex((step) => step.id === event.id);
      if (matchIndex === -1) {
        // No matching id → ignore, leave steps unchanged (Req 9.4).
        return s;
      }
      // Matching id → spinner becomes check; retain status + label (Req 9.3).
      const doneStep: ActivityStep = { ...s.steps[matchIndex], state: "done" };
      const steps = s.steps.slice();
      steps[matchIndex] = doneStep;
      return {
        ...s,
        steps,
        liveRegion: stepSummaryText(doneStep),
      };
    }

    case "report_file": {
      // Record the key; the card is shown later once presigned (Req 11.5).
      return {
        ...s,
        reports: [...s.reports, { key: event.key }],
      };
    }

    case "done": {
      // Collapse the timeline into an ordered one-line summary (Req 9.6).
      const summary = s.steps.map(stepSummaryText).join(SUMMARY_SEPARATOR);
      return {
        ...s,
        phase: "done",
        collapsed: true,
        liveRegion: summary,
      };
    }

    case "error": {
      // Every still-running step is stopped (spinner cleared, not checked) (Req 9.7).
      const steps = s.steps.map((step) =>
        step.state === "running" ? { ...step, state: "stopped" as const } : step,
      );
      return {
        ...s,
        steps,
        phase: "error",
        errorMessage: event.message,
        liveRegion: event.message,
      };
    }

    default: {
      // Unknown/unhandled event kinds are ignored (upstream already filters).
      return s;
    }
  }
}

// ---------------------------------------------------------------------------
// Network wiring (task 14.1)
// ---------------------------------------------------------------------------

/** The SSE event-block delimiter (a blank line between `data:` frames). */
const FRAME_DELIMITER = "\n\n";

/**
 * Generic, secret-free message surfaced as an `error` event when the network
 * request itself fails (offline, aborted, DNS) or the relay returns a non-OK
 * response with no readable JSON body. Mirrors the tone of the server's own
 * redacted errors and never leaks internals.
 */
const NETWORK_ERROR_MESSAGE =
  "The assistant could not be reached. Please try again.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * CLIENT-SAFE SSE frame parser. Splits an accumulated buffer into complete
 * `data:` frames (separated by a blank line) plus the trailing incomplete
 * remainder, `JSON.parse`s each payload, and keeps only records that carry a
 * string `type`.
 *
 * The relay has already redacted secrets and filtered to the known event
 * vocabulary server-side, so the browser deliberately does NOT re-import the
 * server-only narrower (`toKnownEvent`) — it only needs to split, parse, and do
 * a light shape check. A malformed frame is skipped so one bad event never
 * breaks the stream.
 */
function parseClientFrames(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = [];

  const lastDelimiter = buffer.lastIndexOf(FRAME_DELIMITER);
  if (lastDelimiter === -1) {
    return { events, rest: buffer };
  }

  const complete = buffer.slice(0, lastDelimiter);
  const rest = buffer.slice(lastDelimiter + FRAME_DELIMITER.length);

  for (const block of complete.split(FRAME_DELIMITER)) {
    if (block.length === 0) continue;

    const dataParts: string[] = [];
    for (const rawLine of block.split("\n")) {
      const line = rawLine.replace(/\r$/, "");
      if (!line.startsWith("data:")) continue;
      let value = line.slice("data:".length);
      if (value.startsWith(" ")) value = value.slice(1);
      dataParts.push(value);
    }

    if (dataParts.length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(dataParts.join("\n"));
    } catch {
      continue;
    }

    if (isRecord(parsed) && typeof parsed.type === "string") {
      // Trust the server's vocabulary; cast the validated record to SseEvent.
      events.push(parsed as SseEvent);
    }
  }

  return { events, rest };
}

/** What the `useAgentStream` hook exposes to chat UI components. */
export interface UseAgentStream {
  /** The reduced, render-ready state for the current (or last) turn. */
  state: StreamState;
  /** POST a prompt for `threadId` and stream the reply into `state`. */
  send: (prompt: string) => Promise<void>;
}

/**
 * React hook that drives one chat thread's SSE turn through `streamReducer`.
 *
 * `send(prompt)`:
 *  1. Resets state (`{ kind: "reset" }`) so the new turn starts clean.
 *  2. POSTs `{ threadId, prompt }` to `/api/chat`.
 *  3. On a network failure or a non-OK response (e.g. 400/401 pre-invoke
 *     rejection), dispatches an `error` event — surfacing an error state
 *     without throwing uncaught (Req 7.6, 9.7).
 *  4. Otherwise reads the `text/event-stream` body via a `ReadableStream`
 *     reader + `TextDecoder`, buffers, splits `data:` frames, parses each
 *     payload, and dispatches it in received order so the UI updates promptly
 *     (Req 9.x, 10.1).
 *  5. For each `report_file` event, calls `GET /api/report-url?key=…` and — only
 *     once the presigned URL resolves — dispatches `{ kind: "reportUrl" }` so the
 *     download card can render (Req 11.5). Presign runs in the background and
 *     never blocks delta rendering.
 */
export function useAgentStream(threadId: string): UseAgentStream {
  const [state, dispatch] = useReducer(
    streamReducer,
    undefined,
    createInitialStreamState,
  );

  const send = useCallback(
    async (prompt: string): Promise<void> => {
      // (1) Fresh state for the new turn.
      dispatch({ kind: "reset" });

      // Presign a report key in the background; attach the URL only on success
      // so the card renders once ready (Req 11.5). Failures are swallowed — the
      // card simply stays hidden rather than breaking the turn.
      const resolveReportUrl = async (key: string): Promise<void> => {
        try {
          const res = await fetch(
            `/api/report-url?key=${encodeURIComponent(key)}`,
            { method: "GET" },
          );
          if (!res.ok) return;
          const data: unknown = await res.json();
          if (isRecord(data) && typeof data.url === "string") {
            dispatch({
              kind: "reportUrl",
              key,
              url: data.url,
              fileType:
                typeof data.fileType === "string" ? data.fileType : undefined,
            });
          }
        } catch {
          // Presign failed — leave the marker unresolved; the card won't render.
        }
      };

      const dispatchEvent = (event: SseEvent): void => {
        dispatch({ kind: "event", event });
        if (event.type === "report_file") {
          void resolveReportUrl(event.key);
        }
      };

      // (2) Kick off the relay POST.
      let response: Response;
      try {
        response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ threadId, prompt }),
        });
      } catch {
        dispatchEvent({ type: "error", message: NETWORK_ERROR_MESSAGE });
        return;
      }

      // (3) Non-OK (pre-invoke rejection) or missing body → surface an error
      // without throwing. Prefer the relay's redacted JSON message when present.
      if (!response.ok || response.body === null) {
        let message = NETWORK_ERROR_MESSAGE;
        try {
          const data: unknown = await response.json();
          if (isRecord(data) && typeof data.error === "string") {
            message = data.error;
          }
        } catch {
          // No JSON body — keep the generic message.
        }
        dispatchEvent({ type: "error", message });
        return;
      }

      // (4) Stream + parse the SSE body.
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const { events, rest } = parseClientFrames(buffer);
          buffer = rest;
          for (const event of events) dispatchEvent(event);
        }

        // Flush any final buffered bytes and process a trailing frame that may
        // not be terminated by a blank line.
        buffer += decoder.decode();
        if (buffer.length > 0) {
          const { events } = parseClientFrames(`${buffer}${FRAME_DELIMITER}`);
          for (const event of events) dispatchEvent(event);
        }
      } catch {
        // Mid-stream failure (aborted/network drop): stop spinners with an error.
        dispatchEvent({ type: "error", message: NETWORK_ERROR_MESSAGE });
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // Reader already released — nothing to do.
        }
      }
    },
    [threadId],
  );

  return { state, send };
}
