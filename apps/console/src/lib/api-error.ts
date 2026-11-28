/**
 * A refusal or failure from the Nearzero API, in its one error shape (docs/api/identity.md):
 * a stable code, a message written for people, and one message per field. Used by the server
 * side of pages and by browser code alike, so both show the API's own words.
 */

export const UNREACHABLE_MESSAGE =
  "The console can't reach the Nearzero API. Check that Nearzero is running with: sudo nearzero status";

export const LOAD_FAILED_MESSAGE = "Could not load this page. Try refreshing.";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: Record<string, string>;
  readonly reference: string | null;

  constructor(input: {
    status: number;
    code: string;
    message: string;
    fields?: Record<string, string>;
    reference?: string | null;
  }) {
    super(input.message);
    this.name = "ApiError";
    this.status = input.status;
    this.code = input.code;
    this.fields = input.fields ?? {};
    this.reference = input.reference ?? null;
  }

  /** The message for one field, if the API named it. */
  field(name: string): string | undefined {
    return this.fields[name];
  }
}

/** Reads the API's error body; anything else becomes a generic failure with the status. */
export function apiErrorFrom(status: number, body: unknown): ApiError {
  const error =
    typeof body === "object" && body !== null && "error" in body
      ? (body as { error: unknown }).error
      : null;
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    const fields: Record<string, string> = {};
    if (typeof record.fields === "object" && record.fields !== null) {
      for (const [key, value] of Object.entries(record.fields as Record<string, unknown>)) {
        if (typeof value === "string") fields[key] = value;
      }
    }
    return new ApiError({
      status,
      code: typeof record.code === "string" ? record.code : "internal",
      message:
        typeof record.message === "string" && record.message
          ? record.message
          : `The request failed (HTTP ${status}). Try again.`,
      fields,
      reference: typeof record.reference === "string" ? record.reference : null,
    });
  }
  return new ApiError({
    status,
    code: status === 404 ? "not_found" : "internal",
    message: `The request failed (HTTP ${status}). Try again.`,
  });
}

export function unreachableError(): ApiError {
  return new ApiError({ status: 503, code: "control_unreachable", message: UNREACHABLE_MESSAGE });
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}
