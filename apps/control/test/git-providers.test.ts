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
import { githubOrganizationProblem, isConsoleReturnPath } from "@nearzero/shared";
import { sql } from "kysely";
import { ObjectRegistry } from "../src/access/objects.ts";
import { orderBranches } from "../src/git-providers/client.ts";
import { parsePushes } from "../src/git-providers/events.ts";
import {
  FLOW_EXPIRED,
  FLOW_OTHER_PERSON,
  FLOW_OTHER_WORKSPACE,
  FLOW_UNKNOWN,
  FLOW_USED,
  flowProblem,
} from "../src/git-providers/flows.ts";
import { forgetInstallationTokens } from "../src/git-providers/github.ts";
import { appFolders, pickManifests } from "../src/git-providers/reads.ts";
import {
  openProviderSecrets,
  registerGitAccountObjects,
  sealProviderSecrets,
} from "../src/git-providers/records.ts";
import {
  pushOrigin,
  verifyBitbucketSignature,
  verifyGiteaSignature,
  verifyGithubSignature,
  verifyGitlabToken,
} from "../src/git-providers/signatures.ts";
import { providerCloneAccess } from "../src/git-providers/sources.ts";
import { registerProjectObjects } from "../src/projects/objects.ts";
import { registerServerObjects } from "../src/servers/servers.ts";
import { runnerTeardown } from "../src/service-runtime/teardown.ts";
import { FakeGitHosts, type FakeRepository, makeRepository } from "./support/fake-git-hosts.ts";
import {
  type Browser,
  createHarness,
  type Harness,
  INSTANCE_RESEND,
  personIdOf,
  setUpNamedOwner,
} from "./support/harness.ts";
import { addMember, makeProject, makeService } from "./support/projects.ts";

/**
 * Git providers (spec 16, 6.3, 6.6, 7.1, 22.3, 23.4, 24 G4, G7): the signature checks, connect
 * states bound to the person, who sees and shares which provider, repository and branch caps,
 * the GitHub App's manifest and install, the four hosts' connect flows against fake APIs, service
 * sources, push deploys and the deploy engine's clone credentials.
 */

setDefaultTimeout(60_000);

const body = new TextEncoder().encode('{"ref":"refs/heads/main"}');
const sign = (secret: string, bytes: Uint8Array) =>
  createHmac("sha256", secret).update(bytes).digest("hex");

describe("signature checks on the raw body (spec 6.6, G4, G7)", () => {
  test("GitHub: valid, wrong secret, body altered, header missing", () => {
    const header = `sha256=${sign("s3cret", body)}`;
    expect(verifyGithubSignature("s3cret", body, header)).toBe(true);
    expect(verifyGithubSignature("other", body, header)).toBe(false);
    const altered = new TextEncoder().encode('{"ref":"refs/heads/evil"}');
    expect(verifyGithubSignature("s3cret", altered, header)).toBe(false);
    expect(verifyGithubSignature("s3cret", body, null)).toBe(false);
    expect(verifyGithubSignature("s3cret", body, sign("s3cret", body))).toBe(false);
    expect(verifyGithubSignature("", body, `sha256=${sign("", body)}`)).toBe(false);
  });

  test("Gitea: X-Gitea-Signature hex, or the GitHub-style header", () => {
    const hex = sign("gitea-secret", body);
    expect(
      verifyGiteaSignature("gitea-secret", body, new Headers({ "x-gitea-signature": hex })),
    ).toBe(true);
    expect(verifyGiteaSignature("wrong", body, new Headers({ "x-gitea-signature": hex }))).toBe(
      false,
    );
    expect(
      verifyGiteaSignature(
        "gitea-secret",
        new TextEncoder().encode("{}"),
        new Headers({ "x-gitea-signature": hex }),
      ),
    ).toBe(false);
    expect(
      verifyGiteaSignature(
        "gitea-secret",
        body,
        new Headers({ "x-hub-signature-256": `sha256=${hex}` }),
      ),
    ).toBe(true);
    expect(verifyGiteaSignature("gitea-secret", body, new Headers())).toBe(false);
  });

  test("Bitbucket: X-Hub-Signature sha256", () => {
    const header = `sha256=${sign("bb", body)}`;
    expect(verifyBitbucketSignature("bb", body, header)).toBe(true);
    expect(verifyBitbucketSignature("bb2", body, header)).toBe(false);
    expect(verifyBitbucketSignature("bb", new Uint8Array([1, 2]), header)).toBe(false);
  });

  test("GitLab: the secret token header", () => {
    expect(verifyGitlabToken("tok", "tok")).toBe(true);
    expect(verifyGitlabToken("tok", "tok2")).toBe(false);
    expect(verifyGitlabToken("tok", null)).toBe(false);
    expect(verifyGitlabToken("", "")).toBe(false);
  });

  test("the host is told apart by its event headers; Gitea's GitHub header doesn't fool it", () => {
    expect(pushOrigin(new Headers({ "x-gitea-event": "push", "x-github-event": "push" }))).toBe(
      "gitea",
    );
    expect(pushOrigin(new Headers({ "x-gitlab-event": "Push Hook" }))).toBe("gitlab");
    expect(pushOrigin(new Headers({ "x-event-key": "repo:push", "x-hook-uuid": "u" }))).toBe(
      "bitbucket",
    );
    expect(pushOrigin(new Headers({ "x-github-event": "push" }))).toBe("github");
    expect(pushOrigin(new Headers())).toBeNull();
  });
});

describe("connect states (spec 16.1, 16.2)", () => {
  const flow = {
    personId: "p1",
    workspaceId: "w1",
    purpose: "oauth" as const,
    expiresAt: new Date(10_000),
    usedAt: null,
  };
  const who = { personId: "p1", workspaceId: "w1", purpose: "oauth" as const, now: 5_000 };

  test("bound to the person, the workspace and the purpose, once, until it expires", () => {
    expect(flowProblem(flow, who)).toBeNull();
    expect(flowProblem(flow, { ...who, personId: "p2" })).toBe(FLOW_OTHER_PERSON);
    expect(flowProblem(flow, { ...who, now: 10_000 })).toBe(FLOW_EXPIRED);
    expect(flowProblem({ ...flow, usedAt: new Date(1) }, who)).toBe(FLOW_USED);
    expect(flowProblem(flow, { ...who, purpose: "github-install" })).toBe(FLOW_UNKNOWN);
    expect(flowProblem(flow, { ...who, workspaceId: "w2" })).toBe(FLOW_OTHER_WORKSPACE);
    expect(flowProblem(null, who)).toBe(FLOW_UNKNOWN);
  });

  test("return addresses stay on the console", () => {
    expect(isConsoleReturnPath("/acme/dashboard/agent")).toBe(true);
    expect(isConsoleReturnPath("//evil.example.com")).toBe(false);
    expect(isConsoleReturnPath("https://evil.example.com")).toBe(false);
    expect(isConsoleReturnPath("/a\\b")).toBe(false);
  });

  test("GitHub organization names follow GitHub's rules", () => {
    expect(githubOrganizationProblem("")).toBeNull();
    expect(githubOrganizationProblem("acme-inc")).toBeNull();
    expect(githubOrganizationProblem("-acme")).not.toBeNull();
    expect(githubOrganizationProblem("acme--inc")).not.toBeNull();
    expect(githubOrganizationProblem("a".repeat(40))).not.toBeNull();
    expect(githubOrganizationProblem("a".repeat(39))).toBeNull();
  });
});

