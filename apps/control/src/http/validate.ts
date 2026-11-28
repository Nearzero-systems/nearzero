import { AppError } from "@nearzero/shared";
import type { Context } from "hono";
import type { z } from "zod";
import type { AppEnv } from "./context.ts";

/**
 * Reads and checks a JSON body. Only JSON is accepted for changes, which (with SameSite=Lax
 * cookies) keeps other sites from submitting forms to the API. Problems come back as
 * invalid_request with one message per field, in the spec's words.
 */
export async function readBody<Schema extends z.ZodType>(
  c: Context<AppEnv>,
  schema: Schema,
): Promise<z.output<Schema>> {
  const type = c.req.header("content-type") ?? "";
  if (!/^application\/json\b/i.test(type)) {
    throw new AppError(
      "invalid_request",
      "Send the request body as JSON with Content-Type: application/json.",
    );
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new AppError("invalid_request", "The request body is not valid JSON.");
  }
  return check(schema, body);
}

export function check<Schema extends z.ZodType>(schema: Schema, value: unknown): z.output<Schema> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.length > 0 ? issue.path.join(".") : "_";
    fields[key] ??= issue.message;
  }
  const first = result.error.issues[0]?.message ?? "Check what was sent and try again.";
  throw new AppError("invalid_request", first, { fields });
}
