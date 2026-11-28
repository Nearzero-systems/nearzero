import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { createHmac } from "node:crypto";
import { sql } from "kysely";
import { ObjectRegistry } from "../src/access/objects.ts";
import { forgetInstallationTokens } from "../src/git-providers/github.ts";
import { registerGitAccountObjects } from "../src/git-providers/records.ts";
import { registerProjectObjects } from "../src/projects/objects.ts";
import { registerServerObjects } from "../src/servers/servers.ts";
import { classifyCall, decideCall, parseImage } from "../src/webhooks/calls.ts";
import { shouldDeployPush, skipKeyword } from "../src/webhooks/push-rules.ts";
import { WEBHOOK_UPLOAD_SOURCE } from "../src/webhooks/tokens.ts";
import { FakeGitHosts } from "./support/fake-git-hosts.ts";
import {
  type Browser,
  createHarness,
  type Harness,
  INSTANCE_RESEND,
  setUpNamedOwner,
} from "./support/harness.ts";
import { makeProject, makeService } from "./support/projects.ts";

/**
 * What the deploy webhook does with each kind of call (spec 6.6, 24 G4; 30b R2-03, R2-10; 30c
 * R3-36, R3-39; 30d R4-12, R4-13; B1-40, B1-42): Git hosts' pings and other events deploy
 * nothing, Bitbucket's push format is read for its branch, skip keywords stop push deploys,
 * image apps redeploy only for their own image and tag, upload apps have no webhook, a provider
 * webhook with a secret can't be called without it, a carried-over unsigned one keeps deploying,
 * and a GitHub delivery that failed can be delivered again.
 */

setDefaultTimeout(240_000);

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const sign = (secret: string, bytes: Uint8Array) =>
  createHmac("sha256", secret).update(bytes).digest("hex");

describe("reading a call (pure)", () => {
  test("image references as Docker reads them", () => {
    expect(parseImage("nginx")).toMatchObject({ repository: "docker.io/library/nginx", tag: null });
    expect(parseImage("nginx:alpine")).toMatchObject({
      repository: "docker.io/library/nginx",
      tag: "alpine",
    });
    expect(parseImage("acme/web:1.2")).toMatchObject({ repository: "docker.io/acme/web" });
    expect(parseImage("index.docker.io/acme/web")).toMatchObject({
      repository: "docker.io/acme/web",
    });
    expect(parseImage("ghcr.io/Acme/Web:dev")).toMatchObject({
      repository: "ghcr.io/acme/web",
      tag: "dev",
    });
    expect(parseImage("registry.example.com:5000/team/app@sha256:abc")).toMatchObject({
      repository: "registry.example.com:5000/team/app",
      tag: null,
      digest: "sha256:abc",
    });
    expect(parseImage("localhost/app:1")).toMatchObject({ repository: "localhost/app", tag: "1" });
  });

  test("skip keywords, in any case, only on branch pushes", () => {
    expect(skipKeyword("Fix the docs [skip ci]")).toBe("[skip ci]");
    for (const word of ["[ci skip]", "[no ci]", "[skip actions]", "[actions skip]", "[SKIP CI]"]) {
      expect(skipKeyword(`Subject\n\nBody ${word}`)).toBe(word);
    }
    expect(skipKeyword("skip ci without brackets")).toBeNull();
    const rules = { trigger: "push" as const, branch: "main", watchPaths: [] };
    expect(
      shouldDeployPush(rules, { ref: "refs/heads/main", message: "Tidy up [ci skip]" }),
    ).toEqual({
      deploy: false,
      reason: "The head commit's message contains [ci skip], so this push doesn't deploy.",
    });
    expect(
      shouldDeployPush(
        { ...rules, trigger: "tag" },
        { ref: "refs/tags/v1", message: "Release [skip ci]" },
      ),
    ).toMatchObject({ deploy: true, tag: "v1" });
  });

  test("Git hosts' pings, other events and Bitbucket pushes", () => {
    const git = {
      type: "git" as const,
      trigger: "push" as const,
      branch: "main",
      watchPaths: [],
      repository: null,
    };
    const headers = (entries: Record<string, string>) => new Headers(entries);
    expect(classifyCall(headers({ "x-github-event": "ping" }), { zen: "hi" })).toEqual({
      kind: "ping",
      host: "GitHub",
    });
    expect(
      decideCall(git, classifyCall(headers({ "x-github-event": "issues" }), { action: "opened" })),
    ).toEqual({
      deploy: false,
      message: "Not deployed: only pushes deploy, and GitHub sent the issues event.",
    });
    expect(classifyCall(headers({ "x-event-key": "diagnostics:ping" }), {})).toMatchObject({
      kind: "ping",
    });
    const bitbucketPush = (branch: string) => ({
      repository: { full_name: "acme/web" },
      push: {
        changes: [
          {
            new: { type: "branch", name: branch, target: { hash: "a".repeat(40), message: "x" } },
            old: { target: { hash: "b".repeat(40) } },
          },
        ],
      },
    });
    // With Bitbucket's header, and without it (a body of the same shape).
    const withAndWithout: Record<string, string>[] = [{ "x-event-key": "repo:push" }, {}];
    for (const head of withAndWithout) {
      expect(decideCall(git, classifyCall(headers(head), bitbucketPush("feature")))).toEqual({
        deploy: false,
        message: "The push was to feature; this app deploys main.",
      });
      expect(decideCall(git, classifyCall(headers(head), bitbucketPush("main")))).toMatchObject({
        deploy: true,
        commit: "a".repeat(40),
      });
    }
    // A plain call deploys the branch's newest commit.
    expect(decideCall(git, classifyCall(headers({}), null))).toEqual({
      deploy: true,
      commit: null,
      tag: null,
      title: null,
    });
  });
});

