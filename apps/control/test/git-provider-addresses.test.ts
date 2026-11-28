import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { ObjectRegistry } from "../src/access/objects.ts";
import { INTERNAL_GIT_ADDRESS } from "../src/git-providers/connect.ts";
import { registerGitAccountObjects } from "../src/git-providers/records.ts";
import { registerProjectObjects } from "../src/projects/objects.ts";
import { registerServerObjects } from "../src/servers/servers.ts";
import { FakeGitHosts } from "./support/fake-git-hosts.ts";
import {
  type Browser,
  createHarness,
  type Harness,
  INSTANCE_RESEND,
  setUpNamedOwner,
} from "./support/harness.ts";
import { addMember } from "./support/projects.ts";

/**
 * 31d G4-12 (spec 23.9): a member who may connect their own Git accounts can't point a GitLab or
 * Gitea connection, or its internal address, at a private, loopback, link-local or internal
 * address, which the control plane would then call. Owners, admins and instance administrators
 * still can. Refused before anything is saved or called.
 */

setDefaultTimeout(120_000);

let h: Harness;
let hosts: FakeGitHosts;
let owner: Browser;
let member: Browser;
/** Every outbound call the control plane made. */
const called: string[] = [];

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
  h.services.http = (input, init) => {
    called.push(String(input));
    return hosts.handles(String(input)) ? hosts.fetch(String(input), init) : outside(input, init);
  };
  h.outside.dns.set("gitea.corp.test", ["10.0.0.7"]);
  h.outside.dns.set("nearzero1-postgres", ["172.18.0.5"]);
  owner = await setUpNamedOwner(h);
  member = await addMember(h, owner, "connector@example.com", {
    capabilities: ["git.connect-own"],
  });
});

afterAll(async () => {
  await h.drop();
});

describe("Git connections at internal addresses (G4-12)", () => {
  test("a member is refused, with the rule, before anything is saved or called", async () => {
    for (const [field, body] of [
      ["url", { url: "http://127.0.0.1:3000" }],
      ["url", { url: "http://169.254.169.254" }],
      ["url", { url: "https://gitea.corp.test" }],
      ["url", { url: "http://[::1]:3000" }],
      ["internalUrl", { url: hosts.gitea.base, internalUrl: "http://nearzero1-postgres:5432" }],
      ["internalUrl", { url: hosts.gitea.base, internalUrl: "http://10.1.2.3:3000" }],
    ] as const) {
      const before = called.length;
      const reply = await member.post("/git-providers/gitea", {
        name: "Team Gitea",
        accessToken: hosts.gitea.accessToken,
        ...body,
      });
      expect(reply.status).toBe(400);
      expect(reply.body.error.fields[field]).toContain(INTERNAL_GIT_ADDRESS);
      expect(called.length).toBe(before);
    }
    const gitlab = await member.post("/git-providers/gitlab", {
      name: "Company GitLab",
      url: "http://192.168.1.20",
      applicationId: hosts.gitlab.clientId,
      applicationSecret: hosts.gitlab.clientSecret,
    });
    expect(gitlab.status).toBe(400);
    expect(gitlab.body.error.message).toContain(INTERNAL_GIT_ADDRESS);
    expect(await h.test.db.selectFrom("git_provider").select("id").execute()).toEqual([]);
  });

  test("a member may use a public address, and is refused moving it inside", async () => {
    const created = await member.post("/git-providers/gitea", {
      name: "Team Gitea",
      url: hosts.gitea.base,
      accessToken: hosts.gitea.accessToken,
    });
    expect(created.status).toBe(201);
    const id = created.body.provider.id as string;
    const before = called.length;
    const moved = await member.patch(`/git-providers/${id}`, {
      name: "Team Gitea",
      url: hosts.gitea.base,
      internalUrl: "http://127.0.0.1:3000",
      accessToken: hosts.gitea.accessToken,
    });
    expect(moved.status).toBe(400);
    expect(moved.body.error.fields.internalUrl).toContain(INTERNAL_GIT_ADDRESS);
    const tested = await member.post(`/git-providers/${id}/test`, {
      name: "Team Gitea",
      url: "http://127.0.0.1:3000",
      accessToken: hosts.gitea.accessToken,
    });
    expect(tested.status).toBe(400);
    expect(called.length).toBe(before);
  });

  test("an owner may still set them", async () => {
    const reply = await owner.post("/git-providers/gitea", {
      name: "Internal Gitea",
      url: "http://127.0.0.1:3000",
      accessToken: hosts.gitea.accessToken,
    });
    expect(JSON.stringify(reply.body)).not.toContain(INTERNAL_GIT_ADDRESS);
  });
});
