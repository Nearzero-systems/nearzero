import type { AstroCookies } from "astro";
import { ApiError } from "../api-error.ts";
import type { ComposeOverview } from "../compose-rules.ts";
import { ControlClient } from "../control-client.ts";

/**
 * The Compose page's own reads (spec 07 7.2; docs/api/compose.md). The page loads the stack's
 * summary on the server; Preview, the containers and their actions load in the browser
 * (client/compose.ts).
 */

interface Host {
  cookies: AstroCookies;
  request: Request;
  url: URL;
  clientAddress?: string;
}

function peerOf(host: Host): string | undefined {
  try {
    return host.clientAddress;
  } catch {
    return undefined;
  }
}

/** The stack's summary, or null when it can't be read just now (the page still renders). */
export async function composeOverview(
  host: Host,
  serviceId: string,
): Promise<ComposeOverview | null> {
  const api = new ControlClient({
    cookies: host.cookies,
    request: host.request,
    clientAddress: peerOf(host),
  });
  try {
    return await api.get<ComposeOverview>(`/services/${encodeURIComponent(serviceId)}/compose`);
  } catch (error) {
    if (error instanceof ApiError) return null;
    throw error;
  }
}

export { CONTAINER_ROW_ACTIONS } from "../compose-rules.ts";
