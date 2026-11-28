import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { checkCredential, enroll } from "../../../runner/src/credentials.ts";
import type { DockerClient } from "../../../runner/src/docker/client.ts";
import { linkFetch } from "../../../runner/src/link/link.ts";
import { createLog, silentLog as silentRunnerLog } from "../../../runner/src/log.ts";
import { Router } from "../../../runner/src/router/router.ts";
import { RunnerSession } from "../../../runner/src/session.ts";
import { ObjectRegistry } from "../src/access/objects.ts";
import { registerProjectObjects } from "../src/projects/objects.ts";
import { HOST_TARGET } from "../src/runners/hub.ts";
import {
  cancelNextLinkCertificate,
  createLinkCertificate,
  createNextLinkCertificate,
  ensureLinkCertificate,
  LINK_CERTIFICATE_FILE,
  LINK_KEY_FILE,
  NEXT_KEY_FILE,
  nextPinToAnnounce,
  PREVIOUS_CERTIFICATE_FILE,
  PREVIOUS_INFO_FILE,
  PREVIOUS_KEPT_MS,
  PREVIOUS_KEY_FILE,
  prunePreviousLinkCertificate,
  readNextLinkCertificate,
  readPreviousLinkCertificate,
  switchLinkCertificate,
} from "../src/runners/link-certificate.ts";
import { isRunnerLinkPath, serveRunnerLink } from "../src/runners/link-paths.ts";
import { registerServerObjects } from "../src/servers/servers.ts";
import { generateKeyPair } from "../src/ssh-keys/format.ts";
import { type Browser, createHarness, type Harness, setUpNamedOwner } from "./support/harness.ts";

/**
 * Where servers reach Nearzero, and the runner link's own TLS port (spec 31 "Remote runners are
 * always encrypted"; 31c G3-01; C2-07; C2-09):
 *
 * - the join command carries an encrypted address only, with the fingerprint of Nearzero's own
 *   certificate when there is no domain, and moves to the console's hostname once the host's
 *   router holds a valid certificate for it;
 * - the console's plain address, set outright or not, is never given;
 * - the certificate is made once and kept, so restarts and reruns keep every pin working;
 * - a real runner session joins and connects over that port, and only with that certificate.
 */

// A busy machine makes the database slow to create and drop.
setDefaultTimeout(120_000);
let harness: Harness;
let owner: Browser;
let directory: string;
const link = createLinkCertificate(["203.0.113.10"]);

async function addServer(): Promise<string> {
  const keys = await generateKeyPair("ed25519", "test");
  const key = await owner.post("/ssh-keys", { name: "deploy", ...keys });
  const server = await owner.post("/servers", {
    name: "prod-1",
    sshKeyId: key.body.key.id,
    address: "198.51.100.20",
    sshUser: "ubuntu",
  });
  if (server.status !== 201) throw new Error(JSON.stringify(server.body));
  return server.body.server.id as string;
}

beforeAll(async () => {
  const objects = new ObjectRegistry();
  registerProjectObjects(objects);
  registerServerObjects(objects);
  harness = await createHarness({
    // A console address set outright, plain (C2-09): never a runner's address.
    consoleUrl: "http://203.0.113.10:4321",
    extra: {
      objects,
      runnerLinkPort: { port: 3443, fingerprint: link.fingerprint },
      publicIp: "203.0.113.10",
    },
  });
  owner = await setUpNamedOwner(harness);
  directory = await mkdtemp(join(tmpdir(), "nz-link-cert-"));
}, 60_000);

afterAll(async () => {
  harness?.services.runners.stop();
  await harness?.drop();
  await rm(directory, { recursive: true, force: true });
});