let h: Harness;
let hosts: FakeGitHosts;
let owner: Browser;

beforeAll(async () => {
  hosts = new FakeGitHosts();
  const objects = new ObjectRegistry();
  registerProjectObjects(objects);
  registerServerObjects(objects);
  registerGitAccountObjects(objects);
  h = await createHarness({
    instanceEmail: INSTANCE_RESEND,
    consoleUrl: "https://nz.example.com",
    extra: { objects },
  });
  const outside = h.services.http;
  h.services.http = (input, init) =>
    hosts.handles(String(input)) ? hosts.fetch(String(input), init) : outside(input, init);
});

afterAll(async () => {
  await h.drop();
});

beforeEach(async () => {
  await h.reset();
  await sql`truncate project, git_provider, git_provider_flow, job, deployment cascade`.execute(
    h.test.db,
  );
  await sql`drop trigger if exists test_deploy_failure on deployment`.execute(h.test.db);
  hosts = new FakeGitHosts();
  forgetInstallationTokens();
  owner = await setUpNamedOwner(h);
});

async function app(settings: Record<string, unknown>, name = "web") {
  const { environments } = await makeProject(owner, `Shop ${name}`);
  const created = await makeService(owner, environments.development as string, {
    kind: "application",
    name,
    settings,
  });
  return created.service.id as string;
}

async function webhookPath(serviceId: string): Promise<string> {
  const created = await owner.post(`/services/${serviceId}/webhook`, {});
  expect(created.status).toBe(200);
  return new URL(created.body.url).pathname.replace("/api/v1", "");
}

async function deploymentsOf(serviceId: string) {
  return h.test.db
    .selectFrom("deployment")
    .select(["id", "status", "trigger", "requested_commit", "title"])
    .where("service_id", "=", serviceId)
    .orderBy("created_at")
    .execute();
}

function call(path: string, body: unknown, headers: Record<string, string> = {}) {
  return h.browser().request("POST", path, body === undefined ? undefined : json(body), {
    "content-type": "application/json",
    ...headers,
  });
}

