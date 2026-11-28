import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { sql } from "kysely";
import { ObjectRegistry } from "../../src/access/objects.ts";
import { createApp } from "../../src/app.ts";
import { createDatabase, type Db } from "../../src/db/database.ts";
import { migrate } from "../../src/db/migrate.ts";
import { type DnsLookup, LookupError } from "../../src/domains/settings.ts";
import { registerGitAccountObjects } from "../../src/git-providers/records.ts";
import type { AppEnv } from "../../src/http/context.ts";
import { silentLogger } from "../../src/log.ts";
import { registerProjectObjects } from "../../src/projects/objects.ts";
import { TEST_HASHING } from "../../src/security/passwords.ts";
import { registerServerObjects } from "../../src/servers/servers.ts";
import { type ControlServices, createServices } from "../../src/services.ts";
import { MIGRATIONS_DIR, TEST_DATABASE_URL } from "../support/database.ts";
import { Browser } from "../support/harness.ts";

/**
 * A control plane on a throwaway database named nz_mig_*, for the migration tests. Each file
 * makes its own and drops it at the end.
 */

export const TEST_SECRET = "9b1e4c7a2f8d03e6b5a9c1d4e7f20a3b6c9d2e5f8a1b4c7d0e3f6a9b2c5d8e1f";
export const PLATFORM_DOMAIN = "apps.example.com";

const fakeDns: DnsLookup = {
  async resolve4(name) {
    throw new LookupError("not_found", `${name} doesn't exist`);
  },
  async resolve6() {
    throw new LookupError("no_data", "none");
  },
  async resolveCname() {
    throw new LookupError("no_data", "none");
  },
  async resolveNs() {
    throw new LookupError("no_data", "none");
  },
  async soaSerialAt() {
    throw new LookupError("failed", "none");
  },
};

export interface MigrationHarness {
  db: Db;
  /** The database's address, for the command line in a child process. */
  url: string;
  services: ControlServices;
  app: Hono<AppEnv>;
  browser(): Browser;
  /** The same database seen by an install with another key (to prove secrets are bound to it). */
  servicesWithSecret(secret: string): ControlServices;
  drop(): Promise<void>;
}

function objects(): ObjectRegistry {
  const registry = new ObjectRegistry();
  registerProjectObjects(registry);
  registerServerObjects(registry);
  registerGitAccountObjects(registry);
  return registry;
}

export async function createMigrationHarness(): Promise<MigrationHarness> {
  const admin = createDatabase(TEST_DATABASE_URL, {
    maxConnections: 1,
    applicationName: "nz-mig-test",
  });
  const name = `nz_mig_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  await sql`create database ${sql.id(name)}`.execute(admin);
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  const db = createDatabase(url.toString(), { maxConnections: 8, applicationName: "nz-mig-test" });
  await migrate(db, { directory: MIGRATIONS_DIR });
  const make = (secret: string) =>
    createServices({
      db,
      log: silentLogger,
      authSecret: secret,
      consoleUrl: "http://console.test:4321",
      passwordHashing: TEST_HASHING,
      objects: objects(),
      hostPublicIPv4: "203.0.113.10",
      domains: { platformDomain: PLATFORM_DOMAIN, dns: fakeDns, sleep: async () => {} },
      http: async (input) => {
        throw new Error(`The test made an unexpected outbound call to ${input}`);
      },
    });
  const services = make(TEST_SECRET);
  const app = createApp({ db, log: silentLogger, services });
  return {
    db,
    url: url.toString(),
    services,
    app,
    browser: () => new Browser(app),
    servicesWithSecret: make,
    async drop() {
      services.runners.stop();
      await db.destroy();
      await sql`drop database if exists ${sql.id(name)} with (force)`.execute(admin);
      await admin.destroy();
    },
  };
}

/** A self-signed certificate and its key, made with openssl. */
export async function selfSigned(
  names: string[],
  days = 30,
): Promise<{ certificate: string; key: string }> {
  const work = await mkdtemp(join(tmpdir(), "nz-mig-cert-"));
  try {
    const made = Bun.spawn(
      [
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        String(days),
        "-subj",
        `/CN=${names[0]}`,
        "-addext",
        `subjectAltName=${names.map((item) => `DNS:${item}`).join(",")}`,
        "-keyout",
        join(work, "k.pem"),
        "-out",
        join(work, "c.pem"),
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    await made.exited;
    return {
      certificate: await readFile(join(work, "c.pem"), "utf8"),
      key: await readFile(join(work, "k.pem"), "utf8"),
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
