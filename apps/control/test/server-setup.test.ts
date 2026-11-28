import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  passwordlessSudoMessage,
  SETUP_MESSAGES,
  SETUP_STALLED_MS,
  wrongUserMessage,
} from "@nearzero/shared";
import { sql } from "kysely";
import { loadGrants, WorkspaceAccess } from "../src/access/grants.ts";
import { ObjectRegistry } from "../src/access/objects.ts";
import { serverSetupPort } from "../src/agent/adapters/server-setup.ts";
import type { WorkspaceActor } from "../src/http/actor.ts";
import { registerProjectObjects } from "../src/projects/objects.ts";
import type { Socket, SocketHandler } from "../src/runners/sockets.ts";
import { carryOutSetup } from "../src/server-setup/job.ts";
import { configureServerSetup } from "../src/server-setup/settings.ts";
import {
  type CommandResult,
  type ExecOptions,
  type HostKeyPolicy,
  type ShellSize,
  SshFailure,
  type SshSession,
  type SshShell,
  type SshTarget,
} from "../src/server-setup/ssh.ts";
import { registerServerObjects } from "../src/servers/servers.ts";
import { generateKeyPair } from "../src/ssh-keys/format.ts";
import { isInstanceAdmin, resolveActiveWorkspace } from "../src/workspaces/workspaces.ts";
import {
  addMemberThroughInvitation,
  type Browser,
  createHarness,
  type Harness,
  INSTANCE_RESEND,
  setUpNamedOwner,
} from "./support/harness.ts";
import { addMember } from "./support/projects.ts";

/**
 * Setup runs over SSH against a scripted server (spec 09 9.2, 9.3, 9.6, 9.8): the failures a
 * person can act on, the wrong-user button, host keys, a failed step's sentence, the stalled
 * rule, the daily cleanup switch and deleting with services. The steps themselves run against
 * real servers in e2e/server-setup.
 */

const UBUNTU = `PRETTY_NAME="Ubuntu 24.04.3 LTS"\nID=ubuntu\nID_LIKE=debian\nVERSION_CODENAME=noble\nUBUNTU_CODENAME=noble\n`;
const FINGERPRINT = "SHA256:Zk0rbqH3s1Q6s3o8V5mJmQm2d2S0QjG4mS4nE3bVb8A";

interface Script {
  /** What a sign-in as each user does. */
  users: Record<
    string,
    | {
        kind: "ok";
        sudo?: "works" | "password";
        release?: string;
        failStep?: { marker: string; code: number; stderr: string };
      }
    | { kind: "wrong_user"; asks: string }
    | { kind: "reject" }
    | { kind: "unreachable" }
  >;
  fingerprint: string;
  commands: string[];
  /** Interactive shells opened (the server Terminal): their sizes and what was typed. */
  shells: { user: string; sizes: ShellSize[]; typed: string; closed: boolean }[];
  /** Makes opening a shell fail after signing in. */
  shellRefused?: boolean;
  /** How many times each read-only probe ran: setup validation and the security audit. */
  probes: { validation: number; audit: number };
  /** What the audit probe answers. */
  audit?: string;
}

const server: Script = {
  users: {},
  fingerprint: FINGERPRINT,
  commands: [],
  shells: [],
  probes: { validation: 0, audit: 0 },
};

/** A login shell that echoes each line as "$ <line>" and ends on "exit". */
function fakeShell(user: string, size: ShellSize): SshShell {
  const record = { user, sizes: [size], typed: "", closed: false };
  server.shells.push(record);
  const data: ((bytes: Uint8Array) => void)[] = [];
  const closers: ((code: number | null) => void)[] = [];
  const emit = (text: string) => {
    for (const listener of data) listener(new TextEncoder().encode(text));
  };
  const end = (code: number | null) => {
    if (record.closed) return;
    record.closed = true;
    for (const listener of closers) listener(code);
  };
  queueMicrotask(() => emit(`${user}@prod-1:~$ `));
  return {
    write(bytes) {
      record.typed += new TextDecoder().decode(bytes);
      const lines = record.typed.split("\r");
      const last = lines.at(-2);
      if (lines.length > 1 && last !== undefined) {
        if (last.trim() === "exit") end(0);
        else emit(`$ ${last}\r\n`);
      }
    },
    resize(next) {
      record.sizes.push(next);
    },
    onData(listener) {
      data.push(listener);
    },
    onClose(listener) {
      closers.push(listener);
    },
    close() {
      end(null);
    },
  };
}

