import { z } from "zod";

/** Every control-plane endpoint lives under this prefix (spec 25, D5). */
export const API_PREFIX = "/api/v1";

/** Header that carries the request id between the console proxy, the control plane and logs. */
export const REQUEST_ID_HEADER = "x-request-id";

/** Request ids we accept from a caller; anything else is replaced with a fresh one. */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export const healthResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  version: z.string(),
  checks: z.object({
    database: z.enum(["ok", "unreachable"]),
  }),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

const REQUEST_ID_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

/**
 * A short id like req_k3m9x2p7q4wz: easy to read out, unique enough to find in a log. Uses the
 * random-bytes API, which browsers keep even on plain HTTP (spec 21.9).
 */
export function newRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let id = "req_";
  for (const byte of bytes) id += REQUEST_ID_ALPHABET[byte % REQUEST_ID_ALPHABET.length];
  return id;
}
