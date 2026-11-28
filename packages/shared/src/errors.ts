import { z } from "zod";

/**
 * Stable machine codes for API errors, with the HTTP status each one uses.
 *
 * Codes never change meaning once released; clients branch on the code and show the message.
 * "not_found" is also the answer for things a person may not see, so existence is never leaked
 * (spec 22.4, rule 3).
 */
export const ERROR_STATUS = {
  invalid_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  method_not_allowed: 405,
  conflict: 409,
  payload_too_large: 413,
  rate_limited: 429,
  internal: 500,
  control_unreachable: 502,
  unavailable: 503,
  timeout: 504,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;
export type ErrorStatus = (typeof ERROR_STATUS)[ErrorCode];

/**
 * The body of every error response.
 *
 * - `code`: a stable machine code.
 * - `message`: plain words that name the cause and the fix (spec 01, principle 4).
 * - `fields`: per-field messages for forms, keyed by field name.
 * - `reference`: the request id, which matches a line in the server log (spec 23.8).
 */
export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    fields?: Record<string, string>;
    reference?: string;
  };
}

/**
 * Parses an error body from the API. Codes are accepted as any well-formed string so an older
 * console still shows the message from a newer control plane.
 */
export const apiErrorBodySchema = z.object({
  error: z.object({
    code: z.string().regex(/^[a-z][a-z0-9_]*$/),
    message: z.string().min(1),
    fields: z.record(z.string(), z.string()).optional(),
    reference: z.string().optional(),
  }),
});

export interface AppErrorOptions {
  fields?: Record<string, string>;
  cause?: unknown;
}

/**
 * An error whose message is safe and useful to show to a person. Throw it from handlers; the
 * control plane turns it into an {@link ApiErrorBody}. Never put a secret in the message.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: ErrorStatus;
  readonly fields: Record<string, string> | undefined;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.fields = options.fields;
  }

  toBody(reference?: string): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.fields ? { fields: this.fields } : {}),
        ...(reference ? { reference } : {}),
      },
    };
  }
}

/** The message for an error whose cause is not known. It always carries the log reference. */
export function unknownErrorMessage(reference: string): string {
  return (
    "Something went wrong on the server. Try again; if it keeps happening, give your " +
    `administrator the reference ${reference}, which matches a line in the server log.`
  );
}

export type ParsedApiErrorBody = z.infer<typeof apiErrorBodySchema>;

export function isApiErrorBody(value: unknown): value is ParsedApiErrorBody {
  return apiErrorBodySchema.safeParse(value).success;
}