function result(stdout: string, code = 0, stderr = ""): CommandResult {
  return { code, signal: null, stdout, stderr };
}

function connector() {
  return {
    async connect(target: SshTarget, policy: HostKeyPolicy): Promise<SshSession> {
      const user = server.users[target.user] ?? { kind: "reject" };
      if (user.kind === "unreachable") throw new SshFailure("unreachable", "connection refused");
      if (policy.expected && policy.expected !== server.fingerprint) {
        throw new SshFailure("host_key_changed", "changed", server.fingerprint);
      }
      if (!policy.expected && policy.strict) {
        throw new SshFailure("host_key_unknown", "unknown", server.fingerprint);
      }
      if (user.kind === "reject") throw new SshFailure("key_rejected", "refused");
      return {
        fingerprint: server.fingerprint,
        close() {},
        async shell(size: ShellSize) {
          if (server.shellRefused) throw new SshFailure("closed", "no pty");
          return fakeShell(target.user, size);
        },
        async exec(command: string, options: ExecOptions = {}) {
          server.commands.push(command);
          if (user.kind === "wrong_user") {
            return result(
              `Please login as the user "${user.asks}" rather than the user "${target.user}".\n\n`,
              142,
            );
          }
          if (command.startsWith("echo ::nz-ok::")) return result("::nz-ok::\n");
          if (command === "sudo -n true") {
            return user.sudo === "password"
              ? result("", 1, "sudo: a password is required\n")
              : result("");
          }
          const input = typeof options.stdin === "string" ? options.stdin : "";
          if (input.includes("::ban::begin")) {
            server.probes.audit++;
            return result(server.audit ?? "");
          }
          if (input.includes("router_dir_owner")) server.probes.validation++;
          if (input.includes("::os-release::begin")) {
            return result(
              `uid=${target.user === "root" ? 0 : 1000}\nuser=${target.user}\narch=x86_64\nbash=/bin/bash\nsudo=/usr/bin/sudo\nsystemd=yes\nmem_kb=2000000\nswap_kb=0\ndisk_free_kb=40000000\n::os-release::begin\n${user.release ?? UBUNTU}::os-release::end\n`,
            );
          }
          if (user.failStep && input.includes(user.failStep.marker)) {
            options.onData?.("::nz-doing::Installing basic tools: jq\n", "out");
            options.onData?.(`${user.failStep.stderr}\n`, "err");
            options.onData?.(`::nz-failed::${user.failStep.code}::apt-get install -y jq\n`, "err");
            return result("", user.failStep.code, user.failStep.stderr);
          }
          options.onData?.("::nz-note::Nothing was left over.\n", "out");
          return result("");
        },
      };
    },
  };
}

// Each test signs an owner up (password hashing) and carries a run out against the database.
setDefaultTimeout(60_000);

let harness: Harness;
let owner: Browser;
let keyPair: { publicKey: string; privateKey: string };

beforeAll(async () => {
  const objects = new ObjectRegistry();
  registerProjectObjects(objects);
  registerServerObjects(objects);
  harness = await createHarness({
    instanceEmail: INSTANCE_RESEND,
    extra: { objects, runnerControlUrl: "https://nearzero.example.com" },
  });
  configureServerSetup(harness.services, { connector: connector(), strictHostKeyChecking: false });
  keyPair = await generateKeyPair("ed25519", "setup");
}, 60_000);

afterAll(async () => {
  harness?.services.runners.stop();
  await harness?.drop();
});

beforeEach(async () => {
  await harness.reset();
  await sql`truncate ssh_key, server, runner, runner_join_token, server_setup_run, docker_cleanup, server_removal, job cascade`.execute(
    harness.test.db,
  );
  configureServerSetup(harness.services, { strictHostKeyChecking: false });
  server.users = {};
  server.fingerprint = FINGERPRINT;
  server.commands = [];
  server.shells = [];
  server.shellRefused = false;
  server.probes = { validation: 0, audit: 0 };
  server.audit = undefined;
  owner = await setUpNamedOwner(harness);
}, 30_000);

