import { createVerify, generateKeyPairSync } from "node:crypto";

/**
 * Pretend GitHub, GitLab, Bitbucket and Gitea APIs for the Git provider tests (spec 16): enough of
 * each host's API for connecting, listing repositories and branches, reading trees and files,
 * installation tokens, OAuth code exchange and webhook registration. It answers as an HttpFetch,
 * so no test reaches a real host. Tokens are checked, so a wrong credential is refused like the
 * real thing.
 */

export interface FakeRepository {
  fullName: string;
  id: number;
  defaultBranch: string;
  private: boolean;
  branches: string[];
  /** path → content */
  files: Record<string, string>;
  pushedAt: string;
}

export interface RegisteredHook {
  host: "gitlab" | "gitea" | "bitbucket";
  repository: string;
  url: string;
  secret: string;
  id: string;
}

export function makeRepository(fullName: string, id: number, extra: Partial<FakeRepository> = {}) {
  return {
    fullName,
    id,
    defaultBranch: "main",
    private: true,
    branches: ["main", "develop"],
    files: {
      Dockerfile: "FROM node:24-alpine\n",
      "package.json": '{"name":"web","scripts":{"start":"node index.js"}}',
      "apps/api/package.json": '{"name":"api"}',
      "apps/api/src/index.ts": "export {}\n",
      "docs/readme.md": "# Docs\n",
      ".env.example": "DATABASE_URL=\n",
    },
    pushedAt: new Date(Date.UTC(2026, 10, 1) + id * 1000).toISOString(),
    ...extra,
  } satisfies FakeRepository;
}

export class FakeGitHosts {
  /** Every call that reached a fake host: method and URL. */
  readonly calls: { method: string; url: string; authorization: string | null }[] = [];
  readonly hooks: RegisteredHook[] = [];
  /** Webhooks removed through the hosts' APIs: host and hook id. */
  readonly removedHooks: { host: RegisteredHook["host"]; id: string }[] = [];

  // ---- GitHub
  readonly github = {
    repositories: [] as FakeRepository[],
    appId: 4242,
    installationId: 777,
    otherInstallationId: 999,
    token: "ghs_installation_token_abc123",
    keys: generateKeyPairSync("rsa", { modulusLength: 2048 }),
    manifestCode: "manifest-code-1",
    conversions: 0,
    ownerLogin: "acme",
  };

  // ---- GitLab and Gitea (one shape each; base URLs differ)
  readonly gitlab = {
    base: "https://gitlab.example.com",
    repositories: [] as FakeRepository[],
    accessToken: "glpat-access-token-1",
    oauthCode: "gitlab-code",
    oauthToken: "gitlab-oauth-token",
    refreshToken: "gitlab-refresh",
    /** Refresh requests seen. */
    refreshes: 0,
    /** The redirect address each token request sent. */
    tokenRedirects: [] as (string | null)[],
    clientId: "gl-app-id",
    clientSecret: "gl-app-secret",
    login: "gitlab-user",
  };

  readonly gitea = {
    base: "https://gitea.example.com",
    repositories: [] as FakeRepository[],
    accessToken: "gitea-access-token-1",
    oauthCode: "gitea-code",
    oauthToken: "gitea-oauth-token",
    clientId: "gitea-client",
    clientSecret: "gitea-secret",
    login: "gitea-user",
    /** Gitea's MAX_RESPONSE_ITEMS: at most this many per page, whatever `limit` asks. */
    maxPage: 50,
    /** Whether list answers carry X-Total-Count, as Gitea's do. */
    totalHeader: true,
  };

  readonly bitbucket = {
    repositories: [] as FakeRepository[],
    email: "dev@example.com",
    username: "bb-user",
    apiToken: "ATATT-bitbucket-token",
    workspaces: ["acme-ws"],
  };

  constructor() {
    this.github.repositories.push(makeRepository("acme/web", 1), makeRepository("acme/api", 2));
    this.gitlab.repositories.push(makeRepository("group/web", 11));
    this.gitea.repositories.push(makeRepository("team/web", 21), makeRepository("team/docs", 22));
    this.bitbucket.repositories.push(makeRepository("acme-ws/web", 31));
  }

  handles(url: string): boolean {
    return (
      url.startsWith("https://api.github.com/") ||
      url.startsWith(this.gitlab.base) ||
      url.startsWith(this.gitea.base) ||
      url.startsWith("https://api.bitbucket.org/")
    );
  }

