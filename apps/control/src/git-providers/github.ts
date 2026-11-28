import { createSign } from "node:crypto";
import type { HttpFetch } from "../services.ts";
import {
  type BranchSummary,
  type CloneAccess,
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
import { encodePath, ProviderError, providerBytes, providerRequest } from "./http.ts";
import type { GithubSecrets, GithubSettings } from "./records.ts";

/**
 * GitHub through the person's own GitHub App (spec 16.2): the manifest conversion that creates
 * the app, the app's JWT, installation tokens (an hour each) for every API call and clone, and
 * the reads the console and the Agent use. Pushes arrive on the app's webhook (push.ts).
 */

export const GITHUB_API = "https://api.github.com";
export const GITHUB_WEB = "https://github.com";
const LABEL = "GitHub";
export const NO_REPOSITORY_ACCESS =
  "GitHub says the app has no access to this repository. Grant access on GitHub.";

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/** The app's own credential: a JWT signed with its private key, valid for nine minutes. */
export function appJwt(appId: number, privateKey: string, nowSeconds: number): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 9 * 60, iss: appId }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${base64url(signer.sign(privateKey))}`;
}

export interface ManifestConversion {
  id: number;
  slug: string;
  name: string;
  htmlUrl: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  pem: string;
  owner: { login: string; type: "User" | "Organization"; id: number | null };
}

/** Exchanges the code GitHub sent back after creating the app for its credentials. */
export async function convertManifest(http: HttpFetch, code: string): Promise<ManifestConversion> {
  const answer = await providerRequest(http, LABEL, {
    method: "POST",
    url: `${GITHUB_API}/app-manifests/${encodeURIComponent(code)}/conversions`,
    headers: { accept: "application/vnd.github+json" },
    allow: [404, 422],
  });
  const app = answer.json;
  if (answer.status !== 201 && answer.status !== 200) {
    throw new ProviderError(
      "failed",
      "GitHub didn't accept the code it sent back. It works only once and for an hour; start connecting GitHub again.",
      answer.status,
    );
  }
  if (!app || typeof app.id !== "number" || typeof app.pem !== "string") {
    throw new ProviderError("failed", "GitHub's answer didn't include the new app's credentials.");
  }
  return {
    id: app.id,
    slug: String(app.slug ?? ""),
    name: String(app.name ?? ""),
    htmlUrl: String(app.html_url ?? `${GITHUB_WEB}/apps/${app.slug}`),
    clientId: String(app.client_id ?? ""),
    clientSecret: String(app.client_secret ?? ""),
    webhookSecret: String(app.webhook_secret ?? ""),
    pem: app.pem,
    owner: {
      login: String(app.owner?.login ?? ""),
      type: app.owner?.type === "Organization" ? "Organization" : "User",
      id: typeof app.owner?.id === "number" ? app.owner.id : null,
    },
  };
}

/**
 * Whether the app owns an installation (spec 16.2: a late install binds only after GitHub
 * confirms it). Asking with the app's JWT answers 404 for anyone else's installation.
 */
export async function installationOfApp(
  http: HttpFetch,
  settings: Pick<GithubSettings, "appId">,
  secrets: Pick<GithubSecrets, "privateKey">,
  installationId: number,
  nowSeconds: number,
): Promise<{ account: string; accountType: string } | null> {
  const answer = await providerRequest(http, LABEL, {
    url: `${GITHUB_API}/app/installations/${installationId}`,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${appJwt(settings.appId, secrets.privateKey, nowSeconds)}`,
    },
    allow: [404],
  });
  if (answer.status === 404) return null;
  const body = answer.json;
  if (!body || Number(body.app_id) !== settings.appId) return null;
  return {
    account: String(body.account?.login ?? ""),
    accountType: String(body.account?.type ?? "User"),
  };
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

/** Installation tokens, reused until five minutes before they expire. */
const tokens = new Map<string, CachedToken>();

export function forgetInstallationTokens(): void {
  tokens.clear();
}

function repositoryOf(item: Record<string, unknown>): RepositorySummary {
  const owner = (item.owner as Record<string, unknown> | undefined)?.login;
  const fullName = String(item.full_name ?? "");
  return {
    id: String(item.id ?? ""),
    fullName,
    name: String(item.name ?? fullName.split("/").pop() ?? ""),
    owner: String(owner ?? fullName.split("/")[0] ?? ""),
    private: item.private === true,
    defaultBranch: typeof item.default_branch === "string" ? item.default_branch : null,
    webUrl: typeof item.html_url === "string" ? item.html_url : null,
    cloneUrl: `${GITHUB_WEB}/${fullName}.git`,
    updatedAt:
      typeof item.pushed_at === "string"
        ? item.pushed_at
        : typeof item.updated_at === "string"
          ? item.updated_at
          : null,
  };
}

