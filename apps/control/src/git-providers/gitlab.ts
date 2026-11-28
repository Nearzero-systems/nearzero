import type { HttpFetch } from "../services.ts";
import {
  type BranchSummary,
  cleanCloneUrl,
  matchesSearch,
  orderBranches,
  type ProviderClient,
  type RepositorySummary,
  sortRepositories,
  type TreeEntry,
  withinDepth,
} from "./client.ts";
import { joinUrl, ProviderError, providerBytes, providerRequest } from "./http.ts";
import { apiBase } from "./oauth.ts";
import type { OAuthSettings } from "./records.ts";

/**
 * GitLab, gitlab.com or self-hosted (spec 16.3), through API v4 with an OAuth token (or an
 * access token): projects the person is a member of, or one group's projects including
 * subgroups; branches; the repository tree and raw files; clones as oauth2:<token>; and the
 * project webhook carrying a secret token for push deploys (spec 16.6).
 */

const LABEL = "GitLab";

/** The clone address always points at the configured host (credentials go only there). */
function repositoryOf(item: Record<string, unknown>, host: string): RepositorySummary {
  const fullName = String(item.path_with_namespace ?? "");
  const namespace = item.namespace as Record<string, unknown> | undefined;
  return {
    id: String(item.id ?? ""),
    fullName,
    name: String(item.path ?? item.name ?? ""),
    owner: String(namespace?.full_path ?? fullName.split("/").slice(0, -1).join("/")),
    private: item.visibility !== "public",
    defaultBranch: typeof item.default_branch === "string" ? item.default_branch : null,
    webUrl: typeof item.web_url === "string" ? item.web_url : null,
    cloneUrl: cleanCloneUrl(String(item.http_url_to_repo ?? ""), host),
    updatedAt: typeof item.last_activity_at === "string" ? item.last_activity_at : null,
  };
}

export class GitlabClient implements ProviderClient {
  readonly kind = "gitlab" as const;
  readonly label = LABEL;

  constructor(
    private readonly http: HttpFetch,
    private readonly settings: OAuthSettings,
    private readonly token: () => Promise<string>,
  ) {}

  private api(path: string): string {
    return joinUrl(apiBase(this.settings), `/api/v4${path}`);
  }

  private async get(path: string, allow: number[] = []) {
    return providerRequest(this.http, LABEL, {
      url: this.api(path),
      headers: { authorization: `Bearer ${await this.token()}` },
      allow,
    });
  }

  async whoAmI(): Promise<string> {
    const answer = await this.get("/user");
    return String(answer.json?.username ?? "");
  }

  async listRepositories(search: string, cap: number) {
    const term = search.trim();
    const query = new URLSearchParams({
      per_page: "100",
      order_by: "last_activity_at",
      simple: "true",
    });
    if (term) query.set("search", term);
    // "Group name" may list several groups, comma-separated, as in 0.1.x (R3-40): each one's
    // projects with its subgroups. None means the projects the account is a member of.
    const groups = gitlabGroups(this.settings.filter);
    if (groups.length > 0) query.set("include_subgroups", "true");
    else query.set("membership", "true");
    const found = new Map<string, RepositorySummary>();
    let truncated = false;
    for (const group of groups.length > 0 ? groups : [null]) {
      const path = group ? `/groups/${encodeURIComponent(group)}/projects` : "/projects";
      for (let page = 1; page <= 3; page++) {
        query.set("page", String(page));
        const answer = await this.get(`${path}?${query.toString()}`, [404]);
        if (answer.status === 404) {
          throw new ProviderError(
            "not_found",
            `GitLab has no group called ${group} that this account can see. Fix the group name in Edit.`,
            404,
          );
        }
        const items = (answer.json ?? []) as Record<string, unknown>[];
        for (const item of items) {
          const repository = repositoryOf(item, apiBase(this.settings));
          if (matchesSearch(repository, term)) found.set(String(repository.id), repository);
        }
        const next = answer.headers.get("x-next-page");
        if (!next || items.length < 100) break;
        if (page === 3) truncated = true;
      }
    }
    const sorted = sortRepositories([...found.values()]);
    return { repositories: sorted.slice(0, cap), truncated: truncated || sorted.length > cap };
  }