describe("the address servers are given", () => {
  test("without a domain: Nearzero's own TLS port, with the certificate's fingerprint", async () => {
    const serverId = await addServer();
    const join = await owner.post(`/servers/${serverId}/join-command`);
    expect(join.body.controlUrl).toBe("https://203.0.113.10:3443");
    expect(join.body.controlFingerprint).toBe(link.fingerprint);
    expect(join.body.command).toBe(
      `sudo nearzero-runner join https://203.0.113.10:3443 --fingerprint sha256:${link.fingerprint}`,
    );
    expect(await harness.services.runnerLink()).toEqual({
      url: "https://203.0.113.10:3443",
      fingerprint: link.fingerprint,
    });
  });

  test("a hostname saved under About Nearzero counts once its certificate is valid", async () => {
    await harness.test.db
      .insertInto("address_setting")
      .values({ key: "console_hostname", value: "nz.example.com" })
      .execute();
    // No certificate yet: the hostname can't be reached over HTTPS, so the TLS port stays.
    expect((await harness.services.runnerLink())?.url).toBe("https://203.0.113.10:3443");
    const status = (notAfter: number) =>
      JSON.stringify({
        readable: true,
        error: null,
        certificates: [{ names: ["nz.example.com"], notBefore: 0, notAfter, issuer: "R11" }],
        uploaded: [],
        attempts: [],
        holds: [],
        backoff: [],
        checkedAt: Date.now(),
      });
    await harness.test.db
      .insertInto("certificate_snapshot")
      .values({ target: HOST_TARGET, status: status(Date.now() - 1000), error: null })
      .execute();
    expect((await harness.services.runnerLink())?.url).toBe("https://203.0.113.10:3443");
    await harness.test.db
      .updateTable("certificate_snapshot")
      .set({ status: status(Date.now() + 86_400_000) })
      .execute();
    expect(await harness.services.runnerLink()).toEqual({
      url: "https://nz.example.com",
      fingerprint: null,
    });
    const serverId = (
      await harness.test.db.selectFrom("server").select("id").executeTakeFirstOrThrow()
    ).id;
    const join = await owner.post(`/servers/${serverId}/join-command`);
    expect(join.body.command).toBe("sudo nearzero-runner join https://nz.example.com");
    await sql`delete from certificate_snapshot; delete from address_setting`.execute(
      harness.test.db,
    );
  });
});

