import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { Server } from "bun";
import { ObjectRegistry } from "../src/access/objects.ts";
import { registerGitAccountObjects } from "../src/git-providers/records.ts";
import { registerProjectObjects } from "../src/projects/objects.ts";
import { registerServerObjects } from "../src/servers/servers.ts";
import { FakeGitHosts, giteaRoutes } from "./support/fake-git-hosts.ts";
import { type Browser, createHarness, type Harness, setUpNamedOwner } from "./support/harness.ts";
import { makeProject, makeService } from "./support/projects.ts";

/**
 * Gitea end to end over real HTTP (spec 16.5, 16.6, 19.7): a Gitea-compatible server on a local
 * port, reached by the control plane with its real outbound fetch. It covers connecting with an
 * access token (no OAuth) and through OAuth's redirect, listing repositories, reading the file
 * list and small files without cloning, registering the push webhook, and a push the "Gitea"
 * signs with that webhook's secret turning into a deploy request.
 */

setDefaultTimeout(60_000);

let server: Server<undefined>;
let hosts: FakeGitHosts;
let h: Harness;
let owner: Browser;
let base: string;

beforeAll(async () => {
  hosts = new FakeGitHosts();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const host = hosts.gitea;
      if (url.pathname === "/login/oauth/authorize") {
        // Auto-consent: straight back to the console with a code and the state.
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
  base = `http://127.0.0.1:${server.port}`;
  hosts.gitea.base = base;
  const objects = new ObjectRegistry();
  registerProjectObjects(objects);
  registerServerObjects(objects);
  registerGitAccountObjects(objects);
  h = await createHarness({
    extra: { objects, http: (input, init) => fetch(input, init) },
  });
  owner = await setUpNamedOwner(h);
});

afterAll(async () => {
  server.stop(true);
  await h.drop();
});

describe("a Gitea server over HTTP", () => {
  let providerId = "";

  test("connects with an access token, no OAuth", async () => {
    const reply = await owner.post("/git-providers/gitea", {
      name: "Local Gitea",
      url: base,
      accessToken: hosts.gitea.accessToken,
      organization: "",
    });
    expect(reply.status).toBe(201);
    expect(reply.body.provider).toMatchObject({
      status: "ready",
      account: "gitea-user",
      kind: "gitea",
    });
    expect(reply.body.authorizeUrl).toBeNull();
    providerId = reply.body.provider.id;
  });

  test("connects through OAuth: save and connect, the host's redirect, the code exchange", async () => {
    const created = await owner.post("/git-providers/gitea", {
      name: "Gitea OAuth",
      url: base,
      clientId: hosts.gitea.clientId,
      clientSecret: hosts.gitea.clientSecret,
      returnTo: "/acme/dashboard/agent",
    });
    expect(created.status).toBe(201);
    const redirect = await fetch(created.body.authorizeUrl, { redirect: "manual" });
    expect(redirect.status).toBe(302);
    const back = new URL(redirect.headers.get("location") ?? "");
    expect(back.pathname).toBe("/git-providers/gitea/callback");
    const done = await owner.post("/git-providers/oauth/complete", {
      kind: "gitea",
      code: back.searchParams.get("code"),
      state: back.searchParams.get("state"),
    });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({
      returnTo: "/acme/dashboard/agent",
      message: "Gitea connected",
    });
    expect(done.body.provider.status).toBe("ready");
  });

  test("lists repositories and reads files without cloning", async () => {
    const repos = await owner.get(`/git-providers/${providerId}/repositories?search=web`);
    expect(repos.status).toBe(200);
    expect(repos.body.repositories.map((item: { fullName: string }) => item.fullName)).toEqual([
      "team/web",
    ]);
    expect(repos.body.repositories[0].cloneUrl).toBe(`${base}/team/web.git`);
    const files = await owner.get(
      `/git-providers/${providerId}/files?repository=team/web&ref=main`,
    );
    expect(files.body.files.map((item: { path: string }) => item.path)).toContain(
      "apps/api/package.json",
    );
    const file = await owner.get(
      `/git-providers/${providerId}/file?repository=team/web&path=Dockerfile`,
    );
    expect(file.body.content).toBe("FROM node:24-alpine\n");
    const inspected = await owner.get(`/git-providers/${providerId}/inspect?repository=team/web`);
    expect(inspected.body.manifests.length).toBeGreaterThan(2);
  });

  test("a signed push from Gitea becomes a deploy request at that commit", async () => {
    const { environments } = await makeProject(owner, "Shop");
    const created = await makeService(owner, environments.development as string, {
      kind: "application",
      name: "web",
    });
    const serviceId = created.service.id as string;
    const saved = await owner.put(`/services/${serviceId}/git-source`, {
      providerId,
      repository: "team/web",
      watchPaths: ["src/**"],
    });
    expect(saved.status).toBe(200);
    expect(saved.body.push.status).toBe("registered");
    const hook = hosts.hooks.at(-1);
    expect(hook?.url).toContain("/api/v1/webhooks/deploy/nzw1.");
    const payload = (files: string[], commit: string) =>
      new TextEncoder().encode(
        JSON.stringify({
          ref: "refs/heads/main",
          before: `${"0".repeat(39)}1`,
          after: commit,
          repository: { id: 21, full_name: "team/web" },
          commits: [{ added: [], modified: files, removed: [] }],
          head_commit: { message: "Update from Gitea" },
        }),
      );
    const deliver = (raw: Uint8Array) =>
      h
        .browser()
        .request("POST", new URL(hook?.url as string).pathname.replace("/api/v1", ""), raw, {
          "content-type": "application/json",
          "x-gitea-event": "push",
          "x-gitea-signature": createHmac("sha256", hook?.secret as string)
            .update(raw)
            .digest("hex"),
        });
    const docs = await deliver(payload(["docs/readme.md"], "a".repeat(40)));
    expect(docs.status).toBe(200);
    expect(docs.body.deployed).toBe(false);
    const code = await deliver(payload(["src/index.ts"], "b".repeat(40)));
    expect(code.status).toBe(202);
    const rows = await h.test.db
      .selectFrom("deployment")
      .select(["trigger", "requested_commit", "title", "status"])
      .where("service_id", "=", serviceId)
      .execute();
    expect(rows).toEqual([
      {
        trigger: "push",
        requested_commit: "b".repeat(40),
        title: "Update from Gitea",
        status: "queued",
      },
    ]);
  });
});
