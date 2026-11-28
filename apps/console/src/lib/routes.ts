import type { Capability } from "@nearzero/shared/browser";

/**
 * Console addresses. Every dashboard page lives under /<workspace-slug>/dashboard/... (spec 4.4).
 */

/** Documentation and Support open outside the console (spec 21.6). */
export const DOCS_URL = "https://nearzero.dev/docs";
export const SUPPORT_URL = "mailto:support@nearzero.dev";

export const PROJECT_SECTIONS = ["overview", "services", "variables"] as const;
export type ProjectSection = (typeof PROJECT_SECTIONS)[number];

export const SETTINGS_ENTRIES = [
  { key: "about", label: "About Nearzero", path: "" },
  { key: "members", label: "Members & access", path: "members" },
  { key: "agent-policies", label: "Agent policies", path: "agent-policies" },
  { key: "api-keys", label: "API keys", path: "api-keys" },
  { key: "git-providers", label: "Git providers", path: "git-providers" },
  { key: "router-files", label: "Traefik", path: "router-files" },
  { key: "backups", label: "Backups", path: "backups" },
  { key: "channels", label: "Channels", path: "channels" },
] as const;
export type SettingsKey = (typeof SETTINGS_ENTRIES)[number]["key"];

export function dashboardPath(workspace: string, rest = ""): string {
  const tail = rest.replace(/^\/+/, "");
  return `/${encodeURIComponent(workspace)}/dashboard${tail ? `/${tail}` : ""}`;
}

export function agentPath(workspace: string): string {
  return dashboardPath(workspace, "agent");
}

export function projectsPath(workspace: string): string {
  return dashboardPath(workspace, "projects");
}

export function projectPath(
  workspace: string,
  projectId: string,
  environmentId: string,
  section: ProjectSection = "overview",
): string {
  return dashboardPath(
    workspace,
    `projects/${encodeURIComponent(projectId)}/${encodeURIComponent(environmentId)}/${section}`,
  );
}

/** The new-application page (spec 6.1); the environment switcher keeps it. */
export function newApplicationPath(
  workspace: string,
  projectId: string,
  environmentId: string,
): string {
  return dashboardPath(
    workspace,
    `projects/${encodeURIComponent(projectId)}/${encodeURIComponent(environmentId)}/new-application`,
  );
}

/** Tabs of a service's page, per kind (spec 6.2, 8.2). Compose is one page of sections (7.2). */
// The original's tabs first, in its order (spec 21.10), then the ones 1.0 adds.
export const SERVICE_TABS = {
  application: ["overview", "settings", "variables", "backups", "logs", "advanced"],
  database: ["overview", "settings", "variables", "backups", "logs"],
  compose: ["overview"],
} as const;
export type ServiceTab = "overview" | "logs" | "variables" | "advanced" | "backups" | "settings";

export const SERVICE_TAB_LABELS: Record<ServiceTab, string> = {
  overview: "Overview",
  logs: "Logs",
  variables: "Variables",
  advanced: "Advanced",
  backups: "Backups",
  settings: "Settings",
};

export function servicePath(
  workspace: string,
  projectId: string,
  environmentId: string,
  serviceId: string,
  tab: ServiceTab = "overview",
): string {
  const base = `projects/${encodeURIComponent(projectId)}/${encodeURIComponent(environmentId)}/services/${encodeURIComponent(serviceId)}`;
  return dashboardPath(workspace, tab === "overview" ? base : `${base}/${tab}`);
}

export function settingsPath(workspace: string, key: SettingsKey = "about"): string {
  const entry = SETTINGS_ENTRIES.find((item) => item.key === key);
  return dashboardPath(workspace, `settings${entry?.path ? `/${entry.path}` : ""}`);
}

export function isProjectSection(value: string | undefined): value is ProjectSection {
  return (PROJECT_SECTIONS as readonly string[]).includes(value ?? "");
}

/** The dashboard path after the workspace slug, so switching workspaces keeps the page. */
export function pathAfterWorkspace(pathname: string): string {
  const match = pathname.match(/^\/[^/]+\/dashboard(\/.*)?$/);
  return match?.[1] ?? "";
}

/** What the settings hub says to someone who opens an entry they can't use (spec 18.1). */
export const NO_ACCESS_MESSAGE = "You do not have access to this section.";

export interface SettingsAudience {
  role: "owner" | "admin" | "member";
  isInstanceAdmin: boolean;
  capabilities: readonly Capability[];
  can: { manageMembers: boolean; manageAgentPolicies: boolean; manageApiKeys: boolean };
  /** The person may use at least one Git account (shared, granted, or their own). */
  usesGitAccounts?: boolean;
}

/**
 * Which settings entries a person can use (spec 18.1). Hidden entries also refuse direct access
 * by address. Members see Git providers, Router files, Backups and Channels when they hold the
 * capability that opens them (GET /workspace lists the person's own capabilities); Git providers
 * also when they may use a Git account someone shared with them (spec 16.1).
 */
export function settingsVisibility(audience: SettingsAudience): Record<SettingsKey, boolean> {
  const manager = audience.role === "owner" || audience.role === "admin";
  const holds = (capability: Capability) => manager || audience.capabilities.includes(capability);
  return {
    about: true,
    members: audience.can.manageMembers,
    "agent-policies": audience.can.manageAgentPolicies,
    "api-keys": audience.can.manageApiKeys,
    "git-providers": holds("git.connect-own") || audience.usesGitAccounts === true,
    // Owners and admins hold "See router files" for their workspace's servers (spec 22.3).
    "router-files": audience.isInstanceAdmin || holds("router-files.read"),
    backups: holds("backups.manage-destinations") || holds("backups.use-destinations"),
    channels: holds("notifications.manage"),
  };
}