  async getRepository(fullName: string): Promise<RepositorySummary> {
    const answer = await this.get(`/projects/${encodeURIComponent(fullName)}`, [403, 404]);
    if (answer.status >= 400) {
      throw new ProviderError(
        "not_found",
        "GitLab says this account has no access to this project. Grant it access on GitLab.",
        answer.status,
      );
    }
    return repositoryOf(answer.json ?? {}, apiBase(this.settings));
  }

  async listBranches(repository: RepositorySummary, cap: number) {
    const branches: BranchSummary[] = [];
    let more = false;
    for (let page = 1; page <= 3; page++) {
      const answer = await this.get(
        `/projects/${repository.id}/repository/branches?per_page=100&page=${page}`,
      );
      const items = (answer.json ?? []) as Record<string, unknown>[];
      for (const item of items) {
        const commit = item.commit as Record<string, unknown> | undefined;
        branches.push({ name: String(item.name ?? ""), commit: String(commit?.id ?? "") || null });
      }
      more = Boolean(answer.headers.get("x-next-page")) && items.length === 100;
      if (!more) break;
    }
    const ordered = orderBranches(branches, repository.defaultBranch, cap);
    return { branches: ordered.branches, truncated: ordered.truncated || more };
  }

  async listTree(repository: RepositorySummary, ref: string, maxDepth: number | null, cap: number) {
    const entries: TreeEntry[] = [];
    let truncated = false;
    for (let page = 1; page <= 100; page++) {
      const answer = await this.get(
        `/projects/${repository.id}/repository/tree?ref=${encodeURIComponent(ref)}&recursive=true&per_page=100&page=${page}`,
        [404],
      );
      if (answer.status === 404) {
        throw new ProviderError("not_found", `GitLab has no branch or commit called ${ref}.`, 404);
      }
      const items = (answer.json ?? []) as Record<string, unknown>[];
      for (const item of items) {
        const entry: TreeEntry = {
          path: String(item.path ?? ""),
          type: item.type === "tree" ? "folder" : "file",
          size: null,
        };
        if (item.type !== "blob" && item.type !== "tree") continue;
        if (withinDepth(entry, maxDepth)) entries.push(entry);
      }
      if (entries.length > cap) {
        truncated = true;
        break;
      }
      if (!answer.headers.get("x-next-page") || items.length < 100) break;
      if (page === 100) truncated = true;
    }
    return { entries: entries.slice(0, cap), truncated };
  }

  async readFile(repository: RepositorySummary, ref: string, path: string, maxBytes: number) {
    const answer = await providerBytes(
      this.http,
      LABEL,
      {
        url: this.api(
          `/projects/${repository.id}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`,
        ),
        headers: { authorization: `Bearer ${await this.token()}` },
        allow: [404],
      },
      maxBytes,
    );
    return answer.status === 404 ? null : { bytes: answer.bytes, tooLarge: answer.tooLarge };
  }

  async cloneAccess(repository: RepositorySummary) {
    return { url: repository.cloneUrl, username: "oauth2", password: await this.token() };
  }

  async registerWebhook(
    repository: RepositorySummary,
    url: string,
    secret: string,
    options: { tags: boolean },
  ): Promise<string> {
    const answer = await providerRequest(this.http, LABEL, {
      method: "POST",
      url: this.api(`/projects/${repository.id}/hooks`),
      headers: { authorization: `Bearer ${await this.token()}` },
      json: {
        url,
        token: secret,
        push_events: true,
        tag_push_events: options.tags,
        enable_ssl_verification: url.startsWith("https://"),
      },
    });
    return String(answer.json?.id ?? "");
  }

  async removeWebhook(repository: RepositorySummary, hookId: string): Promise<void> {
    await providerRequest(this.http, LABEL, {
      method: "DELETE",
      url: this.api(`/projects/${repository.id}/hooks/${encodeURIComponent(hookId)}`),
      headers: { authorization: `Bearer ${await this.token()}` },
      allow: [404],
    });
  }
}

/** The groups of a GitLab provider's "Group name": comma-separated, blanks dropped (R3-40). */
export function gitlabGroups(filter: string | null | undefined): string[] {
  return [
    ...new Set(
      (filter ?? "")
        .split(",")
        .map((group) => group.trim())
        .filter(Boolean),
    ),
  ];
}
