import { readFile, statfs } from "node:fs/promises";
import { arch, cpus, hostname, release } from "node:os";
import { METRICS_INTERVAL_MS, type MetricsSample, type SystemInfo } from "@nearzero/shared";
import { serverTimeZone } from "./backups/time-zone.ts";
import type { DockerClient } from "./docker/client.ts";

/**
 * Server metrics, collected by the runner itself (spec 14.1, spec 25 D5: no separate monitoring
 * service): CPU use, memory used and total, disk used, total and available for the root
 * filesystem, uptime, and system information. Network is not collected in 1.0.
 *
 * /proc/stat, /proc/meminfo and /proc/uptime describe the whole machine even inside a container,
 * so the Nearzero host's runner reads the host's figures too. The root filesystem doesn't: inside
 * a container "/" is the container's own, which lives on the disk holding Docker's data. So the
 * host's runner measures NEARZERO_HOST_ROOT_PATH instead, a read-only bind of one file of the
 * host's root filesystem (installer/compose.yml), which gives it nothing it could write (30c
 * R3-34). Anywhere else, and when that path can't be read, it measures "/".
 */

export interface CpuTimes {
  busy: number;
  total: number;
}

/** The first line of /proc/stat: time spent busy and in total since boot. */
export function parseCpuTimes(procStat: string): CpuTimes | null {
  const line = procStat.split("\n").find((entry) => entry.startsWith("cpu "));
  if (!line) return null;
  const values = line.trim().split(/\s+/).slice(1).map(Number);
  // user nice system idle iowait irq softirq steal (guest time is already in user and nice).
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] =
    values;
  const idleAll = idle + iowait;
  const total = user + nice + system + idleAll + irq + softirq + steal;
  return { busy: total - idleAll, total };
}

export function cpuPercent(previous: CpuTimes, current: CpuTimes): number {
  const total = current.total - previous.total;
  if (total <= 0) return 0;
  const busy = current.busy - previous.busy;
  return Math.min(100, Math.max(0, Math.round((busy / total) * 1000) / 10));
}

/** MemTotal and MemAvailable from /proc/meminfo, in bytes. */
export function parseMemory(meminfo: string): { total: number; available: number } | null {
  const read = (name: string) => {
    const match = new RegExp(`^${name}:\\s+(\\d+) kB`, "m").exec(meminfo);
    return match ? Number(match[1]) * 1024 : null;
  };
  const total = read("MemTotal");
  if (total === null) return null;
  const available = read("MemAvailable") ?? read("MemFree") ?? 0;
  return { total, available };
}

/** What statfs says about a filesystem: blocks of `bsize` bytes in all, free, and free to anyone. */
export interface FilesystemStats {
  bsize: number;
  blocks: number;
  bfree: number;
  bavail: number;
}

/**
 * A filesystem's size, use and free space as df counts them: used is everything not free
 * (blocks − bfree), and available is what anyone but root may still write (bavail), so space
 * reserved for root is neither used nor available (30c R3-34).
 */
export function diskFigures(stats: FilesystemStats | null): {
  diskUsedBytes: number;
  diskTotalBytes: number;
  diskAvailableBytes: number;
} {
  if (!stats) return { diskUsedBytes: 0, diskTotalBytes: 0, diskAvailableBytes: 0 };
  const total = stats.blocks * stats.bsize;
  return {
    diskUsedBytes: Math.max(0, total - stats.bfree * stats.bsize),
    diskTotalBytes: total,
    diskAvailableBytes: Math.max(0, stats.bavail * stats.bsize),
  };
}

/** The path whose filesystem is the server's root: the host's, when the install points at it. */
export function rootFilesystemPath(env: Record<string, string | undefined>): string {
  const path = env.NEARZERO_HOST_ROOT_PATH?.trim() ?? "";
  return path.startsWith("/") ? path : "/";
}

export class MetricsCollector {
  #previous: CpuTimes | null = null;
  readonly #root: string;
  readonly #statfs: (path: string) => Promise<FilesystemStats>;