describe("lists and inspection, without a host", () => {
  test("branches: the default first, then by name, capped", () => {
    const names = Array.from({ length: 250 }, (_, index) => ({
      name: `b${String(index).padStart(3, "0")}`,
      commit: null,
    }));
    names.push({ name: "trunk", commit: null });
    const ordered = orderBranches(names, "trunk", 200);
    expect(ordered.branches).toHaveLength(200);
    expect(ordered.branches[0]?.name).toBe("trunk");
    expect(ordered.branches[1]?.name).toBe("b000");
    expect(ordered.truncated).toBe(true);
  });

  test("manifests are read shallow first, at most twelve; app folders put Dockerfiles first", () => {
    const files = [
      "apps/web/package.json",
      "package.json",
      "Dockerfile",
      "node_modules/x/package.json",
      "services/api/Dockerfile",
      ".env.example",
      ...Array.from({ length: 20 }, (_, index) => `pkg${index}/package.json`),
    ].map((path) => ({ path, type: "file" as const, size: 10 }));
    const picked = pickManifests(files, 12);
    expect(picked).toHaveLength(12);
    expect(picked.slice(0, 3)).toEqual(["Dockerfile", "package.json", ".env.example"]);
    expect(picked).not.toContain("node_modules/x/package.json");
    const folders = appFolders(files);
    expect(folders[0]).toEqual({ path: "", dockerfile: true });
    expect(folders[1]).toEqual({ path: "services/api", dockerfile: true });
    expect(folders.map((folder) => folder.path)).not.toContain("node_modules/x");
  });

  test("push events of every host read into one shape", () => {
    const gitlab = parsePushes(
      "gitlab",
      {
        object_kind: "push",
        ref: "refs/heads/main",
        before: "1".repeat(40),
        checkout_sha: "2".repeat(40),
        commits: [
          {
            id: "2".repeat(40),
            title: "Fix the header",
            added: [],
            modified: ["src/a.ts"],
            removed: [],
          },
        ],
        project: { id: 11, path_with_namespace: "group/web" },
      },
      new Headers({ "x-gitlab-event": "Push Hook" }),
    );
    expect(gitlab.pushes[0]).toMatchObject({
      ref: "refs/heads/main",
      commit: "2".repeat(40),
      subject: "Fix the header",
      files: { modified: ["src/a.ts"] },
    });
    const bitbucket = parsePushes(
      "bitbucket",
      {
        repository: { full_name: "acme-ws/web", uuid: "{31}" },
        push: {
          changes: [
            {
              new: {
                type: "branch",
                name: "main",
                target: { hash: "3".repeat(40), message: "Ship it\nbody" },
              },
              old: { target: { hash: "4".repeat(40) } },
            },
            {
              new: null,
              old: { type: "tag", name: "v1", target: { hash: "5".repeat(40) } },
              closed: true,
            },
          ],
        },
      },
      new Headers({ "x-event-key": "repo:push" }),
    );
    expect(bitbucket.pushes).toHaveLength(2);
    expect(bitbucket.pushes[0]).toMatchObject({
      ref: "refs/heads/main",
      subject: "Ship it",
      before: "4".repeat(40),
    });
    expect(bitbucket.pushes[1]).toMatchObject({ ref: "refs/tags/v1", deleted: true });
  });
});

// ------------------------------------------------------------------ Against the API

let h: Harness;
let hosts: FakeGitHosts;
let owner: Browser;

async function harnessWith(consoleUrl: string) {
  const objects = new ObjectRegistry();
  registerProjectObjects(objects);
  registerServerObjects(objects);
  registerGitAccountObjects(objects);
  const harness = await createHarness({
    instanceEmail: INSTANCE_RESEND,
    consoleUrl,
    extra: { objects },
  });
  const outside = harness.services.http;
  harness.services.http = (input, init) =>
    hosts.handles(String(input)) ? hosts.fetch(String(input), init) : outside(input, init);
  return harness;
}

beforeAll(async () => {
  hosts = new FakeGitHosts();
  h = await harnessWith("https://nz.example.com");
});

afterAll(async () => {
  await h.drop();
});

beforeEach(async () => {
  await h.reset();
  await sql`truncate project, git_provider, git_provider_flow, job cascade`.execute(h.test.db);
  hosts = new FakeGitHosts();
  forgetInstallationTokens();
  owner = await setUpNamedOwner(h);
});

async function connectBitbucket(browser: Browser, name = "Acme Bitbucket") {
  const reply = await browser.post("/git-providers/bitbucket", {
    name,
    username: hosts.bitbucket.username,
    email: hosts.bitbucket.email,
    apiToken: hosts.bitbucket.apiToken,
  });
  expect(reply.status).toBe(201);
  return reply.body.provider as { id: string; status: string };
}

async function connectGiteaToken(browser: Browser, name = "Team Gitea") {
  const reply = await browser.post("/git-providers/gitea", {
    name,
    url: hosts.gitea.base,
    accessToken: hosts.gitea.accessToken,
  });
  expect(reply.status).toBe(201);
  return reply.body.provider as { id: string; status: string };
}

/** The whole GitHub App flow: manifest, conversion, install. */
async function connectGithub(browser: Browser) {
  const started = await browser.post("/git-providers/github/manifest", { organization: "acme" });
  expect(started.status).toBe(200);
  const state = new URL(started.body.action).searchParams.get("state") as string;
  const created = await browser.post("/git-providers/github/manifest/complete", {
    code: hosts.github.manifestCode,
    state,
  });
  expect(created.status).toBe(201);
  const installState = new URL(created.body.installUrl).searchParams.get("state");
  const installed = await browser.post("/git-providers/github/installations", {
    installationId: hosts.github.installationId,
    state: installState,
    setupAction: "install",
  });
  expect(installed.status).toBe(200);
  return installed.body.provider as { id: string; status: string };
}

