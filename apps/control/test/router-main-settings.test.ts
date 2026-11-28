import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ROUTER_MAIN_SETTINGS, SETUP_MESSAGES } from "@nearzero/shared";
import { sql } from "kysely";
import { ObjectRegistry } from "../src/access/objects.ts";
import { registerProjectObjects } from "../src/projects/objects.ts";
import { firewallScript } from "../src/server-setup/scripts.ts";
import { registerServerObjects } from "../src/servers/servers.ts";
import { generateKeyPair } from "../src/ssh-keys/format.ts";
import { FakeRunner } from "./support/fake-runner.ts";
import {
  type Browser,
  createHarness,
  type Harness,
  INSTANCE_RESEND,
  setUpNamedOwner,
} from "./support/harness.ts";

/**
 * The router's main settings in Router files, read-only (R3-23, spec 18.3), and HTTP/3 on a
 * server's details (R3-22): what the runner reports reaches the server's view in plain words.
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
  await sql`truncate ssh_key, server, runner, runner_join_token, router_route cascade`.execute(
    harness.test.db,
  );
  owner = await setUpNamedOwner(harness);
}, 30_000);

async function serverWithRunner() {
  const key = await owner.post("/ssh-keys", { name: "deploy", ...ed25519 });
  const created = await owner.post("/servers", {
    name: "prod-1",
    sshKeyId: key.body.key.id,
    address: "203.0.113.10",
    sshUser: "ubuntu",
  });
  const server = created.body.server as { id: string };
  const runner = await FakeRunner.connect(harness.test.db, harness.services.runners, server.id);
  return { server, runner };
}

const MAIN = `# The router's main settings, as Nearzero sets them when it starts the router.
entryPoints:
  websecure:
    address: ":8443"
    http3:
      advertisedPort: 443
`;

describe("Router files' main settings (R3-23)", () => {
  test("are listed read-only beside the folder's files, and can't be saved", async () => {
    const { server, runner } = await serverWithRunner();
    const writes: unknown[] = [];
    runner.extraHandlers.set("router.files", async () => ({
      files: [{ name: "console.yml", contents: "http: {}\n" }],
      mainSettings: MAIN,
    }));
    runner.extraHandlers.set("router.file-write", async (params) => {
      writes.push(params);
      return params;
    });
    const listed = await owner.get(`/servers/${server.id}/router-files`);
    expect(listed.status).toBe(200);
    expect(listed.body.canEdit).toBe(true);
    // The folder's files are listed as before; the main settings beside them.
    expect(listed.body.files.map((file: { name: string }) => file.name)).toEqual(["console.yml"]);
    expect(listed.body.mainSettings).toEqual({
      name: "main-settings",
      title: "Main settings",
      contents: MAIN,
      note: "Nearzero sets these when it starts the router, so they can't be edited here.",
      managed: true,
      editable: false,
    });
    // Nothing there is editable: a save is refused with the reason and never reaches the runner.
    const refused = await owner.put(
      `/servers/${server.id}/router-files/${ROUTER_MAIN_SETTINGS.name}`,
      { contents: "entryPoints: {}\n" },
    );
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toBe(ROUTER_MAIN_SETTINGS.note);
    expect(writes).toEqual([]);
  });

  test("an older runner that doesn't send them shows none", async () => {
    const { server, runner } = await serverWithRunner();
    runner.extraHandlers.set("router.files", async () => ({ files: [] }));
    const listed = await owner.get(`/servers/${server.id}/router-files`);
    expect(listed.status).toBe(200);
    expect(listed.body.mainSettings).toBeNull();
  });
});

describe("HTTP/3 on a server's details (R3-22)", () => {
  test("a router without HTTP/3 because UDP 443 is taken says so and names the program", async () => {
    const { server, runner } = await serverWithRunner();
    // A runner that doesn't report HTTP/3 (older): nothing is shown.
    await runner.sendRouterState();
    expect((await owner.get(`/servers/${server.id}`)).body.server.runner.http3).toBeNull();
    await runner.sendRouterState({ http3: { enabled: true, port: 443, blockedBy: null } });
    expect((await owner.get(`/servers/${server.id}`)).body.server.runner.http3).toEqual({
      enabled: true,
      message: null,
    });
    await runner.sendRouterState({ http3: { enabled: false, port: 443, blockedBy: "caddy" } });
    expect((await owner.get(`/servers/${server.id}`)).body.server.runner.http3).toEqual({
      enabled: false,
      message: "HTTP/3 is off: UDP port 443 is in use by caddy",
    });
    // Once the runner is gone, it isn't known any more.
    runner.disconnect();
    await Bun.sleep(50);
    expect((await owner.get(`/servers/${server.id}`)).body.server.runner.http3).toBeNull();
  });
});

describe("HTTP/3's port in setup (R3-22)", () => {
  test("setup's firewall step and the cloud firewall reminder keep 443/udp", () => {
    const script = firewallScript();
    expect(script).toContain("ufw allow 443/udp");
    expect(script).toContain("--add-port=443/udp");
    expect(script).toContain('"-p udp --dport 443"');
    expect(SETUP_MESSAGES.cloudFirewall).toContain("443/udp");
  });
});
