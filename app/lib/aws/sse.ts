/**
 * SSE parsing, filtering, and redaction for the AgentCore relay.
 *
 * This module is PURE and deterministic (no I/O, no AWS SDK, no secrets), which
 * is why it deliberately does NOT `import "server-only"`: it is the testable
 * core that the Node-runtime `/api/chat` relay composes with the server-only
 * invocation module (`lib/aws/agentcore.ts`). Keeping it pure lets property
 * tests import it directly.
 *
 * Responsibilities:
 *  - `parseSseChunk`  — split an accumulated SSE text buffer into complete
 *    events + a trailing remainder, tolerating malformed JSON.
 *  - `toKnownEvent`   — narrow an arbitrary parsed value to the known
 *    `SseEvent` vocabulary, dropping anything unknown/malformed (Req 7.7).
 *  - `redactForBrowser` — deep-clone an object graph with secret fields removed
 *    before it is serialized to the browser (Req 4.5, 4.6, 5.9, 7.4, 18.2).
 */

/**
 * Structured data for an inline, client-rendered chart (Req 2.1–2.5).
 *
 * Carried by the `chart` SSE event. The browser renders this live with a
 * charting library (no image, no S3, no presign). `labels` and `values` are
 * parallel arrays of equal length: `values[i]` is the magnitude for `labels[i]`.
 */
export interface ChartSpec {
  id: string;
  chart_type: "bar" | "hbar" | "line" | "pie";
  title: string;
  currency: string;
  labels: string[];
  values: number[];
}

/** The known event vocabulary forwarded to the browser (Req 7.7). */
export type SseEvent =
  | { type: "delta"; text: string }
  | { type: "tool"; phase: "start"; id: string; name: string; label: string; status: string }
  | { type: "tool"; phase: "end"; id: string; name: string }
  | { type: "chart"; spec: ChartSpec }
  | { type: "report_file"; key: string; bucket: string }
  | { type: "error"; message: string }
  | { type: "done" };

/** The chart types accepted in a `ChartSpec` (Req 2.2). */
const CHART_TYPES: ReadonlySet<string> = new Set(["bar", "hbar", "line", "pie"]);

/** The SSE event-block delimiter (a blank line between events). */
const EVENT_DELIMITER = "\n\n";

/**
 * Split an accumulated SSE text buffer into fully-received events plus the
 * trailing incomplete segment.
 *
 * Events are separated by a blank line (`\n\n`). For each complete block we
 * extract the `data:` line(s) (a leading space after the colon is optional and
 * stripped), concatenate multi-line data per the SSE spec, `JSON.parse` the
 * payload, and push the parsed value (as `unknown`) into `events`. A block that
 * has no `data:` line, or whose data is not valid JSON, is skipped gracefully
 * so a single malformed event never breaks the relay.
 *
 * The segment after the final `\n\n` is returned as `rest` so the caller can
 * prepend it to the next chunk. If the buffer ends exactly on a delimiter,
 * `rest` is the empty string.
 *
 * Pure and deterministic: same input always yields the same output.
 */
export function parseSseChunk(buffer: string): { events: unknown[]; rest: string } {
  const events: unknown[] = [];

  const lastDelimiter = buffer.lastIndexOf(EVENT_DELIMITER);
  if (lastDelimiter === -1) {
    // No complete event yet; everything is still pending.
    return { events, rest: buffer };
  }

  const complete = buffer.slice(0, lastDelimiter);
  const rest = buffer.slice(lastDelimiter + EVENT_DELIMITER.length);

  for (const block of complete.split(EVENT_DELIMITER)) {
    if (block.length === 0) continue;

    const dataParts: string[] = [];
    for (const rawLine of block.split("\n")) {
      const line = rawLine.replace(/\r$/, "");
      if (!line.startsWith("data:")) continue;
      // Drop the `data:` prefix and at most one leading space (SSE convention).
      let value = line.slice("data:".length);
      if (value.startsWith(" ")) value = value.slice(1);
      dataParts.push(value);
    }

    if (dataParts.length === 0) continue;

    const payload = dataParts.join("\n");
    try {
      events.push(JSON.parse(payload));
    } catch {
      // Malformed JSON — skip this event, keep processing the rest.
      continue;
    }
  }

  return { events, rest };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === "number");
}

