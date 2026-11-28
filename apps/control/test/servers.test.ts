import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { SERVER_MESSAGES, SSH_KEY_MESSAGES, sshKeyInUseMessage } from "@nearzero/shared";
import { sql } from "kysely";
import { ObjectRegistry } from "../src/access/objects.ts";
import { registerProjectObjects } from "../src/projects/objects.ts";
import {
  createJoinToken,
  JOIN_TOKEN_REFUSED,
  redeemJoinToken,
  verifyCredential,
} from "../src/runners/credentials.ts";
import { registerServerObjects } from "../src/servers/servers.ts";
import { generateKeyPair } from "../src/ssh-keys/format.ts";
import { FakeRunner } from "./support/fake-runner.ts";
import {
  addMemberThroughInvitation,
  type Browser,
  createHarness,
  type Harness,
  INSTANCE_RESEND,
  personIdOf,
  setUpNamedOwner,
} from "./support/harness.ts";

/**
 * Servers and SSH keys as records (spec 09 9.2, 9.6, 9.7, 9.8; 10.2 labels; 22.3; 24 G3), the
 * runner's join tokens and credentials (spec 25 D1, 22.4 rule 7), and the route endpoints'
 * all-or-nothing rule (24 P7). Each endpoint is checked allowed, refused for a member without
 * the capability, and refused for another workspace.
 */

let harness: Harness;
let owner: Browser;
let ed25519: { publicKey: string; privateKey: string };

beforeAll(async () => {
  const objects = new ObjectRegistry();
  registerProjectObjects(objects);
  registerServerObjects(objects);
  harness = await createHarness({ instanceEmail: INSTANCE_RESEND, extra: { objects } });
  ed25519 = await generateKeyPair("ed25519", "test");
}, 60_000);

afterAll(async () => {
  harness?.services.runners.stop();
  await harness.drop();
});

beforeEach(async () => {
  await harness.reset();
  await sql`truncate ssh_key, server, runner, runner_join_token, router_route, server_metric, host_allowed_workspace cascade`.execute(
    harness.test.db,
  );
  owner = await setUpNamedOwner(harness);
}, 30_000);

async function addKey(browser: Browser, name = "deploy") {
  const reply = await browser.post("/ssh-keys", { name, ...ed25519 });
  if (reply.status !== 201) throw new Error(JSON.stringify(reply.body));
  return reply.body.key as { id: string };
}

async function addServer(browser: Browser, keyId: string, overrides: Record<string, unknown> = {}) {
  return browser.post("/servers", {
    name: "prod-1",
    sshKeyId: keyId,
    address: "203.0.113.10",
    sshUser: "ubuntu",
    ...overrides,
  });
}

async function memberWith(capabilities: string[], serverIds: string[] = [], allServers = false) {
  const member = await addMemberThroughInvitation(harness, owner, "mia@example.com");
  const personId = await personIdOf(harness, "mia@example.com");
  const access = await owner.put(`/workspace/members/${personId}/access`, {
    policyIds: [],
    capabilities,
    scope: {
      allProjects: false,
      projectIds: [],
      environmentIds: [],
      serviceIds: [],
      allServers,
      serverIds,
      allGitAccounts: false,
      gitAccountIds: [],
    },
  });
  if (access.status !== 200) throw new Error(JSON.stringify(access.body));
  return member;
}

