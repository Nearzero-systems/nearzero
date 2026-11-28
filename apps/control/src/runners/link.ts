import type { RunnerLinkAddress } from "@nearzero/shared";
import { consoleHostname, hostAddress } from "../domains/addresses.ts";
import { loadSnapshots } from "../domains/certificates.ts";
import type { ControlServices } from "../services.ts";
import { HOST_TARGET } from "./hub.ts";

/**
 * Where remote runners reach the control plane (spec 25 D1; spec 31 "Remote runners are always
 * encrypted"; 31c G3-01; C2-07, C2-09). In order:
 *
 * 1. an https:// address set outright (NEARZERO_RUNNER_CONTROL_URL);
 * 2. the console's hostname (set at install or under About Nearzero) once the Nearzero host's
 *    router holds a valid certificate for it: the router sends /api/v1/runner/ straight to the
 *    API, so ports 3000 and 4321 can be blocked;
 * 3. the runner link's own TLS port on the host's public address, with the SHA-256 fingerprint of
 *    the certificate the control plane made at install, which is the only one runners accept;
 * 4. the console's hostname without a valid certificate yet, when there is no runner link (an
 *    install without its TLS port, as before).
 *
 * Never a plain http:// address: setup and the join command refuse when there is nothing else.
 * Runners already set up are moved to the first of these by their next welcome (hub.ts), and
 * every remote runner keeps 3 as its fallback (C4-06).
 */

export interface RunnerLinkSettings {
  /** An address set outright; plain http:// only from tests, never from the install. */
  outright: RunnerLinkAddress | null;
  /** The runner link's own TLS port and certificate, when the install has them. */
  pinned: { port: number; fingerprint: string } | null;
  /**
   * The fingerprint of the pair that will replace the link certificate (`nearzero runner-link
   * rotate`, C4-10), read again every minute; null when none is waiting.
   */
  next?: string | null;
  /** The host's public address from the install (IPv4 or IPv6), for the TLS port. */
  publicIp: string | null;
}

/** True when the Nearzero host's router holds a certificate for `hostname` that is still valid. */
export async function hostHasValidCertificate(
  services: ControlServices,
  hostname: string,
): Promise<boolean> {
  const snapshot = (await loadSnapshots(services, [HOST_TARGET])).get(HOST_TARGET);
  const now = Date.now();
  return Boolean(
    snapshot?.status?.certificates.some(
      (certificate) => certificate.names.includes(hostname) && certificate.notAfter > now,
    ),
  );
}

function origin(host: string, port: number): string {
  const name = host.includes(":") ? `[${host}]` : host;
  return port === 443 ? `https://${name}` : `https://${name}:${port}`;
}

/** The runner link's own TLS address with its fingerprint, or null without one. */
export async function pinnedRunnerLink(
  services: ControlServices,
  settings: RunnerLinkSettings,
): Promise<RunnerLinkAddress | null> {
  if (!settings.pinned) return null;
  const address = (await hostAddress(services).catch(() => null)) ?? settings.publicIp;
  if (!address) return null;
  return { url: origin(address, settings.pinned.port), fingerprint: settings.pinned.fingerprint };
}

export async function preferredRunnerLink(
  services: ControlServices,
  settings: RunnerLinkSettings,
): Promise<RunnerLinkAddress | null> {
  if (settings.outright) return settings.outright;
  const hostname = await consoleHostname(services).catch(() => null);
  if (hostname && (await hostHasValidCertificate(services, hostname).catch(() => false))) {
    return { url: `https://${hostname}`, fingerprint: null };
  }
  const pinned = await pinnedRunnerLink(services, settings);
  if (pinned) return pinned;
  return hostname ? { url: `https://${hostname}`, fingerprint: null } : null;
}

/** How a runner address reads in commands and messages: the URL, and the fingerprint flag. */
export function joinArguments(link: RunnerLinkAddress): string {
  return link.fingerprint ? `${link.url} --fingerprint sha256:${link.fingerprint}` : link.url;
}

/**
 * The console's address in the links Nearzero makes (webhook URLs, invitation and notification
 * links, OAuth redirects; 31d G4-21): an https:// address the install set wins; otherwise the
 * console's hostname, saved under About Nearzero or set at install, once the host's router holds
 * a valid certificate for it, so nothing points at the plain-HTTP ports people are told to block;
 * otherwise the address the install set.
 */
export async function generatedConsoleUrl(
  services: ControlServices,
  configured: string | null,
): Promise<string | null> {
  if (configured?.startsWith("https:")) return configured;
  const hostname = await consoleHostname(services).catch(() => null);
  if (hostname && (await hostHasValidCertificate(services, hostname).catch(() => false))) {
    return `https://${hostname}`;
  }
  return configured;
}