describe("image apps redeploy from their registry (30b R2-03, 30d R4-12)", () => {
  test("its words are about the registry, not Git pushes (C3-03)", async () => {
    const id = await app({ image: "acme/web:latest", servicePort: 80 });
    const before = h.services.consoleUrl;
    h.services.consoleUrl = () => "http://127.0.0.1:4466";
    try {
      const view = (await owner.get(`/services/${id}/webhook`)).body;
      expect(view.message).toBe(
        "This service has no webhook URL yet. Create one for your registry to call when a new image is pushed.",
      );
      expect(view.warnings).toContain(
        "Docker Hub and GitHub's registry can't reach 127.0.0.1:4466: the console isn't reachable from the internet, so your registry can't call this URL.",
      );
      expect(JSON.stringify(view)).not.toMatch(/when you push\.|pushes can't/);
      // A Git app keeps its own words.
      const git = await app({ servicePort: 3000 }, "api");
      await owner.put(`/services/${git}/source`, {
        type: "git",
        url: "https://github.com/acme/api.git",
        branch: "main",
      });
      const gitView = (await owner.get(`/services/${git}/webhook`)).body;
      expect(gitView.message).toBe(
        "This service has no webhook URL yet. Create one to deploy when you push.",
      );
      expect(gitView.warnings).toContain(
        "GitHub can't reach 127.0.0.1:4466: the console isn't reachable from the internet, so pushes can't call this URL.",
      );
    } finally {
      h.services.consoleUrl = before;
    }
  });

  test("the webhook is shown, and only the app's own image and tag redeploy it", async () => {
    const id = await app({ image: "acme/web:latest", servicePort: 80 });
    const path = await webhookPath(id);
    const view = (await owner.get(`/services/${id}/webhook`)).body;
    expect(view.visible).toBe(true);
    expect(view.url).toContain("/api/v1/webhooks/deploy/nzw1.");
    expect(JSON.stringify(view.warnings)).not.toContain("isn't used");

    const hub = (repo: string, tag: string) => ({
      callback_url: "https://registry.hub.docker.com/u/x/y/hook/1/",
      push_data: { pushed_at: 1_700_000_000, pusher: "acme", tag },
      repository: { repo_name: repo, name: repo.split("/")[1], namespace: repo.split("/")[0] },
    });
    const otherImage = await call(path, hub("acme/api", "latest"));
    expect(otherImage.status).toBe(200);
    expect(otherImage.body).toEqual({
      deployed: false,
      message:
        "Not deployed: Docker Hub pushed acme/api:latest, and this app runs acme/web:latest.",
    });
    const otherTag = await call(path, hub("acme/web", "dev"));
    expect(otherTag.body).toEqual({
      deployed: false,
      message:
        "Not deployed: Docker Hub pushed the tag dev, and this app runs the tag latest (acme/web:latest).",
    });
    expect(await deploymentsOf(id)).toEqual([]);

    const matching = await call(path, hub("acme/web", "latest"));
    expect(matching.status).toBe(202);
    expect(matching.body.deployed).toBe(true);
    const rows = await deploymentsOf(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ trigger: "webhook", title: "Image pushed: acme/web:latest" });
  });

  test("GitHub's package event for the app's image, and a call with no image details", async () => {
    const id = await app({ image: "ghcr.io/acme/web:main", servicePort: 80 });
    const path = await webhookPath(id);
    const event = (tag: string) => ({
      action: "published",
      registry_package: {
        name: "web",
        namespace: "acme",
        ecosystem: "CONTAINER",
        package_type: "CONTAINER",
        owner: { login: "acme" },
        package_version: {
          container_metadata: { tag: { name: tag, digest: "sha256:1" } },
          package_url: `ghcr.io/acme/web:${tag}`,
        },
      },
    });
    const wrong = await call(path, event("pr-7"), { "x-github-event": "registry_package" });
    expect(wrong.body.deployed).toBe(false);
    expect(wrong.body.message).toContain("the tag pr-7");
    expect(wrong.body.message).toContain("the tag main");
    const right = await call(path, event("main"), { "x-github-event": "registry_package" });
    expect(right.status).toBe(202);
    // Adding the webhook at GitHub pings it: nothing deploys.
    const ping = await call(path, { zen: "Keep it simple." }, { "x-github-event": "ping" });
    expect(ping.status).toBe(200);
    expect(ping.body).toEqual({
      deployed: false,
      message: "Ping received: the webhook is active.",
    });
    // An empty call names no image: it redeploys the configured one.
    await h.test.db.updateTable("deployment").set({ status: "failed" }).execute();
    const plain = await h.browser().request("POST", path);
    expect(plain.status).toBe(202);
    expect(await deploymentsOf(id)).toHaveLength(2);
  });

  test("upload apps keep no webhook", async () => {
    const id = await app({ image: "acme/web:latest", servicePort: 80 });
    const path = await webhookPath(id);
    await h.test.db
      .updateTable("service")
      .set({
        settings: JSON.stringify({
          servicePort: 80,
          source: { type: "upload", buildPath: "", upload: null },
        }),
      })
      .where("id", "=", id)
      .execute();
    const create = await owner.post(`/services/${id}/webhook`, {});
    expect(create.status).toBe(409);
    expect(create.body.error.message).toBe(WEBHOOK_UPLOAD_SOURCE);
    const view = (await owner.get(`/services/${id}/webhook`)).body;
    expect(view.warnings).toContain(WEBHOOK_UPLOAD_SOURCE);
    // A URL kept from an earlier source deploys nothing.
    const stale = await h.browser().request("POST", path);
    expect(stale.status).toBe(200);
    expect(stale.body.deployed).toBe(false);
    expect(await deploymentsOf(id)).toEqual([]);
  });
});

