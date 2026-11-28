import type { HttpFetch } from "../services.ts";
import {
  type BranchSummary,
  isCommitHash,
  matchesSearch,
  orderBranches,
  type ProviderClient,
  type RepositorySummary,
  sortRepositories,
  type TreeEntry,
  withinDepth,
} from "./client.ts";
import { encodePath, ProviderError, providerBytes, providerRequest } from "./http.ts";
import type { BitbucketSecrets, BitbucketSettings } from "./records.ts";

/**
 * Bitbucket Cloud (spec 16.4) with an Atlassian API token (the Atlassian account email and the
 * token for the API; the static user name x-bitbucket-api-token-auth for clones), or, for older
 * connections, a legacy app password (marked "Deprecated"). Repositories of one workspace or of
 * every workspace the account can reach, branches, a commit's files, raw files, and repository
 * webhooks signed with a secret.
 */

export const BITBUCKET_API = "https://api.bitbucket.org/2.0";
const LABEL = "Bitbucket";

function repositoryOf(item: Record<string, unknown>): RepositorySummary {
  const fullName = String(item.full_name ?? "");
  const links = item.links as Record<string, unknown> | undefined;
  const html = links?.html as { href?: string } | undefined;
  const workspace = item.workspace as Record<string, unknown> | undefined;
  const main = item.mainbranch as Record<string, unknown> | undefined;
  return {
    id: String(item.uuid ?? ""),
    fullName,
    name: String(item.slug ?? item.name ?? fullName.split("/").pop() ?? ""),
    owner: String(workspace?.slug ?? fullName.split("/")[0] ?? ""),
    private: item.is_private === true,
    defaultBranch: typeof main?.name === "string" ? main.name : null,
    webUrl: html?.href ?? null,
    // Always bitbucket.org: the credentials go nowhere else.
    cloneUrl: `https://bitbucket.org/${fullName}.git`,
    updatedAt: typeof item.updated_on === "string" ? item.updated_on : null,
  };
}

export class BitbucketClient implements ProviderClient {
  readonly kind = "bitbucket" as const;
  readonly label = LABEL;

  constructor(
    private readonly http: HttpFetch,
    private readonly settings: BitbucketSettings,
    private readonly secrets: BitbucketSecrets,
  ) {}

  private authorization(): string {
    const pair =
      this.settings.auth === "app_password"
        ? `${this.settings.username}:${this.secrets.appPassword ?? ""}`
        : `${this.settings.email}:${this.secrets.apiToken ?? ""}`;
    return `Basic ${Buffer.from(pair, "utf8").toString("base64")}`;
  }

  private get(urlOrPath: string, allow: number[] = []) {
    const url = urlOrPath.startsWith("https://") ? urlOrPath : `${BITBUCKET_API}${urlOrPath}`;
    // Pagination links come from the API itself; never follow one to another host.
    if (!url.startsWith(`${BITBUCKET_API}/`)) {
      throw new ProviderError("failed", "Bitbucket answered with an unexpected address.");
    }
    return providerRequest(this.http, LABEL, {
      url,
      headers: { authorization: this.authorization() },
      allow,
    });
  }

  async whoAmI(): Promise<string> {
    const answer = await this.get("/user", [403]);
    if (answer.status === 403 && this.settings.workspace) {
      // Tokens without the account scope can still read their workspace.
      await this.get(`/repositories/${encodeURIComponent(this.settings.workspace)}?pagelen=1`);
      return this.settings.username;
    }
    if (answer.status === 403) {
      throw new ProviderError(
        "forbidden",
        "Bitbucket says this API token can't read the account. Give it the read:user and read:repository scopes, or enter a workspace name.",
        403,
      );
    }
    return String(answer.json?.username ?? answer.json?.nickname ?? this.settings.username);
  }

  private async workspaces(): Promise<string[]> {
    if (this.settings.workspace) return [this.settings.workspace];
    const slugs: string[] = [];
    let next: string | null = "/user/workspaces?pagelen=100";
    for (let page = 0; next && page < 3; page++) {
      const answer = await this.get(next);
      for (const item of (answer.json?.values ?? []) as Record<string, unknown>[]) {
        const workspace = (item.workspace ?? item) as Record<string, unknown>;
        if (typeof workspace.slug === "string") slugs.push(workspace.slug);
      }
      next = typeof answer.json?.next === "string" ? answer.json.next : null;
    }
    return slugs;
  }

  async listRepositories(search: string, cap: number) {
    const term = search.trim();
    const found: RepositorySummary[] = [];
    let truncated = false;
    for (const workspace of (await this.workspaces()).slice(0, 20)) {
      const query = new URLSearchParams({ role: "member", pagelen: "100", sort: "-updated_on" });
      if (term) query.set("q", `name ~ "${term.replace(/["\\]/g, "")}"`);
      let next: string | null =
        `/repositories/${encodeURIComponent(workspace)}?${query.toString()}`;
      for (let page = 0; next && page < 3; page++) {
        const answer = await this.get(next, [404]);
        if (answer.status === 404) {
          throw new ProviderError(
            "not_found",
            `Bitbucket has no workspace called ${workspace} that this account can see. Fix the workspace name in Edit.`,
            404,
          );
        }
        for (const item of (answer.json?.values ?? []) as Record<string, unknown>[]) {
          const repository = repositoryOf(item);
          if (matchesSearch(repository, term)) found.push(repository);
        }
        next = typeof answer.json?.next === "string" ? answer.json.next : null;
        if (next && page === 2) truncated = true;
      }
      if (found.length > cap) break;
    }
    const sorted = sortRepositories(found);
    return { repositories: sorted.slice(0, cap), truncated: truncated || sorted.length > cap };
  }