describe("the runner link's certificate", () => {
  test("made once, kept on every later start, private key owner-only", async () => {
    const first = await ensureLinkCertificate(directory, ["203.0.113.10"]);
    expect(first.created).toBe(true);
    expect((await stat(join(directory, LINK_KEY_FILE))).mode & 0o777).toBe(0o600);
    const again = await ensureLinkCertificate(directory, ["198.51.100.99"]);
    expect(again).toMatchObject({ created: false, fingerprint: first.fingerprint });
  });

  test("a pair that doesn't belong together stops the link rather than replacing it", async () => {
    const other = createLinkCertificate();
    const saved = await readFile(join(directory, LINK_CERTIFICATE_FILE), "utf8");
    await writeFile(join(directory, LINK_CERTIFICATE_FILE), other.certificate);
    await expect(ensureLinkCertificate(directory)).rejects.toThrow("don't belong together");
    await writeFile(join(directory, LINK_CERTIFICATE_FILE), saved);
  });

  test("C4-10: a certificate whose key is gone stops the link, naming the files", async () => {
    const before = await ensureLinkCertificate(directory);
    const key = await readFile(join(directory, LINK_KEY_FILE), "utf8");
    await rm(join(directory, LINK_KEY_FILE));
    // A removed key or a partial restore: making a new pair would cut every pinned server off.
    const error = await ensureLinkCertificate(directory).then(
      () => null,
      (problem: Error) => problem.message,
    );
    expect(error).toContain(join(directory, LINK_KEY_FILE));
    expect(error).toContain("isn't");
    expect(await readFile(join(directory, LINK_CERTIFICATE_FILE), "utf8")).toBe(before.certificate);
    await writeFile(join(directory, LINK_KEY_FILE), key, { mode: 0o600 });
    expect((await ensureLinkCertificate(directory)).fingerprint).toBe(before.fingerprint);
  });

  test("C4-10: a key without its certificate (an interrupted first start) is made again", async () => {
    await rm(join(directory, LINK_CERTIFICATE_FILE));
    const made = await ensureLinkCertificate(directory);
    expect(made).toMatchObject({ created: true, replaced: true });
  });

  test("C4-10: the pair is replaced in two steps, the next one made beside it first", async () => {
    const current = await ensureLinkCertificate(directory);
    expect(await readNextLinkCertificate(directory)).toBeNull();
    const next = await createNextLinkCertificate(directory);
    expect(next.created).toBe(true);
    expect(next.fingerprint).not.toBe(current.fingerprint);
    // Made once: asking again gives the one waiting.
    expect((await createNextLinkCertificate(directory)).fingerprint).toBe(next.fingerprint);
    expect((await readNextLinkCertificate(directory))?.fingerprint).toBe(next.fingerprint);
    expect((await stat(join(directory, NEXT_KEY_FILE))).mode & 0o777).toBe(0o600);
    // The current pair is untouched until the switch.
    expect((await ensureLinkCertificate(directory)).fingerprint).toBe(current.fingerprint);
    const switched = await switchLinkCertificate(directory);
    expect(switched).toEqual({ previous: current.fingerprint, current: next.fingerprint });
    expect((await ensureLinkCertificate(directory)).fingerprint).toBe(next.fingerprint);
    expect((await readFile(join(directory, "fingerprint"), "utf8")).trim()).toBe(next.fingerprint);
    expect(await readNextLinkCertificate(directory)).toBeNull();
    expect(await readFile(join(directory, PREVIOUS_CERTIFICATE_FILE), "utf8")).toBe(
      current.certificate,
    );
    await expect(switchLinkCertificate(directory)).rejects.toThrow("No next pair");
    // And one made but not wanted is dropped.
    await createNextLinkCertificate(directory);
    const dropped = await createNextLinkCertificate(directory);
    expect(await cancelNextLinkCertificate(directory)).toBe(dropped.fingerprint);
    expect(await cancelNextLinkCertificate(directory)).toBeNull();
    expect(await readNextLinkCertificate(directory)).toBeNull();
  });

  test("C4-14: a switch stopped between its two files is finished by running it again", async () => {
    // recheck-switch-interrupt: the new key was written, the certificate not yet. The port stayed
    // off and `switch` refused to run again.
    const dir = await mkdtemp(join(directory, "interrupted-"));
    const current = await ensureLinkCertificate(dir);
    const next = await createNextLinkCertificate(dir);
    // Where the switch stopped: the served pair kept as the previous one, then the new key in
    // place, and not yet the new certificate.
    await copyFile(join(dir, LINK_KEY_FILE), join(dir, PREVIOUS_KEY_FILE));
    await copyFile(join(dir, LINK_CERTIFICATE_FILE), join(dir, PREVIOUS_CERTIFICATE_FILE));
    await writeFile(
      join(dir, PREVIOUS_INFO_FILE),
      JSON.stringify({ fingerprint: current.fingerprint, switchedAt: new Date().toISOString() }),
    );
    await copyFile(join(dir, NEXT_KEY_FILE), join(dir, LINK_KEY_FILE));
    const atStart = await ensureLinkCertificate(dir).then(
      () => "port on",
      (error: Error) => error.message,
    );
    expect(atStart).toContain("was interrupted");
    expect(atStart).toContain("sudo nearzero runner-link switch");
    // Finished; the pair kept for going back is the one that was served.
    expect(await switchLinkCertificate(dir)).toEqual({
      previous: current.fingerprint,
      current: next.fingerprint,
    });
    expect((await ensureLinkCertificate(dir)).fingerprint).toBe(next.fingerprint);
    expect(await readFile(join(dir, PREVIOUS_CERTIFICATE_FILE), "utf8")).toBe(current.certificate);
    expect(await readNextLinkCertificate(dir)).toBeNull();
    // Any other broken pair is left alone for a person to put right.
    const other = await mkdtemp(join(directory, "broken-"));
    await ensureLinkCertificate(other);
    await createNextLinkCertificate(other);
    await writeFile(join(other, LINK_KEY_FILE), createLinkCertificate().key);
    await expect(switchLinkCertificate(other)).rejects.toThrow("don't belong together");
  });

  test("C4-14: the replaced pair goes once every server has moved, or a week after the switch", async () => {
    const dir = await mkdtemp(join(directory, "previous-"));
    const first = await ensureLinkCertificate(dir);
    await createNextLinkCertificate(dir);
    const switchedAt = new Date("2026-11-20T10:00:00Z");
    await switchLinkCertificate(dir, switchedAt);
    expect(await readPreviousLinkCertificate(dir)).toEqual({
      fingerprint: first.fingerprint,
      switchedAt,
    });
    expect((await stat(join(dir, PREVIOUS_KEY_FILE))).mode & 0o777).toBe(0o600);
    // Servers still to reconnect, within the week: kept.
    const soon = new Date(switchedAt.getTime() + 86_400_000);
    expect(
      await prunePreviousLinkCertificate(dir, { everyServerMoved: false, now: soon }),
    ).toBeNull();
    expect(await readPreviousLinkCertificate(dir)).not.toBeNull();
    // Every server reconnected to the new pair: removed, key and all.
    expect(await prunePreviousLinkCertificate(dir, { everyServerMoved: true, now: soon })).toBe(
      first.fingerprint,
    );
    expect(await readPreviousLinkCertificate(dir)).toBeNull();
    await expect(stat(join(dir, PREVIOUS_KEY_FILE))).rejects.toThrow();
    // Or a week passed, whoever is still away.
    await createNextLinkCertificate(dir);
    await switchLinkCertificate(dir, switchedAt);
    const later = new Date(switchedAt.getTime() + PREVIOUS_KEPT_MS + 1);
    expect(
      await prunePreviousLinkCertificate(dir, { everyServerMoved: false, now: later }),
    ).not.toBeNull();
    await expect(stat(join(dir, PREVIOUS_KEY_FILE))).rejects.toThrow();
  });

  test("C4-13: between the switch and the restart, the new pin is still the one announced", async () => {
    const dir = await mkdtemp(join(directory, "window-"));
    const served = await ensureLinkCertificate(dir);
    expect(await nextPinToAnnounce(dir, served.fingerprint)).toBeNull();
    const next = await createNextLinkCertificate(dir);
    expect(await nextPinToAnnounce(dir, served.fingerprint)).toBe(next.fingerprint);
    // `switch` removed link.next.*; this process still serves the old pair until it restarts.
    await switchLinkCertificate(dir);
    expect(await readNextLinkCertificate(dir)).toBeNull();
    expect(await nextPinToAnnounce(dir, served.fingerprint)).toBe(next.fingerprint);
    // Restarted, it serves the new pair: nothing more to announce.
    expect(await nextPinToAnnounce(dir, next.fingerprint)).toBeNull();
  });

  test("the TLS port serves runner routes and the health check only", () => {
    expect(isRunnerLinkPath("/api/v1/runner/connect")).toBe(true);
    expect(isRunnerLinkPath("/api/v1/runner/uploads/abc")).toBe(true);
    expect(isRunnerLinkPath("/api/v1/health")).toBe(true);
    expect(isRunnerLinkPath("/api/v1/auth/sign-in")).toBe(false);
    expect(isRunnerLinkPath("/api/v1/webhooks/deploy/x")).toBe(false);
  });
});

