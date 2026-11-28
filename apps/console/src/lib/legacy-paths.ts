/**
 * Old addresses (spec 18.1, 29.5): settings pages that moved, and console paths people
 * bookmarked or received in notifications before 1.0, which had no workspace in the address.
 * These rules only compute where an old address goes; the pages under `/dashboard/…`,
 * `settings/[entry]` and the old sign-in, registration and invitation paths apply them.
 */

/** Where an old settings entry lives in 1.0, relative to `/<workspace>/dashboard/` (18.1). */
const SETTINGS_MOVES: Record<string, string> = {
  server: "settings",
  general: "settings",
  certificates: "domains?tab=uploaded-certificates",
  dns: "domains",
  domains: "domains",
  profile: "profile",
  users: "settings/members",
  members: "settings/members",
  agent: "settings/agent-policies",
  notifications: "settings/channels",
  destinations: "settings/backups",
  "ssh-keys": "servers?tab=ssh-keys",
  servers: "servers",
  traefik: "settings/router-files",
  git: "settings/git-providers",
  "api-keys": "settings/api-keys",
};

/** The 1.0 address of an old settings entry, or null when the entry isn't one that moved. */
export function movedSettingsPath(workspace: string, entry: string): string | null {
  const target = SETTINGS_MOVES[entry.toLowerCase()];
  return target ? `/${encodeURIComponent(workspace)}/dashboard/${target}` : null;
}

const ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export type LegacyTarget =
  /** Go straight there. */
  | { kind: "redirect"; to: string }
  /**
   * A deep link naming a service or deployment by id: the page looks it up and opens its 1.0
   * page, or goes to `fallback` when nothing visible has that id.
   */
  | { kind: "lookup"; id: string; deployment: boolean; fallback: string };

/**
 * Where an address from before workspaces were in the path (`/dashboard/<rest>`) goes, for a
 * person whose active workspace is `workspace`. `rest` has no leading slash; `search` is kept.
 */
export function legacyDashboardTarget(
  rest: string,
  search: string,
  workspace: string,
): LegacyTarget {
  const base = `/${encodeURIComponent(workspace)}/dashboard`;
  const parts = rest.split("/").filter(Boolean);
  const same = `${base}${parts.length ? `/${parts.map(encodeURIComponent).join("/")}` : ""}${search}`;
  if (parts[0] === "settings" && parts[1]) {
    const moved = movedSettingsPath(workspace, parts[1]);
    if (moved) return { kind: "redirect", to: moved };
  }
  if (parts.length === 1 && parts[0]) {
    const page = movedDashboardPage(workspace, parts[0], search);
    if (page) return { kind: "redirect", to: page };
  }
  const id = parts.find((part) => ID.test(part) && part.length === 36);
  if (id && parts[0] !== "projects") {
    return {
      kind: "lookup",
      id: id.toLowerCase(),
      deployment: parts.some((part) => /^deployments?$/.test(part)),
      fallback: same,
    };
  }
  if (id && parts[0] === "projects" && parts.includes("services")) {
    const serviceId = parts[parts.indexOf("services") + 1];
    if (serviceId && ID.test(serviceId)) {
      return { kind: "lookup", id: serviceId.toLowerCase(), deployment: false, fallback: same };
    }
  }
  return { kind: "redirect", to: same };
}

/** Old public pages: sign-in, registration and invitation links (29.5). Query strings are kept. */
export const LEGACY_PUBLIC_PATHS: Record<string, string> = {
  "/login": "/sign-in",
  "/signin": "/sign-in",
  "/register": "/sign-up",
  "/signup": "/sign-up",
  "/accept-invitation": "/invitation",
};

/**
 * Where an old public address goes, with its query, or null for one 1.0 has:
 * - the sign-in, registration and invitation paths above;
 * - a registration link with its invitation, `/register?token=…` (and `/sign-up?token=…`), goes
 *   to the invitation page exactly like `/invitation?token=…` (31a G1-04);
 * - the retired setup wizard, `/setup` and `/setup/<anything>`, goes to sign-in (31a G1-03).
 */