/**
 * Narrow an arbitrary parsed value to a well-typed `SseEvent`, or return `null`
 * for any unknown type or malformed shape (Req 7.7).
 *
 * Validation is strict per variant so malformed events are dropped rather than
 * forwarded:
 *  - `delta`       — string `text`
 *  - `tool`/start  — `phase === "start"` + string `id`, `name`, `label`, `status`
 *  - `tool`/end    — `phase === "end"`   + string `id`, `name`
 *  - `chart`       — object `spec` with `chart_type ∈ {bar,hbar,line,pie}`,
 *                    string-array `labels`, number-array `values`, and
 *                    `labels.length === values.length`
 *  - `report_file` — string `key`, `bucket`
 *  - `error`       — string `message`
 *  - `done`        — just the type
 */
export function toKnownEvent(raw: unknown): SseEvent | null {
  if (!isRecord(raw)) return null;

  switch (raw.type) {
    case "delta":
      return isString(raw.text) ? { type: "delta", text: raw.text } : null;

    case "tool": {
      if (raw.phase === "start") {
        if (isString(raw.id) && isString(raw.name) && isString(raw.label) && isString(raw.status)) {
          return {
            type: "tool",
            phase: "start",
            id: raw.id,
            name: raw.name,
            label: raw.label,
            status: raw.status,
          };
        }
        return null;
      }
      if (raw.phase === "end") {
        if (isString(raw.id) && isString(raw.name)) {
          return { type: "tool", phase: "end", id: raw.id, name: raw.name };
        }
        return null;
      }
      return null;
    }

    case "chart": {
      const spec = raw.spec;
      if (!isRecord(spec)) return null;
      if (!isString(spec.chart_type) || !CHART_TYPES.has(spec.chart_type)) return null;
      if (!isString(spec.id) || !isString(spec.title) || !isString(spec.currency)) return null;
      if (!isStringArray(spec.labels) || !isNumberArray(spec.values)) return null;
      if (spec.labels.length !== spec.values.length) return null;
      return {
        type: "chart",
        spec: {
          id: spec.id,
          chart_type: spec.chart_type as ChartSpec["chart_type"],
          title: spec.title,
          currency: spec.currency,
          labels: spec.labels,
          values: spec.values,
        },
      };
    }

    case "report_file":
      return isString(raw.key) && isString(raw.bucket)
        ? { type: "report_file", key: raw.key, bucket: raw.bucket }
        : null;

    case "error":
      return isString(raw.message) ? { type: "error", message: raw.message } : null;

    case "done":
      return { type: "done" };

    default:
      return null;
  }
}

/**
 * Secret field names to strip from browser-bound output, matched
 * case-insensitively against object keys (Req 4.5, 4.6, 5.9, 7.4, 18.2).
 * Covers cross-account role/external-id fields (in snake_case, camelCase, and
 * the encrypted-at-rest variants) plus raw AWS credential fields.
 */
const SECRET_KEYS: ReadonlySet<string> = new Set(
  [
    "role_arn",
    "roleArn",
    "external_id",
    "externalId",
    "external_id_enc",
    "externalIdEnc",
    "accessKeyId",
    "secretAccessKey",
    "sessionToken",
    "aws_access_key_id",
    "aws_secret_access_key",
    "aws_session_token",
  ].map((k) => k.toLowerCase()),
);

function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key.toLowerCase());
}

/**
 * Deep-clone `value`, removing any secret fields (see `SECRET_KEYS`) from every
 * nested plain object, before it is serialized to the browser.
 *
 * Guarantees:
 *  - Never mutates the input — returns a cleaned deep copy.
 *  - Idempotent — `redactForBrowser(redactForBrowser(x))` deep-equals
 *    `redactForBrowser(x)` (secret keys are removed entirely, so a second pass
 *    finds nothing to strip).
 *  - Recurses through nested plain objects and arrays; preserves non-secret
 *    fields and their key order.
 *
 * Assumption: SSE payloads and browser-bound projections are JSON-like graphs
 * (primitives, `null`, arrays, plain objects). Class instances and other exotic
 * values are passed through by reference (shallow), which is acceptable because
 * the relayed data is plain JSON.
 */
export function redactForBrowser<T>(value: T): T {
  return redact(value) as T;
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }

  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      if (isSecretKey(key)) continue;
      out[key] = redact(val);
    }
    return out;
  }

  // Primitives, null, and non-plain objects pass through unchanged.
  return value;
}