describe("Git URL apps: only pushes to the branch deploy (30b R2-10, 30d R4-13, 30c R3-39)", () => {
  async function gitApp() {
    const id = await app({ servicePort: 3000 });
    const saved = await owner.put(`/services/${id}/source`, {
      type: "git",
      url: "https://bitbucket.org/acme/web.git",
      branch: "main",
    });
    expect(saved.status).toBe(200);
    return id;
  }

  test("GitHub's ping and other events deploy nothing; Bitbucket pushes are read for their branch", async () => {
    const id = await gitApp();
    const path = await webhookPath(id);
    const ping = await call(
      path,
      { zen: "Design for failure.", hook_id: 1 },
      {
        "x-github-event": "ping",
      },
    );
    expect(ping.status).toBe(200);
    expect(ping.body).toEqual({
      deployed: false,
      message: "Ping received: the webhook is active.",
    });
    const star = await call(path, { action: "created" }, { "x-github-event": "star" });
    expect(star.body).toEqual({
      deployed: false,
      message: "Not deployed: only pushes deploy, and GitHub sent the star event.",
    });
    const issue = await call(path, { object_kind: "issue" }, { "x-gitlab-event": "Issue Hook" });
    expect(issue.body.deployed).toBe(false);
    const bitbucket = (branch: string, hash: string) => ({
      repository: { full_name: "acme/web", uuid: "{1}" },
      push: {
        changes: [
          {
            new: { type: "branch", name: branch, target: { hash, message: `To ${branch}` } },
            old: { target: { hash: "0123456789abcdef0123456789abcdef01234567" } },
          },
        ],
      },
    });
    const elsewhere = await call(path, bitbucket("feature", "c".repeat(40)), {
      "x-event-key": "repo:push",
      "x-request-uuid": "r1",
    });
    expect(elsewhere.status).toBe(200);
    expect(elsewhere.body).toEqual({
      deployed: false,
      message: "The push was to feature; this app deploys main.",
    });
    expect(await deploymentsOf(id)).toEqual([]);
    const main = await call(path, bitbucket("main", "d".repeat(40)), {
      "x-event-key": "repo:push",
      "x-request-uuid": "r2",
    });
    expect(main.status).toBe(202);
    expect((await deploymentsOf(id))[0]).toMatchObject({
      requested_commit: "d".repeat(40),
      title: "To main",
    });
    // A POST with no body still deploys (CI tools).
    await h.test.db.updateTable("deployment").set({ status: "failed" }).execute();
    const plain = await h.browser().request("POST", path);
    expect(plain.status).toBe(202);
  });

  test("a push whose head commit says [skip ci] doesn't deploy, and the answer says why", async () => {
    const id = await gitApp();
    const path = await webhookPath(id);
    const skipped = await call(
      path,
      {
        ref: "refs/heads/main",
        after: "e".repeat(40),
        head_commit: { message: "Update the README\n\n[skip ci]" },
      },
      { "x-github-event": "push" },
    );
    expect(skipped.status).toBe(200);
    expect(skipped.body).toEqual({
      deployed: false,
      message: "The head commit's message contains [skip ci], so this push doesn't deploy.",
    });
    expect(await deploymentsOf(id)).toEqual([]);
  });
});

