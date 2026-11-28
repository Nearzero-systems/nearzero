import { describe, expect, test } from "bun:test";
import {
  metricsSampleSchema,
  monitoringCards,
  NOT_REPORTING_AFTER_MS,
  notReportingMessage,
  reportingState,
  storageDetail,
  storagePercent,
} from "../src/index.ts";

/** Storage as df counts it (30c R3-34), and servers that stopped reporting (30c R3-33). */

const GB = 1024 ** 3;

describe("storage usage (30c R3-34)", () => {
  test("used / (used + available), rounded up like df", () => {
    // A full ext4 disk with 5% reserved for root: df says 100%.
    expect(
      storagePercent({ diskUsedBytes: 95 * GB, diskTotalBytes: 100 * GB, diskAvailableBytes: 0 }),
    ).toBe(100);
    // 99.2% in use is "100%" in df.
    expect(
      storagePercent({ diskUsedBytes: 992, diskTotalBytes: 1050, diskAvailableBytes: 8 }),
    ).toBe(100);
    // Exactly half is 50%, not 51%.
    expect(storagePercent({ diskUsedBytes: 50, diskTotalBytes: 110, diskAvailableBytes: 50 })).toBe(
      50,
    );
    expect(storagePercent({ diskUsedBytes: 0, diskTotalBytes: 0, diskAvailableBytes: 0 })).toBe(0);
    // Very large disks still round sensibly.
    expect(
      storagePercent({
        diskUsedBytes: 600 * 1024 ** 4,
        diskTotalBytes: 1000 * 1024 ** 4,
        diskAvailableBytes: 350 * 1024 ** 4,
      }),
    ).toBe(64);
  });

  test("an older runner's sample, without the available figure, reads used / total", () => {
    expect(storagePercent({ diskUsedBytes: 95 * GB, diskTotalBytes: 100 * GB })).toBe(95);
    expect(storageDetail({ diskUsedBytes: 95 * GB, diskTotalBytes: 100 * GB })).toBe(
      "95.0 GB / 100.0 GB",
    );
    expect(
      storageDetail({ diskUsedBytes: 95 * GB, diskTotalBytes: 100 * GB, diskAvailableBytes: 0 }),
    ).toBe("95.0 GB / 100.0 GB, 0.0 GB free");
  });

  test("the protocol takes samples with and without the available figure", () => {
    const base = {
      at: 1,
      cpuPercent: 1,
      memoryUsedBytes: 1,
      memoryTotalBytes: 2,
      diskUsedBytes: 1,
      diskTotalBytes: 2,
      uptimeSeconds: 1,
    };
    expect(metricsSampleSchema.parse(base).diskAvailableBytes).toBeUndefined();
    expect(metricsSampleSchema.parse({ ...base, diskAvailableBytes: 1 }).diskAvailableBytes).toBe(
      1,
    );
    expect(metricsSampleSchema.safeParse({ ...base, diskAvailableBytes: -1 }).success).toBe(false);
  });
});

describe("a server that stopped reporting (30c R3-33)", () => {
  const now = Date.parse("2026-11-28T14:10:00Z");
  const last = Date.parse("2026-11-28T14:05:09Z");

  test("connected, or gone for under a minute, is current", () => {
    expect(
      reportingState({ name: "web-1", online: true, lastSeenAt: null, lastSampleAt: last, now })
        .current,
    ).toBe(true);
    expect(
      reportingState({
        name: "web-1",
        online: false,
        lastSeenAt: now - NOT_REPORTING_AFTER_MS,
        lastSampleAt: last,
        now,
      }).current,
    ).toBe(true);
  });

  test("gone for over a minute says so, with when the last sample was taken", () => {
    expect(
      reportingState({
        name: "web-1",
        online: false,
        lastSeenAt: last + 1_000,
        lastSampleAt: last,
        now,
      }),
    ).toEqual({
      current: false,
      lastSampleAt: "2026-11-28T14:05:09.000Z",
      message: "web-1 isn't reporting. The last sample was taken 2026-11-28 14:05:09 UTC.",
    });
    expect(notReportingMessage("web-1", null)).toBe(
      "web-1 isn't reporting, and no sample has arrived yet.",
    );
    // Never connected and never sampled: the panel's "No samples yet" says it instead.
    expect(
      reportingState({ name: "web-1", online: false, lastSeenAt: null, lastSampleAt: null, now })
        .message,
    ).toBeNull();
  });

  test("the cards show dashes, not old figures, without a current sample", () => {
    expect(monitoringCards(null)).toEqual({
      uptime: "—",
      cpu: "—",
      memory: "—",
      memoryDetail: "",
      disk: "—",
      diskDetail: "",
      meters: { cpu: 0, memory: 0, disk: 0 },
    });
    expect(
      monitoringCards({
        cpuPercent: 12.34,
        memoryUsedBytes: 1 * GB,
        memoryTotalBytes: 4 * GB,
        diskUsedBytes: 95 * GB,
        diskTotalBytes: 100 * GB,
        diskAvailableBytes: 0,
        uptimeSeconds: 120,
      }),
    ).toEqual({
      uptime: "2 minutes",
      cpu: "12.3%",
      memory: "25.0%",
      memoryDetail: "1.0 GB / 4.0 GB",
      disk: "100%",
      diskDetail: "95.0 GB / 100.0 GB, 0.0 GB free",
      meters: { cpu: 12.34, memory: 25, disk: 100 },
    });
  });
});