  async getRepository(fullName: string): Promise<RepositorySummary> {
    const answer = await this.get(`/repositories/${encodePath(fullName)}`, [403, 404]);
    if (answer.status >= 400) {
      throw new ProviderError(
        "not_found",
        "Bitbucket says this account has no access to this repository. Grant it access on Bitbucket.",
        answer.status,
      );
    }
    return repositoryOf(answer.json ?? {});
  }

  async listBranches(repository: RepositorySummary, cap: number) {
    const branches: BranchSummary[] = [];
    let next: string | null =
      `/repositories/${encodePath(repository.fullName)}/refs/branches?pagelen=100`;
    for (let page = 0; next && page < 3; page++) {
      const answer = await this.get(next);
      for (const item of (answer.json?.values ?? []) as Record<string, unknown>[]) {
        const target = item.target as Record<string, unknown> | undefined;
        branches.push({
          name: String(item.name ?? ""),
          commit: String(target?.hash ?? "") || null,
        });
      }
      next = typeof answer.json?.next === "string" ? answer.json.next : null;
    }
    const ordered = orderBranches(branches, repository.defaultBranch, cap);
    return { branches: ordered.branches, truncated: ordered.truncated || next !== null };
  }

  private async commitOf(repository: RepositorySummary, ref: string): Promise<string> {
    if (isCommitHash(ref)) return ref;
    const answer = await this.get(
      `/repositories/${encodePath(repository.fullName)}/refs/branches/${encodeURIComponent(ref)}`,
      [404],
    );
    const hash = answer.json?.target?.hash;
    if (answer.status === 404 || typeof hash !== "string") {
      throw new ProviderError("not_found", `Bitbucket has no branch called ${ref}.`, 404);
    }
    return hash;
  }

  async listTree(repository: RepositorySummary, ref: string, maxDepth: number | null, cap: number) {
    const commit = await this.commitOf(repository, ref);
    const entries: TreeEntry[] = [];
    let truncated = false;
    const depth = maxDepth === null ? 20 : maxDepth + 1;
    let next: string | null =
      `/repositories/${encodePath(repository.fullName)}/src/${commit}/?max_depth=${depth}&pagelen=100`;
    for (let page = 0; next && page < 100; page++) {
      const answer = await this.get(next);
      for (const item of (answer.json?.values ?? []) as Record<string, unknown>[]) {
        const entry: TreeEntry = {
          path: String(item.path ?? ""),
          type: item.type === "commit_directory" ? "folder" : "file",
          size: typeof item.size === "number" ? item.size : null,
        };
        if (withinDepth(entry, maxDepth)) entries.push(entry);
      }
      next = typeof answer.json?.next === "string" ? answer.json.next : null;
      if (entries.length > cap) {
        truncated = true;
        break;
      }
    }
    if (next) truncated = true;
    return { entries: entries.slice(0, cap), truncated };
  }

  async readFile(repository: RepositorySummary, ref: string, path: string, maxBytes: number) {
    const commit = await this.commitOf(repository, ref);
    const answer = await providerBytes(
      this.http,
      LABEL,
      {
        url: `${BITBUCKET_API}/repositories/${encodePath(repository.fullName)}/src/${commit}/${encodePath(path)}`,
        headers: { authorization: this.authorization() },
        allow: [404],
      },
      maxBytes,
    );
    return answer.status === 404 ? null : { bytes: answer.bytes, tooLarge: answer.tooLarge };
  }

  async cloneAccess(repository: RepositorySummary) {
    return this.settings.auth === "app_password"
      ? {
          url: repository.cloneUrl,
          username: this.settings.username,
          password: this.secrets.appPassword ?? "",
        }
      : {
          url: repository.cloneUrl,
          username: "x-bitbucket-api-token-auth",
          password: this.secrets.apiToken ?? "",
        };
  }

  async registerWebhook(
    repository: RepositorySummary,
    url: string,
    secret: string,
    _options: { tags: boolean },
  ): Promise<string> {
    const answer = await providerRequest(this.http, LABEL, {
      method: "POST",
      url: `${BITBUCKET_API}/repositories/${encodePath(repository.fullName)}/hooks`,
      headers: { authorization: this.authorization() },
      json: { description: "Nearzero deploys", url, active: true, secret, events: ["repo:push"] },
    });
    return String(answer.json?.uuid ?? "");
  }

  async removeWebhook(repository: RepositorySummary, hookId: string): Promise<void> {
    await providerRequest(this.http, LABEL, {
      method: "DELETE",
      url: `${BITBUCKET_API}/repositories/${encodePath(repository.fullName)}/hooks/${encodeURIComponent(hookId)}`,
      headers: { authorization: this.authorization() },
      allow: [404],
    });
  }

  /** Bitbucket's push events don't list files; the diffstat between the two commits does. */
  async changedFiles(repository: RepositorySummary, from: string, to: string) {
    const files: string[] = [];
    let next: string | null =
      `/repositories/${encodePath(repository.fullName)}/diffstat/${to}..${from}?pagelen=500`;
    for (let page = 0; next && page < 5; page++) {
      const answer = await this.get(next, [404]);
      if (answer.status === 404) return null;
      for (const item of (answer.json?.values ?? []) as Record<string, unknown>[]) {
        for (const side of ["old", "new"] as const) {
          const path = (item[side] as Record<string, unknown> | null)?.path;
          if (typeof path === "string") files.push(path);
        }
      }
      next = typeof answer.json?.next === "string" ? answer.json.next : null;
    }
    return next ? null : [...new Set(files)];
  }
}
