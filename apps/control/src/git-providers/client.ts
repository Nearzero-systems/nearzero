import type { GitProviderKind } from "@nearzero/shared";

/**
 * What Nearzero asks of every Git host (spec 16, 19.7): who the connection acts as, its
 * repositories (searchable, capped), a repository's branches, a branch's file list and small
 * files read through the API without cloning, short-lived credentials for a clone, and
 * webhooks where the host's API lets the connected token add them.
 */

export interface RepositorySummary {
  /** The host's own id (a number or a UUID), as text. */
  id: string;
  /** owner/name (GitLab groups may nest). */
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  defaultBranch: string | null;
  webUrl: string | null;
  /** The HTTPS address git clones from, without credentials. */
  cloneUrl: string;
  updatedAt: string | null;
}

export interface BranchSummary {
  name: string;
  commit: string | null;
}

export interface TreeEntry {
  path: string;
  type: "file" | "folder";
  size: number | null;
}

export interface CloneAccess {
  /** The clone address, credential-free. */
  url: string;
  username: string;
  /** A secret: a token valid for a short time where the host offers that. */
  password: string;
}

export interface ProviderClient {
  readonly kind: GitProviderKind;
  readonly label: string;
  /** The login the credentials act as (checks the connection). */
  whoAmI(): Promise<string>;
  listRepositories(
    search: string,
    cap: number,
  ): Promise<{ repositories: RepositorySummary[]; truncated: boolean }>;
  /**
   * Every repository the connection can see, at most `max`, for hosts whose APIs can't search
   * what a connection sees (GitHub installations, Gitea accounts and organizations). A search
   * looks through all of them, so the result cap limits what is shown, not what is searched
   * (spec 16.7, R3-43). `complete` is false when the host had more than `max`.
   */
  allRepositories?(max: number): Promise<RepositoryScope>;
  getRepository(fullName: string): Promise<RepositorySummary>;
  listBranches(
    repository: RepositorySummary,
    cap: number,
  ): Promise<{ branches: BranchSummary[]; truncated: boolean }>;
  /** Every file and folder of a ref, at most `maxDepth` folders deep when given. */
  listTree(
    repository: RepositorySummary,
    ref: string,
    maxDepth: number | null,
    cap: number,
  ): Promise<{ entries: TreeEntry[]; truncated: boolean }>;
  /** A file's bytes, or null when it doesn't exist at that ref. */
  readFile(
    repository: RepositorySummary,
    ref: string,
    path: string,
    maxBytes: number,
  ): Promise<{ bytes: Uint8Array; tooLarge: boolean } | null>;
  cloneAccess(repository: RepositorySummary): Promise<CloneAccess>;
  /** Adds a push webhook with a secret; returns the host's id for it. */
  registerWebhook?(
    repository: RepositorySummary,
    url: string,
    secret: string,
    options: { tags: boolean },
  ): Promise<string>;
  removeWebhook?(repository: RepositorySummary, hookId: string): Promise<void>;
  /** Files that differ between two commits, when the push event doesn't list them. */
  changedFiles?(repository: RepositorySummary, from: string, to: string): Promise<string[] | null>;
}

/** How many folders deep a path's file sits ("a/b/c.txt" is 2). */
export function folderDepth(path: string, type: "file" | "folder"): number {
  const parts = path.split("/").filter(Boolean).length;
  return type === "folder" ? parts : parts - 1;
}

/** Keeps entries at most `maxDepth` folders deep. */
export function withinDepth(entry: TreeEntry, maxDepth: number | null): boolean {
  return maxDepth === null || folderDepth(entry.path, entry.type) <= maxDepth;
}

/** Case-insensitive match on owner/name, for hosts whose APIs don't search. */
export function matchesSearch(repository: { fullName: string }, search: string): boolean {
  const term = search.trim().toLowerCase();
  return term === "" || repository.fullName.toLowerCase().includes(term);
}

/** Most recently changed first, then by name. */
export function sortRepositories(list: RepositorySummary[]): RepositorySummary[] {
  return [...list].sort((a, b) => {
    const time = (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
    return time !== 0 ? time : a.fullName.localeCompare(b.fullName);
  });
}

/** What a connection sees, read in full (see ProviderClient.allRepositories). */
export interface RepositoryScope {
  repositories: RepositorySummary[];
  /** False when the host had more than Nearzero reads. */
  complete: boolean;
}

/**
 * How many repositories are read from a host that can't search what a connection sees: enough
 * that any of them can be found (R3-43), with a bound so one connection can't make Nearzero page
 * forever.
 */
export const REPOSITORY_SCOPE_MAX = 10_000;

/** Pages are read this many at a time once the first page says how many there are. */
const PAGES_AT_ONCE = 8;

/**
 * Reads pages `from`..`to` of a list, a few at a time, in page order, so a large list costs a
 * few round trips' time, not one per page.
 */
export async function readPages<T>(
  from: number,
  to: number,
  read: (page: number) => Promise<T[]>,
): Promise<T[]> {
  const out: T[] = [];
  for (let start = from; start <= to; start += PAGES_AT_ONCE) {
    const pages: Promise<T[]>[] = [];
    for (let page = start; page <= Math.min(to, start + PAGES_AT_ONCE - 1); page++) {
      pages.push(read(page));
    }
    for (const items of await Promise.all(pages)) out.push(...items);
  }
  return out;
}

/**
 * One copy of each repository, most recently changed first: a list read page by page can shift
 * while it is read, so a repository can turn up on two pages.
 */
export function scopeOf(found: RepositorySummary[], complete: boolean): RepositoryScope {
  const seen = new Set<string>();
  const unique = found.filter((repository) => {
    const key = repository.id || repository.fullName;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { repositories: sortRepositories(unique), complete };
}

/** A search through a whole scope: every match is found, at most `cap` are returned. */
export function searchScope(
  scope: RepositoryScope,
  search: string,
  cap: number,
): { repositories: RepositorySummary[]; truncated: boolean } {
  const matches = scope.repositories.filter((repository) => matchesSearch(repository, search));
  return {
    repositories: matches.slice(0, cap),
    truncated: matches.length > cap || !scope.complete,
  };
}

/** The default branch first, the rest by name, at most `cap` (spec 19.7 step 3). */
export function orderBranches(
  branches: BranchSummary[],
  defaultBranch: string | null,
  cap: number,
): { branches: BranchSummary[]; truncated: boolean } {
  const seen = new Set<string>();
  const unique = branches.filter((branch) => {
    if (seen.has(branch.name)) return false;
    seen.add(branch.name);
    return true;
  });
  const first = unique.filter((branch) => branch.name === defaultBranch);
  const rest = unique
    .filter((branch) => branch.name !== defaultBranch)
    .sort((a, b) => a.name.localeCompare(b.name));
  const all = [...first, ...rest];
  return { branches: all.slice(0, cap), truncated: all.length > cap };
}

/** A clone address with any user name removed (Bitbucket puts one in), on another origin if asked. */
export function cleanCloneUrl(url: string, internalBase?: string | null): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    if (internalBase) {
      const internal = new URL(internalBase);
      parsed.protocol = internal.protocol;
      parsed.host = internal.host;
      const prefix = internal.pathname.replace(/\/+$/, "");
      if (prefix && !parsed.pathname.startsWith(`${prefix}/`)) {
        parsed.pathname = `${prefix}${parsed.pathname}`;
      }
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

export function isCommitHash(ref: string): boolean {
  return /^[0-9a-f]{40}$/i.test(ref);
}