async function addServer(user = "root"): Promise<string> {
  const key = await owner.post("/ssh-keys", { name: "deploy", ...keyPair });
  const created = await owner.post("/servers", {
    name: "prod-1",
    sshKeyId: key.body.key.id,
    address: "203.0.113.10",
    sshUser: user,
  });
  if (created.status !== 201) throw new Error(JSON.stringify(created.body));
  return created.body.server.id;
}

/** Starts setup and carries the run out here (the job worker isn't running in these tests). */
async function runSetup(serverId: string, body: Record<string, unknown> = {}) {
  const started = await owner.post(`/servers/${serverId}/setup`, body);
  expect(started.status).toBe(202);
  const runId = started.body.setup.run.id as string;
  await carryOutSetup(harness.services, runId, {
    signal: new AbortController().signal,
    job: { id: 1, kind: "servers.setup", payload: {}, attempt: 1, maxAttempts: 2 },
  });
  return { started, setup: (await owner.get(`/servers/${serverId}/setup`)).body.setup };
}

describe("signing in (spec 9.3 Failure messages)", () => {
  test("a cloud image that refuses root: the hint, then the button switches user and runs again", async () => {
    server.users.root = { kind: "wrong_user", asks: "ubuntu" };
    server.users.ubuntu = {
      kind: "ok",
      failStep: {
        marker: "Installing basic tools",
        code: 100,
        stderr: "E: Unable to locate package jq",
      },
    };
    const id = await addServer("root");
    const first = await runSetup(id);
    expect(first.setup.run.state).toBe("failed");
    expect(first.setup.run.failure.kind).toBe("wrong_user");
    expect(first.setup.run.failure.message).toBe(wrongUserMessage("root", "ubuntu"));
    expect(first.setup.run.failure.suggestedUser).toBe("ubuntu");
    expect(first.setup.server.setupState).toBe("failed");
    // "Use ubuntu and run setup again"
    const second = await runSetup(id, { sshUser: "ubuntu" });
    expect(second.started.body.started).toBe(true);
    expect(second.setup.server.target).toBe("ubuntu@203.0.113.10:22");
    expect((await owner.get(`/servers/${id}`)).body.server.sshUser).toBe("ubuntu");
    // It got past signing in and stopped at step 2 with the spec's sentence.
    expect(second.setup.run.failure.message).toBe(
      "Setup stopped at step 2 (Install basic tools): Installing basic tools: jq. Cause: E: Unable to locate package jq (exit code 100)",
    );
    expect(second.setup.run.steps.slice(0, 3).map((step: { state: string }) => step.state)).toEqual(
      ["done", "failed", "waiting"],
    );
    // Every step ran as root through sudo -n, with input from /dev/null.
    const stepCommands = server.commands.filter((command) => command.includes("bash"));
    expect(stepCommands.length).toBeGreaterThan(0);
    for (const command of stepCommands)
      expect(command).toContain('sudo -n -- bash "$f" </dev/null');
    // The live log has numbered, titled steps.
    const log = (await owner.get(`/servers/${id}/setup/log`)).body.text as string;
    expect(log).toContain("Connecting to ubuntu@203.0.113.10:22");
    expect(log).toContain("[1/15] Clean up leftovers from an earlier run");
    expect(log).toContain("[2/15] Install basic tools");
  });

  test("no passwordless sudo gives the exact fix", async () => {
    server.users.deploy = { kind: "ok", sudo: "password" };
    const id = await addServer("deploy");
    const { setup } = await runSetup(id);
    expect(setup.run.failure.kind).toBe("sudo_missing");
    expect(setup.run.failure.message).toBe(passwordlessSudoMessage("deploy"));
    expect(setup.run.failure.fixCommand).toBe(
      "echo 'deploy ALL=(ALL) NOPASSWD:ALL' | sudo tee /etc/sudoers.d/deploy",
    );
  });

  test("a rejected key and an unreachable server", async () => {
    server.users.root = { kind: "reject" };
    const id = await addServer("root");
    const rejected = await runSetup(id);
    expect(rejected.setup.run.failure.message).toBe(SETUP_MESSAGES.keyRejected);
    expect(rejected.setup.run.failure.hints.length).toBeGreaterThan(0);
    server.users.root = { kind: "unreachable" };
    const unreachable = await runSetup(id);
    expect(unreachable.setup.run.failure.kind).toBe("unreachable");
    expect(unreachable.setup.run.failure.message).toStartWith(
      "Couldn't connect to your server at 203.0.113.10:22 (connection refused).",
    );
    // The server is kept after a failure.
    expect((await owner.get(`/servers/${id}`)).status).toBe(200);
  });

  test("an unsupported system gets the spec's refusal", async () => {
    server.users.root = { kind: "ok", release: "ID=gentoo\nPRETTY_NAME=Gentoo\n" };
    const id = await addServer("root");
    const { setup } = await runSetup(id);
    expect(setup.run.failure.message).toBe(SETUP_MESSAGES.unsupportedSystem);
  });
});

