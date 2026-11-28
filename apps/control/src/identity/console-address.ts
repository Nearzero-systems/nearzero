import { consoleHostname } from "../domains/addresses.ts";
import { loadSnapshots } from "../domains/certificates.ts";
import { HOST_TARGET } from "../runners/hub.ts";
import type { ControlServices } from "../services.ts";

/**
 * The console's HTTPS address, which plain-HTTP visits to the server's IP address are sent to
 * (spec 04 4.1 "Plain HTTP", 21.9): NEARZERO_CONSOLE_URL when it is an https:// address, else the
 * public domain set under About Nearzero once the Nearzero host's router holds a valid
 * certificate for it, so nobody is sent to an address that can't answer over HTTPS yet. Null when
 * there is none, and then nothing is redirected.
 */
export async function httpsConsoleAddress(services: ControlServices): Promise<string | null> {
  const configured = services.consoleUrl();
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === "https:") return url.origin;
    } catch {
      // A malformed setting is reported at start; nothing to redirect to.
    }
  }
  const hostname = await consoleHostname(services);
  if (!hostname) return null;
  const snapshot = (await loadSnapshots(services, [HOST_TARGET])).get(HOST_TARGET);
  const now = Date.now();
  const ready = snapshot?.status?.certificates.some(
    (cert) => cert.names.includes(hostname) && cert.notAfter > now,
  );
  return ready ? `https://${hostname}` : null;
}
