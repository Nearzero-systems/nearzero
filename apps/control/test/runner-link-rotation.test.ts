import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../src/cli/commands.ts";
import { ensureLinkCertificate, readNextLinkCertificate } from "../src/runners/link-certificate.ts";
import { createHarness, fakeIo, type Harness } from "./support/harness.ts";

/**
 * C4-10: replacing the runner link's certificate with `sudo nearzero runner-link …`. `rotate`
 * makes the next pair, whose fingerprint the control plane then gives every server over its
 * current link (runner-link-moves.test.ts); `status` lists the servers that don't hold it yet;
 * `switch` refuses while one doesn't, unless --force, then puts the next pair in place.
 */

setDefaultTimeout(120_000);

let h: Harness;
let directory: string;
const servers: Record<string, string> = {};

beforeAll(async () => {
  h = await createHarness();
  directory = await mkdtemp(join(tmpdir(), "nz-rotation-"));
  const workspace = await h.test.db
    .insertInto("workspace")
    .values({ name: "Acme", slug: "acme-rotation" })
    .returning("id")
    .executeTakeFirstOrThrow();
  const key = await h.test.db
    .insertInto("ssh_key")
    .values({
      workspace_id: workspace.id,
      name: "deploy",
      key_type: "ed25519",
      public_key: "ssh-ed25519 AAAA test",
      fingerprint: "SHA256:test",
      private_key_sealed: "sealed",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  for (const name of ["alpha", "beta"]) {
    const server = await h.test.db
      .insertInto("server")
      .values({
        workspace_id: workspace.id,
        name,
        address: `198.51.100.${name === "alpha" ? 7 : 8}`,
        ssh_user: "root",
        ssh_key_id: key.id,
        label: name,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const runner = await h.test.db
      .insertInto("runner")
      .values({
        server_id: server.id,
        credential_hash: "0".repeat(64),
        link_url: "https://203.0.113.10:3443",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    servers[name] = runner.id;
  }
});

afterAll(async () => {
  await h.drop();
  await rm(directory, { recursive: true, force: true });
});

async function run(...args: string[]) {
  const io = fakeIo([]);
  const code = await runCommand(["runner-link", ...args], h.services, io, undefined, directory);
  return { code, out: io.output.join("\n"), err: io.errors.join("\n") };
}

describe("nearzero runner-link (C4-10)", () => {
  test("rotate, status, a refused switch, then the switch once every server holds the pin", async () => {
    const current = await ensureLinkCertificate(directory);
    const before = await run("status");
    expect(before.code).toBe(0);
    expect(before.out).toContain(`sha256:${current.fingerprint}`);
    expect(before.out).toContain("No replacement is waiting");

    const rotated = await run("rotate");
    expect(rotated.code).toBe(0);
    const next = await readNextLinkCertificate(directory);
    expect(next).not.toBeNull();
    expect(rotated.out).toContain(`sha256:${next?.fingerprint}`);
    expect(rotated.out).toContain("over the link that still works");

    // alpha has taken the next fingerprint (its runner's hello or heartbeat said so); beta hasn't.
    await h.test.db
      .updateTable("runner")
      .set({ link_next: next?.fingerprint ?? null })
      .where("id", "=", servers.alpha as string)
      .execute();
    const status = await run("status", "--json");
    expect(JSON.parse(status.out)).toMatchObject({
      fingerprint: current.fingerprint,
      next: next?.fingerprint,
      servers: [
        { name: "alpha", holdsNext: true },
        { name: "beta", holdsNext: false },
      ],
    });
    expect((await run("status")).out).toContain("- beta");

    const refused = await run("switch");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("beta");
    expect(refused.err).toContain("--force");
    expect((await ensureLinkCertificate(directory)).fingerprint).toBe(current.fingerprint);

    await h.test.db
      .updateTable("runner")
      .set({ link_next: next?.fingerprint ?? null })
      .where("id", "=", servers.beta as string)
      .execute();
    const switched = await run("switch");
    expect(switched.code).toBe(0);
    expect(switched.out).toContain(`sha256:${next?.fingerprint}`);
    expect((await ensureLinkCertificate(directory)).fingerprint).toBe(next?.fingerprint ?? "");
    expect(await readNextLinkCertificate(directory)).toBeNull();
  });

  test("--force switches anyway and names the servers that need setup again", async () => {
    await run("rotate");
    const forced = await run("switch", "--force");
    expect(forced.code).toBe(0);
    expect(forced.out).toContain("Run setup again on: alpha, beta");
  });

  test("cancel drops a waiting pair; without the TLS port there is nothing to replace", async () => {
    await run("rotate");
    expect((await run("cancel")).out).toContain("Dropped");
    expect(await readNextLinkCertificate(directory)).toBeNull();
    const io = fakeIo([]);
    expect(await runCommand(["runner-link", "status"], h.services, io)).toBe(1);
    expect(io.errors.join(" ")).toContain("no runner link port");
  });

  test("C4-14: rotate, switch and cancel are in the audit log, a forced switch with whom it cut off", async () => {
    const events = await h.test.db
      .selectFrom("audit_event")
      .select(["action", "actor_kind", "actor_label", "target_kind", "target_id", "details"])
      .where("action", "like", "runner-link.%")
      .orderBy("id")
      .execute();
    expect(events.map((event) => event.action)).toEqual([
      "runner-link.rotate",
      "runner-link.switch",
      "runner-link.rotate",
      "runner-link.switch",
      "runner-link.rotate",
      "runner-link.cancel",
    ]);
    for (const event of events) {
      expect(event).toMatchObject({
        actor_kind: "command",
        actor_label: "nearzero runner-link",
        target_kind: "runner-link",
      });
      expect(event.target_id).toMatch(/^[0-9a-f]{64}$/);
    }
    const details = (event: (typeof events)[number]) =>
      (typeof event.details === "string" ? JSON.parse(event.details) : event.details) as Record<
        string,
        unknown
      >;
    expect(details(events[1] as (typeof events)[number])).toMatchObject({ forced: false });
    expect(details(events[3] as (typeof events)[number])).toMatchObject({
      forced: true,
      cutOff: ["alpha", "beta"],
    });
    expect(details(events[3] as (typeof events)[number]).previous).toMatch(/^[0-9a-f]{64}$/);
  });

  test("status shows the replaced pair and when its key goes", async () => {
    const status = await run("status");
    expect(status.out).toContain("Replaced certificate:");
    expect(status.out).toContain("Its key is deleted once every server has reconnected");
  });
});