describe("a runner over the TLS port", () => {
  test("joins and connects with the pinned certificate; another certificate gets nothing", async () => {
    const serverId = await addServer().catch(async () => {
      return (await harness.test.db.selectFrom("server").select("id").executeTakeFirstOrThrow()).id;
    });
    const server = serveRunnerLink(harness.app, {
      hostname: "127.0.0.1",
      port: 0,
      certificate: link.certificate,
      key: link.key,
      idleTimeoutSeconds: 120,
    });
    const pinned = { url: `https://127.0.0.1:${server.port}`, fingerprint: link.fingerprint };
    // This test's port and address are the install's (otherwise the runner is moved there).
    const settings = harness.services.runnerLinkSettings;
    const before = { pinned: settings.pinned, publicIp: settings.publicIp };
    settings.pinned = { port: server.port as number, fingerprint: link.fingerprint };
    settings.publicIp = "127.0.0.1";
    try {
      // Pages and the console's API aren't served there.
      const page = await linkFetch(pinned)(`${pinned.url}/api/v1/auth/session`);
      expect(page.status).toBe(404);

      const joining = await owner.post(`/servers/${serverId}/join-command`);
      // Another certificate (someone between the server and Nearzero): joining is refused
      // before the token leaves the server, so it still works afterwards.
      const impostor = { ...pinned, fingerprint: createLinkCertificate().fingerprint };
      await expect(
        enroll(impostor.url, joining.body.token, {}, linkFetch(impostor)),
      ).rejects.toThrow("isn't Nearzero's");
      const enrolled = await enroll(pinned.url, joining.body.token, {}, linkFetch(pinned));
      expect(enrolled.serverId).toBe(serverId);
      expect(
        (await checkCredential(pinned.url, enrolled.credential, linkFetch(pinned))).result,
      ).toBe("accepted");

      const state = await mkdtemp(join(directory, "runner-"));
      const docker = {
        negotiate: async () => {
          throw new Error("no docker here");
        },
        info: async () => {
          throw new Error("no docker here");
        },
        findNetwork: async () => null,
        listContainers: async () => {
          throw new Error("no docker here");
        },
        async *events(signal: AbortSignal) {
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        },
      } as unknown as DockerClient;
      const session = new RunnerSession({
        controlUrl: pinned.url,
        controlFingerprint: pinned.fingerprint,
        stateDirectory: state,
        credential: async () => enrolled.credential,
        onCredentialRefused: async () => null,
        check: (credential, current) =>
          checkCredential(current.url, credential, linkFetch(current)),
        docker,
        router: new Router(
          docker,
          {
            directory: state,
            hostDirectory: state,
            image: "traefik:v3.7.18",
            acmeEmail: "",
            httpPort: 80,
            httpsPort: 443,
            network: "nearzero-edge",
          },
          silentRunnerLog,
        ),
        manageRouter: false,
        log: process.env.NZ_DEBUG ? createLog("debug") : silentRunnerLog,
        workDirectory: join(state, "work"),
        dockerSocket: "/nowhere.sock",
        containerized: false,
      });
      void session.run();
      const deadline = Date.now() + 15_000;
      while (!harness.services.runners.isOnline(serverId) && Date.now() < deadline)
        await Bun.sleep(50);
      expect(harness.services.runners.isOnline(serverId)).toBe(true);
      expect(await harness.services.runners.command(serverId, "router.files", {})).toHaveProperty(
        "files",
      );
      const row = await harness.test.db
        .selectFrom("runner")
        .select(["link_url", "link_problem"])
        .where("server_id", "=", serverId)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ link_url: pinned.url, link_problem: null });
      // C4-06: its welcome gave it the TLS port with its fingerprint as its fallback.
      const deadlineFallback = Date.now() + 5_000;
      while (!session.fallback && Date.now() < deadlineFallback) await Bun.sleep(20);
      expect(session.fallback).toEqual(pinned);
      session.stop();
      while (harness.services.runners.isOnline(serverId)) await Bun.sleep(20);
      // C4-05: what the hub records when it refuses a runner on plain HTTP is what the server's
      // page says.
      const problem =
        "prod-1's runner reaches Nearzero over plain HTTP, which Nearzero never uses for a server. Run setup again on the server.";
      await harness.test.db
        .updateTable("runner")
        .set({ link_problem: problem })
        .where("server_id", "=", serverId)
        .execute();
      const view = (await owner.get(`/servers/${serverId}`)).body.server.runner;
      expect(view).toMatchObject({ state: "offline", message: problem });
    } finally {
      settings.pinned = before.pinned;
      settings.publicIp = before.publicIp;
      server.stop(true);
    }
  }, 60_000);
});