describe("webhook calls GitHub can send (31b G2-04, 31d G4-17)", () => {
  /** The report's push: 20 commits listing 20,000 changed files, about 5 MB. */
  function bigPush(extra: Record<string, unknown> = {}) {
    const files = Array.from(
      { length: 1000 },
      (_, i) =>
        `vendor/some-library/packages/module-${i}/src/${"deeply-nested-folder/".repeat(10)}index-with-a-long-name.ts`,
    );
    return {
      ref: "refs/heads/main",
      after: "a".repeat(40),
      before: "1".repeat(40),
      commits: Array.from({ length: 20 }, (_, i) => ({
        id: String(i).padStart(40, "0"),
        message: `Update vendored code, part ${i}`,
        added: [],
        removed: [],
        modified: [...files, `src/changed-${i}.ts`],
      })),
      head_commit: { message: "Update vendored code" },
      ...extra,
    };
  }

  test("a 5 MB push is read, checked for its branch and watch paths, and deploys", async () => {
    const id = await app({ servicePort: 3000 });
    await owner.put(`/services/${id}/source`, {
      type: "git",
      url: "https://github.com/acme/web.git",
      branch: "main",
      watchPaths: ["src/**"],
    });
    const path = await webhookPath(id);
    const body = bigPush();
    expect(json(body).length).toBeGreaterThan(5 * 1024 * 1024);
    const deployed = await call(path, body, { "x-github-event": "push" });
    expect(deployed.status).toBe(202);
    expect(await deploymentsOf(id)).toHaveLength(1);
    // Still checked like any push: another branch doesn't deploy.
    await h.test.db.updateTable("deployment").set({ status: "failed" }).execute();
    const elsewhere = await call(path, bigPush({ ref: "refs/heads/feature" }), {
      "x-github-event": "push",
    });
    expect(elsewhere.status).toBe(200);
    expect(elsewhere.body.deployed).toBe(false);
  });

  test("a GET deploys nothing and says to use POST, whatever the token", async () => {
    const id = await app({ image: "acme/web:latest", servicePort: 80 });
    const path = await webhookPath(id);
    const get = await h.browser().get(path);
    expect(get.status).toBe(405);
    expect(get.body.error.message).toBe("Call this webhook with POST.");
    expect(get.headers.get("allow")).toBe("POST");
    expect((await h.browser().get("/webhooks/deploy/nzw1.not-a-real-token")).status).toBe(405);
    expect(await deploymentsOf(id)).toEqual([]);
  });
});

