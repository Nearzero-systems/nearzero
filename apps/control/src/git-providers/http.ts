import { AppError, type ErrorCode } from "@nearzero/shared";
import type { HttpFetch } from "../services.ts";

/**
 * Calls to a Git host's API (spec 16): JSON in and out, a timeout on every call, and failures
 * turned into plain words that name the host and what to do (spec 16.7). Tokens travel only in
 * headers, never in URLs, and no message ever repeats one.
 */

export const PROVIDER_TIMEOUT_MS = 20_000;

export type ProviderFailure = "credentials" | "forbidden" | "not_found" | "unreachable" | "failed";

/** A refusal or failure from a Git host, already in words a person can act on. */
export class ProviderError extends Error {
  constructor(
    readonly failure: ProviderFailure,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "ProviderError";
  }

  toAppError(): AppError {
    const code: ErrorCode =
      this.failure === "unreachable"
        ? "unavailable"
        : this.failure === "not_found"
          ? "not_found"
          : "conflict";
    return new AppError(code, this.message);
  }
}

export interface ProviderResponse {
  status: number;
  headers: Headers;
  text: string;
  // biome-ignore lint/suspicious/noExplicitAny: provider answers are read field by field.
  json: any;
}

export interface ProviderCall {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  /** A JSON body, or URL-encoded form text with a form content type. */
  json?: unknown;
  form?: Record<string, string>;
  /** Statuses the caller handles itself instead of the generic words below. */
  allow?: readonly number[];
  timeoutMs?: number;
}

/** The generic words for a status, per host. Callers give better ones where they know more. */
export function statusFailure(label: string, status: number): ProviderError {
  if (status === 401) {
    return new ProviderError(
      "credentials",
      `${label} refused Nearzero's credentials. Reconnect the account in Settings → Git providers.`,
      status,
    );
  }
  if (status === 403) {
    return new ProviderError(
      "forbidden",
      `${label} says this account has no access to that. Grant access on ${label}, then try again.`,
      status,
    );
  }
  if (status === 404) {
    return new ProviderError(
      "not_found",
      `${label} says it doesn't exist, or this account can't see it.`,
      status,
    );
  }
  if (status === 429) {
    return new ProviderError(
      "failed",
      `${label} is limiting requests from this account right now. Wait a minute and try again.`,
      status,
    );
  }
  return new ProviderError(
    "failed",
    `${label} answered with an error (HTTP ${status}). Try again in a minute.`,
    status,
  );
}

export async function providerRequest(
  http: HttpFetch,
  label: string,
  call: ProviderCall,
): Promise<ProviderResponse> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": "Nearzero",
    ...call.headers,
  };
  let body: string | undefined;
  if (call.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(call.json);
  } else if (call.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(call.form).toString();
  }
  let response: Response;
  try {
    response = await http(call.url, {
      method: call.method ?? (body === undefined ? "GET" : "POST"),
      headers,
      ...(body === undefined ? {} : { body }),
      redirect: "follow",
      signal: AbortSignal.timeout(call.timeoutMs ?? PROVIDER_TIMEOUT_MS),
    });
  } catch (error) {
    const reason =
      (error as Error).name === "TimeoutError"
        ? "it didn't answer within 20 seconds"
        : "the connection failed";
    let host = call.url;
    try {
      host = new URL(call.url).host;
    } catch {
      // keep the address as given
    }
    throw new ProviderError(
      "unreachable",
      `${label} can't be reached from Nearzero at ${host}: ${reason}. Check the address and the network, then try again.`,
    );
  }
  const text = await response.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (!response.ok && !(call.allow ?? []).includes(response.status)) {
    throw statusFailure(label, response.status);
  }
  return { status: response.status, headers: response.headers, text, json };
}

/** Raw bytes (file contents), with a size limit checked as they arrive. */
export async function providerBytes(
  http: HttpFetch,
  label: string,
  call: ProviderCall,
  maxBytes: number,
): Promise<{ status: number; bytes: Uint8Array; tooLarge: boolean }> {
  let response: Response;
  try {
    response = await http(call.url, {
      method: "GET",
      headers: { "user-agent": "Nearzero", ...call.headers },
      redirect: "follow",
      signal: AbortSignal.timeout(call.timeoutMs ?? PROVIDER_TIMEOUT_MS),
    });
  } catch {
    throw new ProviderError(
      "unreachable",
      `${label} can't be reached from Nearzero right now. Try again in a minute.`,
    );
  }
  if (!response.ok && !(call.allow ?? []).includes(response.status)) {
    throw statusFailure(label, response.status);
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    return { status: response.status, bytes: new Uint8Array(), tooLarge: true };
  }
  const reader = response.body?.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        return { status: response.status, bytes: new Uint8Array(), tooLarge: true };
      }
      parts.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return { status: response.status, bytes, tooLarge: false };
}

/** Joins an API base and a path without doubling slashes. */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** Encodes each part of a file path for a URL, keeping the slashes. */
export function encodePath(path: string): string {
  return path
    .split("/")
    .filter((part) => part !== "")
    .map(encodeURIComponent)
    .join("/");
}