describe("SSH keys (spec 9.7)", () => {
  test("generated on the server, in both formats, and accepted as a pair", async () => {
    for (const type of ["ed25519", "rsa"] as const) {
      const generated = await owner.post("/ssh-keys/generate", { type, name: "my key" });
      expect(generated.status).toBe(200);
      expect(generated.body.message).toBe(SSH_KEY_MESSAGES.generated);
      expect(generated.body.publicKey).toStartWith(type === "rsa" ? "ssh-rsa " : "ssh-ed25519 ");
      expect(generated.body.publicKey).toEndWith(" my-key");
      expect(generated.body.privateKey).toContain(
        type === "rsa" ? "BEGIN RSA PRIVATE KEY" : "BEGIN OPENSSH PRIVATE KEY",
      );
      const saved = await owner.post("/ssh-keys", {
        name: `key ${type}`,
        publicKey: generated.body.publicKey,
        privateKey: generated.body.privateKey,
      });
      expect(saved.status).toBe(201);
      expect(saved.body.key.fingerprint).toBe(generated.body.fingerprint);
    }
  }, 30_000);

  test("private keys are sealed and never sent back", async () => {
    const key = await addKey(owner);
    const list = await owner.get("/ssh-keys");
    const one = await owner.get(`/ssh-keys/${key.id}`);
    for (const reply of [list, one]) {
      expect(JSON.stringify(reply.body)).not.toContain("PRIVATE KEY");
    }
    const row = await harness.test.db
      .selectFrom("ssh_key")
      .select("private_key_sealed")
      .executeTakeFirstOrThrow();
    expect(row.private_key_sealed).toStartWith("nzs1.");
    expect(row.private_key_sealed).not.toContain("OPENSSH");
  });

  test("pasted keys are checked: format, matching halves, no passphrase", async () => {
    const badPublic = await owner.post("/ssh-keys", {
      name: "x",
      ...ed25519,
      publicKey: "ssh-dss AAAA",
    });
    expect(badPublic.status).toBe(400);
    expect(badPublic.body.error.fields.publicKey).toBe(SSH_KEY_MESSAGES.invalidPublic);
    const badPrivate = await owner.post("/ssh-keys", { name: "x", ...ed25519, privateKey: "nope" });
    expect(badPrivate.body.error.fields.privateKey).toBe(SSH_KEY_MESSAGES.invalidPrivate);
    const other = await generateKeyPair("ed25519");
    const mismatch = await owner.post("/ssh-keys", {
      name: "x",
      publicKey: ed25519.publicKey,
      privateKey: other.privateKey,
    });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error.message).toBe(SSH_KEY_MESSAGES.mismatch);
    // The same key, re-encoded as if a passphrase protected it.
    const body = Buffer.from(
      ed25519.privateKey
        .split("\n")
        .filter((line) => !line.startsWith("-----"))
        .join(""),
      "base64",
    );
    const magic = "openssh-key-v1\0".length;
    const protectedBody = Buffer.concat([
      body.subarray(0, magic),
      Buffer.from([0, 0, 0, 10]),
      Buffer.from("aes256-ctr"),
      body.subarray(magic + 8),
    ]);
    const pem = `-----BEGIN OPENSSH PRIVATE KEY-----\n${protectedBody.toString("base64")}\n-----END OPENSSH PRIVATE KEY-----\n`;
    const passphrase = await owner.post("/ssh-keys", {
      name: "x",
      publicKey: ed25519.publicKey,
      privateKey: pem,
    });
    expect(passphrase.body.error.message).toBe(SSH_KEY_MESSAGES.passphrase);
  });

  test("edit changes name and description only; delete is refused while a server uses the key", async () => {
    const key = await addKey(owner);
    const edited = await owner.patch(`/ssh-keys/${key.id}`, { name: "renamed", description: "d" });
    expect(edited.body.key).toMatchObject({ name: "renamed", description: "d" });
    expect((await addServer(owner, key.id)).status).toBe(201);
    const refused = await owner.delete(`/ssh-keys/${key.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toBe(
      "This SSH key is attached to server: prod-1. Remove that server first.",
    );
    // R3-08: two servers on a key are both named, in the plural.
    expect(
      (await addServer(owner, key.id, { name: "prod-2", address: "203.0.113.11" })).status,
    ).toBe(201);
    expect((await owner.delete(`/ssh-keys/${key.id}`)).body.error.message).toBe(
      "This SSH key is attached to servers: prod-1, prod-2. Remove those servers first.",
    );
    const unused = await addKey(owner, "spare");
    expect((await owner.delete(`/ssh-keys/${unused.id}`)).status).toBe(200);
  });

  test("a member without the capability can't see the keys", async () => {
    await addKey(owner);
    const member = await memberWith([]);
    const list = await member.get("/ssh-keys");
    expect(list.status).toBe(403);
    expect(list.body.error.message).toContain('"Use the workspace\'s SSH keys"');
  });

  test("a member with use can list but not add; with manage they can add", async () => {
    await addKey(owner);
    const member = await memberWith(["ssh-keys.use"]);
    expect((await member.get("/ssh-keys")).body.keys).toHaveLength(1);
    const add = await member.post("/ssh-keys", { name: "mine", ...ed25519 });
    expect(add.status).toBe(403);
    expect(add.body.error.message).toContain("Add and remove SSH keys");
    const personId = await personIdOf(harness, "mia@example.com");
    await owner.put(`/workspace/members/${personId}/access`, {
      policyIds: [],
      capabilities: ["ssh-keys.use", "ssh-keys.manage"],
      scope: {
        allProjects: false,
        projectIds: [],
        environmentIds: [],
        serviceIds: [],
        allServers: false,
        serverIds: [],
        allGitAccounts: false,
        gitAccountIds: [],
      },
    });
    expect((await member.post("/ssh-keys", { name: "mine", ...ed25519 })).status).toBe(201);
  });

  test("C1-13: a key's servers are named only when the person can see them", async () => {
    const key = await addKey(owner);
    const s1 = await addServer(owner, key.id, { name: "edge-1", address: "203.0.113.11" });
    const s2 = await addServer(owner, key.id, { name: "secret-db-box", address: "203.0.113.12" });
    expect(s1.status).toBe(201);
    expect(s2.status).toBe(201);
    const member = await memberWith(["ssh-keys.use", "ssh-keys.manage"], [s1.body.server.id]);
    const listed = (await member.get("/ssh-keys")).body.keys[0];
    expect(listed.usedBy).toEqual([{ id: s1.body.server.id, name: "edge-1" }]);
    expect(listed.hiddenServers).toBe(1);
    expect(JSON.stringify(listed)).not.toContain(s2.body.server.id);
    const refused = await member.delete(`/ssh-keys/${key.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toBe(
      "This SSH key is attached to servers: edge-1, 1 more you can't see. Remove those servers first.",
    );
    expect(refused.body.error.message).not.toContain("secret-db-box");
    // Someone who sees neither is told they're there, not what they are.
    expect(sshKeyInUseMessage([], 2)).toBe(
      "This SSH key is attached to 2 servers you can't see. Ask an owner or admin to remove them first.",
    );
    // The owner sees both.
    expect((await owner.get(`/ssh-keys/${key.id}`)).body.key.usedBy).toHaveLength(2);
  });

  test("a key apps clone with lists them, and deleting it is allowed (spec 9.7)", async () => {
    const key = await addKey(owner);
    const project = await owner.post("/projects", { name: "shop" });
    const service = await owner.post(`/environments/${project.body.environmentId}/services`, {
      kind: "application",
      name: "web",
      serverId: "host",
      settings: { image: "nginx:alpine", servicePort: 80 },
    });
    expect(service.status).toBe(201);
    // Each service says whether its Backups tab is for this person (punch list 30).
    expect(service.body.service.can.backups).toBe(true);
    const serviceId = service.body.service.id as string;
    const source = await owner.put(`/services/${serviceId}/source`, {
      type: "git",
      url: "git@github.com:acme/shop.git",
      branch: "main",
      sshKeyId: key.id,
    });
    expect(source.status).toBe(200);
    const viewed = (await owner.get(`/ssh-keys/${key.id}`)).body.key;
    expect(viewed.usedBy).toEqual([]);
    expect(viewed.gitUsers).toEqual([
      {
        id: serviceId,
        name: "web",
        kind: "application",
        project: "shop",
        environment: "development",
      },
    ]);
    expect(viewed.hiddenGitUsers).toBe(0);
    // A member who manages keys but can't see the app gets a count, not its name.
    const member = await memberWith(["ssh-keys.use", "ssh-keys.manage"]);
    const theirs = (await member.get(`/ssh-keys/${key.id}`)).body.key;
    expect(theirs.gitUsers).toEqual([]);
    expect(theirs.hiddenGitUsers).toBe(1);
    expect((await owner.delete(`/ssh-keys/${key.id}`)).status).toBe(200);
    const audit = await harness.test.db
      .selectFrom("audit_event")
      .select("details")
      .where("action", "=", "ssh-key.deleted")
      .executeTakeFirstOrThrow();
    expect(audit.details).toMatchObject({ gitUsers: [serviceId] });
  });
});

describe("servers (spec 9.2, 9.6, 10.2)", () => {
  test("fields are checked with the spec's words", async () => {
    const key = await addKey(owner);
    const protocol = await addServer(owner, key.id, { address: "https://203.0.113.10" });
    expect(protocol.body.error.fields.address).toBe(SERVER_MESSAGES.addressRule);
    const withPort = await addServer(owner, key.id, { address: "example.com:22" });
    expect(withPort.body.error.fields.address).toBe(SERVER_MESSAGES.addressRule);
    const port = await addServer(owner, key.id, { port: 70000 });
    expect(port.body.error.fields.port).toBe("Enter a port from 1 to 65535.");
    const user = await addServer(owner, key.id, { sshUser: "9lives" });
    expect(user.body.error.fields.sshUser).toContain("a letter or _ first");
    const noUser = await addServer(owner, key.id, { sshUser: "" });
    expect(noUser.body.error.fields.sshUser).toBe("Enter the SSH user, like ubuntu.");
    const noKey = await addServer(owner, "00000000-0000-4000-8000-000000000000");
    expect(noKey.body.error.fields.sshKeyId).toBe(SERVER_MESSAGES.keyNotFound);
  });

  test("names are unique ignoring case, and so are address and port", async () => {
    const key = await addKey(owner);
    expect((await addServer(owner, key.id)).status).toBe(201);
    const sameName = await addServer(owner, key.id, { name: "PROD-1", address: "203.0.113.11" });
    expect(sameName.status).toBe(409);
    // 0.1.x's sentences (G3-08).
    expect(sameName.body.error.message).toBe(
      'A server named "PROD-1" already exists. Use another name, or change that server instead.',
    );
    const sameAddress = await addServer(owner, key.id, { name: "prod-2" });
    expect(sameAddress.body.error.message).toBe(
      '"prod-1" already uses 203.0.113.10:22. Change that server instead of adding the same machine twice.',
    );
    expect((await addServer(owner, key.id, { name: "prod-2", port: 2222 })).status).toBe(201);
  });

  test("R3-05: a new address or port forgets the recorded host key, with a notice; the key can be forgotten by itself", async () => {
    const key = await addKey(owner);
    const created = await addServer(owner, key.id);
    const id = created.body.server.id as string;
    const fingerprint = "SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    expect((await owner.post(`/servers/${id}/host-key/trust`, { fingerprint })).status).toBe(200);
    // A rename keeps it.
    const renamed = await owner.patch(`/servers/${id}`, { name: "prod-renamed" });
    expect(renamed.body.server.hostKeyFingerprint).toBe(fingerprint);
    expect(renamed.body.notices).toEqual([]);
    // A replacement machine at a new address is a first connection again.
    const moved = await owner.patch(`/servers/${id}`, { address: "203.0.113.99" });
    expect(moved.body.server.hostKeyFingerprint).toBeNull();
    expect(moved.body.notices).toEqual([
      "The host key recorded for the old address was forgotten. The next setup records the server's new one.",
    ]);
    await owner.post(`/servers/${id}/host-key/trust`, { fingerprint });
    expect(
      (await owner.patch(`/servers/${id}`, { port: 2222 })).body.server.hostKeyFingerprint,
    ).toBeNull();
    // Forget host key, as the console's button sends it.
    await owner.post(`/servers/${id}/host-key/trust`, { fingerprint });
    expect((await owner.delete(`/servers/${id}/host-key`)).body).toEqual({
      hostKeyFingerprint: null,
    });
    expect((await owner.get(`/servers/${id}`)).body.server.hostKeyFingerprint).toBeNull();
  });

  test('R3-01: a member whose only server right is "Add and remove servers" reaches the server they add', async () => {
    const key = await addKey(owner);
    const others = await addServer(owner, key.id, { name: "not-theirs", address: "203.0.113.30" });
    const member = await memberWith(["servers.manage", "ssh-keys.use"]);
    const added = await addServer(member, key.id, { name: "mine", address: "203.0.113.31" });
    expect(added.status).toBe(201);
    const id = added.body.server.id as string;
    // Its card is listed, its details open, it can be edited and deleted.
    const listed = (await member.get("/servers")).body.servers as { id: string }[];
    expect(listed.map((server) => server.id)).toEqual([id]);
    expect((await member.get(`/servers/${id}`)).status).toBe(200);
    expect((await member.patch(`/servers/${id}`, { description: "set up by Mia" })).status).toBe(
      200,
    );
    // Servers they didn't add stay out of reach.
    expect((await member.get(`/servers/${others.body.server.id}`)).status).toBe(404);
    expect((await member.delete(`/servers/${id}`)).status).toBe(200);
  });

  test('G3-06: "Add and remove servers" alone covers choosing a saved key in the server forms', async () => {
    const key = await addKey(owner);
    const other = await addKey(owner, "second");
    const member = await memberWith(["servers.manage"]);
    // The Add server form's key list, without the SSH keys capability.
    const keys = await member.get("/ssh-keys");
    expect(keys.status).toBe(200);
    expect(keys.body.keys.map((item: { name: string }) => item.name).sort()).toEqual([
      "deploy",
      "second",
    ]);
    const added = await addServer(member, key.id, { name: "theirs", address: "203.0.113.32" });
    expect(added.status).toBe(201);
    const changed = await member.patch(`/servers/${added.body.server.id}`, {
      sshKeyId: other.id,
    });
    expect(changed.status).toBe(200);
    expect(changed.body.server.sshKey.id).toBe(other.id);
    // Still only the workspace's own keys, and keys stay theirs to manage only with the right.
    const missing = await addServer(member, "00000000-0000-4000-8000-000000000000", {
      name: "nope",
      address: "203.0.113.33",
    });
    expect(missing.body.error.fields.sshKeyId).toBe(SERVER_MESSAGES.keyNotFound);
    expect((await member.post("/ssh-keys", { name: "mine", ...ed25519 })).status).toBe(403);
  });

  test("R3-09: the list is newest first", async () => {
    const key = await addKey(owner);
    await addServer(owner, key.id, { name: "alpha", address: "203.0.113.40" });
    await Bun.sleep(20);
    await addServer(owner, key.id, { name: "beta", address: "203.0.113.41" });
    const names = (await owner.get("/servers")).body.servers.map(
      (server: { name: string }) => server.name,
    );
    expect(names).toEqual(["beta", "alpha"]);
  });

  test("labels come from the name once and never change on rename", async () => {
    const key = await addKey(owner);
    const digits = await addServer(owner, key.id, { name: "123 Prod" });
    expect(digits.body.server.label).toBe("server-123-prod");
    const first = await addServer(owner, key.id, { name: "Web", address: "203.0.113.20" });
    expect(first.body.server.label).toBe("web");
    await owner.patch(`/servers/${first.body.server.id}`, { name: "web old" });
    const second = await addServer(owner, key.id, { name: "web", address: "203.0.113.21" });
    expect(second.body.server.label).toBe("web-2");
    const renamed = await owner.get(`/servers/${first.body.server.id}`);
    expect(renamed.body.server).toMatchObject({ name: "web old", label: "web" });
  });

  test("a new server needs setup and its runner has never connected", async () => {
    const key = await addKey(owner);
    const created = await addServer(owner, key.id);
    expect(created.body.server).toMatchObject({
      readiness: "setup_needed",
      setup: { state: "not_started" },
      runner: { state: "never_connected" },
      sshKey: { id: key.id, name: "deploy" },
    });
    const edited = await owner.patch(`/servers/${created.body.server.id}`, { sshUser: "admin" });
    expect(edited.body.notices).toEqual([SERVER_MESSAGES.sshUserChanged]);
    const filtered = await owner.get("/servers?status=ready");
    expect(filtered.body.servers).toEqual([]);
    const searched = await owner.get("/servers?q=203.0.113");
    expect(searched.body.servers).toHaveLength(1);
  });

  test("a server with services can't be deleted; without, it is and its runner is revoked", async () => {
    const key = await addKey(owner);
    const server = (await addServer(owner, key.id)).body.server;
    const { token } = await createJoinToken(harness.test.db, server.id);
    const enrolled = await redeemJoinToken(harness.test.db, token);
    const workspace = await harness.test.db
      .selectFrom("workspace")
      .select("id")
      .executeTakeFirstOrThrow();
    const project = await harness.test.db
      .insertInto("project")
      .values({ workspace_id: workspace.id, name: "p" })
      .returning("id")
      .executeTakeFirstOrThrow();
    const environment = await harness.test.db
      .insertInto("environment")
      .values({
        workspace_id: workspace.id,
        project_id: project.id,
        name: "development",
        is_default: true,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await harness.test.db
      .insertInto("service")
      .values({
        workspace_id: workspace.id,
        project_id: project.id,
        environment_id: environment.id,
        kind: "redis",
        name: "cache",
        app_name_base: "cache",
        app_name: "cache-abc123",
        server_id: server.id,
        settings: "{}",
      })
      .execute();
    const refused = await owner.delete(`/servers/${server.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toBe(SERVER_MESSAGES.hasServices);
    await harness.test.db.deleteFrom("service").execute();
    const deleted = await owner.delete(`/servers/${server.id}`);
    expect(deleted.body).toEqual({ deleted: true, message: "Server deleted" });
    expect(await verifyCredential(harness.test.db, enrolled.credential)).toBeNull();
  });

  test("members: hidden without scope, read-only without the capability, allowed with both", async () => {
    const key = await addKey(owner);
    const server = (await addServer(owner, key.id)).body.server;
    const member = await memberWith([], [server.id]);
    expect((await member.get("/servers")).body.servers.map((s: { id: string }) => s.id)).toEqual([
      server.id,
    ]);
    const edit = await member.patch(`/servers/${server.id}`, { description: "x" });
    expect(edit.status).toBe(403);
    expect(edit.body.error.message).toContain("Add and remove servers");
    const add = await addServer(member, key.id, { name: "mine", address: "203.0.113.99" });
    expect(add.status).toBe(403);

    const other = (await addServer(owner, key.id, { name: "other", address: "203.0.113.50" })).body
      .server;
    expect((await member.get(`/servers/${other.id}`)).status).toBe(404);
    expect((await member.get("/servers")).body.servers).toHaveLength(1);
  });

  test("another workspace's server and key are not found, for owners too (spec 22.4 rule 1)", async () => {
    const key = await addKey(owner);
    const server = (await addServer(owner, key.id)).body.server;
    const team = await owner.post("/workspaces", { name: "Team Two" });
    expect(team.status).toBe(201);
    await owner.post(`/workspaces/${team.body.workspace.id}/switch`);
    expect((await owner.get(`/servers/${server.id}`)).status).toBe(404);
    expect((await owner.patch(`/servers/${server.id}`, { name: "x" })).status).toBe(404);
    expect((await owner.delete(`/servers/${server.id}`)).status).toBe(404);
    expect((await owner.post(`/servers/${server.id}/join-command`)).status).toBe(404);
    expect((await owner.get(`/servers/${server.id}/metrics`)).status).toBe(404);
    expect((await owner.get(`/ssh-keys/${key.id}`)).status).toBe(404);
    expect((await owner.delete(`/ssh-keys/${key.id}`)).status).toBe(404);
    expect((await owner.get("/servers")).body.servers).toEqual([]);
    const borrowed = await addServer(owner, key.id, { name: "borrowed" });
    expect(borrowed.body.error.fields.sshKeyId).toBe(SERVER_MESSAGES.keyNotFound);
  });
});

describe("the Nearzero host as a target (spec 24 G3)", () => {
  test("only instance administrators and allowed workspaces get it; reading it stays theirs", async () => {
    const ownerTargets = await owner.get("/servers/targets");
    expect(ownerTargets.body.targets.map((t: { id: string }) => t.id)).toContain("host");
    const team = await owner.post("/workspaces", { name: "Team Two" });
    const teamId = team.body.workspace.id as string;
    await owner.post(`/workspaces/${teamId}/switch`);
    const admin = await addMemberThroughInvitation(harness, owner, "ann@example.com", {
      role: "admin",
    });
    await admin.post(`/workspaces/${teamId}/switch`);
    const refused = await admin.get("/host");
    expect(refused.status).toBe(404);
    expect((await admin.get("/servers/targets")).body.targets).toEqual([]);

    const allowed = await owner.put(`/host/allowed-workspaces/${teamId}`, { allowed: true });
    expect(allowed.status).toBe(200);
    const host = await admin.get("/host");
    expect(host.body.host).toMatchObject({ id: "host", available: true, canManage: false });
    expect(host.body.host.runner.system).toBeUndefined();
    expect(
      (await admin.get("/servers/targets")).body.targets.map((t: { id: string }) => t.id),
    ).toEqual(["host"]);
    // Containers, logs, terminals and metrics of the host stay with instance administrators.
    const containers = await admin.get("/servers/host/containers");
    expect(containers.status).toBe(403);
    expect(containers.body.error.message).toStartWith("Only Nearzero administrators");
    expect((await admin.get("/servers/host/metrics")).status).toBe(403);
    expect((await admin.get("/host/allowed-workspaces")).status).toBe(403);
  });

  test("B3-23: the host's workspace list tells same-named workspaces apart by owner and slug", async () => {
    await addMemberThroughInvitation(harness, owner, "mia@example.com");
    await addMemberThroughInvitation(harness, owner, "sam@example.com");
    const listed = (await owner.get("/host/allowed-workspaces")).body.workspaces as {
      name: string;
      slug: string;
      owner: string | null;
    }[];
    const personal = listed.filter((item) => item.name === "My Workspace");
    expect(personal.length).toBeGreaterThanOrEqual(2);
    const owners = personal.map((item) => item.owner ?? "");
    expect(owners.some((who) => who.includes("mia@example.com"))).toBe(true);
    expect(owners.some((who) => who.includes("sam@example.com"))).toBe(true);
    expect(new Set(personal.map((item) => `${item.owner} ${item.slug}`)).size).toBe(
      personal.length,
    );
  });

  test("an offline host runner is reported in plain words", async () => {
    const reply = await owner.get("/servers/host/containers");
    expect(reply.status).toBe(503);
    expect(reply.body.error.message).toContain("The Nearzero host's runner isn't connected");
  });
});

describe("routes (spec 10, 24 P7)", () => {
  test("are for instance administrators, and nothing is saved when the runner can't write them", async () => {
    const key = await addKey(owner);
    const server = (await addServer(owner, key.id)).body.server;
    const put = await owner.put(`/servers/${server.id}/routes/web`, {
      hostnames: ["app.example.com"],
      upstream: { host: "web", port: 80 },
    });
    expect(put.status).toBe(503);
    expect(put.body.error.message).toBe(
      `The runner on "prod-1" isn't connected, so Nearzero can't reach that server right now. Check that the server is on and can reach Nearzero; the runner reconnects by itself.`,
    );
    expect((await owner.get(`/servers/${server.id}/routes`)).body.routes).toEqual([]);
    const bad = await owner.put(`/servers/${server.id}/routes/web`, {
      hostnames: ["app`) || Host(`evil.com"],
      upstream: { host: "web", port: 80 },
    });
    expect(bad.status).toBe(400);
    const member = await memberWith(["servers.manage"], [server.id]);
    const refused = await member.get(`/servers/${server.id}/routes`);
    expect(refused.status).toBe(403);
  });
});

describe("router files (spec 18.3)", () => {
  async function serverWithFiles() {
    const key = await addKey(owner);
    const server = (await addServer(owner, key.id)).body.server as { id: string };
    const runner = await FakeRunner.connect(harness.test.db, harness.services.runners, server.id);
    const folder = new Map<string, string>([
      ["console.yml", "http: {}\n"],
      ["route-web.yml", "# Written by the Nearzero runner.\nhttp: {}\n"],
      ["legacy.toml", "[http]\n"],
    ]);
    runner.extraHandlers.set("router.files", async () => ({
      files: [...folder].map(([name, contents]) => ({ name, contents })),
    }));
    runner.extraHandlers.set("router.file-write", async (params) => {
      folder.set(String(params.name), String(params.contents));
      return { name: params.name, contents: params.contents };
    });
    return { server, folder };
  }

  const VALID = "http:\n  middlewares:\n    strip:\n      stripPrefix:\n        prefixes: [/x]\n";

  test("lists files with what may be edited, and saves only valid YAML the router accepts", async () => {
    const { server, folder } = await serverWithFiles();
    const listed = await owner.get(`/servers/${server.id}/router-files`);
    expect(listed.status).toBe(200);
    expect(listed.body.canEdit).toBe(true);
    const byName = Object.fromEntries(
      listed.body.files.map((file: { name: string }) => [file.name, file]),
    );
    expect(byName["console.yml"]).toMatchObject({ managed: false, editable: true });
    expect(byName["route-web.yml"]).toMatchObject({ managed: true, editable: false });
    expect(byName["legacy.toml"]).toMatchObject({ managed: false, editable: false });

    const saved = await owner.put(`/servers/${server.id}/router-files/my-rules.yml`, {
      contents: VALID,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.message).toBe("Router config updated");
    expect(folder.get("my-rules.yml")).toBe(VALID);

    const yaml = await owner.put(`/servers/${server.id}/router-files/my-rules.yml`, {
      contents: "http:\n  routers:\n    web: [\n",
    });
    expect(yaml.status).toBe(400);
    expect(yaml.body.error.message).toMatch(/^Line 3: This isn't valid YAML: /);
    expect(yaml.body.error.fields.contents).toBe(yaml.body.error.message);
    const schema = await owner.put(`/servers/${server.id}/router-files/my-rules.yml`, {
      contents: "http:\n  routers:\n    web:\n      service: web\n",
    });
    expect(schema.body.error.message).toBe('Line 3: "http.routers.web" needs a rule.');
    expect(folder.get("my-rules.yml")).toBe(VALID);

    const managed = await owner.put(`/servers/${server.id}/router-files/route-web.yml`, {
      contents: VALID,
    });
    expect(managed.status).toBe(400);
    expect(managed.body.error.message).toBe(
      "Managed by Nearzero; changes are overwritten on the next deploy.",
    );
    const outside = await owner.put(`/servers/${server.id}/router-files/..%2Fescape.yml`, {
      contents: VALID,
    });
    expect(outside.status).toBe(400);
    expect(outside.body.error.message).toContain("Paths outside it are refused");
    expect(folder.has("../escape.yml")).toBe(false);

    const audit = await harness.test.db
      .selectFrom("audit_event")
      .select(["action", "details"])
      .where("action", "=", "router-file.saved")
      .execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.details).toMatchObject({ file: "my-rules.yml" });
  });

  test("members see files with See router files, and save them only where they manage the server", async () => {
    const { server } = await serverWithFiles();
    const reader = await memberWith(["router-files.read"], [server.id]);
    const read = await reader.get(`/servers/${server.id}/router-files`);
    expect(read.status).toBe(200);
    expect(read.body.canEdit).toBe(false);
    expect(read.body.files.every((file: { editable: boolean }) => !file.editable)).toBe(true);
    const refused = await reader.put(`/servers/${server.id}/router-files/my-rules.yml`, {
      contents: VALID,
    });
    expect(refused.status).toBe(403);

    const personId = await personIdOf(harness, "mia@example.com");
    await owner.put(`/workspace/members/${personId}/access`, {
      policyIds: [],
      capabilities: ["router-files.read", "servers.manage"],
      scope: {
        allProjects: false,
        projectIds: [],
        environmentIds: [],
        serviceIds: [],
        allServers: false,
        serverIds: [server.id],
        allGitAccounts: false,
        gitAccountIds: [],
      },
    });
    const allowed = await reader.put(`/servers/${server.id}/router-files/my-rules.yml`, {
      contents: VALID,
    });
    expect(allowed.status).toBe(200);
    await owner.put(`/workspace/members/${personId}/access`, {
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
        gitAccountIds: [],
      },
    });
    expect((await reader.get(`/servers/${server.id}/router-files`)).status).toBe(404);
  });
});

describe("join tokens and credentials (spec 25 D1, 22.4 rule 7)", () => {
  test("a join token works once, and joining again rotates the credential", async () => {
    const key = await addKey(owner);
    const server = (await addServer(owner, key.id)).body.server;
    const join = await owner.post(`/servers/${server.id}/join-command`);
    // The console's plain http:// address is never a runner's (G3-01, C2-09): with no encrypted
    // address there is no command (runner-link-address.test.ts has the encrypted ones).
    expect(join.body.command).toBeNull();
    expect(join.body.controlUrl).toBeNull();
    expect(join.body.note).toContain("no encrypted address servers can reach yet");
    expect(join.body.token).toStartWith("nzj1.");
    const system = { runnerVersion: "1.0.0-dev", protocol: 1, minProtocol: 1 };
    const enroll = await owner.post("/runner/enroll", { joinToken: join.body.token, ...system });
    expect(enroll.status).toBe(201);
    expect(enroll.body).toMatchObject({ serverId: server.id, serverName: "prod-1" });
    const again = await owner.post("/runner/enroll", { joinToken: join.body.token, ...system });
    expect(again.status).toBe(401);
    expect(again.body.error.message).toBe(JOIN_TOKEN_REFUSED);

    const check = await harness.app.request("/api/v1/runner/check", {
      headers: { authorization: `Bearer ${enroll.body.credential}` },
    });
    expect(check.status).toBe(200);
    const second = await owner.post(`/servers/${server.id}/join-command`);
    const rotated = await owner.post("/runner/enroll", { joinToken: second.body.token, ...system });
    expect(rotated.status).toBe(201);
    expect(await verifyCredential(harness.test.db, enroll.body.credential)).toBeNull();
    expect(await verifyCredential(harness.test.db, rotated.body.credential)).not.toBeNull();
    const refused = await harness.app.request("/api/v1/runner/check", {
      headers: { authorization: `Bearer ${enroll.body.credential}` },
    });
    expect(refused.status).toBe(401);
  });

  test("expired tokens, wrong secrets and outdated runners are refused", async () => {
    const key = await addKey(owner);
    const server = (await addServer(owner, key.id)).body.server;
    const expired = await createJoinToken(harness.test.db, server.id, { ttlMs: -1000 });
    await expect(redeemJoinToken(harness.test.db, expired.token)).rejects.toThrow(
      JOIN_TOKEN_REFUSED,
    );
    const fresh = await createJoinToken(harness.test.db, server.id);
    const tampered = `${fresh.token.slice(0, -4)}AAAA`;
    await expect(redeemJoinToken(harness.test.db, tampered)).rejects.toThrow(JOIN_TOKEN_REFUSED);
    const outdated = await owner.post("/runner/enroll", {
      joinToken: fresh.token,
      runnerVersion: "0.9.0",
      protocol: 0 + 1,
      minProtocol: 99,
    });
    expect(outdated.status).toBe(409);
    expect(outdated.body.error.message).toContain("needs a newer Nearzero");
    // The refused enrollment didn't use the token up.
    expect((await redeemJoinToken(harness.test.db, fresh.token)).serverId).toBe(server.id);
    expect(await verifyCredential(harness.test.db, "nzr1.not-a-runner.secret")).toBeNull();
  });
});
