import { describe, expect, test } from "bun:test";
import { interpreterLibc } from "../scripts/libc.ts";
import { readConfig } from "../src/config.ts";
import { imageWithTag, type PullEvent, PullMeter } from "../src/docker/client.ts";
import { Demuxer } from "../src/docker/demux.ts";
import { cpuPercent, parseCpuTimes, parseMemory, physicalCores } from "../src/metrics.ts";
import { reconnectDelay } from "../src/session.ts";

/** Smaller pieces of the runner: Docker's stream frames, metrics parsing, settings, backoff. */

function frame(stream: number, text: string): Uint8Array {
  const payload = new TextEncoder().encode(text);
  const out = new Uint8Array(8 + payload.length);
  out[0] = stream;
  new DataView(out.buffer).setUint32(4, payload.length);
  out.set(payload, 8);
  return out;
}

describe("Docker's multiplexed output", () => {
  test("frames split anywhere come back as one stream, in order", () => {
    const all = new Uint8Array([
      ...frame(1, "out 1\n"),
      ...frame(2, "err 1\n"),
      ...frame(1, "out 2\n"),
    ]);
    for (let cut = 0; cut <= all.length; cut++) {
      const demuxer = new Demuxer();
      const parts = [...demuxer.push(all.subarray(0, cut)), ...demuxer.push(all.subarray(cut))];
      expect(parts.map((part) => new TextDecoder().decode(part)).join("")).toBe(
        "out 1\nerr 1\nout 2\n",
      );
      expect(demuxer.pendingBytes).toBe(0);
    }
  });
});

describe("pull progress (spec 6.5)", () => {
  /** A pull as the Engine reports it: layers announced, sizes learned late, then extraction. */
  const events: PullEvent[] = [
    { status: "Pulling from library/app", id: "1.0" },
    { status: "Pulling fs layer", id: "a" },
    { status: "Pulling fs layer", id: "b" },
    { status: "Waiting", id: "c" },
    { status: "Downloading", id: "a", progressDetail: { current: 50, total: 100 } },
    { status: "Downloading", id: "a", progressDetail: { current: 100, total: 100 } },
    { status: "Download complete", id: "a" },
    // b's size arrives only now and is much larger than a's.
    { status: "Downloading", id: "b", progressDetail: { current: 10, total: 1000 } },
    // Extraction reports its own sizes, starting from zero again.
    { status: "Extracting", id: "a", progressDetail: { current: 1, total: 100 } },
    { status: "Downloading", id: "b", progressDetail: { current: 600, total: 1000 } },
    { status: "Downloading", id: "c", progressDetail: { current: 0, total: 10 } },
    { status: "Download complete", id: "b" },
    { status: "Download complete", id: "c" },
    { status: "Pull complete", id: "a" },
    { status: "Pull complete", id: "b" },
    { status: "Pull complete", id: "c" },
    { status: "Digest: sha256:abc" },
    { status: "Status: Downloaded newer image for app:1.0" },
  ];

  test("the percentage never goes down and reaches 100 only when every layer is in", () => {
    const meter = new PullMeter();
    const seen = events.map((event) => meter.update(event).percent);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i] as number).toBeGreaterThanOrEqual(seen[i - 1] as number);
    }
    expect(Math.max(...seen.slice(0, 12))).toBeLessThan(100);
    expect(seen.at(-1)).toBe(100);
    // With a's size known and b, c unknown, the guess stays well below "a is done".
    expect(seen[5]).toBeLessThan(50);
  });

  test("layer changes are worth a line; byte counts and the repository line aren't layers", () => {
    const meter = new PullMeter();
    const lines = events.map((event) => meter.update(event).line).filter(Boolean);
    expect(lines).toContain("a: Pulling fs layer");
    expect(lines).toContain("c: Pull complete");
    expect(lines).toContain("Status: Downloaded newer image for app:1.0");
    expect(lines.some((line) => line?.startsWith("a: Downloading"))).toBe(false);
  });

  test("an image whose layers all exist already is at 100 at once", () => {
    const meter = new PullMeter();
    expect(meter.update({ status: "Already exists", id: "a" }).percent).toBe(100);
  });
});