describe("visibility and sharing (spec 16.1, 22.3)", () => {
  test("members see their own, the shared ones and granted ones; owners and admins see all", async () => {
    const bitbucket = await connectBitbucket(owner);
    const connector = await addMember(h, owner, "connector@example.com", {
      capabilities: ["git.connect-own"],
    });
    const plain = await addMember(h, owner, "plain@example.com");
    const gitea = await connectGiteaToken(connector);

    const asPlain = await plain.get("/git-providers");
    expect(asPlain.status).toBe(200);
    expect(asPlain.body.providers).toEqual([]);
    expect(asPlain.body.can.connect).toBe(false);
    expect(asPlain.body.noConnectMessage).toContain("Connect their own Git accounts");
    expect(
      (
        await plain.post("/git-providers/bitbucket", {
          name: "x",
          username: "u",
          email: "e@example.com",
          apiToken: "t",
        })
      ).status,
    ).toBe(403);

    const asConnector = await connector.get("/git-providers");
    expect(asConnector.body.providers.map((item: { id: string }) => item.id)).toEqual([gitea.id]);
    expect(asConnector.body.can.connect).toBe(true);
    const asOwner = await owner.get("/git-providers");
    expect(asOwner.body.providers.map((item: { id: string }) => item.id).sort()).toEqual(
      [bitbucket.id, gitea.id].sort(),
    );
    // Not yours: the owner sees the member's provider, but can't share it.
    const theirs = asOwner.body.providers.find((item: { id: string }) => item.id === gitea.id);
    expect(theirs.mine).toBe(false);
    expect(theirs.can.share).toBe(false);
    expect((await owner.post(`/git-providers/${gitea.id}/share`, { shared: true })).status).toBe(
      403,
    );
    // Hidden ones are "not found", like ones that don't exist.
    expect((await plain.get(`/git-providers/${bitbucket.id}`)).status).toBe(404);
    expect((await plain.get(`/git-providers/${bitbucket.id}/repositories`)).status).toBe(404);

    const shared = await owner.post(`/git-providers/${bitbucket.id}/share`, { shared: true });
    expect(shared.body.message).toBe("Provider shared with workspace");
    const nowPlain = await plain.get("/git-providers");
    expect(nowPlain.body.providers).toHaveLength(1);
    expect(nowPlain.body.providers[0]).toMatchObject({
      id: bitbucket.id,
      mine: false,
      shared: true,
    });
    expect(nowPlain.body.providers[0].can).toMatchObject({
      share: false,
      edit: false,
      delete: false,
    });
    // Using a shared account works; changing it doesn't.
    expect((await plain.get(`/git-providers/${bitbucket.id}/repositories`)).status).toBe(200);
    expect((await plain.delete(`/git-providers/${bitbucket.id}`)).status).toBe(403);
    expect(
      (await plain.post(`/git-providers/${bitbucket.id}/share`, { shared: false })).status,
    ).toBe(403);
    const unshared = await owner.post(`/git-providers/${bitbucket.id}/share`, { shared: false });
    expect(unshared.body.message).toBe("Provider unshared");
    expect((await plain.get("/git-providers")).body.providers).toEqual([]);

    // A direct grant (policy scope) reaches an unshared provider.
    const personId = await personIdOf(h, "plain@example.com");
    const granted = await owner.put(`/workspace/members/${personId}/access`, {
      policyIds: [],
      capabilities: [],
      scope: {
        allProjects: false,
        projectIds: [],
        environmentIds: [],
        serviceIds: [],
        allServers: false,
        serverIds: [],
        allGitAccounts: false,
        gitAccountIds: [gitea.id],
      },
    });
    expect(granted.status).toBe(200);
    expect(
      (await plain.get("/git-providers")).body.providers.map((item: { id: string }) => item.id),
    ).toEqual([gitea.id]);
  });

  test("another workspace's provider is not found, and secrets never come back", async () => {
    const bitbucket = await connectBitbucket(owner);
    const list = await owner.get("/git-providers");
    const text = JSON.stringify(list.body);
    expect(text).not.toContain(hosts.bitbucket.apiToken);
    expect(list.body.providers[0].configured).toEqual({ apiToken: true, appPassword: false });
    // The second workspace belongs to the same instance administrator; switch into it.
    const other = await owner.post("/workspaces", { name: "Side" });
    expect(other.status).toBe(201);
    await owner.post(`/workspaces/${other.body.workspace.id}/switch`);
    expect((await owner.get(`/git-providers/${bitbucket.id}`)).status).toBe(404);
    expect((await owner.get("/git-providers")).body.providers).toEqual([]);
  });
});

describe("saved secrets stay with their host (B1-10, spec 16.7, 23.4)", () => {
  test("an owner can't send a member's saved token to another address; Test is audited; a name-only edit keeps the address", async () => {
    const connector = await addMember(h, owner, "connector@example.com", {
      capabilities: ["git.connect-own"],
    });
    const gitea = await connectGiteaToken(connector);
    const evil = "https://evil.example.net";
    // The review's attack: Test with the member's saved token (blank) at another host.
    const tested = await owner.post(`/git-providers/${gitea.id}/test`, {
      name: "Team Gitea",
      url: evil,
      accessToken: "",
    });
    expect(tested.status).toBe(400);
    expect(tested.body.error.fields.accessToken).toBe(
      "Paste the access token again: Nearzero sends a saved token only to the address it was saved for, and this one changed.",
    );
    const saved = await owner.patch(`/git-providers/${gitea.id}`, {
      name: "Team Gitea",
      url: evil,
      accessToken: "",
    });
    expect(saved.status).toBe(400);
    expect(hosts.calls.some((call) => call.url.startsWith(evil))).toBe(false);
    // A PATCH with only a name keeps the saved address (it used to become the default host).
    const renamed = await owner.patch(`/git-providers/${gitea.id}`, { name: "Renamed" });
    expect(renamed.status).toBe(200);
    const row = await h.test.db
      .selectFrom("git_provider")
      .select(["name", "settings"])
      .where("id", "=", gitea.id)
      .executeTakeFirstOrThrow();
    expect(row.name).toBe("Renamed");
    expect((row.settings as { url: string }).url).toBe(hosts.gitea.base);
    // Testing the saved values works, and is recorded with who did it.
    expect((await owner.post(`/git-providers/${gitea.id}/test`)).status).toBe(200);
    const audits = await h.test.db
      .selectFrom("audit_event")
      .select(["action", "target_id"])
      .where("action", "=", "git-provider.tested")
      .execute();
    expect(audits).toEqual([{ action: "git-provider.tested", target_id: gitea.id }]);
  });
});