describe("GitHub App pushes (30c R3-39, B1-40)", () => {
  async function connectGithub() {
    const started = await owner.post("/git-providers/github/manifest", { organization: "acme" });
    const state = new URL(started.body.action).searchParams.get("state") as string;
    const created = await owner.post("/git-providers/github/manifest/complete", {
      code: hosts.github.manifestCode,
      state,
    });
    const installState = new URL(created.body.installUrl).searchParams.get("state");
    const installed = await owner.post("/git-providers/github/installations", {
      installationId: hosts.github.installationId,
      state: installState,
      setupAction: "install",
    });
    expect(installed.status).toBe(200);
    return installed.body.provider.id as string;
  }

  async function linkedApp(providerId: string) {
    const id = await app({ servicePort: 3000 });
    const saved = await owner.put(`/services/${id}/git-source`, {
      providerId,
      repository: "acme/web",
      watchPaths: [],
    });
    expect(saved.status).toBe(200);
    return id;
  }

  function send(providerId: string, payload: unknown, delivery = crypto.randomUUID()) {
    const raw = json(payload);
    return h.browser().request("POST", `/webhooks/github/${providerId}`, raw, {
      "content-type": "application/json",
      "x-github-event": "push",
      "x-github-delivery": delivery,
      "x-hub-signature-256": `sha256=${sign("github-webhook-secret", raw)}`,
    });
  }

  const push = (message: string, commit = "f".repeat(40)) => ({
    ref: "refs/heads/main",
    after: commit,
    before: "1".repeat(40),
    repository: { id: 1, full_name: "acme/web" },
    installation: { id: hosts.github.installationId },
    commits: [{ added: [], modified: ["src/a.ts"], removed: [] }],
    head_commit: { message },
  });

  test("a 5 MB push reaches the GitHub App's webhook and deploys (G2-04)", async () => {
    const providerId = await connectGithub();
    const id = await linkedApp(providerId);
    const big = {
      ...push("Update vendored code"),
      commits: Array.from({ length: 20 }, () => ({
        added: [],
        removed: [],
        modified: Array.from(
          { length: 1000 },
          (_, i) => `vendor/library/module-${i}/${"deeply-nested-folder/".repeat(11)}index.ts`,
        ),
      })),
    };
    expect(json(big).length).toBeGreaterThan(5 * 1024 * 1024);
    const deployed = await send(providerId, big);
    expect(deployed.status).toBe(202);
    expect(await deploymentsOf(id)).toHaveLength(1);
  });

  test("skip keywords stop the push deploy", async () => {
    const providerId = await connectGithub();
    const id = await linkedApp(providerId);
    const skipped = await send(providerId, push("Bump the docs [ci skip]"));
    expect(skipped.status).toBe(200);
    expect(skipped.body.services[0]).toMatchObject({
      deployed: false,
      message: "The head commit's message contains [ci skip], so this push doesn't deploy.",
    });
    expect(await deploymentsOf(id)).toEqual([]);
    const deployed = await send(providerId, push("Ship it"));
    expect(deployed.status).toBe(202);
  });

  test("a delivery that failed is handled again when GitHub redelivers it", async () => {
    const providerId = await connectGithub();
    const id = await linkedApp(providerId);
    // The first try fails inside the database, like a dropped connection.
    await sql`drop sequence if exists test_deploy_failures`.execute(h.test.db);
    await sql.raw("create sequence test_deploy_failures").execute(h.test.db);
    await sql
      .raw(`create or replace function test_deploy_failure() returns trigger as $$
      begin
        if nextval('test_deploy_failures') <= 1 then
          raise exception 'terminating connection due to administrator command';
        end if;
        return new;
      end $$ language plpgsql`)
      .execute(h.test.db);
    await sql
      .raw(`create trigger test_deploy_failure before insert on deployment
      for each row execute function test_deploy_failure()`)
      .execute(h.test.db);
    const delivery = crypto.randomUUID();
    const failed = await send(providerId, push("Add the cart"), delivery);
    expect(failed.status).toBe(500);
    expect(await deploymentsOf(id)).toEqual([]);
    const again = await send(providerId, push("Add the cart"), delivery);
    expect(again.status).toBe(202);
    expect(again.body.duplicate).toBeUndefined();
    expect(await deploymentsOf(id)).toHaveLength(1);
    // Delivered once more after it worked: a duplicate, nothing more deploys.
    const third = await send(providerId, push("Add the cart"), delivery);
    expect(third.body.duplicate).toBe(true);
    expect(await deploymentsOf(id)).toHaveLength(1);
  });
});