  readonly fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    this.calls.push({ method, url: url.toString(), authorization: headers.get("authorization") });
    const body = typeof init?.body === "string" ? init.body : "";
    if (url.hostname === "api.github.com") return this.githubApi(method, url, headers);
    if (url.origin === new URL(this.gitlab.base).origin) {
      return this.gitlabApi(method, url, headers, body);
    }
    if (url.origin === new URL(this.gitea.base).origin) {
      return this.giteaApi(method, url, headers, body);
    }
    return this.bitbucketApi(method, url, headers, body);
  };

  // ---------------------------------------------------------------- GitHub

  private verifyJwt(authorization: string | null): boolean {
    const token = authorization?.replace(/^Bearer /, "") ?? "";
    const [header, payload, signature] = token.split(".");
    if (!header || !payload || !signature) return false;
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    if (!verifier.verify(this.github.keys.publicKey, Buffer.from(signature, "base64url"))) {
      return false;
    }
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return claims.iss === this.github.appId;
  }

  private githubRepo(item: FakeRepository) {
    return {
      id: item.id,
      full_name: item.fullName,
      name: item.fullName.split("/")[1],
      owner: { login: item.fullName.split("/")[0] },
      private: item.private,
      default_branch: item.defaultBranch,
      html_url: `https://github.com/${item.fullName}`,
      pushed_at: item.pushedAt,
    };
  }

  private githubApi(method: string, url: URL, headers: Headers): Response {
    const path = url.pathname;
    const conversion = /^\/app-manifests\/([^/]+)\/conversions$/.exec(path);
    if (conversion && method === "POST") {
      if (conversion[1] !== this.github.manifestCode) return Response.json({}, { status: 404 });
      this.github.conversions++;
      return Response.json(
        {
          id: this.github.appId,
          slug: "nearzero-2026-11-25-test",
          name: "Nearzero-2026-11-25-test",
          html_url: "https://github.com/apps/nearzero-2026-11-25-test",
          client_id: "Iv1.client",
          client_secret: "client-secret-value",
          webhook_secret: "github-webhook-secret",
          pem: this.github.keys.privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
          owner: { login: this.github.ownerLogin, type: "Organization", id: 55 },
        },
        { status: 201 },
      );
    }
    const installation = /^\/app\/installations\/(\d+)(\/access_tokens)?$/.exec(path);
    if (installation) {
      if (!this.verifyJwt(headers.get("authorization"))) return Response.json({}, { status: 401 });
      const id = Number(installation[1]);
      if (id !== this.github.installationId) return Response.json({}, { status: 404 });
      if (installation[2]) {
        return Response.json(
          { token: this.github.token, expires_at: new Date(Date.now() + 3600_000).toISOString() },
          { status: 201 },
        );
      }
      return Response.json({
        id,
        app_id: this.github.appId,
        account: { login: this.github.ownerLogin, type: "Organization" },
      });
    }
    if (headers.get("authorization") !== `Bearer ${this.github.token}`) {
      return Response.json({ message: "Bad credentials" }, { status: 401 });
    }
    if (path === "/installation/repositories") {
      const page = Number(url.searchParams.get("page") ?? "1");
      const per = Number(url.searchParams.get("per_page") ?? "30");
      const items = this.github.repositories.slice((page - 1) * per, page * per);
      return Response.json({
        total_count: this.github.repositories.length,
        repositories: items.map((item) => this.githubRepo(item)),
      });
    }
    const repoMatch = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(path);
    if (repoMatch) {
      const repo = this.github.repositories.find((item) => item.fullName === repoMatch[1]);
      if (!repo) return Response.json({ message: "Not Found" }, { status: 404 });
      const rest = repoMatch[2] ?? "";
      if (rest === "") return Response.json(this.githubRepo(repo));
      if (rest === "/branches") {
        const page = Number(url.searchParams.get("page") ?? "1");
        const per = Number(url.searchParams.get("per_page") ?? "30");
        return Response.json(
          repo.branches
            .slice((page - 1) * per, page * per)
            .map((name) => ({ name, commit: { sha: "a".repeat(40) } })),
        );
      }
      const tree = /^\/git\/trees\/(.+)$/.exec(rest);
      if (tree) {
        const ref = decodeURIComponent(tree[1] ?? "");
        if (!repo.branches.includes(ref)) return Response.json({}, { status: 404 });
        return Response.json({
          tree: treeOf(repo).map((entry) => ({
            ...entry,
            type: entry.type === "folder" ? "tree" : "blob",
          })),
          truncated: false,
        });
      }
      const contents = /^\/contents\/(.+)$/.exec(rest);
      if (contents) {
        const file = repo.files[decodeURIComponent(contents[1] ?? "")];
        if (file === undefined) return Response.json({}, { status: 404 });
        return new Response(file);
      }
    }
    return Response.json({ message: "Not Found" }, { status: 404 });
  }

  // ---------------------------------------------------------------- GitLab

  private gitlabApi(method: string, url: URL, headers: Headers, body: string): Response {
    const path = url.pathname;
    const host = this.gitlab;
    if (path === "/oauth/token" && method === "POST") {
      const form = new URLSearchParams(body);
      host.tokenRedirects.push(form.get("redirect_uri"));
      const good =
        form.get("client_id") === host.clientId && form.get("client_secret") === host.clientSecret;
      const code =
        form.get("grant_type") === "authorization_code"
          ? form.get("code") === host.oauthCode
          : true;
      if (!good || !code) return Response.json({ error: "invalid_grant" }, { status: 400 });
      // A refresh token works once, as at GitLab: each refresh hands out the next one.
      if (form.get("grant_type") === "refresh_token") {
        host.refreshes++;
        if (form.get("refresh_token") !== host.refreshToken) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        host.refreshToken = `gitlab-refresh-${host.refreshes}`;
      }
      return Response.json({
        access_token: host.oauthToken,
        refresh_token: host.refreshToken,
        expires_in: 7200,
      });
    }
    const auth = headers.get("authorization");
    if (auth !== `Bearer ${host.accessToken}` && auth !== `Bearer ${host.oauthToken}`) {
      return Response.json({ message: "401 Unauthorized" }, { status: 401 });
    }
    if (path === "/api/v4/user") return Response.json({ username: host.login });
    const project = (item: FakeRepository) => ({
      id: item.id,
      path_with_namespace: item.fullName,
      path: item.fullName.split("/").pop(),
      namespace: { full_path: item.fullName.split("/").slice(0, -1).join("/") },
      visibility: "private",
      default_branch: item.defaultBranch,
      web_url: `${host.base}/${item.fullName}`,
      http_url_to_repo: `${host.base}/${item.fullName}.git`,
      last_activity_at: item.pushedAt,
    });
    if (path === "/api/v4/projects" || /^\/api\/v4\/groups\/[^/]+\/projects$/.test(path)) {
      const search = url.searchParams.get("search") ?? "";
      // A group's projects include its subgroups'; a group no project is in doesn't exist here.
      const group = /^\/api\/v4\/groups\/([^/]+)\/projects$/.exec(path)?.[1];
      const prefix = group ? `${decodeURIComponent(group)}/` : "";
      const inGroup = host.repositories.filter((item) => item.fullName.startsWith(prefix));
      if (group && inGroup.length === 0) {
        return Response.json({ message: "404 Group Not Found" }, { status: 404 });
      }
      return Response.json(inGroup.filter((item) => item.fullName.includes(search)).map(project));
    }
    const one = /^\/api\/v4\/projects\/([^/]+)(\/.*)?$/.exec(path);
    if (one) {
      const key = decodeURIComponent(one[1] ?? "");
      const repo = host.repositories.find(
        (item) => item.fullName === key || String(item.id) === key,
      );
      if (!repo) return Response.json({}, { status: 404 });
      const rest = one[2] ?? "";
      if (rest === "") return Response.json(project(repo));
      if (rest === "/repository/branches") {
        return Response.json(
          repo.branches.map((name) => ({ name, commit: { id: "b".repeat(40) } })),
        );
      }
      if (rest === "/repository/tree") {
        return Response.json(
          treeOf(repo).map((entry) => ({
            path: entry.path,
            type: entry.type === "folder" ? "tree" : "blob",
          })),
        );
      }
      const file = /^\/repository\/files\/(.+)\/raw$/.exec(rest);
      if (file) {
        const content = repo.files[decodeURIComponent(file[1] ?? "")];
        return content === undefined ? Response.json({}, { status: 404 }) : new Response(content);
      }
      if (rest === "/hooks" && method === "POST") {
        const value = JSON.parse(body);
        const id = String(this.hooks.length + 1);
        this.hooks.push({
          host: "gitlab",
          repository: repo.fullName,
          url: value.url,
          secret: value.token,
          id,
        });
        return Response.json({ id: Number(id) }, { status: 201 });
      }
      if (/^\/hooks\/\d+$/.test(rest) && method === "DELETE") {
        this.removedHooks.push({ host: "gitlab", id: rest.slice("/hooks/".length) });
        return new Response(null, { status: 204 });
      }
    }
    return Response.json({}, { status: 404 });
  }

  // ---------------------------------------------------------------- Gitea

  private giteaApi(method: string, url: URL, headers: Headers, body: string): Response {
    const path = url.pathname;
    const host = this.gitea;
    if (path === "/login/oauth/access_token" && method === "POST") {
      const form = new URLSearchParams(body);
      if (
        form.get("client_id") !== host.clientId ||
        form.get("client_secret") !== host.clientSecret ||
        (form.get("grant_type") === "authorization_code" && form.get("code") !== host.oauthCode)
      ) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      return Response.json({ access_token: host.oauthToken, expires_in: 3600, refresh_token: "r" });
    }
    const auth = headers.get("authorization");
    if (auth !== `token ${host.accessToken}` && auth !== `token ${host.oauthToken}`) {
      return Response.json({ message: "unauthorized" }, { status: 401 });
    }
    return giteaRoutes(this, host, method, url, body);
  }

  // ---------------------------------------------------------------- Bitbucket

  private bitbucketApi(method: string, url: URL, headers: Headers, body: string): Response {
    const host = this.bitbucket;
    const expected = `Basic ${Buffer.from(`${host.email}:${host.apiToken}`).toString("base64")}`;
    if (headers.get("authorization") !== expected) return Response.json({}, { status: 401 });
    const path = url.pathname.replace(/^\/2\.0/, "");
    const repoJson = (item: FakeRepository) => ({
      uuid: `{${item.id}}`,
      full_name: item.fullName,
      slug: item.fullName.split("/")[1],
      is_private: item.private,
      workspace: { slug: item.fullName.split("/")[0] },
      mainbranch: { name: item.defaultBranch },
      links: {
        html: { href: `https://bitbucket.org/${item.fullName}` },
        clone: [
          { name: "https", href: `https://${host.username}@bitbucket.org/${item.fullName}.git` },
        ],
      },
      updated_on: item.pushedAt,
    });
    if (path === "/user") return Response.json({ username: host.username });
    if (path === "/user/workspaces") {
      return Response.json({ values: host.workspaces.map((slug) => ({ workspace: { slug } })) });
    }
    const list = /^\/repositories\/([^/]+)$/.exec(path);
    if (list) {
      return Response.json({
        values: host.repositories
          .filter((item) => item.fullName.startsWith(`${list[1]}/`))
          .map(repoJson),
      });
    }
    const one = /^\/repositories\/([^/]+\/[^/]+)(\/.*)?$/.exec(path);
    if (one) {
      const repo = host.repositories.find((item) => item.fullName === one[1]);
      if (!repo) return Response.json({}, { status: 404 });
      const rest = one[2] ?? "";
      if (rest === "") return Response.json(repoJson(repo));
      if (rest === "/refs/branches") {
        return Response.json({
          values: repo.branches.map((name) => ({ name, target: { hash: "c".repeat(40) } })),
        });
      }
      const branch = /^\/refs\/branches\/(.+)$/.exec(rest);
      if (branch) {
        const name = decodeURIComponent(branch[1] ?? "");
        return repo.branches.includes(name)
          ? Response.json({ name, target: { hash: "c".repeat(40) } })
          : Response.json({}, { status: 404 });
      }
      const src = /^\/src\/[0-9a-f]{40}\/(.*)$/.exec(rest);
      if (src) {
        const file = decodeURIComponent(src[1] ?? "");
        if (file === "") {
          return Response.json({
            values: treeOf(repo).map((entry) => ({
              path: entry.path,
              type: entry.type === "folder" ? "commit_directory" : "commit_file",
              size: entry.size,
            })),
          });
        }
        const content = repo.files[file];
        return content === undefined ? Response.json({}, { status: 404 }) : new Response(content);
      }
      if (rest === "/hooks" && method === "POST") {
        const value = JSON.parse(body);
        const id = `{hook-${this.hooks.length + 1}}`;
        this.hooks.push({
          host: "bitbucket",
          repository: repo.fullName,
          url: value.url,
          secret: value.secret,
          id,
        });
        return Response.json({ uuid: id }, { status: 201 });
      }
      if (rest.startsWith("/hooks/") && method === "DELETE") {
        this.removedHooks.push({
          host: "bitbucket",
          id: decodeURIComponent(rest.slice("/hooks/".length)),
        });
        return new Response(null, { status: 204 });
      }
      if (/^\/diffstat\//.test(rest)) {
        return Response.json({ values: [{ old: null, new: { path: "docs/readme.md" } }] });
      }
    }
    return Response.json({}, { status: 404 });
  }
}