export class GithubClient implements ProviderClient {
  readonly kind = "github" as const;
  readonly label = LABEL;

  constructor(
    private readonly http: HttpFetch,
    private readonly settings: GithubSettings,
    private readonly secrets: GithubSecrets,
    private readonly installationId: number,
    private readonly now: () => number,
  ) {}

  async token(): Promise<string> {
    const key = `${this.settings.appId}:${this.installationId}`;
    const cached = tokens.get(key);
    if (cached && cached.expiresAt - 5 * 60_000 > this.now()) return cached.token;
    const answer = await providerRequest(this.http, LABEL, {
      method: "POST",
      url: `${GITHUB_API}/app/installations/${this.installationId}/access_tokens`,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${appJwt(this.settings.appId, this.secrets.privateKey, Math.floor(this.now() / 1000))}`,
      },
      allow: [401, 403, 404],
    });
    if (answer.status === 404 || answer.status === 403) {
      throw new ProviderError(
        "credentials",
        "GitHub says the app isn't installed any more. Install it again in Settings → Git providers.",
        answer.status,
      );
    }
    if (answer.status === 401) {
      throw new ProviderError(
        "credentials",
        "GitHub refused the app's key. Delete this provider and connect GitHub again.",
        401,
      );
    }
    const token = String(answer.json?.token ?? "");
    const expiresAt = Date.parse(String(answer.json?.expires_at ?? "")) || this.now() + 50 * 60_000;
    if (!token) throw new ProviderError("failed", "GitHub didn't give the app a token.");
    tokens.set(key, { token, expiresAt });
    return token;
  }

  private async get(path: string, allow: number[] = []) {
    return providerRequest(this.http, LABEL, {
      url: `${GITHUB_API}${path}`,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${await this.token()}`,
        "x-github-api-version": "2022-11-28",
      },
      allow,
    });
  }

  async whoAmI(): Promise<string> {
    const answer = await this.get("/installation/repositories?per_page=1");
    const first = answer.json?.repositories?.[0]?.owner?.login;
    return typeof first === "string" ? first : this.settings.ownerLogin;
  }

  async listRepositories(search: string, cap: number) {
    return searchScope(await this.allRepositories(REPOSITORY_SCOPE_MAX), search, cap);
  }

  /** One page of what the installation sees (GitHub lists at most 100 a page). */
  private async repositoryPage(page: number) {
    const answer = await this.get(`/installation/repositories?per_page=100&page=${page}`);
    const items = (answer.json?.repositories ?? []) as Record<string, unknown>[];
    const total = Number(answer.json?.total_count);
    return { items: items.map(repositoryOf), total: Number.isFinite(total) ? total : null };
  }

  /**
   * Every repository the installation sees, up to `max` (R3-43): an installation can't be
   * searched, so a search looks through all of them, not only the first pages. The first page
   * gives the total, and the rest are read a few at a time.
   */
  async allRepositories(max: number): Promise<RepositoryScope> {
    const first = await this.repositoryPage(1);
    const pages = Math.ceil(max / 100);
    if (first.total !== null && first.total >= first.items.length) {
      const last = Math.min(Math.ceil(first.total / 100), pages);
      const rest = await readPages(
        2,
        last,
        async (page) => (await this.repositoryPage(page)).items,
      );
      return scopeOf([...first.items, ...rest].slice(0, max), first.total <= max);
    }
    // No usable total: page on until a short page.
    const found = [...first.items];
    let full = first.items.length === 100;
    for (let page = 2; full && page <= pages; page++) {
      const next = await this.repositoryPage(page);
      found.push(...next.items);
      full = next.items.length === 100;
    }
    return scopeOf(found.slice(0, max), !full);
  }

  async getRepository(fullName: string): Promise<RepositorySummary> {
    const answer = await this.get(`/repos/${encodePath(fullName)}`, [403, 404]);
    if (answer.status === 404 || answer.status === 403) {
      throw new ProviderError("not_found", NO_REPOSITORY_ACCESS, answer.status);
    }
    return repositoryOf(answer.json ?? {});
  }

  async listBranches(repository: RepositorySummary, cap: number) {
    const branches: BranchSummary[] = [];
    let more = false;
    for (let page = 1; page <= 3; page++) {
      const answer = await this.get(
        `/repos/${encodePath(repository.fullName)}/branches?per_page=100&page=${page}`,
        [404],
      );
      if (answer.status === 404) throw new ProviderError("not_found", NO_REPOSITORY_ACCESS, 404);
      const items = (answer.json ?? []) as Record<string, unknown>[];
      for (const item of items) {
        branches.push({
          name: String(item.name ?? ""),
          commit: String((item.commit as Record<string, unknown> | undefined)?.sha ?? "") || null,
        });
      }
      more = items.length === 100;
      if (!more) break;
    }
    const ordered = orderBranches(branches, repository.defaultBranch, cap);
    return { branches: ordered.branches, truncated: ordered.truncated || more };
  }

  async listTree(repository: RepositorySummary, ref: string, maxDepth: number | null, cap: number) {
    const answer = await this.get(
      `/repos/${encodePath(repository.fullName)}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
      [404, 409],
    );
    if (answer.status === 409) return { entries: [], truncated: false };
    if (answer.status === 404) {
      throw new ProviderError("not_found", `GitHub has no branch or commit called ${ref}.`, 404);
    }
    const entries: TreeEntry[] = [];
    for (const item of (answer.json?.tree ?? []) as Record<string, unknown>[]) {
      if (item.type !== "blob" && item.type !== "tree") continue;
      const entry: TreeEntry = {
        path: String(item.path ?? ""),
        type: item.type === "tree" ? "folder" : "file",
        size: typeof item.size === "number" ? item.size : null,
      };
      if (withinDepth(entry, maxDepth)) entries.push(entry);
    }
    return {
      entries: entries.slice(0, cap),
      truncated: entries.length > cap || answer.json?.truncated === true,
    };
  }

  async readFile(repository: RepositorySummary, ref: string, path: string, maxBytes: number) {
    const answer = await providerBytes(
      this.http,
      LABEL,
      {
        url: `${GITHUB_API}/repos/${encodePath(repository.fullName)}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
        headers: {
          accept: "application/vnd.github.raw",
          authorization: `Bearer ${await this.token()}`,
        },
        allow: [404],
      },
      maxBytes,
    );
    return answer.status === 404 ? null : { bytes: answer.bytes, tooLarge: answer.tooLarge };
  }

  async cloneAccess(repository: RepositorySummary): Promise<CloneAccess> {
    return { url: repository.cloneUrl, username: "x-access-token", password: await this.token() };
  }
}

