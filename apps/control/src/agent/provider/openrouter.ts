import type { HttpFetch } from "../../services.ts";
import { forwardStop } from "../abort.ts";
import {
  type ChatRequest,
  type ModelInputs,
  type ModelProvider,
  ProviderError,
  type StreamChunk,
  type StreamOptions,
} from "./provider.ts";

/**
 * OpenRouter's OpenAI-compatible chat completions (streaming with server-sent events, tool
 * calls) and its model listing, from OpenRouter's public API documentation. The workspace's own
 * key is passed in for every call; nothing here reads the environment.
 */

function retryAfter(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

/** Turns a refusal into the error kinds the Agent explains (spec 19.6, 19.10). */
export function errorFor(status: number, detail: string, retryAfterMs: number | null = null) {
  const text = detail.slice(0, 300);
  if (status === 401 || status === 403) {
    if (/moderat|flagged/i.test(text)) {
      return new ProviderError(
        "bad_request",
        `The model provider refused this request: ${text}`,
        status,
      );
    }
    return new ProviderError("rejected_key", "The provider rejected the API key.", status);
  }
  if (status === 402) return new ProviderError("out_of_credits", "Out of credits.", status);
  if (status === 408 || status === 429) {
    return new ProviderError(
      status === 429 ? "rate_limited" : "unavailable",
      text || "The provider is busy.",
      status,
      retryAfterMs,
    );
  }
  if (status >= 500) {
    return new ProviderError(
      "unavailable",
      text || "The provider had a problem.",
      status,
      retryAfterMs,
    );
  }
  return new ProviderError("bad_request", text || `The provider answered ${status}.`, status);
}

async function readError(response: Response): Promise<ProviderError> {
  let detail = "";
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    detail = body.error?.message ?? "";
  } catch {
    detail = "";
  }
  return errorFor(response.status, detail, retryAfter(response));
}

interface StreamDelta {
  choices?: {
    delta?: {
      content?: string | null;
      tool_calls?: {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
  error?: { code?: number | string; message?: string };
}

/** Whether any message carries a PDF for the provider to read. */
function carriesPdf(request: ChatRequest): boolean {
  return request.messages.some(
    (message) =>
      message.role === "user" &&
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === "file"),
  );
}

function body(request: ChatRequest, stream: boolean): string {
  return JSON.stringify({
    model: request.model,
    messages: request.messages,
    stream,
    // OpenRouter's file parser, named, so a PDF never falls to the paid OCR by default (G4-10).
    ...(request.pdfEngine && carriesPdf(request)
      ? { plugins: [{ id: "file-parser", pdf: { engine: request.pdfEngine } }] }
      : {}),
    ...(request.tools && request.tools.length > 0 && request.toolChoice !== "none"
      ? { tools: request.tools, tool_choice: request.toolChoice ?? "auto" }
      : {}),
    ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
  });
}

/** A signal that fires on the caller's abort or after `silenceMs` without data, re-armed by touch(). */
function silenceWatch(options: StreamOptions) {
  const controller = new AbortController();
  let silent = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      silent = true;
      controller.abort();
    }, options.silenceMs);
  };
  const forwarded = forwardStop(options.signal, controller);
  arm();
  return {
    signal: controller.signal,
    touch: arm,
    get silent() {
      return silent;
    },
    done() {
      clearTimeout(timer);
      forwarded.release();
    },
  };
}

function failure(error: unknown, watch: { silent: boolean }, signal: AbortSignal): ProviderError {
  if (error instanceof ProviderError) return error;
  if (watch.silent) return new ProviderError("silent", "No data from the provider for too long.");
  if (signal.aborted) return new ProviderError("aborted", "Stopped.");
  return new ProviderError("unavailable", (error as Error)?.message ?? "Network error.");
}

export class OpenRouterProvider implements ModelProvider {
  readonly name = "OpenRouter";
  readonly #listing = new Map<string, { at: number; inputs: ModelInputs | null }>();

  constructor(
    private readonly baseUrl: string,
    private readonly fetch: HttpFetch,
    private readonly now: () => number = () => Date.now(),
    /** HTTP-Referer and X-Title, so usage shows as this install (30d R4-09). */
    private readonly identity: () => { referer: string | null; title: string } = () => ({
      referer: null,
      title: "Nearzero",
    }),
  ) {}