describe("host keys (spec 9.2, 22.5)", () => {
  test("recorded on the first connection, then a changed key is refused", async () => {
    server.users.root = {
      kind: "ok",
      failStep: { marker: "Installing basic tools", code: 1, stderr: "stop here" },
    };
    const id = await addServer("root");
    await runSetup(id);
    expect((await owner.get(`/servers/${id}`)).body.server.hostKeyFingerprint).toBe(FINGERPRINT);
    const log = (await owner.get(`/servers/${id}/setup/log`)).body.text as string;
    expect(log).toContain(`Host key ${FINGERPRINT} (first connection: recorded`);
    server.fingerprint = "SHA256:Q2hhbmdlZEtleUNoYW5nZWRLZXlDaGFuZ2VkS2V5MTI";
    const changed = await runSetup(id);
    expect(changed.setup.run.failure.kind).toBe("host_key_changed");
    expect(changed.setup.run.failure.message).toContain(FINGERPRINT);
    // Forgetting the old key lets it sign in again.
    expect((await owner.request("DELETE", `/servers/${id}/host-key`)).status).toBe(200);
    const again = await runSetup(id);
    expect(again.setup.run.failure.kind).toBe("step_failed");
  });

  test("strict checking refuses an unknown key until it is trusted", async () => {
    configureServerSetup(harness.services, { strictHostKeyChecking: true });
    server.users.root = {
      kind: "ok",
      failStep: { marker: "Installing basic tools", code: 1, stderr: "stop here" },
    };
    const id = await addServer("root");
    const refused = await runSetup(id);
    expect(refused.setup.run.failure.kind).toBe("host_key_unknown");
    expect(refused.setup.run.failure.presentedFingerprint).toBe(FINGERPRINT);
    expect(server.commands).toEqual([]);
    const bad = await owner.post(`/servers/${id}/host-key/trust`, { fingerprint: "nope" });
    expect(bad.status).toBe(400);
    expect(
      (await owner.post(`/servers/${id}/host-key/trust`, { fingerprint: FINGERPRINT })).status,
    ).toBe(200);
    const trusted = await runSetup(id);
    expect(trusted.setup.run.failure.kind).toBe("step_failed");
  });
});