describe("repository reads (spec 16.7, 19.7)", () => {
  test("repositories capped at 200 with search; branches with the default first", async () => {
    hosts.github.repositories.length = 0;
    for (let index = 0; index < 450; index++) {
      hosts.github.repositories.push({
        fullName: `acme/repo-${index}`,
        id: 1000 + index,
        defaultBranch: "main",
        private: true,
        branches: ["main"],
        files: {},
        pushedAt: new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
      });
    }
    const web = hosts.github.repositories[7] as FakeRepository;
    web.branches = [
      "main",
      ...Array.from({ length: 249 }, (_, index) => `feature/${index}`),
      "aaa",
    ];
    const github = await connectGithub(owner);
    const all = await owner.get(`/git-providers/${github.id}/repositories`);
    expect(all.status).toBe(200);
    expect(all.body.repositories).toHaveLength(200);
    expect(all.body.truncated).toBe(true);
    expect(all.body.cap).toBe(200);
    expect(all.body.repositories[0].fullName).toBe("acme/repo-449");
    const search = await owner.get(`/git-providers/${github.id}/repositories?search=repo-44`);
    expect(search.body.repositories.map((item: { fullName: string }) => item.fullName)).toContain(
      "acme/repo-44",
    );
    expect(search.body.truncated).toBe(false);
    const branches = await owner.get(`/git-providers/${github.id}/branches?repository=acme/repo-7`);
    expect(branches.status).toBe(200);
    expect(branches.body.branches).toHaveLength(200);
    expect(branches.body.branches[0].name).toBe("main");
    expect(branches.body.defaultBranch).toBe("main");
    expect(branches.body.truncated).toBe(true);
  });

  test("R3-43: a search finds a repository past the 1,000th an installation sees, and past the 500th on Gitea", async () => {
    const names = (reply: { body: { repositories: { fullName: string }[] } }) =>
      reply.body.repositories.map((item) => item.fullName);
    const listCalls = (pattern: RegExp) =>
      hosts.calls.filter((call) => pattern.test(new URL(call.url).pathname)).length;

    // GitHub: 1,250 repositories, the one searched for the oldest, so it sits on page 13.
    hosts.github.repositories.length = 0;
    for (let index = 0; index < 1250; index++) {
      hosts.github.repositories.push(
        makeRepository(`acme/repo-${index}`, 10_000 + index, {
          pushedAt: new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
        }),
      );
    }
    hosts.github.repositories.push(
      makeRepository("acme/needle-far-away", 99_999, { pushedAt: "2020-01-01T00:00:00.000Z" }),
    );
    const github = await connectGithub(owner);
    const installationPages = /^\/installation\/repositories$/;
    const before = listCalls(installationPages);
    const found = await owner.get(`/git-providers/${github.id}/repositories?search=needle`);
    expect(found.status).toBe(200);
    expect(names(found)).toEqual(["acme/needle-far-away"]);
    expect(found.body.truncated).toBe(false);
    // Every page was read once (1,251 at 100 a page).
    expect(listCalls(installationPages) - before).toBe(13);
    // The next keystrokes search what was read, without paging GitHub again.
    const narrower = await owner.get(`/git-providers/${github.id}/repositories?search=needle-far`);
    expect(names(narrower)).toEqual(["acme/needle-far-away"]);
    const all = await owner.get(`/git-providers/${github.id}/repositories`);
    // The cap limits what is shown, not what is searched (spec 16.7).
    expect(all.body.repositories).toHaveLength(200);
    expect(all.body.repositories[0].fullName).toBe("acme/repo-1249");
    expect(all.body.truncated).toBe(true);
    expect(listCalls(installationPages) - before).toBe(13);
    // A minute later the list is read again, so a repository granted since shows up.
    hosts.github.repositories.push(makeRepository("acme/granted-later", 99_998));
    const realNow = h.services.now;
    h.services.now = () => realNow() + 61_000;
    try {
      const later = await owner.get(`/git-providers/${github.id}/repositories?search=granted`);
      expect(names(later)).toEqual(["acme/granted-later"]);
    } finally {
      h.services.now = realNow;
    }

    // Gitea: 650 repositories at 50 a page, the one searched for at 601st.
    hosts.gitea.repositories.length = 0;
    for (let index = 0; index < 650; index++) {
      const name = index === 600 ? "team/needle-on-gitea" : `team/repo-${index}`;
      hosts.gitea.repositories.push(makeRepository(name, 20_000 + index));
    }
    const gitea = await connectGiteaToken(owner);
    const giteaPages = /^\/api\/v1\/user\/repos$/;
    const giteaBefore = listCalls(giteaPages);
    const onGitea = await owner.get(`/git-providers/${gitea.id}/repositories?search=needle`);
    expect(onGitea.status).toBe(200);
    expect(names(onGitea)).toEqual(["team/needle-on-gitea"]);
    expect(onGitea.body.truncated).toBe(false);
    expect(listCalls(giteaPages) - giteaBefore).toBe(13);

    // A Gitea that hands out fewer per page than asked, without X-Total-Count, is read in full
    // too.
    hosts.gitea.maxPage = 30;
    hosts.gitea.totalHeader = false;
    const small = await connectGiteaToken(owner, "Small pages");
    const smallPages = await owner.get(`/git-providers/${small.id}/repositories?search=needle`);
    expect(names(smallPages)).toEqual(["team/needle-on-gitea"]);
    expect(smallPages.body.truncated).toBe(false);
  });

  test("files three folders deep, small text files, and the inspection bundle", async () => {
    const gitea = await connectGiteaToken(owner);
    const files = await owner.get(`/git-providers/${gitea.id}/files?repository=team/web&depth=1`);
    expect(files.status).toBe(200);
    expect(files.body.ref).toBe("main");
    const paths = files.body.files.map((item: { path: string }) => item.path);
    expect(paths).toContain("Dockerfile");
    expect(paths).toContain("apps");
    expect(paths).not.toContain("apps/api/src/index.ts");
    const file = await owner.get(
      `/git-providers/${gitea.id}/file?repository=team/web&path=package.json`,
    );
    expect(file.body).toMatchObject({ path: "package.json", ref: "main" });
    expect(JSON.parse(file.body.content).name).toBe("web");
    const missing = await owner.get(
      `/git-providers/${gitea.id}/file?repository=team/web&path=nope.txt`,
    );
    expect(missing.status).toBe(404);
    (hosts.gitea.repositories[0] as FakeRepository).files["big.txt"] = "x".repeat(200 * 1024);
    const big = await owner.get(`/git-providers/${gitea.id}/file?repository=team/web&path=big.txt`);
    expect(big.status).toBe(413);
    const outside = await owner.get(
      `/git-providers/${gitea.id}/file?repository=team/web&path=../etc/passwd`,
    );
    expect(outside.status).toBe(400);
    const inspected = await owner.get(`/git-providers/${gitea.id}/inspect?repository=team/web`);
    expect(inspected.status).toBe(200);
    expect(inspected.body.manifests.map((item: { path: string }) => item.path)).toEqual(
      expect.arrayContaining([
        "Dockerfile",
        "package.json",
        ".env.example",
        "apps/api/package.json",
      ]),
    );
    expect(inspected.body.appFolders[0]).toEqual({ path: "", dockerfile: true });
    expect(inspected.body.appFolders).toContainEqual({ path: "apps/api", dockerfile: false });
  });
});