describe("the compiled runners' C library", () => {
  const head = (interpreter: string) =>
    new Uint8Array([0x7f, 0x45, 0x4c, 0x46, ...new TextEncoder().encode(`\0\0${interpreter}\0`)]);

  test("is read from the program interpreter", () => {
    expect(interpreterLibc(head("/lib/ld-linux-aarch64.so.1"))).toBe("glibc");
    expect(interpreterLibc(head("/lib64/ld-linux-x86-64.so.2"))).toBe("glibc");
    expect(interpreterLibc(head("/lib/ld-musl-aarch64.so.1"))).toBe("musl");
    expect(interpreterLibc(head("/lib/ld-musl-x86_64.so.1"))).toBe("musl");
    expect(interpreterLibc(new Uint8Array([0x7f, 0x45, 0x4c, 0x46]))).toBeNull();
  });
});

describe("image references", () => {
  test("a pull always names one tag", () => {
    expect(imageWithTag("nginx")).toBe("nginx:latest");
    expect(imageWithTag("nginx:alpine")).toBe("nginx:alpine");
    expect(imageWithTag("localhost:5000/app")).toBe("localhost:5000/app:latest");
    expect(imageWithTag("ghcr.io/a/b@sha256:abc")).toBe("ghcr.io/a/b@sha256:abc");
  });
});

describe("metrics (spec 14.1)", () => {
  test("CPU use comes from the change in /proc/stat between samples", () => {
    const before = parseCpuTimes("cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 1 2 3 4\n");
    const after = parseCpuTimes("cpu  150 0 150 900 0 0 0 0 0 0\n");
    expect(before).toEqual({ busy: 200, total: 1000 });
    if (!before || !after) throw new Error("unparsed");
    expect(cpuPercent(before, after)).toBe(50);
    expect(cpuPercent(after, after)).toBe(0);
  });

  test("memory used is total minus available", () => {
    expect(
      parseMemory("MemTotal:       2048 kB\nMemFree: 100 kB\nMemAvailable:   1024 kB\n"),
    ).toEqual({
      total: 2048 * 1024,
      available: 1024 * 1024,
    });
    expect(parseMemory("nothing")).toBeNull();
  });

  test("physical cores are counted from core ids", () => {
    const info =
      "processor: 0\nphysical id: 0\ncore id: 0\n\nprocessor: 1\nphysical id: 0\ncore id: 0\n\nprocessor: 2\nphysical id: 0\ncore id: 1\n";
    expect(physicalCores(info)).toBe(2);
    expect(physicalCores("processor: 0\n")).toBeNull();
  });
});

describe("settings", () => {
  test("every problem is reported at once", () => {
    const result = readConfig({ NEARZERO_HTTP_PORT: "eighty", NEARZERO_LOG_LEVEL: "loud" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toHaveLength(3);
    expect(result.problems[0]).toContain("NEARZERO_CONTROL_URL is not set");
  });

  test("defaults, and the control plane's origin only", () => {
    const result = readConfig({ NEARZERO_CONTROL_URL: "https://nz.example.com/some/path" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.controlUrl).toBe("https://nz.example.com");
    expect(result.config.router).toMatchObject({
      directory: "/etc/nearzero/router",
      httpPort: 80,
      httpsPort: 443,
    });
    expect(result.config.network).toBe("nearzero-edge");
  });
});

describe("reconnecting", () => {
  test("waits 1 second, doubling to 30, with jitter", () => {
    expect(reconnectDelay(0, () => 0.5)).toBe(1000);
    expect(reconnectDelay(3, () => 0.5)).toBe(8000);
    expect(reconnectDelay(20, () => 0.5)).toBe(30000);
    expect(reconnectDelay(20, () => 1)).toBe(37500);
  });
});
