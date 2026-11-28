/**
 * Monitoring (spec 14): the chart controls, the alert thresholds and the rule that decides when
 * an alert fires. Pure and browser-safe.
 *
 * An alert fires when the value stays above its threshold for 3 consecutive samples, then not
 * again for 30 minutes unless the value drops to or below the threshold and rises again (which
 * needs 3 consecutive samples above it once more).
 */

export const MONITORING_POINTS = ["50", "200", "500", "all"] as const;
export type MonitoringPoints = (typeof MONITORING_POINTS)[number];
export const MONITORING_POINT_LABELS: Record<MonitoringPoints, string> = {
  "50": "50 points",
  "200": "200 points",
  "500": "500 points",
  all: "All",
};

/** Seconds between refreshes; there is no refresh with "All". */
export const MONITORING_REFRESH_SECONDS = [5, 10, 20, 30] as const;

export const ALERT_METRICS = ["cpu", "memory"] as const;
export type AlertMetric = (typeof ALERT_METRICS)[number];

export const ALERT_METRIC_LABELS: Record<AlertMetric, string> = {
  cpu: "CPU",
  memory: "Memory",
};

export const ALERT_CONSECUTIVE_SAMPLES = 3;
export const ALERT_QUIET_MS = 30 * 60_000;
/** Samples older than this when they arrive (sent after a reconnect) never fire an alert. */
export const ALERT_STALE_MS = 5 * 60_000;

export const SERVER_ALERT_EVENT = "server.alert";

export const MONITORING_MESSAGES = {
  hostIntro: "Track host CPU, RAM, and storage usage for this Nearzero install.",
  serverIntro: "Track this server's CPU, RAM, and storage usage.",
  fetchError: "Error fetching metrics",
  noSamples: "No samples yet. The runner reports one every 5 seconds once it is connected.",
  cpuLabel: "CPU alert above (%)",
  memoryLabel: "Memory alert above (%)",
  thresholdHint: "Leave blank for no alert. Alerts go to channels that subscribe to Server alerts.",
  saved: "Alert settings saved",
  testSent: "Test alert sent",
  noChannels:
    "No notification channel subscribes to Server alerts yet. Add one in Settings → Channels.",
} as const;

/** A threshold as typed: blank is off; otherwise a whole number from 1 to 100. */
export function thresholdProblem(value: number | null): string | null {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    return "Enter a whole percentage from 1 to 100, or leave it blank for no alert.";
  }
  return null;
}

export interface AlertState {
  /** Consecutive samples above the threshold. */
  streak: number;
  /** When the last alert fired (ms), or null. */
  firedAt: number | null;
  /** The value dropped to or below the threshold since the last alert. */
  droppedSince: boolean;
}

export const INITIAL_ALERT_STATE: AlertState = { streak: 0, firedAt: null, droppedSince: true };

/**
 * Applies one sample. Returns the new state and whether an alert fires on this sample. A
 * threshold of null (off) resets the state.
 */
export function stepAlert(
  state: AlertState,
  value: number,
  threshold: number | null,
  at: number,
): { state: AlertState; fire: boolean } {
  if (threshold === null) return { state: { ...INITIAL_ALERT_STATE }, fire: false };
  if (!(value > threshold)) {
    return { state: { streak: 0, firedAt: state.firedAt, droppedSince: true }, fire: false };
  }
  const streak = state.streak + 1;
  const quietOver = state.firedAt === null || at - state.firedAt >= ALERT_QUIET_MS;
  const fire = streak >= ALERT_CONSECUTIVE_SAMPLES && (state.droppedSince || quietOver);
  if (fire) return { state: { streak, firedAt: at, droppedSince: false }, fire: true };
  return { state: { ...state, streak }, fire: false };
}

export function memoryPercent(used: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.min(100, Math.max(0, Math.round((used / total) * 1000) / 10));
}

/** The alert's words: "CPU on web-1 is at 93%, above its 50% threshold." */
export function alertSentence(
  server: string,
  metric: AlertMetric,
  value: number,
  threshold: number,
) {
  return `${ALERT_METRIC_LABELS[metric]} on ${server} is at ${Math.round(value)}%, above its ${threshold}% threshold.`;
}

/** Uptime in words: "3 days, 4 hours", "5 hours, 2 minutes", "40 seconds". */
export function uptimeText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const days = Math.floor(s / 86_400);
  const hours = Math.floor((s % 86_400) / 3_600);
  const minutes = Math.floor((s % 3_600) / 60);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (days > 0) return `${plural(days, "day")}, ${plural(hours, "hour")}`;
  if (hours > 0) return `${plural(hours, "hour")}, ${plural(minutes, "minute")}`;
  if (minutes > 0) return plural(minutes, "minute");
  return plural(s, "second");
}

/** Bytes as gigabytes with one decimal: "3.2 GB". */
export function gigabytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

// ---- Storage as df counts it (30c R3-34), and servers that stopped reporting (R3-33)