  constructor(
    rootPath = rootFilesystemPath(process.env),
    readStats: (path: string) => Promise<FilesystemStats> = statfs,
  ) {
    this.#root = rootPath;
    this.#statfs = readStats;
  }

  /** The root filesystem's figures; "/" when the configured path can't be read. */
  async #disk(): Promise<FilesystemStats | null> {
    const stats = await this.#statfs(this.#root).catch(() => null);
    if (stats || this.#root === "/") return stats;
    return this.#statfs("/").catch(() => null);
  }

  async sample(now = Date.now()): Promise<MetricsSample> {
    const [stat, meminfo, uptime, disk] = await Promise.all([
      readFile("/proc/stat", "utf8").catch(() => ""),
      readFile("/proc/meminfo", "utf8").catch(() => ""),
      readFile("/proc/uptime", "utf8").catch(() => ""),
      this.#disk(),
    ]);
    const times = parseCpuTimes(stat);
    const cpu = times && this.#previous ? cpuPercent(this.#previous, times) : 0;
    if (times) this.#previous = times;
    const memory = parseMemory(meminfo) ?? { total: 0, available: 0 };
    return {
      at: now,
      cpuPercent: cpu,
      memoryUsedBytes: Math.max(0, memory.total - memory.available),
      memoryTotalBytes: memory.total,
      ...diskFigures(disk),
      uptimeSeconds: Math.floor(Number(uptime.split(/\s+/)[0] ?? 0) || 0),
    };
  }
}

/** Counts physical cores from /proc/cpuinfo; null when it doesn't say. */
export function physicalCores(cpuinfo: string): number | null {
  const pairs = new Set<string>();
  let physical = "0";
  for (const line of cpuinfo.split("\n")) {
    const [key, value] = line.split(":").map((part) => part.trim());
    if (key === "physical id") physical = value ?? "0";
    if (key === "core id") pairs.add(`${physical}:${value}`);
  }
  return pairs.size > 0 ? pairs.size : null;
}

export async function systemInfo(docker: DockerClient | null, containerized: boolean) {
  const list = cpus();
  const cpuinfo = await readFile("/proc/cpuinfo", "utf8").catch(() => "");
  const engine = docker ? await docker.info().catch(() => null) : null;
  const osRelease = await readFile("/etc/os-release", "utf8").catch(() => "");
  const prettyName = /^PRETTY_NAME="?([^"\n]*)"?/m.exec(osRelease)?.[1] ?? "Linux";
  const info: SystemInfo = {
    hostname: engine?.Name ?? hostname(),
    // Inside a container /etc/os-release is the image's; the engine knows the host's system.
    os: (containerized ? engine?.OperatingSystem : prettyName) ?? prettyName,
    kernel: engine?.KernelVersion ?? release(),
    architecture: engine?.Architecture ?? arch(),
    cpuModel: list[0]?.model?.trim() || "Unknown",
    cpuCores: physicalCores(cpuinfo) ?? list.length,
    cpuThreads: list.length,
    cpuMhz: list[0]?.speed ?? 0,
    memoryTotalBytes: engine?.MemTotal ?? 0,
    dockerVersion: engine?.ServerVersion ?? null,
    containerized,
    // Backup schedules run in the server's time zone (spec 08 8.3).
    timeZone: await serverTimeZone(
      (engine as { SystemTime?: string } | null)?.SystemTime ?? null,
      containerized,
    ),
  };
  return info;
}

/**
 * How often samples are taken: NEARZERO_METRICS_REFRESH_SECONDS (1 to 3600, a setting 0.1.x had,
 * spec 03 3.5) when the runner has it, else every 5 seconds (spec 14.1).
 */
export function metricsIntervalMs(env: Record<string, string | undefined>): number {
  const value = env.NEARZERO_METRICS_REFRESH_SECONDS?.trim() ?? "";
  const seconds = /^\d{1,4}$/.test(value) ? Number(value) : 0;
  return seconds >= 1 && seconds <= 3600 ? seconds * 1000 : METRICS_INTERVAL_MS;
}
