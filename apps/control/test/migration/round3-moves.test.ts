import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createBundle, openBundle } from "../../src/migration/bundle.ts";
import { importBundle } from "../../src/migration/importer.ts";
import { richFixture } from "./fixture.ts";
import { createMigrationHarness, type MigrationHarness } from "./support.ts";

/**
 * Round 3's moves (spec 29): two volume schedules of one service in one folder both come over and
 * keep running (31c G3-20), a schedule 1.0 can't keep is named in plain words, a schedule 0.1.x
 * ran in UTC says so when its server's time zone is another (31c G3-21), and a file mount larger
 * than 1.0 takes is named before anything deploys (31d G4-16).
 */

const PASSPHRASE = "a passphrase of sixteen+ characters";

let h: MigrationHarness;
let report: { notImported: { message: string }[]; changed: { message: string }[] };

function schedule(ref: string, serviceRef: string, fields: Record<string, unknown>) {
  return {
    ref,
    serviceRef,
    destinationRef: "dst_s3",
    kind: "Volume",
    name: null,
    database: null,
    composeDatabase: null,
    volume: null,
    innerService: null,
    timeZone: null,
    keep: 7,
    enabled: true,
    stopWhileCopying: false,
    createdAt: null,
    ...fields,
  };
}

beforeAll(async () => {
  h = await createMigrationHarness();
  // The Nearzero host's runner has reported its time zone: Asia/Kolkata.
  await h.db
    .insertInto("runner")
    .values({ server_id: null, system: JSON.stringify({ timeZone: "Asia/Kolkata" }) } as never)
    .execute();
  const fixture = await richFixture();
  const schedules = fixture.content.records["backup-schedules.jsonl"] as unknown[];
  schedules.push(
    // The report's app: volumes data and uploads, nightly, to the same folder.
    schedule("bkp_api_data", "svc_api", {
      volume: "api-data",
      folder: "nightly",
      cron: "0 3 * * *",
    }),
    schedule("bkp_api_uploads", "svc_api", {
      volume: "api-uploads",
      folder: "nightly",
      cron: "0 3 * * *",
    }),
    // The same volume again in that folder: 1.0 keeps one per volume and folder.
    schedule("bkp_api_again", "svc_api", {
      volume: "api-data",
      folder: "nightly",
      cron: "0 4 * * *",
    }),
  );
  // An app on the host with a 1.5 MB file mount (a certificate bundle, say).
  const services = fixture.content.records["services.jsonl"] as {
    ref: string;
    settings: Record<string, unknown>;
  }[];
  const api = services.find((item) => item.ref === "svc_api");
  if (!api) throw new Error("The fixture has no svc_api.");
  api.settings = {
    ...api.settings,
    mounts: [
      { type: "File", containerPath: "/etc/ssl/bundle.pem", content: "x".repeat(1_500_000) },
      { type: "File", containerPath: "/etc/app.conf", content: "small" },
    ],
  };
  const bundle = await openBundle(
    await createBundle(fixture.content, PASSPHRASE, { N: 2 ** 14 }),
    PASSPHRASE,
  );
  const result = await importBundle(h.services, bundle, { dryRun: false, inPlace: true });
  report = result.report as never;
}, 120_000);

afterAll(async () => {
  await h?.drop();
});

describe("two volume schedules of one service in one folder (31c G3-20)", () => {
  test("both are kept, each for its own volume and 0.1.x's files of it", async () => {
    const rows = await h.db
      .selectFrom("backup_schedule as b")
      .innerJoin("service as s", "s.id", "b.service_id")
      .select(["b.volume_name", "b.folder", "b.legacy_files", "b.enabled", "b.next_run_at"])
      .where("s.name", "=", "api")
      .orderBy("b.volume_name")
      .execute();
    expect(rows.map((row) => [row.volume_name, row.folder, row.legacy_files, row.enabled])).toEqual(
      [
        ["api-data", "nightly", true, true],
        ["api-uploads", "nightly", true, true],
      ],
    );
    expect(rows.every((row) => row.next_run_at !== null)).toBe(true);
  });

  test("the one 1.0 can't keep is named with its service and folder in plain words", () => {
    const refused = report.notImported.map((item) => item.message);
    expect(refused).toContainEqual(
      'Backup schedule nightly of api: another schedule of api already backs up the volume api-data to the folder "nightly" on that destination, and 1.0 keeps one per volume and folder. Its files stay there and are listed under the kept schedule.',
    );
    expect(refused.join("\n")).not.toMatch(/constraint|duplicate key|_idx/);
  });
});

describe("schedules 0.1.x ran in UTC (31c G3-21)", () => {
  test("the move report says they now run in the server's time zone", () => {
    const changed = report.changed.map((item) => item.message);
    expect(changed).toContainEqual(
      'Backup schedule nightly of api: 1.0 runs backups in their server\'s time zone (Asia/Kolkata), so "0 3 * * *" now runs in Asia/Kolkata instead of UTC.',
    );
  });
});

describe("file mounts over the limit (31d G4-16)", () => {
  test("the move report names each one before anything deploys", () => {
    const changed = report.changed.map((item) => item.message);
    const named = changed.filter((message) => message.includes("more than the 1 MB a file mount"));
    expect(named).toHaveLength(1);
    expect(named[0]).toContain(
      "the file mount at /etc/ssl/bundle.pem holds 1.4 MB, more than the 1 MB a file mount can hold in 1.0, so it won't deploy as it is.",
    );
  });
});
