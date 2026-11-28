import { writeCookie } from "./cookies.ts";

/**
 * The Agent page runs as its own React island (components/agent/AgentApp.tsx). What stays here
 * is shared with the server: the browser's time zone in a cookie, so the greeting the server
 * renders first ("Good morning, …") follows the person's own clock (spec 19.2).
 */

function rememberTimeZone(): void {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone) writeCookie("nz_tz", zone);
  } catch {
    // No time zone: greetings use the server's clock.
  }
}

export function initAgentHome(): void {
  rememberTimeZone();
}