  #headers(key: string): Record<string, string> {
    const { referer, title } = this.identity();
    return {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "x-title": title,
      ...(referer ? { "http-referer": referer } : {}),
    };
  }

  async *stream(
    key: string,
    request: ChatRequest,
    options: StreamOptions,
  ): AsyncIterable<StreamChunk> {
    const watch = silenceWatch(options);
    try {
      let response: Response;
      try {
        response = await this.fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { ...this.#headers(key), accept: "text/event-stream" },
          body: body(request, true),
          signal: watch.signal,
        });
      } catch (error) {
        throw failure(error, watch, options.signal);
      }
      watch.touch();
      if (!response.ok) throw await readError(response);
      if (!response.body) throw new ProviderError("unavailable", "The provider sent no answer.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (error) {
          throw failure(error, watch, options.signal);
        }
        if (chunk.done) break;
        watch.touch();
        buffer += decoder.decode(chunk.value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          if (!line.startsWith("data:")) continue; // comments and blank lines keep it alive
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") return;
          let parsed: StreamDelta;
          try {
            parsed = JSON.parse(payload) as StreamDelta;
          } catch {
            continue;
          }
          if (parsed.error) {
            const status = Number(parsed.error.code);
            throw errorFor(Number.isFinite(status) ? status : 502, parsed.error.message ?? "");
          }
          for (const choice of parsed.choices ?? []) {
            const delta = choice.delta;
            if (delta?.content) yield { type: "text", delta: delta.content };
            for (const call of delta?.tool_calls ?? []) {
              yield {
                type: "tool_call",
                index: call.index ?? 0,
                ...(call.id ? { id: call.id } : {}),
                ...(call.function?.name ? { name: call.function.name } : {}),
                ...(call.function?.arguments ? { argumentsDelta: call.function.arguments } : {}),
              };
            }
            if (choice.finish_reason) {
              if (choice.finish_reason === "error") {
                throw new ProviderError("unavailable", "The model stopped with an error.");
              }
              yield { type: "finish", reason: choice.finish_reason };
            }
          }
        }
      }
    } finally {
      watch.done();
    }
  }

  async complete(key: string, request: ChatRequest, options: StreamOptions): Promise<string> {
    const watch = silenceWatch(options);
    try {
      let response: Response;
      try {
        response = await this.fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: this.#headers(key),
          body: body(request, false),
          signal: watch.signal,
        });
      } catch (error) {
        throw failure(error, watch, options.signal);
      }
      if (!response.ok) throw await readError(response);
      try {
        const parsed = (await response.json()) as {
          choices?: { message?: { content?: string | null } }[];
          error?: { code?: number; message?: string };
        };
        if (parsed.error) throw errorFor(parsed.error.code ?? 502, parsed.error.message ?? "");
        return parsed.choices?.[0]?.message?.content ?? "";
      } catch (error) {
        throw failure(error, watch, options.signal);
      }
    } finally {
      watch.done();
    }
  }

  /** The listing is public; it is read at most every 6 hours (spec 19.10). */
  async modelInputs(key: string, model: string, signal: AbortSignal): Promise<ModelInputs | null> {
    const cached = this.#listing.get(model);
    const now = this.now();
    if (cached && now - cached.at < (cached.inputs ? SIX_HOURS : TEN_MINUTES)) return cached.inputs;
    let inputs: ModelInputs | null = null;
    try {
      const response = await this.fetch(`${this.baseUrl}/models`, {
        headers: this.#headers(key),
        signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
      });
      if (response.ok) {
        const listing = (await response.json()) as {
          data?: { id?: string; architecture?: { input_modalities?: string[] } }[];
        };
        for (const entry of listing.data ?? []) {
          if (!entry.id) continue;
          const modalities = entry.architecture?.input_modalities ?? [];
          this.#listing.set(entry.id, {
            at: now,
            inputs: {
              images: modalities.includes("image"),
              pdfs: modalities.includes("file"),
              video: modalities.includes("video"),
            },
          });
        }
        inputs = this.#listing.get(model)?.inputs ?? null;
      }
    } catch {
      inputs = null;
    }
    if (!inputs) this.#listing.set(model, { at: now, inputs: null });
    return inputs;
  }
}

const SIX_HOURS = 6 * 60 * 60 * 1000;
const TEN_MINUTES = 10 * 60 * 1000;