export function legacyPublicTarget(pathname: string, search: string): string | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/setup" || path.startsWith("/setup/")) return "/sign-in";
  const hasToken = new URLSearchParams(search).has("token");
  if (hasToken && ["/register", "/signup", "/sign-up"].includes(path)) {
    return `/invitation${search}`;
  }
  const moved = LEGACY_PUBLIC_PATHS[path];
  return moved ? `${moved}${search}` : null;
}

/**
 * 0.1.79's own addresses for pages that live elsewhere in 1.0 (31a G1-03), relative to
 * `/<workspace>/dashboard/`: About Nearzero is Settings, Traefik is Settings → Traefik, the old
 * Monitoring page is About Nearzero, and Home and Get started are the Agent.
 */
const PAGE_MOVES: Record<string, string> = {
  "about-nearzero": "settings",
  monitoring: "settings",
  traefik: "settings/router-files",
  home: "agent",
  "get-started": "agent",
};

/** The 1.0 address of one of those pages, with the query kept, or null. */
export function movedDashboardPage(workspace: string, page: string, search = ""): string | null {
  const target = PAGE_MOVES[page.toLowerCase()];
  return target ? `/${encodeURIComponent(workspace)}/dashboard/${target}${search}` : null;
}

/**
 * 0.1.x's invitation address with the token as its last path segment,
 * `/accept-invitation/<token>`, opens the invitation page with that token (30a R1-08). Extra
 * query parameters (an emailed link's proof) are kept.
 */
export function legacyInvitationPath(token: string, search = ""): string {
  const query = new URLSearchParams(search);
  query.delete("token");
  const rest = query.toString();
  return `/invitation?token=${encodeURIComponent(token)}${rest ? `&${rest}` : ""}`;
}

// ---- Old addresses of objects (spec 29a.9.1)

/** What the control plane says an old object address leads to (GET /migration/console-path). */
export interface LegacyObject {
  kind: "project" | "environment" | "service" | "deployment" | "server";
  workspace: string;
  projectId?: string;
  environmentId?: string;
  serviceId?: string;
  deploymentId?: string;
  serverId?: string;
}

export type LegacyLookupAnswer = { target: LegacyObject } | { signIn: true } | null;

/** Asks the control plane about an old address; null when it doesn't know it. */
export type LegacyLookup = (path: string) => Promise<LegacyLookupAnswer>;

/** The 1.0 page of an object an old address named. */
export function legacyObjectPath(found: LegacyObject): string | null {
  const base = `/${encodeURIComponent(found.workspace)}/dashboard`;
  const part = (value: string | undefined) => (value ? encodeURIComponent(value) : null);
  const project = part(found.projectId);
  const environment = part(found.environmentId);
  switch (found.kind) {
    case "project":
    case "environment":
      return project && environment ? `${base}/projects/${project}/${environment}/overview` : null;
    case "service": {
      const service = part(found.serviceId);
      return project && environment && service
        ? `${base}/projects/${project}/${environment}/services/${service}`
        : null;
    }
    case "deployment": {
      const deployment = part(found.deploymentId);
      return deployment ? `${base}/deployments/${deployment}` : null;
    }
    case "server":
      return `${base}/servers`;
  }
  return null;
}

/**
 * Where an old address of an object goes, by asking the control plane's lookup: the object's 1.0
 * page, "sign in first" (then back to the same old address), or null when it isn't one of them.
 * Fixed old pages (settings, sign-in and the rest) are handled above, without asking.
 */
export async function legacyObjectTarget(
  pathname: string,
  lookup: LegacyLookup,
): Promise<{ kind: "redirect"; to: string } | { kind: "sign-in" } | null> {
  if (pathname.length > 2000 || !pathname.startsWith("/")) return null;
  let answer: LegacyLookupAnswer;
  try {
    answer = await lookup(pathname);
  } catch {
    return null;
  }
  if (!answer) return null;
  if ("signIn" in answer) return { kind: "sign-in" };
  const to = legacyObjectPath(answer.target);
  return to ? { kind: "redirect", to } : null;
}
