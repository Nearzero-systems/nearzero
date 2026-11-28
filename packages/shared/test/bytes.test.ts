import { describe, expect, test } from "bun:test";
import * as browser from "../src/browser.ts";
import { byteUnitIndex, formatBytes } from "../src/bytes.ts";

/** The one byte formatter (backups, uploads, the runner's archive line, the Docker cleanup). */
describe("byte sizes", () => {
  test("nothing, and sizes that can't be shown, read 0 B", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("0 B");
  });

  test("under 1 KB is whole bytes", () => {
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(10.6)).toBe("11 B");
  });

  test("exact unit boundaries move to the next unit", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1024 ** 2)).toBe("1.0 MB");
    expect(formatBytes(1024 ** 3)).toBe("1.00 GB");
    expect(formatBytes(1024 ** 4)).toBe("1.00 TB");
    expect(formatBytes(1024 ** 2 - 1)).toBe("1024.0 KB");
    for (let index = 1; index <= 4; index++) {
      expect(byteUnitIndex(1024 ** index)).toBe(index);
      expect(byteUnitIndex(1024 ** index - 1)).toBe(index - 1);
    }
  });

  test("the sizes backups and uploads showed before", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(12.4 * 1024 * 1024)).toBe("12.4 MB");
    expect(formatBytes(2.5 * 1024 ** 3)).toBe("2.50 GB");
  });

  test("large values stay in TB, and the largest unit can be capped", () => {
    expect(formatBytes(1024 ** 5)).toBe("1024.00 TB");
    expect(formatBytes(3 * 1024 ** 6)).toBe("3145728.00 TB");
    expect(formatBytes(1024 ** 3, { largest: "MB" })).toBe("1024.0 MB");
    expect(formatBytes(200 * 1024 * 1024, { largest: "MB" })).toBe("200.0 MB");
    expect(formatBytes(5000, { largest: "B" })).toBe("5000 B");
  });

  test("the console can use it", () => {
    expect(browser.formatBytes(2048)).toBe("2.0 KB");
  });
});

describe("whole-unit limits", () => {
  test("trimZeros drops all-zero decimals only", () => {
    const mb = 1024 * 1024;
    expect(formatBytes(10 * mb, { largest: "MB", trimZeros: true })).toBe("10 MB");
    expect(formatBytes(10.5 * mb, { largest: "MB", trimZeros: true })).toBe("10.5 MB");
    expect(formatBytes(3 * 1024 * mb, { largest: "MB", trimZeros: true })).toBe("3072 MB");
    expect(formatBytes(10 * mb)).toBe("10.0 MB");
  });
});
