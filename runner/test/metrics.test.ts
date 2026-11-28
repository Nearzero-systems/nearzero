import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { storagePercent } from "@nearzero/shared";
import {
  diskFigures,
  type FilesystemStats,
  MetricsCollector,
  rootFilesystemPath,
} from "../src/metrics.ts";

/** Storage usage as df counts it, on the server's own root filesystem (30c R3-34). */

const FULL_EXT4: FilesystemStats = {
  // A 4 GB ext4 disk with 5% reserved for root, every other block in use: df says 100%.
  bsize: 4096,
  blocks: 1_000_000,
  bfree: 50_000,
  bavail: 0,
};

describe("disk figures (30c R3-34)", () => {
  test("a full ext4 disk with 5% reserved for root reads 100%, as df says", () => {
    const figures = diskFigures(FULL_EXT4);
    expect(figures).toEqual({
      diskUsedBytes: 950_000 * 4096,
      diskTotalBytes: 1_000_000 * 4096,
      diskAvailableBytes: 0,
    });
    expect(storagePercent(figures)).toBe(100);
    // The old figure, used / total, read 95% on the same disk.
    expect(storagePercent({ ...figures, diskAvailableBytes: undefined })).toBe(95);
  });

  test("reserved space is neither used nor available, like df's Use%", () => {
    // df: Used 600000, Available 350000 blocks → 600000 / 950000 = 63.2%, shown as 64%.
    const figures = diskFigures({
      bsize: 1024,
      blocks: 1_000_000,
      bfree: 400_000,
      bavail: 350_000,
    });
    expect(figures.diskUsedBytes).toBe(600_000 * 1024);
    expect(figures.diskAvailableBytes).toBe(350_000 * 1024);
    expect(storagePercent(figures)).toBe(64);
  });

  test("no figures read as an empty disk", () => {
    expect(diskFigures(null)).toEqual({
      diskUsedBytes: 0,
      diskTotalBytes: 0,
      diskAvailableBytes: 0,
    });
  });
});

describe("which root filesystem is measured (30c R3-34)", () => {
  test("NEARZERO_HOST_ROOT_PATH when the install gives one, else /", () => {
    expect(rootFilesystemPath({})).toBe("/");
    expect(rootFilesystemPath({ NEARZERO_HOST_ROOT_PATH: "" })).toBe("/");
    expect(rootFilesystemPath({ NEARZERO_HOST_ROOT_PATH: "relative/path" })).toBe("/");
    expect(rootFilesystemPath({ NEARZERO_HOST_ROOT_PATH: " /run/host-root " })).toBe(
      "/run/host-root",
    );
  });

  test("the collector measures the host's root path, and / when it can't be read", async () => {
    const asked: string[] = [];
    const host: FilesystemStats = { bsize: 4096, blocks: 100, bfree: 10, bavail: 5 };
    const own: FilesystemStats = { bsize: 4096, blocks: 900, bfree: 800, bavail: 700 };
    const collector = new MetricsCollector("/run/host-root", async (path) => {
      asked.push(path);
      if (path === "/run/host-root") return host;
      return own;
    });
    const sample = await collector.sample(1_000);
    expect(asked).toEqual(["/run/host-root"]);
    expect(sample).toMatchObject({
      diskUsedBytes: 90 * 4096,
      diskTotalBytes: 100 * 4096,
      diskAvailableBytes: 5 * 4096,
    });

    const missing: string[] = [];
    const fallback = new MetricsCollector("/run/host-root", async (path) => {
      missing.push(path);
      if (path === "/run/host-root") throw new Error("ENOENT");
      return own;
    });
    expect((await fallback.sample()).diskTotalBytes).toBe(900 * 4096);
    expect(missing).toEqual(["/run/host-root", "/"]);
  });

  test("a real filesystem gives used, total and available", async () => {
    const sample = await new MetricsCollector(tmpdir()).sample();
    expect(sample.diskTotalBytes).toBeGreaterThan(0);
    expect(sample.diskAvailableBytes).toBeGreaterThan(0);
    expect((sample.diskAvailableBytes ?? 0) + sample.diskUsedBytes).toBeLessThanOrEqual(
      sample.diskTotalBytes,
    );
  });
});
