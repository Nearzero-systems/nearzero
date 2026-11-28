/**
 * Git providers' words, limits and pure checks (spec 16, 06 6.1, 6.3, 6.6, 19.7). Browser-safe:
 * no zod here; the request schemas are in git-providers.ts.
 */

export const GIT_PROVIDER_KINDS = ["github", "gitlab", "bitbucket", "gitea"] as const;
export type GitProviderKind = (typeof GIT_PROVIDER_KINDS)[number];

export const GIT_PROVIDER_LABELS: Record<GitProviderKind, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
  gitea: "Gitea",
};

export function isGitProviderKind(value: unknown): value is GitProviderKind {
  return typeof value === "string" && (GIT_PROVIDER_KINDS as readonly string[]).includes(value);
}

/** Repository and branch lists answer at most this many per request (spec 16.7, 19.7). */
export const REPOSITORY_LIST_CAP = 200;
export const BRANCH_LIST_CAP = 200;
/** A branch's file list stops here; the answer says it was cut. */
export const FILE_LIST_CAP = 10_000;
/** Files read without cloning are at most this large. */
export const FILE_READ_MAX_BYTES = 100 * 1024;
/** Inspection (spec 19.7 step 6): the file list this deep, and this many small manifest files. */
export const INSPECT_DEPTH = 3;
export const INSPECT_MANIFEST_CAP = 12;
/** Connect flows (OAuth, the GitHub App manifest and install) stay open this long. */
export const GIT_FLOW_MINUTES = 30;

export const DEFAULT_GITLAB_URL = "https://gitlab.com";
export const DEFAULT_GITEA_URL = "https://gitea.com";
export const DEFAULT_COMPOSE_PATH = "./docker-compose.yml";

export const SECRET_KEEP_PLACEHOLDER = "Configured - leave blank to keep";
export const NO_CONNECT_RIGHT_MESSAGE =
  'You can use the Git accounts shared with this workspace. To connect your own, ask an owner or admin to allow "Connect their own Git accounts" for you.';
export const PROVIDER_SHARED_MESSAGE = "Provider shared with workspace";
export const PROVIDER_UNSHARED_MESSAGE = "Provider unshared";
export const DELETE_PROVIDER_TITLE = "Delete this Git provider?";
export const DELETE_SHARED_NOTE =
  "This provider is shared with the workspace. Deleting it will remove access for all members.";
export const NO_GIT_SOURCE = "No Git source";
export const CONFIGURE_DOMAIN_FIRST = "Configure a domain first.";
export const GITHUB_NEEDS_HTTPS =
  "GitHub sends its events to the console, so the console needs a public HTTPS address first.";
export const BITBUCKET_DEPRECATED_NOTE =
  "This connection uses a Bitbucket app password, which Atlassian is retiring. Edit it and paste an API token instead.";

export function noAccountsMessage(kind: GitProviderKind): string {
  return `No ${GIT_PROVIDER_LABELS[kind]} accounts connected. Connect one to import repositories.`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "N apps and M compose services use this provider. …" (spec 16.1). */
export function providerInUseMessage(apps: number, composeServices: number): string {
  return `${plural(apps, "app", "apps")} and ${plural(composeServices, "compose service", "compose services")} use this provider. They will stop deploying from Git until you pick another provider.`;
}

/** GitHub's rules for an organization's slug: 1 to 39 letters, digits and single dashes. */
export function githubOrganizationProblem(slug: string): string | null {
  if (slug === "") return null;
  if (slug.length > 39) return "A GitHub organization name has at most 39 characters.";
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9]))*$/.test(slug)) {
    return "Use the organization's name as in its GitHub address: letters, numbers and single dashes, not at the start or end.";
  }
  return null;
}

/**
 * A place in the console to come back to after connecting (spec 16.1): a path on this console,
 * never another site (no scheme, no //, no backslashes).
 */
export function isConsoleReturnPath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 500 &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\\") &&
    !/[\s\0]/.test(value)
  );
}

/** owner/name (GitLab groups may nest: group/sub/name). */
export function repositoryNameProblem(value: string): string | null {
  const name = value.trim();
  if (name === "") return "Choose a repository.";
  if (
    name.length > 300 ||
    !/^[A-Za-z0-9_.~-]+(?:\/[A-Za-z0-9_.~-]+)+$/.test(name) ||
    name.split("/").some((part) => part === "." || part === "..")
  ) {
    return "Choose a repository from the list, written as owner/name.";
  }
  return null;
}

/** A Compose file path inside the repository: ./docker-compose.yml, deploy/compose.yaml. */
export function composePathProblem(value: string): string | null {
  const path = value.trim().replace(/^\.\//, "");
  if (path === "") return "Enter the Compose file's path, like ./docker-compose.yml.";
  if (
    path.length > 500 ||
    path.startsWith("/") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..") ||
    /[\0\\]/.test(path)
  ) {
    return "Enter a file inside the repository, like ./docker-compose.yml.";
  }
  return null;
}

/** The callback paths on the console that providers send people back to (spec 16.2–16.5). */
export const GIT_CALLBACK_PATHS = {
  githubCreated: "/git-providers/github/created",
  githubInstalled: "/git-providers/github/installed",
  gitlab: "/git-providers/gitlab/callback",
  gitea: "/git-providers/gitea/callback",
} as const;

/**
 * 0.1.x's return addresses on the console (R3-41, R4-15): a GitHub App it created returns to
 * the first after an install, and GitLab and Gitea OAuth applications were registered with the
 * others. 1.0 answers them, and keeps sending moved GitLab and Gitea connections to theirs.
 */
export const LEGACY_GIT_CALLBACK_PATHS = {
  githubSetup: "/api/providers/github/setup",
  gitlab: "/api/providers/gitlab/callback",
  gitea: "/api/providers/gitea/callback",
} as const;

/**
 * Where an old return address leads: the 1.0 page that does the same, with the same query. A
 * GitHub return with a code is the app just created; anything else from GitHub is an install.
 */
export function legacyGitCallbackTarget(pathname: string, search: string): string | null {
  const query = search.startsWith("?") ? search : search ? `?${search}` : "";
  switch (pathname.replace(/\/+$/, "")) {
    case LEGACY_GIT_CALLBACK_PATHS.gitlab:
      return `${GIT_CALLBACK_PATHS.gitlab}${query}`;
    case LEGACY_GIT_CALLBACK_PATHS.gitea:
      return `${GIT_CALLBACK_PATHS.gitea}${query}`;
    case LEGACY_GIT_CALLBACK_PATHS.githubSetup: {
      const params = new URLSearchParams(query);
      const created = params.has("code") && !params.has("installation_id");
      return `${created ? GIT_CALLBACK_PATHS.githubCreated : GIT_CALLBACK_PATHS.githubInstalled}${query}`;
    }
    default:
      return null;
  }
}

/** Where GitHub sends an app's events: the console proxies it to the control plane. */
export function githubWebhookPath(providerId: string): string {
  return `/api/v1/webhooks/github/${providerId}`;
}
