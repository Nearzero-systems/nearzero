import type { HttpFetch } from "../services.ts";
import {
  type BranchSummary,
  cleanCloneUrl,
  isCommitHash,
  orderBranches,
  type ProviderClient,
  REPOSITORY_SCOPE_MAX,
  type RepositoryScope,
  type RepositorySummary,
  readPages,
  scopeOf,
  searchScope,
  type TreeEntry,
  withinDepth,
} from "./client.ts";
import { encodePath, joinUrl, ProviderError, providerBytes, providerRequest } from "./http.ts";
import { apiBase } from "./oauth.ts";
import type { OAuthSettings } from "./records.ts";

/**
 * Gitea, gitea.com or self-hosted (spec 16.5), through API v1 with an OAuth token (or an access
 * token): the person's repositories or one organization's, branches, the tree of a commit and raw
 * files, clones with the token as the password, and the repository webhook signed with a secret
 * for push deploys (spec 16.6).
 */

const LABEL = "Gitea";
const PAGE = 50;

/** The clone address always points at the configured host (credentials go only there). */
function repositoryOf(item: Record<string, unknown>, host: string): RepositorySummary {
  const fullName = String(item.full_name ?? "");
  const owner = item.owner as Record<string, unknown> | undefined;
  return {
    id: String(item.id ?? ""),
    fullName,
    name: String(item.name ?? ""),
    owner: String(owner?.login ?? owner?.username ?? fullName.split("/")[0] ?? ""),
    private: item.private === true,
    defaultBranch: typeof item.default_branch === "string" ? item.default_branch : null,
    webUrl: typeof item.html_url === "string" ? item.html_url : null,
    cloneUrl: cleanCloneUrl(String(item.clone_url ?? ""), host),
    updatedAt: typeof item.updated_at === "string" ? item.updated_at : null,
  };
}

export class GiteaClient implements ProviderClient {
  readonly kind = "gitea" as const;
  readonly label = LABEL;

  constructor(
    private readonly http: HttpFetch,
    private readonly settings: OAuthSettings,
    private readonly token: () => Promise<string>,
    private readonly login: string | null,
  ) {}

  private api(path: string): string {
    return joinUrl(apiBase(this.settings), `/api/v1${path}`);
  }

  private async headers(): Promise<Record<string, string>> {
    return { authorization: `token ${await this.token()}` };
  }

  private async get(path: string, allow: number[] = []) {
    return providerRequest(this.http, LABEL, {
      url: this.api(path),
      headers: await this.headers(),
      allow,
    });
  }

  async whoAmI(): Promise<string> {
    const answer = await this.get("/user");
    return String(answer.json?.login ?? answer.json?.username ?? "");
  }

  async listRepositories(search: string, cap: number) {
    return searchScope(await this.allRepositories(REPOSITORY_SCOPE_MAX), search, cap);
  }

  /** One page of the account's (or the organization's) repositories, and Gitea's total. */
  private async repositoryPage(page: number) {
    const path = this.settings.filter
      ? `/orgs/${encodeURIComponent(this.settings.filter)}/repos`
      : "/user/repos";
    const answer = await this.get(`${path}?limit=${PAGE}&page=${page}`, [404]);
    if (answer.status === 404) {
      throw new ProviderError(
        "not_found",
        `Gitea has no organization called ${this.settings.filter} that this account can see. Fix the organization name in Edit.`,
        404,
      );
    }
    const items = (Array.isArray(answer.json) ? answer.json : []) as Record<string, unknown>[];
    const header = answer.headers.get("x-total-count");
    const total = header === null || header.trim() === "" ? Number.NaN : Number(header);
    return {
      items: items.map((item) => repositoryOf(item, apiBase(this.settings))),
      total: Number.isInteger(total) && total >= 0 ? total : null,
    };
  }

  /**
   * Every repository the account (or the organization) has, up to `max` (R3-43): a search looks
   * through all of them, not only the first pages. Gitea sends the total in X-Total-Count, and
   * may hand out fewer per page than asked (its MAX_RESPONSE_ITEMS), so the first page's size is
   * the page size; without a total it pages on until a short page.
   */
  async allRepositories(max: number): Promise<RepositoryScope> {
    const first = await this.repositoryPage(1);
    const size = first.items.length;
    if (size === 0) return scopeOf([], true);
    const pages = Math.ceil(max / size);
    if (first.total !== null && first.total >= size) {
      const last = Math.min(Math.ceil(first.total / size), pages);
      const rest = await readPages(
        2,
        last,
        async (page) => (await this.repositoryPage(page)).items,
      );
      return scopeOf([...first.items, ...rest].slice(0, max), first.total <= max);
    }
    const found = [...first.items];
    let full = true;
    for (let page = 2; full && page <= pages; page++) {
      const next = await this.repositoryPage(page);
      found.push(...next.items);
      full = next.items.length >= size;
    }
    return scopeOf(found.slice(0, max), !full);
  }