describe("GitLab, Bitbucket and Gitea webhooks with a secret (B1-42, 30c R3-36, 24 G4)", () => {
  async function gitlabApp() {
    const gitlab = await owner.post("/git-providers/gitlab", {
      name: "GL",
      url: hosts.gitlab.base,
      accessToken: hosts.gitlab.accessToken,
    });
    expect(gitlab.status).toBe(201);
    const id = await app({ servicePort: 3000 });
    const saved = await owner.put(`/services/${id}/git-source`, {
      providerId: gitlab.body.provider.id,
      repository: "group/web",
      watchPaths: [],
    });
    expect(saved.body.push.status).toBe("registered");
    const hook = hosts.hooks.find((item) => item.host === "gitlab");
    return {
      id,
      secret: hook?.secret as string,
      path: new URL(hook?.url as string).pathname.replace("/api/v1", ""),
    };
  }

  const gitlabPush = (branch: string, sha: string) => ({
    object_kind: "push",
    ref: `refs/heads/${branch}`,
    checkout_sha: sha,
    project: { id: 11, path_with_namespace: "group/web" },
    commits: [
      { id: sha, title: "GitLab push", message: "GitLab push", added: [], modified: ["a"] },
    ],
  });

  test("leaving the host's event header out doesn't skip the secret (the attack in B1-42)", async () => {
    const { id, path, secret } = await gitlabApp();
    const attacker = "a".repeat(40);
    // The URL alone, a body naming the commit to deploy, and no GitLab header or token.
    const forged = await call(path, { ref: "refs/heads/main", after: attacker });
    expect(forged.status).toBe(401);
    const bare = await h.browser().request("POST", path);
    expect(bare.status).toBe(401);
    const wrongToken = await call(path, gitlabPush("main", attacker), {
      "x-gitlab-token": "guess",
    });
    expect(wrongToken.status).toBe(401);
    expect(await deploymentsOf(id)).toEqual([]);
    // The real host's call, with the token, deploys.
    const real = await call(path, gitlabPush("main", "7".repeat(40)), {
      "x-gitlab-event": "Push Hook",
      "x-gitlab-token": secret,
    });
    expect(real.status).toBe(202);
    expect((await deploymentsOf(id))[0]).toMatchObject({ requested_commit: "7".repeat(40) });
  });

  test("a webhook carried over from 0.1.x without a secret keeps deploying pushes to the branch", async () => {
    const { id, path } = await gitlabApp();
    // As after a move: the service's own URL, and no secret registered for it.
    await h.test.db.deleteFrom("git_service_hook").where("service_id", "=", id).execute();
    const headers = { "x-gitlab-event": "Push Hook" };
    const other = await call(path, gitlabPush("develop", "8".repeat(40)), headers);
    expect(other.status).toBe(200);
    expect(other.body.message).toBe("The push was to develop; this app deploys main.");
    const elsewhere = await call(
      path,
      { ...gitlabPush("main", "8".repeat(40)), project: { path_with_namespace: "other/repo" } },
      headers,
    );
    expect(elsewhere.body.deployed).toBe(false);
    const pushed = await call(path, gitlabPush("main", "9".repeat(40)), headers);
    expect(pushed.status).toBe(202);
    expect((await deploymentsOf(id))[0]).toMatchObject({ requested_commit: "9".repeat(40) });
    // The Source panel says pushes arrive unsigned and how to fix it.
    const view = (await owner.get(`/services/${id}/git-source`)).body;
    expect(view.push.status).toBe("none");
    expect(view.push.message).toContain("without a secret");
    // Once the webhook is registered, unsigned calls are refused.
    const registered = await owner.post(`/services/${id}/git-source/webhook`);
    expect(registered.body.push.status).toBe("registered");
    const unsigned = await call(path, gitlabPush("main", "6".repeat(40)), headers);
    expect(unsigned.status).toBe(401);
  });
});
