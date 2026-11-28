import { describe, expect, test } from "bun:test";
import {
  backupFileName,
  backupFileTime,
  backupFileVolume,
  backupPrefix,
  createDestinationRequestSchema,
  createScheduleRequestSchema,
  describeSchedule,
  fileBelongsToService,
  isBackupFileName,
  isLegacyBackupFileName,
  isLegacyFileOf,
  isSafeKey,
  newestFirst,
  nextRunAfter,
  normalizeFolder,
  parseCron,
  restoreRequestSchema,
  updateDestinationRequestSchema,
  usableTimeZone,
  zonedInstant,
} from "../src/index.ts";

/** Backup rules (spec 08 8.3, 17, 24 G1/G2): schedules, folders, file names, prefixes, fields. */

function cron(expression: string) {
  const parsed = parseCron(expression);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.cron;
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

describe("schedules in words (spec 08 8.3)", () => {
  test("presets and other shapes", () => {
    expect(describeSchedule("0 * * * *")).toBe("Every hour");
    expect(describeSchedule("0 3 * * *")).toBe("Every day at 03:00");
    expect(describeSchedule("0 3 * * 0")).toBe("Every Sunday at 03:00");
    expect(describeSchedule("0 3 * * 7")).toBe("Every Sunday at 03:00");
    expect(describeSchedule("0 3 1 * *")).toBe("On the 1st of each month at 03:00");
    expect(describeSchedule("30 22 2 * *")).toBe("On the 2nd of each month at 22:30");
    expect(describeSchedule("5 4 * * fri")).toBe("Every Friday at 04:05");
    expect(describeSchedule("*/15  *  * * *")).toBe("Cron */15 * * * *");
    expect(describeSchedule("0 0 29 2 *")).toBe("Cron 0 0 29 2 *");
  });

  test("bad expressions say what is wrong", () => {
    expect(parseCron("* * * *")).toMatchObject({ ok: false });
    expect(parseCron("60 * * * *")).toEqual({
      ok: false,
      message: "The minute field takes values from 0 to 59.",
    });
    expect(parseCron("0 3 * * 8")).toMatchObject({ ok: false });
    expect(parseCron("0 3-1 * * *")).toMatchObject({ ok: false });
    expect(parseCron("*/0 * * * *")).toMatchObject({ ok: false });
    expect(parseCron("0 3 * jan,jul mon-fri")).toMatchObject({ ok: true });
  });
});

describe("the next run, in the server's time zone (spec 08 8.3)", () => {
  const after = Date.UTC(2026, 10, 25, 12, 0);

  test("UTC, an IANA zone and a fixed offset", () => {
    const daily = cron("0 3 * * *");
    expect(iso(nextRunAfter(daily, after, "UTC"))).toBe("2026-11-26T03:00:00.000Z");
    expect(iso(nextRunAfter(daily, after, "Asia/Kolkata"))).toBe("2026-11-25T21:30:00.000Z");
    expect(iso(nextRunAfter(daily, after, "UTC+05:30"))).toBe("2026-11-25T21:30:00.000Z");
    expect(iso(nextRunAfter(daily, after, "UTC-03:00"))).toBe("2026-11-26T06:00:00.000Z");
  });

  test("strictly after the given time, minute by minute", () => {
    const hourly = cron("0 * * * *");
    expect(iso(nextRunAfter(hourly, Date.UTC(2026, 0, 1, 10, 0), "UTC"))).toBe(
      "2026-01-01T11:00:00.000Z",
    );
    expect(iso(nextRunAfter(hourly, Date.UTC(2026, 0, 1, 10, 0, 30), "UTC"))).toBe(
      "2026-01-01T11:00:00.000Z",
    );
    expect(iso(nextRunAfter(cron("*/5 * * * *"), Date.UTC(2026, 0, 1, 10, 3), "UTC"))).toBe(
      "2026-01-01T10:05:00.000Z",
    );
  });

  test("day of month or day of week, as cron reads both", () => {
    // The 13th, or any Friday: Friday 2026-11-27 comes first.
    expect(iso(nextRunAfter(cron("0 0 13 * 5"), after, "UTC"))).toBe("2026-11-27T00:00:00.000Z");
    expect(iso(nextRunAfter(cron("0 0 29 2 *"), after, "UTC"))).toBe("2028-02-29T00:00:00.000Z");
    expect(nextRunAfter(cron("0 0 31 2 *"), after, "UTC")).toBeNull();
  });

  test("daylight saving: the same wall clock, and a time that doesn't exist runs after the gap", () => {
    const daily = cron("0 3 * * *");
    expect(iso(nextRunAfter(daily, Date.UTC(2026, 2, 7, 12), "America/New_York"))).toBe(
      "2026-03-08T07:00:00.000Z",
    );
    expect(iso(nextRunAfter(daily, Date.UTC(2026, 2, 6, 12), "America/New_York"))).toBe(
      "2026-03-07T08:00:00.000Z",
    );
    const gap = zonedInstant(
      { year: 2026, month: 3, day: 8, hour: 2, minute: 30 },
      "America/New_York",
    );
    expect(new Date(gap).toISOString()).toBe("2026-03-08T07:30:00.000Z");
  });

  test("an unknown zone falls back to UTC", () => {
    expect(usableTimeZone("Mars/Olympus")).toBe("UTC");
    expect(usableTimeZone(null)).toBe("UTC");
    expect(usableTimeZone("Europe/Berlin")).toBe("Europe/Berlin");
  });
});

describe("folders, file names and prefixes (spec 08 8.3, 17.3)", () => {
  test("folders", () => {
    expect(normalizeFolder(" /daily/ ")).toEqual({ folder: "daily" });
    expect(normalizeFolder("db/nightly")).toEqual({ folder: "db/nightly" });
    expect(normalizeFolder("")).toEqual({ problem: "Enter a folder, like nightly." });
    expect("problem" in normalizeFolder("../other")).toBe(true);
    expect("problem" in normalizeFolder("a//b")).toBe(true);
    expect("problem" in normalizeFolder("with space")).toBe(true);
  });

  test("file names are the run's time in UTC", () => {
    const at = new Date(Date.UTC(2026, 10, 25, 3, 0, 0));
    expect(backupFileName(at, "postgres")).toBe("2026-11-25T03-00-00.sql.gz");
    expect(backupFileName(at, "mongodb")).toBe("2026-11-25T03-00-00.archive.gz");
    expect(backupFileName(at, "volume")).toBe("2026-11-25T03-00-00.tar.gz");
    expect(isBackupFileName("2026-11-25T03-00-00.sql.gz", "mysql")).toBe(true);
    expect(isBackupFileName("2026-11-25T03-00-00.sql.gz", "volume")).toBe(false);
    expect(isBackupFileName("notes.txt")).toBe(false);
    // 0.1.x's names (R2-06, R3-44): milliseconds and Z, .bson.gz, <volume>-<time>.tar.
    expect(isBackupFileName("2026-11-25T03-00-00-123Z.sql.gz", "postgres")).toBe(true);
    expect(isBackupFileName("2026-11-25T03-00-00-123Z.sql.gz", "libsql")).toBe(true);
    expect(isBackupFileName("2026-11-25T03-00-00-123Z.bson.gz", "mongodb")).toBe(true);
    expect(isBackupFileName("2026-11-25T03-00-00-123Z.bson.gz", "postgres")).toBe(false);
    expect(isBackupFileName("data-2026-11-25T03-00-00-123Z.tar", "volume")).toBe(true);
    expect(isBackupFileName("data-2026-11-25T03-00-00-123Z.tar", "postgres")).toBe(false);
    expect(isBackupFileName("2026-11-25T03-00-00-12Z.sql.gz")).toBe(false);
    expect(isLegacyBackupFileName("2026-11-25T03-00-00-123Z.sql.gz")).toBe(true);
    expect(isLegacyBackupFileName("2026-11-25T03-00-00.sql.gz")).toBe(false);
    // A volume backup is named after its volume, so two volumes can share a folder (G3-20).
    expect(backupFileName(at, "volume", false, "shop-web-a1b2c3-data")).toBe(
      "shop-web-a1b2c3-data-2026-11-25T03-00-00.tar.gz",
    );
    expect(backupFileName(at, "postgres", false, "data")).toBe("2026-11-25T03-00-00.sql.gz");
    expect(isBackupFileName("shop-web-a1b2c3-data-2026-11-25T03-00-00.tar.gz", "volume")).toBe(
      true,
    );
    expect(isBackupFileName("data-2026-11-25T03-00-00.tar.gz", "libsql")).toBe(false);
    expect(backupFileVolume("shop-web-a1b2c3-data-2026-11-25T03-00-00.tar.gz")).toBe(
      "shop-web-a1b2c3-data",
    );
    expect(backupFileVolume("uploads-2026-11-25T03-00-00-123Z.tar")).toBe("uploads");
    expect(backupFileVolume("2026-11-25T03-00-00.tar.gz")).toBeNull();
    expect(backupFileTime("data-2026-11-25T03-00-00.tar.gz")).toBe("2026-11-25T03-00-00-000");
    // A moved volume schedule's 0.1.x files are only its own volume's (C1-12).
    expect(isLegacyFileOf("data-2026-11-20T03-00-00-123Z.tar", "data")).toBe(true);
    expect(isLegacyFileOf("uploads-2026-11-22T03-00-00-123Z.tar", "data")).toBe(false);
    expect(isLegacyFileOf("data-extra-2026-11-22T03-00-00-123Z.tar", "data")).toBe(false);
    expect(isLegacyFileOf("2026-11-20T03-00-00-123Z.sql.gz", null)).toBe(true);
    expect(isLegacyFileOf("2026-11-20T03-00-00.sql.gz", null)).toBe(false);
    // libSQL with namespaces archives its data folder (R3-51).
    expect(backupFileName(at, "libsql", true)).toBe("2026-11-25T03-00-00.tar.gz");
    expect(isBackupFileName("2026-11-25T03-00-00.tar.gz", "libsql")).toBe(true);
    // 1.0's and 0.1.x's names sort together by time.
    expect(
      [
        "2026-11-24T03-00-00.sql.gz",
        "data-2026-11-26T03-00-00-001Z.tar",
        "2026-11-25T03-00-00-500Z.sql.gz",
      ].sort(newestFirst),
    ).toEqual([
      "data-2026-11-26T03-00-00-001Z.tar",
      "2026-11-25T03-00-00-500Z.sql.gz",
      "2026-11-24T03-00-00.sql.gz",
    ]);
    expect(backupFileTime("2026-11-25T03-00-00.sql.gz")).toBe("2026-11-25T03-00-00-000");
  });

  test("a file belongs to a service only under its own prefixes (G1, G2)", () => {
    const app = "shop-db-x1y2z3";
    expect(backupPrefix(app, "daily")).toBe("shop-db-x1y2z3/daily/");
    expect(backupPrefix(app, "daily", "postgres")).toBe("shop-db-x1y2z3_postgres/daily/");
    expect(fileBelongsToService(`${app}/daily/2026-11-25T03-00-00.sql.gz`, app)).toBe(true);
    expect(fileBelongsToService(`${app}_web/daily/2026-11-25T03-00-00.tar.gz`, app)).toBe(true);
    expect(fileBelongsToService(`shop-db-x1y2z4/daily/2026-11-25T03-00-00.sql.gz`, app)).toBe(
      false,
    );
    // A longer app name that starts with this one is another service.
    expect(fileBelongsToService(`${app}-copy/daily/2026-11-25T03-00-00.sql.gz`, app)).toBe(false);
    expect(fileBelongsToService(`${app}/../other/daily/2026-11-25T03-00-00.sql.gz`, app)).toBe(
      false,
    );
    // Straight under the app name: a folderless schedule moved from 0.1.x wrote it (R2-06).
    expect(fileBelongsToService(`${app}/2026-11-25T03-00-00-123Z.sql.gz`, app)).toBe(true);
    expect(backupPrefix(app, "")).toBe("shop-db-x1y2z3/");
    expect(fileBelongsToService("2026-11-25T03-00-00.sql.gz", app)).toBe(false);
    expect(fileBelongsToService(`${app}/daily/evil.sh`, app)).toBe(false);
    expect(isSafeKey("/abs/key")).toBe(false);
    expect(isSafeKey("a/./b")).toBe(false);
  });
});

describe("request fields (spec 17.1, 8.3)", () => {
  test("a destination needs every field; the region defaults to auto", () => {
    const parsed = createDestinationRequestSchema.parse({
      name: "Offsite",
      provider: "cloudflare-r2",
      endpoint: "https://abc123.r2.cloudflarestorage.com/",
      bucket: "backups",
      region: "",
      accessKeyId: " key ",
      secretAccessKey: "secret",
    });
    expect(parsed.region).toBe("auto");
    expect(parsed.endpoint).toBe("https://abc123.r2.cloudflarestorage.com");
    expect(parsed.accessKeyId).toBe("key");
    const sample = createDestinationRequestSchema.safeParse({
      name: "R2",
      provider: "cloudflare-r2",
      endpoint: "https://<account-id>.r2.cloudflarestorage.com",
      bucket: "b1",
      accessKeyId: "a",
      secretAccessKey: "b",
    });
    expect(sample.success).toBe(false);
  });

  test("blank keys on edit mean keep", () => {
    const parsed = updateDestinationRequestSchema.parse({
      name: "New",
      accessKeyId: "",
      secretAccessKey: "",
    });
    expect(parsed).toEqual({ name: "New", accessKeyId: "", secretAccessKey: "" });
  });

  test("keep is blank or at least 1; the cron is normalized", () => {
    const base = {
      destinationId: "00000000-0000-4000-8000-000000000001",
      folder: "daily",
      cron: "0  3 * * *",
    };
    expect(createScheduleRequestSchema.parse({ ...base, keep: "" }).keep).toBeNull();
    expect(createScheduleRequestSchema.parse({ ...base, keep: 3 }).cron).toBe("0 3 * * *");
    expect(createScheduleRequestSchema.safeParse({ ...base, keep: 0 }).success).toBe(false);
    expect(createScheduleRequestSchema.safeParse({ ...base, keep: 1.5 }).success).toBe(false);
    expect(createScheduleRequestSchema.safeParse({ ...base, cron: "nope" }).success).toBe(false);
    // The forms 0.1.x ran: the last day, the first Monday, the last Friday, "?" (G3-14).
    for (const cron of ["0 3 L * *", "0 3 * * 1#1", "0 3 ? * 5L"])
      expect(createScheduleRequestSchema.safeParse({ ...base, cron }).success).toBe(true);
    expect(describeSchedule("0 3 L * *")).toBe("On the last day of each month at 03:00");
    expect(describeSchedule("0 3 ? * 1#1")).toBe("On the first Monday of each month at 03:00");
    expect(nextRunAfter(cron("0 3 * * 5L"), Date.UTC(2026, 10, 25), "UTC")).toBe(
      Date.UTC(2026, 10, 27, 3),
    );
  });

  test("a restore names its file and the typed name", () => {
    expect(
      restoreRequestSchema.safeParse({
        destinationId: "00000000-0000-4000-8000-000000000001",
        key: "",
        confirm: "db",
      }).success,
    ).toBe(false);
  });
});

describe("Nearzero's own volumes (spec 22.4 rule 4)", () => {
  test("are never backed up or restored over, the runner link's certificate included (C4-10)", async () => {
    const { isReservedVolume, RESERVED_VOLUMES } = await import("../src/runner-backups.ts");
    for (const name of [
      "nearzero-postgres-data",
      "nearzero-runner-state",
      "nearzero-runner-handoff",
      "nearzero-runner-link",
      "nearzero-router-certificates",
      "nearzero-buildkit-state",
      "nearzero-backup-0b5e1d3c-1f7a-4c1e-9f2a-6d3b8e2a9c10",
    ]) {
      expect([name, isReservedVolume(name)]).toEqual([name, true]);
    }
    expect(RESERVED_VOLUMES).toContain("nearzero-runner-link");
    expect(isReservedVolume("shop-data")).toBe(false);
  });
});