  async getRepository(fullName: string): Promise<RepositorySummary> {
    const answer = await this.get(`/repos/${encodePath(fullName)}`, [403, 404]);
    if (answer.status >= 400) {
      throw new ProviderError(
        "not_found",
        "Gitea says this account has no access to this repository. Grant it access on Gitea.",
        answer.status,
      );
    }
    return repositoryOf(answer.json ?? {}, apiBase(this.settings));
  }

  async listBranches(repository: RepositorySummary, cap: number) {
    const branches: BranchSummary[] = [];
    let more = false;
    for (let page = 1; page <= 5; page++) {
      const answer = await this.get(
        `/repos/${encodePath(repository.fullName)}/branches?limit=${PAGE}&page=${page}`,
      );
      const items = (answer.json ?? []) as Record<string, unknown>[];
      for (const item of items) {
        const commit = item.commit as Record<string, unknown> | undefined;
        branches.push({ name: String(item.name ?? ""), commit: String(commit?.id ?? "") || null });
      }
      more = items.length === PAGE;
      if (!more) break;
    }
    const ordered = orderBranches(branches, repository.defaultBranch, cap);
    return { branches: ordered.branches, truncated: ordered.truncated || more };
  }

  /** Gitea's tree endpoint takes a commit; a branch is looked up first. */
  private async commitOf(repository: RepositorySummary, ref: string): Promise<string> {
    if (isCommitHash(ref)) return ref;
    const answer = await this.get(
      `/repos/${encodePath(repository.fullName)}/branches/${encodeURIComponent(ref)}`,
      [404],
    );
    const id = answer.json?.commit?.id;
    if (answer.status === 404 || typeof id !== "string") {
      throw new ProviderError("not_found", `Gitea has no branch called ${ref}.`, 404);
    }
    return id;
  }

  async listTree(repository: RepositorySummary, ref: string, maxDepth: number | null, cap: number) {
    const commit = await this.commitOf(repository, ref);
    const entries: TreeEntry[] = [];
    let truncated = false;
    for (let page = 1; page <= 20; page++) {
      const answer = await this.get(
        `/repos/${encodePath(repository.fullName)}/git/trees/${commit}?recursive=true&per_page=1000&page=${page}`,
      );
      const items = (answer.json?.tree ?? []) as Record<string, unknown>[];
      for (const item of items) {
        if (item.type !== "blob" && item.type !== "tree") continue;
        const entry: TreeEntry = {
          path: String(item.path ?? ""),
          type: item.type === "tree" ? "folder" : "file",
          size: typeof item.size === "number" ? item.size : null,
        };
        if (withinDepth(entry, maxDepth)) entries.push(entry);
      }
      if (entries.length > cap) {
        truncated = true;
        break;
      }
      if (answer.json?.truncated !== true) break;
      if (page === 20) truncated = true;
    }
    return { entries: entries.slice(0, cap), truncated };
  }

  async readFile(repository: RepositorySummary, ref: string, path: string, maxBytes: number) {
    const answer = await providerBytes(
      this.http,
      LABEL,
      {
        url: this.api(
          `/repos/${encodePath(repository.fullName)}/raw/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
        ),
        headers: await this.headers(),
        allow: [404],
      },
      maxBytes,
    );
    return answer.status === 404 ? null : { bytes: answer.bytes, tooLarge: answer.tooLarge };
  }

  async cloneAccess(repository: RepositorySummary) {
    return {
      url: repository.cloneUrl,
      username: this.login || "oauth2",
      password: await this.token(),
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
      url: this.api(`/repos/${encodePath(repository.fullName)}/hooks`),
      headers: await this.headers(),
      json: {
        type: "gitea",
        config: { url, content_type: "json", secret },
        events: ["push"],
        active: true,
      },
    });
    return String(answer.json?.id ?? "");
  }

  async removeWebhook(repository: RepositorySummary, hookId: string): Promise<void> {
    await providerRequest(this.http, LABEL, {
      method: "DELETE",
      url: this.api(
        `/repos/${encodePath(repository.fullName)}/hooks/${encodeURIComponent(hookId)}`,
      ),
      headers: await this.headers(),
      allow: [404],
    });
  }
}