/** A sample's disk figures; older runners send no available figure. */
export interface DiskFigures {
  diskUsedBytes: number;
  diskTotalBytes: number;
  diskAvailableBytes?: number | null;
}

/**
 * Storage usage as a whole percentage, as df counts it: used / (used + available), rounded up.
 * Space reserved for root counts as not available, so a disk df shows at 100% reads 100%. An
 * older runner's sample, which has no available figure, reads used / total as before.
 */
export function storagePercent(sample: DiskFigures): number {
  const used = Math.max(0, sample.diskUsedBytes);
  const available = sample.diskAvailableBytes;
  const total =
    typeof available === "number" ? used + Math.max(0, available) : sample.diskTotalBytes;
  if (!(total > 0)) return 0;
  const hundreds = used * 100;
  if (!Number.isSafeInteger(hundreds) || !Number.isSafeInteger(total)) {
    return Math.min(100, Math.ceil(hundreds / total));
  }
  // Whole numbers, like df: 99.2% in use is "100%".
  const whole = Math.floor(hundreds / total);
  return Math.min(100, hundreds - whole * total > 0 ? whole + 1 : whole);
}

/** "40.2 GB / 50.0 GB, 7.3 GB free", or "40.2 GB / 50.0 GB" without the available figure. */
export function storageDetail(sample: DiskFigures): string {
  const base = `${gigabytes(sample.diskUsedBytes)} / ${gigabytes(sample.diskTotalBytes)}`;
  return typeof sample.diskAvailableBytes === "number"
    ? `${base}, ${gigabytes(sample.diskAvailableBytes)} free`
    : base;
}

/**
 * A server whose runner has been disconnected this long, with no newer sample, isn't reporting:
 * its last sample is history, not its current state (R3-33).
 */
export const NOT_REPORTING_AFTER_MS = 60_000;

/** A sample's time in words that read the same everywhere: "2026-11-28 14:05:09 UTC". */
export function sampleTimeText(at: number): string {
  return `${new Date(at).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/** "web-1 isn't reporting. The last sample was taken 2026-11-28 14:05:09 UTC." */
export function notReportingMessage(name: string, lastSampleAt: number | null): string {
  if (lastSampleAt === null) return `${name} isn't reporting, and no sample has arrived yet.`;
  return `${name} isn't reporting. The last sample was taken ${sampleTimeText(lastSampleAt)}.`;
}

/** What a metrics answer says about whether its figures are current (GET /servers/:id/metrics). */
export interface MetricsReporting {
  /** False once the server stopped reporting: its figures are then shown as history only. */
  current: boolean;
  lastSampleAt: string | null;
  /** Why the figures aren't current, in plain words; null while they are. */
  message: string | null;
}

/**
 * Whether a server is reporting (R3-33): yes while its runner is connected; after it went away,
 * still yes for a minute from the last time it was heard from or the newest sample, whichever is
 * later; then no.
 */
export function reportingState(input: {
  name: string;
  online: boolean;
  lastSeenAt: number | null;
  lastSampleAt: number | null;
  now: number;
}): MetricsReporting {
  const lastSampleAt =
    input.lastSampleAt === null ? null : new Date(input.lastSampleAt).toISOString();
  const heard = Math.max(input.lastSeenAt ?? 0, input.lastSampleAt ?? 0);
  if (input.online || (heard > 0 && input.now - heard <= NOT_REPORTING_AFTER_MS)) {
    return { current: true, lastSampleAt, message: null };
  }
  return {
    current: false,
    lastSampleAt,
    // A runner that never sent a sample gets the panel's "No samples yet" instead.
    message:
      input.lastSampleAt === null ? null : notReportingMessage(input.name, input.lastSampleAt),
  };
}

/** The four cards of a monitoring panel, from the newest current sample, or dashes without one. */
export interface MonitoringCards {
  uptime: string;
  cpu: string;
  memory: string;
  memoryDetail: string;
  disk: string;
  diskDetail: string;
  meters: { cpu: number; memory: number; disk: number };
}

export function monitoringCards(
  latest:
    | (DiskFigures & {
        cpuPercent: number;
        memoryUsedBytes: number;
        memoryTotalBytes: number;
        uptimeSeconds: number;
      })
    | null,
): MonitoringCards {
  if (!latest) {
    return {
      uptime: "—",
      cpu: "—",
      memory: "—",
      memoryDetail: "",
      disk: "—",
      diskDetail: "",
      meters: { cpu: 0, memory: 0, disk: 0 },
    };
  }
  const memory = memoryPercent(latest.memoryUsedBytes, latest.memoryTotalBytes);
  const disk = storagePercent(latest);
  return {
    uptime: uptimeText(latest.uptimeSeconds),
    cpu: `${latest.cpuPercent.toFixed(1)}%`,
    memory: `${memory.toFixed(1)}%`,
    memoryDetail: `${gigabytes(latest.memoryUsedBytes)} / ${gigabytes(latest.memoryTotalBytes)}`,
    disk: `${disk}%`,
    diskDetail: storageDetail(latest),
    meters: { cpu: latest.cpuPercent, memory, disk },
  };
}
