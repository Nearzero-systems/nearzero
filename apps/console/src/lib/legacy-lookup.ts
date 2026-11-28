import { API_PREFIX } from "@nearzero/shared";
import type { AstroCookies } from "astro";
import { ApiError } from "./api-error.ts";
import { connectionOf, forwardToControl } from "./control-api.ts";
import { ControlClient } from "./control-client.ts";
import type { LegacyLookup, LegacyLookupAnswer } from "./legacy-paths.ts";

/**
 * The console's side of what a move from 0.1.x keeps working (spec 29.5, 29a.9.1), for requests
 * no page of the console takes: an old object address is looked up on the control plane, and a
 * POST to an old webhook address is passed on to it unchanged.
 */

interface RequestHost {
  request: Request;
  cookies: AstroCookies;
  clientAddress?: string | undefined;
}

/** The control plane's lookup of an old console address, as the person asking. */
export function controlLegacyLookup(host: RequestHost): LegacyLookup {
  const api = new ControlClient(host);
  return async (path) => {
    try {
      return await api.get<Exclude<LegacyLookupAnswer, null>>(
        `/migration/console-path?path=${encodeURIComponent(path)}`,
      );
    } catch (error) {
      if (error instanceof ApiError && error.code === "not_found") return null;
      throw error;
    }
  };
}

/**
 * Passes a POST that no console page took on to the control plane as
 * `/api/v1/webhooks/legacy/<path>`, which answers it when it is an old webhook address (and with
 * "not found" otherwise). `request` is a copy taken before the console looked at it.
 */
export function forwardLegacyWebhook(
  request: Request,
  peer: string | undefined,
): Promise<Response> {
  const incoming = new URL(request.url);
  const target = new URL(
    `${API_PREFIX}/webhooks/legacy${incoming.pathname}${incoming.search}`,
    incoming,
  );
  const forwarded = new Request(target, {
    method: "POST",
    headers: request.headers,
    body: request.body,
    // Lets Node stream a request body; Bun ignores it.
    duplex: "half",
  } as RequestInit);
  return forwardToControl(forwarded, connectionOf(request, peer));
}

/**
 * A GET no page takes may be a 0.1.x webhook address a move kept, which 0.1.x deployed on: the
 * control plane answers 405 "Call this webhook with POST." for those (31d G4-17), and that answer
 * is returned; anything else leaves the console's own answer.
 */
export async function legacyWebhookGet(
  request: Request,
  peer: string | undefined,
): Promise<Response | null> {
  const incoming = new URL(request.url);
  const target = new URL(`${API_PREFIX}/webhooks/legacy${incoming.pathname}`, incoming);
  const headers = new Headers(request.headers);
  headers.delete("cookie");
  try {
    const answer = await forwardToControl(
      new Request(target, { method: "GET", headers }),
      connectionOf(request, peer),
    );
    if (answer.status === 405) return answer;
    await answer.body?.cancel();
  } catch {}
  return null;
}