describe("GitHub App (spec 16.2)", () => {
  test("needs the console's public HTTPS address", async () => {
    const plain = await harnessWith("http://203.0.113.5:3000");
    try {
      const person = await setUpNamedOwner(plain);
      const reply = await person.post("/git-providers/github/manifest", {});
      expect(reply.status).toBe(409);
      expect(reply.body.error.message).toContain("public HTTPS address");
      expect((await person.get("/git-providers")).body.console.httpsBase).toBeNull();
    } finally {
      await plain.drop();
    }
  });

  test("the manifest names a private app with the right permissions, events and addresses", async () => {
    const started = await owner.post("/git-providers/github/manifest", {
      organization: "acme",
      returnTo: "/acme/dashboard/agent",
    });
    expect(started.status).toBe(200);
    expect(started.body.action).toStartWith(
      "https://github.com/organizations/acme/settings/apps/new?state=",
    );
    const manifest = JSON.parse(started.body.manifest);
    expect(manifest.name).toMatch(/^Nearzero-\d{4}-\d{2}-\d{2}-[a-z0-9]{6}$/);
    expect(manifest.public).toBe(false);
    expect(manifest.default_permissions).toEqual({
      contents: "read",
      metadata: "read",
      emails: "read",
      pull_requests: "write",
    });
    expect(manifest.default_events).toEqual(["push", "pull_request"]);
    expect(manifest.hook_attributes.url).toBe(
      `https://nz.example.com/api/v1/webhooks/github/${started.body.providerId}`,
    );
    expect(manifest.redirect_url).toBe("https://nz.example.com/git-providers/github/created");
    expect(manifest.setup_url).toBe("https://nz.example.com/git-providers/github/installed");
    const bad = await owner.post("/git-providers/github/manifest", { organization: "-bad-" });
    expect(bad.status).toBe(400);
  });

  test("the state belongs to the person who started it, works once and expires", async () => {
    const started = await owner.post("/git-providers/github/manifest", {});
    const state = new URL(started.body.action).searchParams.get("state") as string;
    const member = await addMember(h, owner, "m@example.com", {
      capabilities: ["git.connect-own"],
    });
    const stolen = await member.post("/git-providers/github/manifest/complete", {
      code: hosts.github.manifestCode,
      state,
    });
    expect(stolen.status).toBe(403);
    expect(hosts.github.conversions).toBe(0);
    await h.test.db
      .updateTable("git_provider_flow")
      .set({ expires_at: new Date(Date.now() - 1000) })
      .execute();
    const late = await owner.post("/git-providers/github/manifest/complete", {
      code: hosts.github.manifestCode,
      state,
    });
    expect(late.status).toBe(409);
    expect(late.body.error.message).toContain("expired");
  });

  test("install with the state; a late install without one binds after GitHub confirms", async () => {
    const started = await owner.post("/git-providers/github/manifest", {
      returnTo: "/acme/dashboard/agent",
    });
    const state = new URL(started.body.action).searchParams.get("state") as string;
    const created = await owner.post("/git-providers/github/manifest/complete", {
      code: hosts.github.manifestCode,
      state,
    });
    expect(created.status).toBe(201);
    expect(created.body.provider.status).toBe("action_required");
    // R3-42: aimed at the app's owner (the organization, id 55), so no account picker.
    expect(created.body.installUrl).toStartWith(
      "https://github.com/apps/nearzero-2026-11-25-test/installations/new/permissions?target_id=55&state=",
    );
    const reinstall = await owner.post(`/git-providers/${created.body.provider.id}/install`, {});
    expect(reinstall.body.installUrl).toStartWith(
      "https://github.com/apps/nearzero-2026-11-25-test/installations/new/permissions?target_id=55&state=",
    );
    expect(created.body.returnTo).toBe("/acme/dashboard/agent");
    // Reused manifest state: refused.
    expect(
      (await owner.post("/git-providers/github/manifest/complete", { code: "x", state })).status,
    ).toBe(409);
    // Someone else's installation never binds.
    const foreign = await owner.post("/git-providers/github/installations", {
      installationId: hosts.github.otherInstallationId,
    });
    expect(foreign.status).toBe(409);
    // No state at all: GitHub confirms this app owns the installation, so it binds.
    const late = await owner.post("/git-providers/github/installations", {
      installationId: hosts.github.installationId,
      setupAction: "install",
    });
    expect(late.status).toBe(200);
    expect(late.body.message).toBe("GitHub App installed");
    expect(late.body.provider).toMatchObject({ status: "ready", account: "acme" });
    expect(late.body.provider.openUrl).toBe("https://github.com/apps/nearzero-2026-11-25-test");
    const stored = await h.test.db.selectFrom("git_provider").selectAll().executeTakeFirstOrThrow();
    expect(stored.secrets_sealed).not.toContain("BEGIN");
    expect(JSON.stringify(stored.settings)).not.toContain("github-webhook-secret");
  });
});