/** Files and the folders above them. */
export function treeOf(
  repo: FakeRepository,
): { path: string; type: "file" | "folder"; size: number }[] {
  const folders = new Set<string>();
  for (const path of Object.keys(repo.files)) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index++) folders.add(parts.slice(0, index).join("/"));
  }
  return [
    ...[...folders].map((path) => ({ path, type: "folder" as const, size: 0 })),
    ...Object.entries(repo.files).map(([path, content]) => ({
      path,
      type: "file" as const,
      size: content.length,
    })),
  ];
}

/** Gitea's API, shared by the in-memory fake and the HTTP fake server. */
export function giteaRoutes(
  hosts: FakeGitHosts,
  host: FakeGitHosts["gitea"],
  method: string,
  url: URL,
  body: string,
): Response {
  const path = url.pathname;
  const repoJson = (item: FakeRepository) => ({
    id: item.id,
    full_name: item.fullName,
    name: item.fullName.split("/")[1],
    owner: { login: item.fullName.split("/")[0] },
    private: item.private,
    default_branch: item.defaultBranch,
    html_url: `${host.base}/${item.fullName}`,
    clone_url: `${host.base}/${item.fullName}.git`,
    updated_at: item.pushedAt,
  });
  if (path === "/api/v1/user") return Response.json({ login: host.login });
  if (path === "/api/v1/user/repos" || /^\/api\/v1\/orgs\/[^/]+\/repos$/.test(path)) {
    const page = Number(url.searchParams.get("page") ?? "1");
    const limit = Math.min(Number(url.searchParams.get("limit") ?? "30"), host.maxPage);
    return Response.json(host.repositories.slice((page - 1) * limit, page * limit).map(repoJson), {
      headers: host.totalHeader ? { "x-total-count": String(host.repositories.length) } : {},
    });
  }
  const one = /^\/api\/v1\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(path);
  if (one) {
    const repo = host.repositories.find((item) => item.fullName === one[1]);
    if (!repo) return Response.json({}, { status: 404 });
    const rest = one[2] ?? "";
    if (rest === "") return Response.json(repoJson(repo));
    if (rest === "/branches") {
      return Response.json(repo.branches.map((name) => ({ name, commit: { id: "d".repeat(40) } })));
    }
    const branch = /^\/branches\/(.+)$/.exec(rest);
    if (branch) {
      const name = decodeURIComponent(branch[1] ?? "");
      return repo.branches.includes(name)
        ? Response.json({ name, commit: { id: "d".repeat(40) } })
        : Response.json({}, { status: 404 });
    }
    if (/^\/git\/trees\/[0-9a-f]{40}$/.test(rest)) {
      return Response.json({
        tree: treeOf(repo).map((entry) => ({
          path: entry.path,
          type: entry.type === "folder" ? "tree" : "blob",
          size: entry.size,
        })),
        truncated: false,
      });
    }
    const raw = /^\/raw\/(.+)$/.exec(rest);
    if (raw) {
      const content = repo.files[decodeURIComponent(raw[1] ?? "")];
      return content === undefined ? Response.json({}, { status: 404 }) : new Response(content);
    }
    if (rest === "/hooks" && method === "POST") {
      const value = JSON.parse(body);
      const id = String(hosts.hooks.length + 1);
      hosts.hooks.push({
        host: "gitea",
        repository: repo.fullName,
        url: value.config.url,
        secret: value.config.secret,
        id,
      });
      return Response.json({ id: Number(id) }, { status: 201 });
    }
    if (/^\/hooks\/\d+$/.test(rest) && method === "DELETE") {
      hosts.removedHooks.push({ host: "gitea", id: rest.slice("/hooks/".length) });
      return new Response(null, { status: 204 });
    }
  }
  return Response.json({}, { status: 404 });
}