describe("runs (spec 9.3)", () => {
  test("a recent run is already running; a stalled one is retried", async () => {
    server.users.root = { kind: "ok" };
    const id = await addServer("root");
    const first = await owner.post(`/servers/${id}/setup`, {});
    expect(first.body.started).toBe(true);
    const again = await owner.post(`/servers/${id}/setup`, {});
    expect(again.body.started).toBe(false);
    expect(again.body.setup.notice).toBe(SETUP_MESSAGES.alreadyRunning);
    expect(again.body.setup.run.id).toBe(first.body.setup.run.id);
    await harness.test.db
      .updateTable("server_setup_run")
      .set({ last_activity_at: new Date(Date.now() - SETUP_STALLED_MS - 1_000) })
      .execute();
    expect((await owner.get(`/servers/${id}/setup`)).body.setup.notice).toBe(
      SETUP_MESSAGES.stalledRetrying,
    );
    const retried = await owner.post(`/servers/${id}/setup`, {});
    expect(retried.body.started).toBe(true);
    expect(retried.body.setup.notice).toBe(SETUP_MESSAGES.stalledRetrying);
    expect(retried.body.setup.run.retriedStalled).toBe(true);
    expect(retried.body.setup.run.id).not.toBe(first.body.setup.run.id);
  });

  test("C2-23: a setup the move runs itself isn't taken for stalled while it beats", async () => {
    server.users.root = { kind: "ok" };
    const id = await addServer("root");
    const row = await harness.test.db
      .selectFrom("server")
      .select("workspace_id")
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    // As migration/move-job.ts makes it: a run with no job of its own, beating.
    const moving = await harness.test.db
      .insertInto("server_setup_run")
      .values({
        server_id: id,
        workspace_id: row.workspace_id,
        steps: JSON.stringify([]),
        ssh_user: "root",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const opened = await owner.post(`/servers/${id}/setup`, {});
    expect(opened.body.started).toBe(false);
    expect(opened.body.setup.notice).toBe(SETUP_MESSAGES.alreadyRunning);
    expect(opened.body.setup.run.id).toBe(moving.id);
    const kept = await harness.test.db
      .selectFrom("server_setup_run")
      .select("state")
      .where("id", "=", moving.id)
      .executeTakeFirstOrThrow();
    expect(kept.state).toBe("running");
    // Once it stops beating it is stalled, as any run is.
    await harness.test.db
      .updateTable("server_setup_run")
      .set({ last_activity_at: new Date(Date.now() - SETUP_STALLED_MS - 1_000) })
      .where("id", "=", moving.id)
      .execute();
    expect((await owner.get(`/servers/${id}/setup`)).body.setup.notice).toBe(
      SETUP_MESSAGES.stalledRetrying,
    );
  });

  test("the host isn't set up over SSH, and members need the right", async () => {
    expect((await owner.post("/servers/host/setup", {})).status).toBe(400);
    server.users.root = { kind: "ok" };
    const id = await addServer("root");
    const member = await addMemberThroughInvitation(harness, owner, "mia@example.com");
    expect((await member.post(`/servers/${id}/setup`, {})).status).toBe(404);
    expect((await member.get(`/servers/${id}/validation`)).status).toBe(404);
  });

  test("a bad user for the button is refused", async () => {
    const id = await addServer("root");
    const reply = await owner.post(`/servers/${id}/setup`, { sshUser: "1bad user" });
    expect(reply.status).toBe(400);
    expect(reply.body.error.fields.sshUser).toContain("32 characters");
  });
});

describe("looking at a server (spec 9.4, R3-06)", () => {
  async function markReady(id: string) {
    await harness.test.db
      .updateTable("server")
      .set({ setup_state: "ready" })
      .where("id", "=", id)
      .execute();
  }

  test("opening a set-up server's details checks it again unless the stored check is under a minute old", async () => {
    server.users.root = { kind: "ok" };
    const id = await addServer("root");
    // Not set up yet: the details show what is stored, and nothing signs in.
    const before = await owner.get(`/servers/${id}/validation?fresh=1`);
    expect(before.status).toBe(200);
    expect(before.body.validation).toBeNull();
    expect(server.probes.validation).toBe(0);

    await markReady(id);
    // Set up but never checked over SSH (it joined with the join command): not signed in to.
    expect((await owner.get(`/servers/${id}/validation?fresh=1`)).body.validation).toBeNull();
    expect(server.probes.validation).toBe(0);
    // Checked a while ago, as setup does when it finishes.
    expect((await owner.post(`/servers/${id}/validation`, {})).status).toBe(200);
    expect(server.probes.validation).toBe(1);
    await harness.test.db
      .updateTable("server_inspection")
      .set({ validation_at: new Date(Date.now() - 5 * 60_000) })
      .where("server_id", "=", id)
      .execute();
    const opened = await owner.get(`/servers/${id}/validation?fresh=1`);
    expect(opened.status).toBe(200);
    expect(server.probes.validation).toBe(2);
    expect(Date.now() - Date.parse(opened.body.validation.checkedAt)).toBeLessThan(10_000);
    // Under a minute old: shown as it is.
    const again = await owner.get(`/servers/${id}/validation?fresh=1`);
    expect(again.body.validation.checkedAt).toBe(opened.body.validation.checkedAt);
    expect(server.probes.validation).toBe(2);
    // The plain read never checks.
    await harness.test.db
      .updateTable("server_inspection")
      .set({ validation_at: new Date(Date.now() - 61_000) })
      .where("server_id", "=", id)
      .execute();
    expect((await owner.get(`/servers/${id}/validation`)).body.validation.checkedAt).toBe(
      opened.body.validation.checkedAt,
    );
    expect(server.probes.validation).toBe(2);
    // A minute old: checked again when the details open.
    const later = await owner.get(`/servers/${id}/validation?fresh=1`);
    expect(server.probes.validation).toBe(3);
    expect(later.body.validation.checkedAt).not.toBe(opened.body.validation.checkedAt);
    // A server that can't be signed in to says so, instead of showing the old result as current.
    server.users.root = { kind: "unreachable" };
    await harness.test.db
      .updateTable("server_inspection")
      .set({ validation_at: new Date(Date.now() - 61_000) })
      .where("server_id", "=", id)
      .execute();
    const unreachable = await owner.get(`/servers/${id}/validation?fresh=1`);
    expect(unreachable.status).toBe(200);
    expect(unreachable.body.validation.ok).toBe(false);
    expect(unreachable.body.validation.verdict).toStartWith(
      "Nearzero could not confirm every mandatory server check. Couldn't connect to your server",
    );
  });

  test("anyone who can see a server may check it again and run the audit; changing it needs manage rights", async () => {
    server.users.root = { kind: "ok" };
    server.audit =
      "::ufw::begin\nStatus: active\nDefault: deny (incoming), allow (outgoing), disabled (routed)\n::ufw::end\n::ban::begin\nfail2ban=active\nfail2ban_boot=yes\nfail2ban_jails=recidive\n::ban::end\n";
    const id = await addServer("root");
    await markReady(id);
    const viewer = await addMember(harness, owner, "vera@example.com", {
      scope: { serverIds: [id] },
    });
    expect((await viewer.get(`/servers/${id}`)).status).toBe(200);

    const checked = await viewer.post(`/servers/${id}/validation`, {});
    expect(checked.status).toBe(200);
    expect(checked.body.validation.verdict).toBeString();
    expect(server.probes.validation).toBe(1);
    const opened = await viewer.get(`/servers/${id}/validation?fresh=1`);
    expect(opened.status).toBe(200);
    // The check a moment ago is fresh enough.
    expect(server.probes.validation).toBe(1);

    const audit = await viewer.post(`/servers/${id}/security-audit`, {});
    expect(audit.status).toBe(200);
    expect(server.probes.audit).toBe(1);
    const ban = audit.body.audit.items.find((item: { id: string }) => item.id === "intrusion_ban");
    expect(ban).toMatchObject({
      state: "attention",
      value: "fail2ban running, but its SSH jail is off",
    });
    expect((await viewer.get(`/servers/${id}/security-audit`)).body.audit.checkedAt).toBe(
      audit.body.audit.checkedAt,
    );

    // Changing anything still needs the server's manage rights.
    expect((await viewer.patch(`/servers/${id}`, { name: "renamed" })).status).toBe(403);
    expect((await viewer.post(`/servers/${id}/setup`, {})).status).toBe(403);
    expect((await viewer.put(`/servers/${id}/docker-cleanup`, { enabled: true })).status).toBe(403);
    // Someone who can't see it learns nothing.
    const stranger = await addMemberThroughInvitation(harness, owner, "sam@example.com");
    expect((await stranger.post(`/servers/${id}/validation`, {})).status).toBe(404);
    expect((await stranger.get(`/servers/${id}/validation?fresh=1`)).status).toBe(404);
    expect((await stranger.post(`/servers/${id}/security-audit`, {})).status).toBe(404);
    expect(server.probes).toEqual({ validation: 1, audit: 1 });

    // The Agent's validate_server and security_audit follow the same rule.
    const serverRow = await harness.test.db
      .selectFrom("server")
      .select("workspace_id")
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    const asViewer = await actorOf("vera@example.com", serverRow.workspace_id);
    const validated = (await serverSetupPort.validate(harness.services, asViewer, id)) as {
      verdict: string;
    };
    expect(validated.verdict).toBeString();
    const audited = (await serverSetupPort.audit(harness.services, asViewer, id)) as {
      items: { id: string }[];
    };
    expect(audited.items.map((item) => item.id)).toContain("intrusion_ban");
    expect(server.probes).toEqual({ validation: 2, audit: 2 });
  });
});

/** The person as the Agent acts for them, in the given workspace. */
async function actorOf(email: string, workspaceId: string): Promise<WorkspaceActor> {
  const person = await harness.test.db
    .selectFrom("person")
    .select("id")
    .where("email", "=", email)
    .executeTakeFirstOrThrow();
  const workspace = await resolveActiveWorkspace(harness.test.db, {
    id: crypto.randomUUID(),
    personId: person.id,
    activeWorkspaceId: workspaceId,
  });
  if (!workspace) throw new Error("no workspace");
  const admin = await isInstanceAdmin(harness.test.db, person.id);
  const grants = await loadGrants(harness.test.db, {
    personId: person.id,
    workspaceId: workspace.id,
    role: workspace.role,
    isInstanceAdmin: admin,
  });
  return {
    personId: person.id,
    email,
    sessionId: "agent",
    clientAddress: "127.0.0.1",
    secure: false,
    userAgent: null,
    workspace,
    role: workspace.role,
    isInstanceAdmin: admin,
    access: new WorkspaceAccess(harness.test.db, harness.services.objects, grants),
  };
}

describe("daily Docker cleanup switch (spec 9.4)", () => {
  test("off by default for servers, on for the host; switches and is audited", async () => {
    const id = await addServer("root");
    const view = (await owner.get(`/servers/${id}/docker-cleanup`)).body.cleanup;
    expect(view.enabled).toBe(false);
    expect(view.defaultEnabled).toBe(false);
    expect(view.description).toBe(
      "Removes unused images and build cache every day at 23:50 server time.",
    );
    const on = await owner.put(`/servers/${id}/docker-cleanup`, { enabled: true });
    expect(on.body.cleanup.enabled).toBe(true);
    expect(on.body.cleanup.nextRunAt).toMatch(/T23:50:00/);
    const host = (await owner.get("/servers/host/docker-cleanup")).body.cleanup;
    expect(host.enabled).toBe(true);
    expect(host.defaultEnabled).toBe(true);
  });
});

describe("deleting a server with services (spec 9.6)", () => {
  test("refused without the choice; with it, the services go first", async () => {
    const id = await addServer("root");
    const project = await owner.post("/projects", { name: "shop" });
    const environmentId = project.body.environmentId;
    const service = await owner.post(`/environments/${environmentId}/services`, {
      kind: "application",
      name: "web",
      serverId: id,
      settings: { image: "nginx:alpine", servicePort: 80 },
    });
    expect(service.status).toBe(201);
    const refused = await owner.request("DELETE", `/servers/${id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toBe("Server has active services, please delete them first");
    const started = await owner.request("DELETE", `/servers/${id}?deleteServices=true`);
    expect(started.status).toBe(202);
    expect(started.body.removal.items.map((item: { name: string }) => item.name)).toEqual(["web"]);
    const followed = await owner.get(`/servers/${id}/removal`);
    expect(followed.body.removal.state).toBe("running");
    // B1-48: a member without access to the server learns nothing of it, or of its services.
    const member = await addMemberThroughInvitation(harness, owner, "nosy@example.com");
    const nosy = await member.get(`/servers/${id}/removal`);
    expect(nosy.status).toBe(404);
    expect(JSON.stringify(nosy.body)).not.toContain("web");
  });
});

describe("the server Terminal: an SSH shell (spec 9.1, 22.3)", () => {
  interface FakeSocket {
    frames: (string | Uint8Array)[];
    closed: { code: number; reason: string } | null;
    send(frame: string | Uint8Array): void;
    close(code: number, reason: string): void;
  }

  /** Opens /servers/:id/terminal as `who`, catching the WebSocket handler the route gives. */
  async function openTerminal(who: Browser, serverId: string, query = "cols=100&rows=30") {
    let handler: SocketHandler | null = null;
    const cookie = [...who.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    const response = await harness.app.request(
      `/api/v1/servers/${serverId}/terminal?${query}`,
      { headers: { cookie, upgrade: "websocket" } },
      {
        peerAddress: "127.0.0.1",
        upgrade: (_request: Request, given: SocketHandler) => {
          handler = given;
          return true;
        },
      },
    );
    const socket: FakeSocket = {
      frames: [],
      closed: null,
      send(frame) {
        this.frames.push(frame);
      },
      close(code, reason) {
        this.closed = { code, reason };
      },
    };
    return { response, handler: handler as SocketHandler | null, socket };
  }

  const text = (socket: FakeSocket) =>
    socket.frames
      .map((frame) => (typeof frame === "string" ? frame : new TextDecoder().decode(frame)))
      .join("");

  async function until(check: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5);
  }

  test("signs in with the server's key and bridges a login shell to the socket", async () => {
    server.users.ubuntu = { kind: "ok" };
    const id = await addServer("ubuntu");
    const { response, handler, socket } = await openTerminal(owner, id);
    expect(response.status).toBe(200);
    if (!handler) throw new Error("no WebSocket handler");
    const live = socket as unknown as Socket;
    handler.open?.(live);
    await until(() => text(socket).includes("ubuntu@prod-1:~$"));
    expect(socket.frames).toContain(JSON.stringify({ type: "status", connected: true }));
    expect(server.shells[0]?.sizes[0]).toEqual({ cols: 100, rows: 30 });
    // The host key is recorded on the first sign-in, as setup does.
    expect((await owner.get(`/servers/${id}`)).body.server.hostKeyFingerprint).toBe(FINGERPRINT);

    handler.message?.(live, new TextEncoder().encode("uptime\r"));
    handler.message?.(live, JSON.stringify({ type: "resize", cols: 5000, rows: 0 }));
    await until(() => text(socket).includes("$ uptime"));
    expect(server.shells[0]?.sizes[1]).toEqual({ cols: 1000, rows: 1 });

    handler.message?.(live, JSON.stringify({ type: "input", data: "exit\r" }));
    await until(() => socket.closed !== null);
    expect(socket.frames.at(-1)).toBe(JSON.stringify({ type: "exit", exitCode: 0, error: null }));
    expect(socket.closed).toEqual({ code: 1000, reason: "exited" });

    const audit = await harness.test.db
      .selectFrom("audit_event")
      .select(["action", "details"])
      .where("action", "=", "terminal.opened")
      .execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.details).toMatchObject({ ssh: true, user: "ubuntu" });
  });

  test("a sign-in or shell problem ends the session with the reason people can act on", async () => {
    server.users.root = { kind: "reject" };
    const id = await addServer("root");
    const rejected = await openTerminal(owner, id);
    rejected.handler?.open?.(rejected.socket as unknown as Socket);
    await until(() => rejected.socket.closed !== null);
    const exit = JSON.parse(rejected.socket.frames.at(-1) as string);
    expect(exit).toEqual({ type: "exit", exitCode: null, error: SETUP_MESSAGES.keyRejected });

    server.users.root = { kind: "ok" };
    server.shellRefused = true;
    const refused = await openTerminal(owner, id);
    refused.handler?.open?.(refused.socket as unknown as Socket);
    await until(() => refused.socket.closed !== null);
    expect(JSON.parse(refused.socket.frames.at(-1) as string).error).toContain(
      "Signed in to prod-1, but it didn't open a shell (no pty)",
    );
  });

  test("closing the socket ends the shell", async () => {
    server.users.root = { kind: "ok" };
    const id = await addServer("root");
    const { handler, socket } = await openTerminal(owner, id);
    handler?.open?.(socket as unknown as Socket);
    await until(() => server.shells.length === 1);
    handler?.close?.(socket as unknown as Socket, 1000, "");
    expect(server.shells[0]?.closed).toBe(true);
  });

  test("needs the server's manage rights, a WebSocket, and isn't offered for the host", async () => {
    server.users.root = { kind: "ok" };
    const id = await addServer("root");
    const member = await addMemberThroughInvitation(harness, owner, "member@example.com");
    const refused = await openTerminal(member, id);
    expect(refused.handler).toBeNull();
    expect([403, 404]).toContain(refused.response.status);
    const plain = await owner.get(`/servers/${id}/terminal`);
    expect(plain.status).toBe(400);
    expect(plain.body.error.message).toBe("Open the terminal with a WebSocket.");
    const host = await openTerminal(owner, "host");
    expect(host.response.status).toBe(400);
    expect(host.handler).toBeNull();
  });
});
