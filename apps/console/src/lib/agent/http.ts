import { ApiError, apiErrorFrom, unreachableError } from "../api-error.ts";

/**
 * The Agent page's calls to the Nearzero API through the console's /api/v1 proxy. Browser-only
 * at call time; importing it is safe on the server (nothing runs until called).
 */

export const GENERIC_RETRY = "Something went wrong. Try again in a moment.";

export async function agentApi<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method,
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    });
  } catch {
    throw unreachableError();
  }
  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!response.ok) throw apiErrorFrom(response.status, parsed);
  if (method !== "GET") document.dispatchEvent(new CustomEvent("nz:changed"));
  return parsed as T;
}

/**
 * Words for a failed list action (spec 19.5): the platform's own words for a refusal (4xx), a
 * generic retry message for server and network errors. Nothing fails silently.
 */
export function failureWords(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status >= 400 && error.status < 500) return error.message;
    return GENERIC_RETRY;
  }
  return GENERIC_RETRY;
}

/** A path from a form's `saveTo` ("/api/v1/services/…") for agentApi. */
export function apiPath(saveTo: string): string {
  return saveTo.replace(/^\/api\/v1(?=\/)/, "");
}

export interface UploadHandle {
  promise: Promise<unknown>;
  abort(): void;
}

/** Uploads a file's bytes with progress (fetch has no upload progress, so XMLHttpRequest). */
export function uploadWithProgress(
  path: string,
  body: Blob,
  contentType: string,
  onProgress: (fraction: number) => void,
): UploadHandle {
  const request = new XMLHttpRequest();
  const promise = new Promise<unknown>((resolve, reject) => {
    request.open("POST", `/api/v1${path}`);
    request.setRequestHeader("content-type", contentType || "application/octet-stream");
    request.setRequestHeader("accept", "application/json");
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    });
    request.addEventListener("load", () => {
      let parsed: unknown = null;
      try {
        parsed = request.responseText ? JSON.parse(request.responseText) : null;
      } catch {
        parsed = null;
      }
      if (request.status >= 200 && request.status < 300) resolve(parsed);
      else reject(apiErrorFrom(request.status, parsed));
    });
    request.addEventListener("error", () => reject(unreachableError()));
    request.addEventListener("abort", () =>
      reject(new ApiError({ status: 0, code: "aborted", message: "Upload cancelled." })),
    );
    request.send(body);
  });
  return { promise, abort: () => request.abort() };
}