describe("GitLab, Gitea and Bitbucket connect (spec 16.3–16.5)", () => {
  test("GitLab OAuth: save and connect, authorize, come back, tokens refresh", async () => {
    const created = await owner.post("/git-providers/gitlab", {
      name: "Company GitLab",
      url: hosts.gitlab.base,
      applicationId: hosts.gitlab.clientId,
      applicationSecret: hosts.gitlab.clientSecret,
      group: "group",
      returnTo: "/acme/dashboard/projects",
    });
    expect(created.status).toBe(201);
    expect(created.body.provider.status).toBe("action_required");
    expect(created.body.provider.details.redirectUri).toBe(
      "https://nz.example.com/git-providers/gitlab/callback",
    );
    const authorize = new URL(created.body.authorizeUrl);
    expect(authorize.origin + authorize.pathname).toBe(`${hosts.gitlab.base}/oauth/authorize`);
    expect(authorize.searchParams.get("redirect_uri")).toBe(
      "https://nz.example.com/git-providers/gitlab/callback",
    );
    const state = authorize.searchParams.get("state") as string;
    const declined = await owner.post("/git-providers/oauth/complete", {
      kind: "gitlab",
      code: "",
      state,
      error: "access_denied",
    });
    expect(declined.status).toBe(409);
    // A declined state is used up; authorize again.
    const again = await owner.post(`/git-providers/${created.body.provider.id}/authorize`, {});
    const second = new URL(again.body.authorizeUrl).searchParams.get("state") as string;
    const done = await owner.post("/git-providers/oauth/complete", {
      kind: "gitlab",
      code: hosts.gitlab.oauthCode,
      state: second,
    });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ message: "GitLab connected", returnTo: null });
    expect(done.body.provider).toMatchObject({ status: "ready", account: "gitlab-user" });
    const repos = await owner.get(`/git-providers/${created.body.provider.id}/repositories`);
    expect(repos.body.repositories[0]).toMatchObject({
      fullName: "group/web",
      defaultBranch: "main",
    });
    // Edit with blank secret keeps it; Test connection reports who it acts as.
    const tested = await owner.post(`/git-providers/${created.body.provider.id}/test`, {});
    expect(tested.status).toBe(200);
    expect(tested.body.message).toBe("Connected as gitlab-user.");
  });

  test("R3-41, R4-15: a moved GitLab connection keeps 0.1.x's redirect address, so Reconnect needs no change at GitLab", async () => {
    const created = await owner.post("/git-providers/gitlab", {
      name: "Moved GitLab",
      url: hosts.gitlab.base,
      applicationId: hosts.gitlab.clientId,
      applicationSecret: hosts.gitlab.clientSecret,
    });
    const id = created.body.provider.id as string;
    // As the move from 0.1.x leaves it: the OAuth application at GitLab was registered with
    // 0.1.x's redirect address.
    const row = await h.test.db
      .selectFrom("git_provider")
      .select("settings")
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    const settings = typeof row.settings === "string" ? JSON.parse(row.settings) : row.settings;
    await h.test.db
      .updateTable("git_provider")
      .set({ settings: JSON.stringify({ ...settings, legacyCallback: true }) })
      .where("id", "=", id)
      .execute();
    const legacy = "https://nz.example.com/api/providers/gitlab/callback";
    expect((await owner.get(`/git-providers/${id}`)).body.provider.details.redirectUri).toBe(
      legacy,
    );
    const authorize = await owner.post(`/git-providers/${id}/authorize`, {});
    const url = new URL(authorize.body.authorizeUrl);
    expect(url.searchParams.get("redirect_uri")).toBe(legacy);
    const done = await owner.post("/git-providers/oauth/complete", {
      kind: "gitlab",
      code: hosts.gitlab.oauthCode,
      state: url.searchParams.get("state"),
    });
    expect(done.status).toBe(200);
    expect(hosts.gitlab.tokenRedirects.at(-1)).toBe(legacy);
    expect(done.body.provider.status).toBe("ready");
    // Editing it keeps the address its dialog shows.
    const edited = await owner.patch(`/git-providers/${id}`, {
      name: "Moved GitLab",
      url: hosts.gitlab.base,
      applicationId: hosts.gitlab.clientId,
      applicationSecret: "",
    });
    expect(edited.status).toBe(200);
    expect((await owner.get(`/git-providers/${id}`)).body.provider.details.redirectUri).toBe(
      legacy,
    );
  });

  test("R3-40: GitLab's group names take several groups, subgroups included", async () => {
    hosts.gitlab.repositories.push(
      makeRepository("team-a/web", 12),
      makeRepository("team-b/sub/api", 13),
      makeRepository("other/secret", 14),
    );
    const created = await owner.post("/git-providers/gitlab", {
      name: "Teams",
      url: hosts.gitlab.base,
      accessToken: hosts.gitlab.accessToken,
      group: "team-a, team-b",
    });
    expect(created.status).toBe(201);
    const listed = await owner.get(`/git-providers/${created.body.provider.id}/repositories`);
    expect(listed.status).toBe(200);
    expect(
      listed.body.repositories.map((item: { fullName: string }) => item.fullName).sort(),
    ).toEqual(["team-a/web", "team-b/sub/api"]);
    // A group that isn't there is named on its own.
    const wrong = await owner.post("/git-providers/gitlab", {
      name: "Typo",
      url: hosts.gitlab.base,
      accessToken: hosts.gitlab.accessToken,
      group: "team-a,team-z",
    });
    const failed = await owner.get(`/git-providers/${wrong.body.provider.id}/repositories`);
    expect(failed.body.error.message).toContain("GitLab has no group called team-z");
  });

  test("B1-41: parallel reads near a GitLab token's expiry share one refresh", async () => {
    const created = await owner.post("/git-providers/gitlab", {
      name: "Busy GitLab",
      url: hosts.gitlab.base,
      applicationId: hosts.gitlab.clientId,
      applicationSecret: hosts.gitlab.clientSecret,
      group: "group",
    });
    const id = created.body.provider.id as string;
    const state = new URL(created.body.authorizeUrl).searchParams.get("state") as string;
    const done = await owner.post("/git-providers/oauth/complete", {
      kind: "gitlab",
      code: hosts.gitlab.oauthCode,
      state,
    });
    expect(done.status).toBe(200);
    // The access token is about to run out.
    const row = await h.test.db
      .selectFrom("git_provider")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    const secrets = openProviderSecrets<Record<string, unknown>>(h.services, row);
    await h.test.db
      .updateTable("git_provider")
      .set({
        secrets_sealed: sealProviderSecrets(h.services, id, { ...secrets, expiresAt: Date.now() }),
      })
      .where("id", "=", id)
      .execute();
    const before = hosts.gitlab.refreshes;
    const reads = await Promise.all(
      Array.from({ length: 4 }, () => owner.get(`/git-providers/${id}/repositories`)),
    );
    expect(reads.map((read) => read.status)).toEqual([200, 200, 200, 200]);
    expect(hosts.gitlab.refreshes - before).toBe(1);
    const view = (await owner.get(`/git-providers/${id}`)).body.provider;
    expect(view.status).toBe("ready");
  });

  test("Gitea with an access token (no OAuth) connects at once; a wrong token is refused", async () => {
    const wrong = await owner.post("/git-providers/gitea", {
      name: "Bad",
      url: hosts.gitea.base,
      accessToken: "not-the-token",
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.fields.accessToken).toContain("refused");
    expect((await owner.get("/git-providers")).body.providers).toEqual([]);
    const gitea = await connectGiteaToken(owner);
    expect(gitea.status).toBe("ready");
  });

  test("Bitbucket: API token with the Atlassian email; app passwords are marked Deprecated", async () => {
    const missingEmail = await owner.post("/git-providers/bitbucket", {
      name: "BB",
      username: "bb-user",
      apiToken: hosts.bitbucket.apiToken,
    });
    expect(missingEmail.status).toBe(400);
    expect(missingEmail.body.error.fields.email).toBe("Enter your Atlassian account email.");
    const bitbucket = await connectBitbucket(owner);
    const view = (await owner.get(`/git-providers/${bitbucket.id}`)).body.provider;
    expect(view).toMatchObject({ deprecated: false, account: "bb-user", status: "ready" });
    const branches = await owner.get(
      `/git-providers/${bitbucket.id}/branches?repository=acme-ws/web`,
    );
    expect(branches.body.branches.map((item: { name: string }) => item.name)).toEqual([
      "main",
      "develop",
    ]);
    await h.test.db
      .updateTable("git_provider")
      .set({
        settings: JSON.stringify({
          username: "bb-user",
          email: "",
          workspace: "",
          auth: "app_password",
        }),
      })
      .execute();
    expect((await owner.get(`/git-providers/${bitbucket.id}`)).body.provider.deprecated).toBe(true);
  });
});

async function appWithSource(
  providerId: string,
  repository: string,
  extra: Record<string, unknown> = {},
) {
  const { environments } = await makeProject(owner, "Shop");
  const created = await makeService(owner, environments.development as string, {
    kind: "application",
    name: "web",
    settings: { servicePort: 3000 },
  });
  const id = created.service.id as string;
  const saved = await owner.put(`/services/${id}/git-source`, {
    providerId,
    repository,
    watchPaths: ["src/**"],
    ...extra,
  });
  expect(saved.status).toBe(200);
  return { id, saved: saved.body };
}

async function deploymentsOf(serviceId: string) {
  return h.test.db
    .selectFrom("deployment")
    .select(["id", "status", "trigger", "requested_commit", "title"])
    .where("service_id", "=", serviceId)
    .orderBy("created_at")
    .execute();
}