/** The manifest that creates the person's private app (spec 16.2). */
export function githubManifest(input: {
  name: string;
  consoleBase: string;
  webhookUrl: string;
  createdUrl: string;
  installedUrl: string;
}): Record<string, unknown> {
  return {
    name: input.name,
    url: input.consoleBase,
    description: "Deploys this account's repositories with Nearzero.",
    public: false,
    hook_attributes: { url: input.webhookUrl, active: true },
    redirect_url: input.createdUrl,
    setup_url: input.installedUrl,
    setup_on_update: true,
    request_oauth_on_install: false,
    default_permissions: {
      contents: "read",
      metadata: "read",
      emails: "read",
      pull_requests: "write",
    },
    default_events: ["push", "pull_request"],
  };
}

/** Where the browser posts the manifest: the person's account, or an organization. */
export function manifestActionUrl(organization: string, state: string): string {
  const base = organization
    ? `${GITHUB_WEB}/organizations/${encodeURIComponent(organization)}/settings/apps/new`
    : `${GITHUB_WEB}/settings/apps/new`;
  return `${base}?state=${encodeURIComponent(state)}`;
}

/**
 * The install page (spec 16.2): aimed at the account or organization that owns the app when its
 * id is known, so GitHub skips "choose an account" and one Install click is left (R3-42).
 */
export function installUrl(slug: string, state: string, ownerId: number | null = null): string {
  const app = `${GITHUB_WEB}/apps/${encodeURIComponent(slug)}/installations/new`;
  const query = `state=${encodeURIComponent(state)}`;
  return ownerId === null
    ? `${app}?${query}`
    : `${app}/permissions?target_id=${encodeURIComponent(String(ownerId))}&${query}`;
}
