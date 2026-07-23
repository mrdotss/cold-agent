import "server-only";

import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";

import { requireEnv } from "@/lib/env";

/**
 * Server-only Bedrock title generation (Title_Model).
 *
 * This module is the single place that issues a direct `ConverseCommand`
 * (`@aws-sdk/client-bedrock-runtime`) against a fast/cheap title model to
 * summarize a Conversation's first user prompt into a short title. It is
 * `import "server-only"` because it touches AWS credentials and must never be
 * bundled into a client.
 *
 * It deliberately uses the Bedrock RUNTIME client only — it NEVER invokes the
 * AgentCore runtime (`lib/aws/agentcore.ts`). Title generation is completely
 * isolated from the agent so a title can never block or trigger a chat turn
 * (Req 10.3, 10.9).
 *
 * The model id is read from `process.env.CBA_TITLE_MODEL_ID` AT CALL TIME. A
 * missing/empty id throws `MissingTitleModelConfigError` before any Bedrock
 * call — the caller (the title route) treats this as a generation failure and
 * applies its fallback-title behavior (Req 12.4). This check is intentionally
 * separate from `lib/env.ts`'s global required-set so the app does not hard-fail
 * on this one variable; only title generation needs it.
 *
 * The returned string is the RAW model completion text. Normalization
 * (trimming quotes/punctuation, clamping to ≤6 words) is done separately by
 * `lib/title.ts` (`normalizeTitle`) in the route (task 10.2).
 */

/** Memoized Bedrock runtime client — one per server process. */
let runtimeClient: BedrockRuntimeClient | undefined;

/**
 * Bedrock caps the title summary tightly — a title is at most ~6 words, so a
 * small token budget is plenty and keeps the call fast/cheap.
 */
const MAX_TITLE_TOKENS = 32;

/**
 * Instruction sent to the title model. It asks for a short (≤6 words) title
 * with no surrounding quotes and no trailing punctuation. The route still
 * normalizes the result, but a well-behaved model needs little cleanup.
 */
const TITLE_SYSTEM_PROMPT =
  "You write short conversation titles. Summarize the user's first message as a " +
  "title of at most 6 words. Respond with the title only — no surrounding " +
  "quotation marks, no trailing punctuation, and no extra commentary.";

/**
 * Thrown when `CBA_TITLE_MODEL_ID` is unset or empty at call time.
 *
 * Carries only the variable NAME — never any value — so it is safe to log or
 * map to a redacted server-side configuration error. The caller treats it as a
 * title-generation failure (Req 12.4).
 */
export class MissingTitleModelConfigError extends Error {
  constructor() {
    super("Missing required environment variable: CBA_TITLE_MODEL_ID");
    this.name = "MissingTitleModelConfigError";
    // Preserve prototype chain for instanceof across transpile targets.
    Object.setPrototypeOf(this, MissingTitleModelConfigError.prototype);
  }
}

/**
 * Thrown when the Converse call fails or returns no usable text.
 *
 * The caller treats any title-generation failure the same way (retry once, then
 * fall back), so this is a coarse signal that carries no secret material.
 */
export class TitleGenerationError extends Error {
  constructor(message = "Title model returned no usable text", options?: { cause?: unknown }) {
    super(message);
    this.name = "TitleGenerationError";
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
    Object.setPrototypeOf(this, TitleGenerationError.prototype);
  }
}

/**
 * Return the memoized `BedrockRuntimeClient`, constructing it on first call.
 * The region is read from `process.env.AWS_REGION` via `requireEnv`.
 */
function getRuntimeClient(): BedrockRuntimeClient {
  if (runtimeClient === undefined) {
    runtimeClient = new BedrockRuntimeClient({ region: requireEnv("AWS_REGION") });
  }
  return runtimeClient;
}

/**
 * Resolve the title model id from `process.env.CBA_TITLE_MODEL_ID`.
 *
 * @throws {MissingTitleModelConfigError} when the variable is unset or empty.
 *   Thrown before any Bedrock call so a missing model id fails fast without
 *   issuing a request (Req 12.4).
 */
function titleModelId(): string {
  const value = process.env.CBA_TITLE_MODEL_ID;
  if (value === undefined || value === "") {
    throw new MissingTitleModelConfigError();
  }
  return value;
}

/**
 * Extract the assistant's text from a Converse response.
 *
 * A Converse `output.message.content` is a list of content blocks; the title
 * model returns a single text block. Joins any text blocks and returns the
 * trimmed result, or `null` when there is no usable text.
 */
function extractText(output: ConverseCommandOutput["output"] | undefined): string | null {
  const blocks = output?.message?.content;
  if (blocks === undefined) return null;
  const text = blocks
    .map((block) => ("text" in block && typeof block.text === "string" ? block.text : ""))
    .join("")
    .trim();
  return text.length > 0 ? text : null;
}

/**
 * Summarize `firstPrompt` into a short conversation title via a direct Bedrock
 * Converse call against `process.env.CBA_TITLE_MODEL_ID` (Req 10.3).
 *
 * Reads the model id at call time and throws {@link MissingTitleModelConfigError}
 * (making no Bedrock call) when it is unset/empty (Req 12.4). Uses the Bedrock
 * runtime client ONLY — it never invokes the AgentCore runtime (Req 10.9).
 *
 * @returns the RAW model completion text (normalization happens in the route).
 * @throws {MissingTitleModelConfigError} when the model id is unset/empty.
 * @throws {TitleGenerationError} when the Converse call fails or returns no
 *   usable text.
 */
export async function generateTitle(firstPrompt: string): Promise<string> {
  // Read + validate the model id BEFORE constructing any request (Req 12.4).
  const modelId = titleModelId();

  const client = getRuntimeClient();

  let response: ConverseCommandOutput["output"];
  try {
    const result = await client.send(
      new ConverseCommand({
        modelId,
        system: [{ text: TITLE_SYSTEM_PROMPT }],
        messages: [
          {
            role: "user",
            content: [{ text: firstPrompt }],
          },
        ],
        inferenceConfig: { maxTokens: MAX_TITLE_TOKENS, temperature: 0 },
      }),
    );
    response = result.output;
  } catch (cause) {
    throw new TitleGenerationError("Title model Converse call failed", { cause });
  }

  const text = extractText(response);
  if (text === null) {
    throw new TitleGenerationError();
  }
  return text;
}
