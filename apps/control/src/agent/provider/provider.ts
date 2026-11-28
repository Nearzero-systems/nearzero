/**
 * The model provider behind the Agent (spec 25 D4: OpenRouter only in 1.0, behind this interface
 * so direct provider keys can follow). Messages and tools use the OpenAI-compatible chat format,
 * which OpenRouter and most providers speak.
 */

/** Words inside a message that also carries files. */
export interface TextPiece {
  type: "text";
  text: string;
}

/** An image, as a data URL. */
export interface ImagePiece {
  type: "image_url";
  image_url: { url: string };
}

/** A PDF, read by the provider's own PDF reading. */
export interface DocumentPiece {
  type: "file";
  file: { filename: string; file_data: string };
}

/** A video, as a data URL (only for models that watch videos). */
export interface VideoPiece {
  type: "video_url";
  video_url: { url: string };
}

export type ContentPart = TextPiece | ImagePiece | DocumentPiece | VideoPiece;

/**
 * The only place the wire shape of message pieces is written: everything else asks for a piece
 * by what it holds.
 */
export const piece = {
  text: (text: string): TextPiece => ({ type: "text", text }),
  image: (dataUrl: string): ImagePiece => ({ type: "image_url", image_url: { url: dataUrl } }),
  document: (name: string, dataUrl: string): DocumentPiece => ({
    type: "file",
    file: { filename: name, file_data: dataUrl },
  }),
  video: (dataUrl: string): VideoPiece => ({ type: "video_url", video_url: { url: dataUrl } }),
};

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ModelMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
  model: string;
  messages: ModelMessage[];
  tools?: ToolDefinition[];
  /** "none" asks for words only (closing summaries, permission sentences). */
  toolChoice?: "auto" | "none";
  maxTokens?: number;
  temperature?: number;
  /** How the provider reads PDFs in this request (31d G4-10); sent only when one is attached. */
  pdfEngine?: "pdf-text" | "mistral-ocr" | "native";
}

export type StreamChunk =
  | { type: "text"; delta: string }
  | { type: "tool_call"; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: "finish"; reason: string | null };

export type ProviderErrorKind =
  | "rejected_key"
  | "out_of_credits"
  | "rate_limited"
  | "unavailable"
  | "silent"
  | "bad_request"
  | "aborted";

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly status: number | null = null,
    /** From a Retry-After header, when the provider sent one. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "ProviderError";
  }

  /** Network errors, timeouts, rate limits and server errors are worth trying again (spec 19.6). */
  get retryable(): boolean {
    return this.kind === "rate_limited" || this.kind === "unavailable";
  }
}

/** What a model takes besides text, from the provider's model listing (spec 19.10). */
export interface ModelInputs {
  images: boolean;
  pdfs: boolean;
  video: boolean;
}

export const TEXT_ONLY: ModelInputs = { images: false, pdfs: false, video: false };

export interface StreamOptions {
  signal: AbortSignal;
  /** Aborts with a "silent" error when nothing arrives for this long. */
  silenceMs: number;
}

export interface ModelProvider {
  readonly name: string;
  stream(key: string, request: ChatRequest, options: StreamOptions): AsyncIterable<StreamChunk>;
  /** One answer, not streamed (titles, follow-ups, log analysis). */
  complete(key: string, request: ChatRequest, options: StreamOptions): Promise<string>;
  /** null when the listing can't be read or doesn't name the model. */
  modelInputs(key: string, model: string, signal: AbortSignal): Promise<ModelInputs | null>;
}
