import type { NavKey } from "../components/shell/nav-items.ts";
import { connectionOf } from "./control-api.ts";
import { isTrustedPeer, parseTrustedProxies } from "./forwarding.ts";

/**
 * What every page says about itself in its <head> (spec 21.9b): the title "<Page> · Nearzero"
 * ("Nearzero" alone on the home), a one-sentence description, and on public pages the link
 * preview, whose image address is absolute and built from the console's own address.
 */

export const SITE_NAME = "Nearzero";

/** The home's title: the Agent's empty chat, where the root address lands (spec 4.1, 19.2). */
export const HOME_TITLE = SITE_NAME;

export function documentTitle(page: string): string {
  const name = page.trim();
  return name === "" || name === SITE_NAME ? SITE_NAME : `${name} · ${SITE_NAME}`;
}

export const DEFAULT_DESCRIPTION =
  "Nearzero runs your apps, databases and Compose stacks on your own servers.";

/** One sentence for each part of the dashboard, by its sidebar item. */
export const SECTION_DESCRIPTIONS: Record<NavKey, string> = {
  agent: "Ask the Agent to deploy, check and fix what runs in this workspace.",
  projects: "The projects in this workspace, with their environments and services.",
  deployments: "Every deployment in this workspace, with its status and build log.",
  tasks: "Scheduled and one-off tasks in this workspace, and how their runs went.",
  analytics: "Requests to your apps through the router, with response times and errors.",
  servers: "The servers this workspace deploys to, and the SSH keys that reach them.",
  domains: "Domains, DNS records and certificates for the apps in this workspace.",
  settings: "Settings for this workspace and this Nearzero install.",
  profile: "Your name, email, password and two-factor sign-in.",
};

/** The link-preview picture (the brand kit's og.png). */
export const PREVIEW_IMAGE = { path: "/og.png", width: 1200, height: 630 } as const;

const HOST =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;

/**
 * The address the browser reached this console at, like `http://203.0.113.10:4321` or
 * `https://nearzero.example.com`: the host it asked for and the scheme it used. Behind the
 * router (or another trusted proxy, see forwarding.ts) the proxy's X-Forwarded-Proto and
 * X-Forwarded-Host say them; from anyone else those headers are ignored. A malformed host falls
 * back to `fallback`'s.
 */
export function consoleOrigin(request: Request, peer: string | undefined, fallback: URL): string {
  const { scheme } = connectionOf(request, peer);
  const proxied = isTrustedPeer(
    peer ?? "",
    parseTrustedProxies(process.env.NEARZERO_TRUSTED_PROXIES),
  );
  const forwardedHost = proxied
    ? request.headers.get("x-forwarded-host")?.split(",")[0]?.trim()
    : undefined;
  const host = [forwardedHost, request.headers.get("host")?.trim()].find((value): value is string =>
    Boolean(value && HOST.test(value)),
  );
  return `${scheme}://${(host ?? fallback.host).toLowerCase()}`;
}

/** The absolute address of a path on this console. */
export function absoluteUrl(origin: string, path: string): string {
  return new URL(path, `${origin}/`).toString();
}