describe("sources and push deploys (spec 6.3, 6.6, 16.6, G4)", () => {
  test("GitHub: the app's signed push deploys; wrong signatures, other branches and watch paths don't", async () => {
    const github = await connectGithub(owner);
    const { id, saved } = await appWithSource(github.id, "acme/web");
    expect(saved.service.settings.source).toMatchObject({
      type: "provider",
      provider: "github",
      repository: "acme/web",
      branch: "main",
      watchPaths: ["src/**"],
    });
    expect(saved.push).toMatchObject({ mode: "app", status: "automatic" });
    const push = (ref: string, files: string[], commit = "e".repeat(40)) =>
      JSON.stringify({
        ref,
        after: commit,
        before: "f".repeat(40),
        repository: { id: 1, full_name: "acme/web" },
        installation: { id: hosts.github.installationId },
        commits: [{ added: [], modified: files, removed: [] }],
        head_commit: { message: "Add the header\n\nLonger text" },
      });
    const send = (raw: string, secret = "github-webhook-secret", delivery = crypto.randomUUID()) =>
      h.browser().request("POST", `/webhooks/github/${github.id}`, new TextEncoder().encode(raw), {
        "content-type": "application/json",
        "x-github-event": "push",
        "x-github-delivery": delivery,
        "x-hub-signature-256": `sha256=${sign(secret, new TextEncoder().encode(raw))}`,
      });
    expect((await send(push("refs/heads/main", ["src/a.ts"]), "wrong")).status).toBe(401);
    const altered = push("refs/heads/main", ["src/a.ts"]);
    const tampered = await h
      .browser()
      .request(
        "POST",
        `/webhooks/github/${github.id}`,
        new TextEncoder().encode(altered.replace("main", "evil")),
        {
          "x-github-event": "push",
          "x-hub-signature-256": `sha256=${sign("github-webhook-secret", new TextEncoder().encode(altered))}`,
        },
      );
    expect(tampered.status).toBe(401);
    const docsOnly = await send(push("refs/heads/main", ["docs/readme.md"]));
    expect(docsOnly.status).toBe(200);
    expect(docsOnly.body.services[0].deployed).toBe(false);
    const other = await send(push("refs/heads/develop", ["src/a.ts"]));
    expect(other.body.services[0].message).toContain("this app deploys main");
    const delivery = crypto.randomUUID();
    const good = await send(
      push("refs/heads/main", ["src/a.ts"]),
      "github-webhook-secret",
      delivery,
    );
    expect(good.status).toBe(202);
    expect(good.body.services[0]).toMatchObject({ deployed: true });
    // GitHub redelivering the same event deploys nothing more.
    const again = await send(
      push("refs/heads/main", ["src/a.ts"]),
      "github-webhook-secret",
      delivery,
    );
    expect(again.body.duplicate).toBe(true);
    const rows = await deploymentsOf(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      trigger: "push",
      requested_commit: "e".repeat(40),
      title: "Add the header",
    });

    // A push during a running deploy queues exactly one more; a third replaces the waiting one.
    await h.test.db
      .updateTable("deployment")
      .set({ status: "building" })
      .where("service_id", "=", id)
      .execute();
    await send(push("refs/heads/main", ["src/b.ts"], "1".repeat(40)));
    await send(push("refs/heads/main", ["src/c.ts"], "2".repeat(40)));
    const queued = await deploymentsOf(id);
    expect(queued).toHaveLength(2);
    expect(queued[1]).toMatchObject({ status: "queued", requested_commit: "2".repeat(40) });
  });

  test("Gitea: the webhook is registered with a secret; signed pushes deploy, unsigned ones are refused", async () => {
    const gitea = await connectGiteaToken(owner);
    const { id, saved } = await appWithSource(gitea.id, "team/web", { watchPaths: [] });
    expect(saved.push).toMatchObject({ mode: "webhook", status: "registered" });
    const hook = hosts.hooks.at(-1);
    expect(hook).toMatchObject({ host: "gitea", repository: "team/web" });
    expect(hook?.url).toStartWith("https://nz.example.com/api/v1/webhooks/deploy/nzw1.");
    const path = new URL(hook?.url as string).pathname.replace("/api/v1", "");
    const raw = new TextEncoder().encode(
      JSON.stringify({
        ref: "refs/heads/main",
        after: "9".repeat(40),
        before: "8".repeat(40),
        repository: { id: 21, full_name: "team/web" },
        commits: [{ added: ["x"], modified: [], removed: [] }],
        head_commit: { message: "Gitea push" },
      }),
    );
    const call = (signature: string) =>
      h.browser().request("POST", path, raw, {
        "content-type": "application/json",
        "x-gitea-event": "push",
        "x-gitea-signature": signature,
      });
    expect((await call(sign("nope", raw))).status).toBe(401);
    const good = await call(sign(hook?.secret as string, raw));
    expect(good.status).toBe(202);
    const rows = await deploymentsOf(id);
    expect(rows[0]).toMatchObject({
      trigger: "push",
      requested_commit: "9".repeat(40),
      title: "Gitea push",
    });
    // The Source panel shows the steps' URL and secret only to people who can deploy.
    const view = await owner.get(`/services/${id}/git-source`);
    expect(view.body).toMatchObject({ state: "connected", push: { status: "registered" } });
    expect(view.body.push.secret).toBe(hook?.secret);
    // Replacing the URL makes the registered webhook stale until it is registered again.
    await owner.post(`/services/${id}/webhook`);
    expect((await owner.get(`/services/${id}/git-source`)).body.push.status).toBe("stale");
    const again = await owner.post(`/services/${id}/git-source/webhook`);
    expect(again.body.push.status).toBe("registered");
  });

  test("GitLab's secret token and Bitbucket's signature guard their pushes", async () => {
    const gitlab = await owner.post("/git-providers/gitlab", {
      name: "GL",
      url: hosts.gitlab.base,
      accessToken: hosts.gitlab.accessToken,
    });
    expect(gitlab.status).toBe(201);
    const { id } = await appWithSource(gitlab.body.provider.id, "group/web", { watchPaths: [] });
    const hook = hosts.hooks.find((item) => item.host === "gitlab");
    const path = new URL(hook?.url as string).pathname.replace("/api/v1", "");
    const raw = new TextEncoder().encode(
      JSON.stringify({
        object_kind: "push",
        ref: "refs/heads/main",
        checkout_sha: "7".repeat(40),
        project: { id: 11, path_with_namespace: "group/web" },
        commits: [
          { id: "7".repeat(40), title: "GitLab push", added: [], modified: ["a"], removed: [] },
        ],
      }),
    );
    const headers = (token: string) => ({ "x-gitlab-event": "Push Hook", "x-gitlab-token": token });
    expect((await h.browser().request("POST", path, raw, headers("wrong"))).status).toBe(401);
    expect(
      (await h.browser().request("POST", path, raw, headers(hook?.secret as string))).status,
    ).toBe(202);
    expect((await deploymentsOf(id))[0]).toMatchObject({ title: "GitLab push" });

    const bitbucket = await connectBitbucket(owner);
    const { environments } = await makeProject(owner, "Docs");
    const service = await makeService(owner, environments.development as string, {
      kind: "application",
      name: "docs",
    });
    const saved = await owner.put(`/services/${service.service.id}/git-source`, {
      providerId: bitbucket.id,
      repository: "acme-ws/web",
      watchPaths: ["src/**"],
    });
    expect(saved.body.push.status).toBe("registered");
    const bbHook = hosts.hooks.find((item) => item.host === "bitbucket");
    const bbPath = new URL(bbHook?.url as string).pathname.replace("/api/v1", "");
    const bbRaw = new TextEncoder().encode(
      JSON.stringify({
        repository: { full_name: "acme-ws/web", uuid: "{31}" },
        push: {
          changes: [
            {
              new: {
                type: "branch",
                name: "main",
                target: { hash: "6".repeat(40), message: "BB" },
              },
              old: { target: { hash: "5".repeat(40) } },
            },
          ],
        },
      }),
    );
    const bbHeaders = (secret: string) => ({
      "x-event-key": "repo:push",
      "x-hook-uuid": "hook",
      "x-hub-signature": `sha256=${sign(secret, bbRaw)}`,
    });
    expect((await h.browser().request("POST", bbPath, bbRaw, bbHeaders("x"))).status).toBe(401);
    // The diffstat says only docs/ changed, so an app watching src/** doesn't deploy.
    const filtered = await h
      .browser()
      .request("POST", bbPath, bbRaw, bbHeaders(bbHook?.secret as string));
    expect(filtered.status).toBe(200);
    expect(filtered.body.deployed).toBe(false);
  });

  test("deleting a service removes the webhooks Nearzero added at GitLab, Gitea and Bitbucket", async () => {
    const gitlab = await owner.post("/git-providers/gitlab", {
      name: "GL",
      url: hosts.gitlab.base,
      accessToken: hosts.gitlab.accessToken,
    });
    const gitea = await connectGiteaToken(owner);
    const bitbucket = await connectBitbucket(owner);
    const { environments } = await makeProject(owner, "Hooks");
    const env = environments.development as string;
    const linked: { id: string; host: "gitlab" | "gitea" | "bitbucket" }[] = [];
    for (const [name, providerId, repository, host] of [
      ["gl", gitlab.body.provider.id, "group/web", "gitlab"],
      ["gt", gitea.id, "team/web", "gitea"],
      ["bb", bitbucket.id, "acme-ws/web", "bitbucket"],
    ] as const) {
      const service = await makeService(owner, env, { kind: "application", name });
      const saved = await owner.put(`/services/${service.service.id}/git-source`, {
        providerId,
        repository,
      });
      expect(saved.body.push.status).toBe("registered");
      linked.push({ id: service.service.id, host });
    }
    const teardown = runnerTeardown(h.services);
    const remove = async (serviceId: string) => {
      const row = await h.test.db
        .selectFrom("service")
        .selectAll()
        .where("id", "=", serviceId)
        .executeTakeFirstOrThrow();
      return teardown.remove(
        {
          serviceId,
          workspaceId: row.workspace_id,
          projectId: row.project_id,
          environmentId: row.environment_id,
          kind: "application",
          name: row.name,
          appName: row.app_name,
          serverId: null,
          status: "idle",
          settings: {},
        },
        { stopFirst: true, removeVolumes: true, signal: new AbortController().signal },
      );
    };
    for (const item of linked.slice(0, 2)) {
      expect(await remove(item.id)).toEqual({ removed: true });
      const hook = hosts.hooks.find((entry) => entry.host === item.host);
      expect(hosts.removedHooks).toContainEqual({ host: item.host, id: String(hook?.id) });
    }
    expect(
      await h.test.db.selectFrom("git_service_hook").select("service_id").execute(),
    ).toHaveLength(1);
    // A host that can't be asked doesn't keep the service; what is left over is noted.
    await h.test.db
      .updateTable("git_provider")
      .set({ status: "pending" })
      .where("id", "=", bitbucket.id)
      .execute();
    const left = await remove(linked[2]?.id as string);
    expect(left).toEqual({
      removed: true,
      notes: [
        `The webhook Nearzero added to acme-ws/web on Bitbucket couldn't be removed (the Bitbucket provider "Acme Bitbucket" isn't connected). Delete it in the repository's webhook settings on Bitbucket.`,
      ],
    });
    expect(hosts.removedHooks.some((entry) => entry.host === "bitbucket")).toBe(false);
    expect(
      await h.test.db.selectFrom("git_service_hook").select("service_id").execute(),
    ).toHaveLength(0);
  });

  test("the deploy engine's clone credentials: a clean URL and a short-lived token", async () => {
    const github = await connectGithub(owner);
    const { id } = await appWithSource(github.id, "acme/web");
    const row = await h.test.db
      .selectFrom("service")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    const source = (row.settings as { source: Parameters<typeof providerCloneAccess>[2] }).source;
    const access = await providerCloneAccess(h.services, row.workspace_id, source);
    expect(access).toEqual({
      url: "https://github.com/acme/web.git",
      username: "x-access-token",
      password: hosts.github.token,
    });
    expect(access.url).not.toContain(hosts.github.token);
  });

  test("delete in use needs the tick and leaves the services with no Git source", async () => {
    const gitea = await connectGiteaToken(owner);
    const { id } = await appWithSource(gitea.id, "team/web");
    const plan = await owner.get(`/git-providers/${gitea.id}/delete-plan`);
    expect(plan.body.plan).toMatchObject({
      apps: 1,
      composeServices: 0,
      needsUnderstood: true,
      warning:
        "1 app and 0 compose services use this provider. They will stop deploying from Git until you pick another provider.",
    });
    const refused = await owner.delete(`/git-providers/${gitea.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.fields.understood).toBeDefined();
    const deleted = await owner.delete(`/git-providers/${gitea.id}?understood=true`);
    expect(deleted.status).toBe(200);
    const view = await owner.get(`/services/${id}/git-source`);
    expect(view.body.state).toBe("no_git_source");
    expect(view.body.push.message).toBe("No Git source");
    await expect(
      providerCloneAccess(
        h.services,
        (await h.test.db.selectFrom("service").select("workspace_id").executeTakeFirstOrThrow())
          .workspace_id,
        view.body.source,
      ),
    ).rejects.toThrow("no Git source");
  });

  test("a member configures a source only with an account they can use", async () => {
    const bitbucket = await connectBitbucket(owner);
    const { environments, projectId } = await makeProject(owner, "Shop");
    const created = await makeService(owner, environments.development as string, {
      kind: "application",
      name: "web",
    });
    const member = await addMember(h, owner, "dev@example.com", {
      capabilities: ["services.create"],
      scope: { projectIds: [projectId] },
    });
    const refused = await member.put(`/services/${created.service.id}/git-source`, {
      providerId: bitbucket.id,
      repository: "acme-ws/web",
    });
    expect(refused.status).toBe(404);
    await owner.post(`/git-providers/${bitbucket.id}/share`, { shared: true });
    const allowed = await member.put(`/services/${created.service.id}/git-source`, {
      providerId: bitbucket.id,
      repository: "acme-ws/web",
    });
    expect(allowed.status).toBe(200);
    // Unshared again: the member sees "Disconnect repository" instead of the account.
    await owner.post(`/git-providers/${bitbucket.id}/share`, { shared: false });
    const view = await member.get(`/services/${created.service.id}/git-source`);
    expect(view.body.state).toBe("no_access");
    const disconnected = await member.delete(`/services/${created.service.id}/git-source`);
    expect(disconnected.body.message).toBe("Repository disconnected");
  });

  test("Compose services keep a Compose file path", async () => {
    const gitea = await connectGiteaToken(owner);
    const { environments } = await makeProject(owner, "Stack");
    const created = await makeService(owner, environments.development as string, {
      kind: "compose",
      name: "stack",
    });
    const saved = await owner.put(`/services/${created.service.id}/git-source`, {
      providerId: gitea.id,
      repository: "team/web",
      composePath: "deploy/compose.yaml",
    });
    expect(saved.status).toBe(200);
    expect(saved.body.service.settings.source).toMatchObject({
      type: "provider",
      composePath: "deploy/compose.yaml",
      buildPath: "",
    });
    const bad = await owner.put(`/services/${created.service.id}/git-source`, {
      providerId: gitea.id,
      repository: "team/web",
      composePath: "../outside.yml",
    });
    expect(bad.status).toBe(400);
  });
});
