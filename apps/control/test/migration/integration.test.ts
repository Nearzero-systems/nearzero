import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createBundle } from "../../src/migration/bundle.ts";
import { totpCode } from "../../src/security/totp.ts";
import { BACKUP_CODE, PASSWORDS, richFixture, TOTP_BASE32, WEBHOOK_TOKEN } from "./fixture.ts";
import {
  createMigrationHarness,
  type MigrationHarness,
  PLATFORM_DOMAIN,
  TEST_SECRET,
} from "./support.ts";

/**
 * The whole import through the real command line (`bun src/cli.ts import`, as `sudo nearzero
 * import` runs it inside the control-plane container), then the acceptance lines of spec 29.6 the
 * control plane can prove without a real 0.1.x install: people sign in with their old passwords
 * and two-factor, hostnames, internal names and public ports are the same, the old webhook URL's
 * token deploys, backups and tasks are scheduled, certificates are kept for the routers (none
 * ordered), and every service waits to move onto the runner in order.
 */

setDefaultTimeout(180_000);

const PASSPHRASE = "integration passphrase 0123";
let h: MigrationHarness;
let work: string;
let file: string;

function cli(args: string[]) {
  const child = Bun.spawn(["bun", resolve(import.meta.dir, "..", "..", "src", "cli.ts"), ...args], {
    env: {
      PATH: process.env.PATH ?? "",
      DATABASE_URL: h.url,
      NEARZERO_AUTH_SECRET: TEST_SECRET,
      NEARZERO_PLATFORM_DOMAIN: PLATFORM_DOMAIN,
      NEARZERO_PUBLIC_IP: "203.0.113.10",
      NEARZERO_MIGRATION_PASSPHRASE: PASSPHRASE,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
}

beforeAll(async () => {
  h = await createMigrationHarness();
  work = await mkdtemp(join(tmpdir(), "nz-mig-int-"));
  file = join(work, "nearzero-export-20261125T120000Z.nzx");
  const fixture = await richFixture();
  await writeFile(file, await createBundle(fixture.content, PASSPHRASE, { N: 2 ** 14 }));
  await chmod(file, 0o600);
});

afterAll(async () => {
  await h?.drop();
  if (work) await rm(work, { recursive: true, force: true });
});

describe("nearzero import, end to end in the control plane", () => {
  test("the dry run prints the report and changes nothing", async () => {
    const [code, out, err] = await cli(["import", "--dry-run", file]);
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(out).toStartWith("Dry run of the import from Nearzero 0.1.80. Nothing was changed.\n");
    expect(out).toContain("Can't be imported:\n");
    expect(out).toContain("  - Notification channel Fax: Fax isn't a channel type 1.0 sends to.");
    expect(out).toContain(
      "11 services will be redeployed on the 1.0 runner, oldest deployed first.",
    );
    expect(out).not.toContain("pg-pass-1");
    expect(await h.db.selectFrom("person").select("id").execute()).toEqual([]);
  });

  test("the import moves everything in; a second run changes nothing", async () => {
    const [code, out] = await cli(["import", "--in-place", file]);
    expect(code).toBe(0);
    expect(out).toStartWith("Imported from Nearzero 0.1.80.\n");
    expect(out).toContain(
      "Moving services onto the 1.0 runner now. Follow it with: sudo nearzero migrate status",
    );
    const [again, second] = await cli(["import", "--in-place", file]);
    expect(again).toBe(0);
    expect(second).toContain("Everything in this export was imported before, so nothing changed.");
    const jobs = await h.db
      .selectFrom("job")
      .select(["kind", "state"])
      .where("kind", "=", "migration.move")
      .execute();
    expect(jobs).toEqual([{ kind: "migration.move", state: "queued" }]);
  });

  test("29.6: everyone signs in with their old password and two-factor", async () => {
    for (const [email, password] of [
      ["bob@example.com", PASSWORDS.bob],
      ["carol@example.com", PASSWORDS.carol],
    ] as const) {
      expect((await h.browser().post("/auth/sign-in", { email, password })).body.status).toBe(
        "signed_in",
      );
    }
    const alice = h.browser();
    expect(
      (await alice.post("/auth/sign-in", { email: "alice@example.com", password: PASSWORDS.alice }))
        .body.status,
    ).toBe("two_factor_required");
    expect(
      (
        await alice.post("/auth/two-factor", {
          code: totpCode(TOTP_BASE32, Math.floor(Date.now() / 30_000)),
        })
      ).body.status,
    ).toBe("signed_in");
    const backup = h.browser();
    await backup.post("/auth/sign-in", { email: "alice@example.com", password: PASSWORDS.alice });
    expect((await backup.post("/auth/two-factor", { code: BACKUP_CODE })).body.status).toBe(
      "signed_in",
    );
    // The old hashes are gone after the first sign-in.
    const hashes = await h.db
      .selectFrom("person")
      .select(["email", "password_hash"])
      .where("email", "in", ["alice@example.com", "bob@example.com", "carol@example.com"])
      .execute();
    for (const row of hashes) expect(row.password_hash?.startsWith("$argon2id$")).toBe(true);
    // Workspace links keep working, old ones included.
    const me = await alice.get("/me");
    expect(me.status).toBe(200);
  });

  test("29.6: hostnames, internal names, public ports and webhook URLs are the same", async () => {
    const hosts = (await h.db.selectFrom("hostname").select("host").orderBy("host").execute()).map(
      (row) => row.host,
    );
    expect(hosts).toEqual([
      "a1b2c3.prod1.apps.example.com",
      "api.apps.example.com",
      "docs.example.net",
      "shop.example.org",
      "spare.example.net",
    ]);
    const databases = await h.db
      .selectFrom("service")
      .select(["app_name", "public_port", "settings"])
      .where("kind", "in", ["postgres", "mysql", "mariadb", "mongodb", "redis", "libsql"])
      .orderBy("app_name")
      .execute();
    expect(
      databases.map((row) => [
        row.app_name,
        row.public_port,
        (row.settings as { dataVolume: string }).dataVolume,
      ]),
    ).toEqual([
      ["cache-e1f2g3", null, "cache-e1f2g3-data"],
      ["edge-f1g2h3", 24080, "edge-f1g2h3-data"],
      ["maria-c1d2e3", null, "maria-c1d2e3-data"],
      ["mongo-d1e2f3", 31017, "mongo-d1e2f3-data"],
      ["mysql-b1c2d3", 23306, "mysql-b1c2d3-data"],
      ["pg-a1b2c3", 25432, "pg-a1b2c3-data"],
    ]);
    const call = await h.browser().post(`/webhooks/deploy/${WEBHOOK_TOKEN}`, {});
    expect([200, 202]).toContain(call.status);
  });

  test("29.6: backups and tasks are on schedule; certificates wait for their routers, none ordered", async () => {
    const due = await h.db
      .selectFrom("backup_schedule")
      .select("next_run_at")
      .where("enabled", "=", true)
      .execute();
    expect(due.length).toBe(2);
    for (const row of due) expect(row.next_run_at?.getTime() ?? 0).toBeGreaterThan(Date.now());
    const tasks = await h.db
      .selectFrom("task")
      .select("next_run_at")
      .where("enabled", "=", true)
      .execute();
    expect(tasks.length).toBe(2);
    // The schedulers were woken for the imported schedules.
    for (const kind of ["tasks.tick", "backups.tick"]) {
      expect(
        await h.db.selectFrom("job").select("kind").where("kind", "=", kind).execute(),
      ).not.toHaveLength(0);
    }
    const acme = await h.db
      .selectFrom("migration_acme_state")
      .select(["certificate_count", "placed_at"])
      .execute();
    expect(acme.map((row) => [row.certificate_count, row.placed_at])).toEqual([
      [1, null],
      [1, null],
    ]);
    expect(await h.db.selectFrom("certificate_snapshot").select("target").execute()).toEqual([]);
  });

  test("migrate status lists every service waiting to move, in order", async () => {
    const [code, out] = await cli(["migrate", "status"]);
    expect(code).toBe(0);
    const lines = out.trim().split("\n");
    expect(lines[0]).toStartWith("Imported from Nearzero 0.1.80 on ");
    expect(lines[1]).toBe("Moving services onto the 1.0 runner: 0 of 11 moved.");
    expect(lines.slice(2)).toEqual([
      "  mysql on the Nearzero host: waiting",
      "  maria on the Nearzero host: waiting",
      "  mongo on the Nearzero host: waiting",
      "  cache on the Nearzero host: waiting",
      "  edge on the Nearzero host: waiting",
      "  monitoring on the Nearzero host: waiting",
      "  api on the Nearzero host: waiting",
      "  worker on the Nearzero host: waiting",
      "  tool on the Nearzero host: waiting",
      "  pg on prod-1: waiting",
      "  web on prod-1: waiting",
      "  web on prod-1: not moved: It wasn't deployed on 0.1.x, so it stays undeployed until you deploy it.",
    ]);
  });
});
