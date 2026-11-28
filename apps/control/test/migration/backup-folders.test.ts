import { describe, expect, test } from "bun:test";
import { backupScheduleSchema } from "../../src/migration/records.ts";

/**
 * 0.1.x backup schedules with no folder (R2-06): 0.1.x wrote their files straight under the app
 * name, and the move keeps them there, so the bundle record takes an empty folder.
 */

describe("a 0.1.x backup schedule's folder", () => {
  test("may be empty", () => {
    const record = {
      ref: "bkp_root",
      serviceRef: "svc_pg",
      destinationRef: "dst_s3",
      kind: "Database",
      name: null,
      database: "shop",
      composeDatabase: null,
      volume: null,
      innerService: null,
      folder: "",
      cron: "0 3 * * *",
      timeZone: null,
      keep: 7,
      enabled: true,
      stopWhileCopying: false,
      createdAt: null,
    };
    expect(backupScheduleSchema.parse(record).folder).toBe("");
    expect(backupScheduleSchema.safeParse({ ...record, folder: "x".repeat(201) }).success).toBe(
      false,
    );
  });
});
