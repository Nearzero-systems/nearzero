import { type Server, SQL } from "bun";
import { FakeGitHosts, giteaRoutes } from "../../control/test/support/fake-git-hosts.ts";
import { ApiSession, type Stack } from "./stack.ts";

/**
 * Git providers for the console's browser checks (spec 16): a Gitea-compatible server on a local
 * port that auto-consents to OAuth (so the real redirect flow runs in a browser), and a seed that
 * connects it, adds GitHub and Bitbucket rows the way the control plane stores them (their hosts
 * can't be reached from a test), and gives a project an application and a Compose service with a
 * provider source. Nothing here talks to a real Git host.
 */

export interface FakeGitea {
  base: string;
  hosts: FakeGitHosts;
  stop(): void;
}

export function startFakeGitea(): FakeGitea {
  const hosts = new FakeGitHosts();
  const server: Server<undefined> = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const host = hosts.gitea;
      if (url.pathname === "/login/oauth/authorize") {
        const back = new URL(url.searchParams.get("redirect_uri") ?? "");
        back.searchParams.set("code", host.oauthCode);
        back.searchParams.set("state", url.searchParams.get("state") ?? "");
        return Response.redirect(back.toString(), 302);
      }
      const body = request.method === "GET" ? "" : await request.text();
      if (url.pathname === "/login/oauth/access_token") {
        const form = new URLSearchParams(body);
        if (
          form.get("client_secret") !== host.clientSecret ||
          form.get("code") !== host.oauthCode
        ) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        return Response.json({ access_token: host.oauthToken, expires_in: 3600 });
      }
      const auth = request.headers.get("authorization");
      if (auth !== `token ${host.accessToken}` && auth !== `token ${host.oauthToken}`) {
        return Response.json({ message: "token is required" }, { status: 401 });
      }
      return giteaRoutes(hosts, host, request.method, url, body);
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  hosts.gitea.base = base;
  return { base, hosts, stop: () => server.stop(true) };
}

export interface GitSeeded {
  workspace: string;
  project: string;
  environment: string;
  app: string;
  compose: string;
  giteaProvider: string;
  githubProvider: string;
}

/** Rows for hosts the test can't reach, written as the control plane writes them. */
async function insertProvider(
  stack: Stack,
  row: {
    workspaceId: string;
    ownerId: string;
    kind: "github" | "bitbucket";
    name: string;
    status: "pending" | "ready";
    shared: boolean;
    settings: Record<string, unknown>;
    account: string | null;
  },
): Promise<string> {
  const sql = new SQL(stack.env.DATABASE_URL as string);
  try {
    const [inserted] = await sql`
      insert into git_provider (workspace_id, owner_person_id, kind, name, status, shared, settings, account_login, connected_at)
      values (${row.workspaceId}, ${row.ownerId}, ${row.kind}, ${row.name}, ${row.status}, ${row.shared},
              ${JSON.stringify(row.settings)}::text::jsonb, ${row.account}, ${row.status === "ready" ? new Date() : null})
      returning id`;
    return (inserted as { id: string }).id;
  } finally {
    await sql.close();
  }
}

export async function seedGit(
  stack: Stack,
  owner: ApiSession,
  gitea: FakeGitea,
): Promise<GitSeeded> {
  const me = await owner.call<{ id: string }>("GET", "/me");
  const workspace = await owner.call<{ workspace: { id: string; slug: string } }>(
    "GET",
    "/workspace",
  );
  const connected = await owner.call<{ provider: { id: string } }>("POST", "/git-providers/gitea", {
    name: "Team Gitea",
    url: gitea.base,
    accessToken: gitea.hosts.gitea.accessToken,
  });
  await owner.call("POST", `/git-providers/${connected.provider.id}/share`, { shared: true });
  const githubProvider = await insertProvider(stack, {
    workspaceId: workspace.workspace.id,
    ownerId: me.id,
    kind: "github",
    name: "Nearzero-2026-11-25-k3m9x2",
    status: "pending",
    shared: false,
    settings: {
      appId: 1,
      slug: "nearzero-2026-11-25-k3m9x2",
      htmlUrl: "https://github.com/apps/nearzero-2026-11-25-k3m9x2",
      clientId: "Iv1.0",
      ownerLogin: "acme",
      ownerType: "Organization",
      ownerId: 1,
      organization: "acme",
    },
    account: "acme",
  });
  await insertProvider(stack, {
    workspaceId: workspace.workspace.id,
    ownerId: me.id,
    kind: "bitbucket",
    name: "Legacy Bitbucket",
    status: "ready",
    shared: false,
    settings: { username: "acme-dev", email: "", workspace: "acme", auth: "app_password" },
    account: "acme-dev",
  });
  const project = await owner.call<{ project: { id: string }; environmentId: string }>(
    "POST",
    "/projects",
    { name: "Shop", description: "The storefront" },
  );
  const environment = project.environmentId;
  const app = await owner.call<{ service: { id: string } }>(
    "POST",
    `/environments/${environment}/services`,
    { kind: "application", name: "web", serverId: "host", settings: { servicePort: 3000 } },
  );
  await owner.call("PUT", `/services/${app.service.id}/git-source`, {
    providerId: connected.provider.id,
    repository: "team/web",
    watchPaths: ["src/**"],
  });
  const compose = await owner.call<{ service: { id: string } }>(
    "POST",
    `/environments/${environment}/services`,
    { kind: "compose", name: "stack", serverId: "host", settings: { format: "compose" } },
  );
  await owner.call("PUT", `/services/${compose.service.id}/git-source`, {
    providerId: connected.provider.id,
    repository: "team/docs",
    composePath: "./docker-compose.yml",
  });
  return {
    workspace: workspace.workspace.slug,
    project: project.project.id,
    environment,
    app: app.service.id,
    compose: compose.service.id,
    giteaProvider: connected.provider.id,
    githubProvider,
  };
}

/** A member without "Connect their own Git accounts", signed in (they see the shared list). */
export async function addPlainMember(
  stack: Stack,
  owner: ApiSession,
  email: string,
  password: string,
): Promise<ApiSession> {
  await owner.call("POST", "/workspace/members", {
    email,
    role: "member",
    policyIds: [],
    password,
  });
  const member = await ApiSession.signIn(stack.consoleUrl, email, password);
  await member.call("POST", "/onboarding/name", { name: "Sam Rivera" });
  return member;
}
