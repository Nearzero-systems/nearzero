import type { APIRoute } from "astro";
import { controlUrl } from "../../lib/control-api.ts";

/**
 * 0.1.x's health address on the console, which uptime monitors point at (R4-11): the control
 * plane's own answer (status, version, database check), read from its fixed internal address.
 * 503 when the control plane can't be reached.
 */
export const GET: APIRoute = async () => {
  const headers = { "content-type": "application/json", "cache-control": "no-store" };
  try {
    const answer = await fetch(new URL("/api/v1/health", controlUrl()), {
      signal: AbortSignal.timeout(5_000),
    });
    return new Response(await answer.text(), { status: answer.status, headers });
  } catch {
    return new Response(
      JSON.stringify({ status: "unreachable", checks: { control: "unreachable" } }),
      { status: 503, headers },
    );
  }
};
