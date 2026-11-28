import {
  type ApiErrorBody,
  AppError,
  ERROR_STATUS,
  type ErrorCode,
  unknownErrorMessage,
} from "@nearzero/shared";
import type { Context, ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "./context.ts";

const CODE_BY_STATUS = new Map<number, ErrorCode>(
  Object.entries(ERROR_STATUS).map(([code, status]) => [status, code as ErrorCode]),
);

function send(c: Context<AppEnv>, error: AppError) {
  // A limit says when to try again (31d G4-14), in the body's words and the standard header.
  const retryAfter = (error as { retryAfterSeconds?: unknown }).retryAfterSeconds;
  if (typeof retryAfter === "number" && retryAfter > 0) {
    c.header("retry-after", String(Math.ceil(retryAfter)));
  }
  return c.json<ApiErrorBody>(error.toBody(c.get("requestId")), error.status);
}

/**
 * Turns anything a handler throws into the standard error body. Known errors keep their own
 * words; anything else gets a message with the request id, which is logged with the full error
 * (spec 23.8: never "Internal server error" when the cause is known).
 */
export const handleError: ErrorHandler<AppEnv> = (error, c) => {
  const log = c.get("log");
  if (error instanceof AppError) {
    if (error.status >= 500) log.error("request failed", { error });
    return send(c, error);
  }
  if (error instanceof HTTPException && error.status < 500) {
    const code = CODE_BY_STATUS.get(error.status) ?? "invalid_request";
    const message =
      error.message || "The request could not be read. Check what was sent and try again.";
    return send(c, new AppError(code, message));
  }
  log.error("unexpected error", { error });
  const reference = c.get("requestId");
  return send(c, new AppError("internal", unknownErrorMessage(reference)));
};

export const handleNotFound: NotFoundHandler<AppEnv> = (c) =>
  send(
    c,
    new AppError(
      "not_found",
      `There is no API endpoint at ${c.req.method} ${c.req.path}. Check the address; if the console sent this request, reload the page so it matches the running version.`,
    ),
  );
