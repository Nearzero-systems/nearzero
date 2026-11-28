/**
 * Analytics (spec 13): the router's request log read as entries, and what the page shows of
 * them: the stats (requests, errors with the 4xx/5xx split, median and 95th percentile
 * response times), the zero-filled chart with at most 200 buckets, the busiest hosts and a page
 * of the table. Pure and browser-safe, so it is tested once and the console shares the words.
 */

export const ANALYTICS_RANGES = ["24h", "3d", "7d", "30d", "custom"] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];

export const ANALYTICS_RANGE_LABELS: Record<AnalyticsRange, string> = {
  "24h": "24 hours",
  "3d": "3 days",
  "7d": "7 days",
  "30d": "30 days",
  custom: "Custom",
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const ANALYTICS_RANGE_MS: Record<Exclude<AnalyticsRange, "custom">, number> = {
  "24h": DAY,
  "3d": 3 * DAY,
  "7d": 7 * DAY,
  "30d": 30 * DAY,
};

export const STATUS_CLASSES = ["2xx", "3xx", "4xx", "5xx"] as const;
export type StatusClass = (typeof STATUS_CLASSES)[number];

export const ANALYTICS_PAGE_SIZE = 25;
export const ANALYTICS_MAX_BUCKETS = 200;
export const ANALYTICS_TOP_HOSTS = 5;

export const ANALYTICS_MESSAGES = {
  recording: "Recording requests",
  off: "Request logging is off",
  turnOn: "Turn on",
  otherServers: "Requests to apps on other servers are not counted yet.",
  restartWarning:
    "The router restarts to apply this, so sites can be unreachable for a few seconds.",
  deleteWarning: "Every request recorded so far is deleted and can't be brought back.",
  /** How the delete confirm ends, by whether logging is on (G3-16). */
  deleteStaysOn: "Request logging stays on, so new requests show up again right away.",
  deleteStaysOff: "Request logging stays off.",
  /** What turning logging off leaves (G3-16). */
  offKeeps: "Requests already recorded stay until the next cleanup.",
  deleted: "Deleted every recorded request",
  turnedOn: "Request logging is on. The router restarts in the background.",
  turnedOff: "Request logging is off. The router restarts in the background.",
  cleanupSaved: "Log cleanup schedule saved",
  cleanupHint: "Each run keeps the newest 10,000 requests.",
  searchPlaceholder: "Filter by host or path…",
  noRequests: "No requests in this range",
  noRequestsText: "Requests to apps on the Nearzero host show here as they arrive.",
  adminsOnly: "Only Nearzero administrators can see Analytics.",
  runnerAway:
    "The Nearzero host's runner isn't connected, so the request log can't be read right now. On the host, check it with: sudo nearzero status",
} as const;

/** The "Delete all request logs?" confirm, which says whether new requests keep coming (G3-16). */
export function deleteLogsWarning(enabled: boolean): string {
  return `${ANALYTICS_MESSAGES.deleteWarning} ${enabled ? ANALYTICS_MESSAGES.deleteStaysOn : ANALYTICS_MESSAGES.deleteStaysOff}`;
}

/** The "Turn off/on request logging?" confirm: the router restart, and what turning off keeps. */
export function loggingSwitchWarning(enabled: boolean): string {
  return enabled
    ? `${ANALYTICS_MESSAGES.restartWarning} ${ANALYTICS_MESSAGES.offKeeps}`
    : ANALYTICS_MESSAGES.restartWarning;
}

/** One request as the router logged it. */
export interface RequestEntry {
  /** Unique within the log: the file and the line's offset in it. */
  id: string;
  at: number;
  method: string;
  host: string;
  path: string;
  status: number;
  durationMs: number;
  client: string;
  /** Every field the router wrote, for the drawer. */
  fields: Record<string, unknown>;
}

function text(value: unknown): string {
  return typeof value === "string"
    ? value
    : value === undefined || value === null
      ? ""
      : String(value);
}

function number(value: unknown): number | null {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Reads one line of Traefik's JSON access log. Lines that aren't requests (or aren't JSON) give
 * null. Duration is in nanoseconds; the status is what the client got (DownstreamStatus).
 */
export function parseAccessLine(line: string, id: string): RequestEntry | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let fields: Record<string, unknown>;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    fields = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const status = number(fields.DownstreamStatus ?? fields.OriginStatus);
  const method = text(fields.RequestMethod);
  if (status === null || method === "") return null;
  const atText = text(fields.StartUTC ?? fields.time ?? fields.StartLocal);
  const at = Date.parse(atText);
  if (!Number.isFinite(at)) return null;
  const host = text(fields.RequestHost || fields.RequestAddr).toLowerCase();
  const durationNs = number(fields.Duration) ?? 0;
  return {
    id,
    at,
    method,
    host,
    path: text(fields.RequestPath) || "/",
    status,
    durationMs: Math.max(0, Math.round((durationNs / 1e6) * 100) / 100),
    client: text(fields.ClientHost || fields.ClientAddr),
    fields,
  };
}

export function statusClassOf(status: number): StatusClass | null {
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 300 && status < 400) return "3xx";
  if (status >= 400 && status < 500) return "4xx";
  if (status >= 500 && status < 600) return "5xx";
  return null;
}

/**
 * The p-quantile (0 to 1) of values sorted ascending, interpolating between the two nearest
 * ranks; null when there are none. The median of 1, 2, 3, 4 is 2.5.
 */
export function quantile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const at = (sorted.length - 1) * Math.min(1, Math.max(0, p));
  const low = Math.floor(at);
  const high = Math.ceil(at);
  const a = sorted[low] as number;
  const b = sorted[high] as number;
  return a + (b - a) * (at - low);
}

/** Bucket sizes in hours, smallest first; the smallest giving at most 200 buckets wins. */
const BUCKET_HOURS = [1, 2, 3, 4, 6, 8, 12, 24, 48, 72, 168, 336, 720];

export interface BucketPlan {
  bucketMs: number;
  /** "Requests per hour", "Requests per 4 hours", "Requests per day", "Requests per 2 days". */
  label: string;
  /** The first bucket's start (aligned to the bucket size in UTC) and how many there are. */
  start: number;
  count: number;
}

export function planBuckets(from: number, to: number): BucketPlan {
  const span = Math.max(1, to - from);
  let hours = BUCKET_HOURS[BUCKET_HOURS.length - 1] as number;
  for (const candidate of BUCKET_HOURS) {
    const size = candidate * HOUR;
    const start = Math.floor(from / size) * size;
    if (Math.ceil((to - start) / size) <= ANALYTICS_MAX_BUCKETS) {
      hours = candidate;
      break;
    }
  }
  const bucketMs = hours * HOUR;
  const start = Math.floor(from / bucketMs) * bucketMs;
  const count = Math.max(
    1,
    Math.min(ANALYTICS_MAX_BUCKETS, Math.ceil((from + span - start) / bucketMs)),
  );
  const label =
    hours === 1
      ? "Requests per hour"
      : hours < 24
        ? `Requests per ${hours} hours`
        : hours === 24
          ? "Requests per day"
          : `Requests per ${hours / 24} days`;
  return { bucketMs, label, start, count };
}

export interface AnalyticsFilter {
  from: number;
  to: number;
  /** Matches the host and path ("app.example.com/api"), ignoring case. */
  search?: string;
  /** Empty means every status. */
  statuses?: readonly StatusClass[];
  /**
   * Hostnames never counted: the console's own (spec 13.1, R3-26), so only traffic to apps
   * shows, even in lines logged before its routes stopped logging.
   */
  excludeHosts?: readonly string[];
}

export interface AnalyticsStats {
  requests: number;
  errors: number;
  /** 0 to 1. */
  errorRate: number;
  clientErrors: number;
  serverErrors: number;
  medianMs: number | null;
  p95Ms: number | null;
}

export interface ChartBucket {
  start: number;
  requests: number;
  errors: number;
}

export interface AnalyticsSummary {
  stats: AnalyticsStats;
  chart: { bucketMs: number; label: string; buckets: ChartBucket[] };
  /** The busiest hosts, each with its 4xx and 5xx answers (R3-27). */
  hosts: { host: string; requests: number; errors: number }[];
  /** The filtered entries, newest first. */
  entries: RequestEntry[];
}

/** A request's hostname without a port, lowercase. */
function bareHost(host: string): string {
  return host.toLowerCase().replace(/:\d+$/, "");
}

export function matchesFilter(entry: RequestEntry, filter: AnalyticsFilter): boolean {
  if (entry.at < filter.from || entry.at > filter.to) return false;
  if (filter.excludeHosts?.length && filter.excludeHosts.includes(bareHost(entry.host))) {
    return false;
  }
  const statuses = filter.statuses ?? [];
  if (statuses.length > 0) {
    const kind = statusClassOf(entry.status);
    if (!kind || !statuses.includes(kind)) return false;
  }
  const search = filter.search?.trim().toLowerCase();
  if (search) {
    const target = `${entry.host}${entry.path}`.toLowerCase();
    if (!target.includes(search)) return false;
  }
  return true;
}

/** Everything the page shows about the entries that match the filter. */
export function summarize(
  entries: readonly RequestEntry[],
  filter: AnalyticsFilter,
): AnalyticsSummary {
  const matching = entries.filter((entry) => matchesFilter(entry, filter));
  matching.sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1));
  let clientErrors = 0;
  let serverErrors = 0;
  const durations: number[] = [];
  const hostCounts = new Map<string, { requests: number; errors: number }>();
  const plan = planBuckets(filter.from, filter.to);
  const buckets: ChartBucket[] = Array.from({ length: plan.count }, (_, index) => ({
    start: plan.start + index * plan.bucketMs,
    requests: 0,
    errors: 0,
  }));
  for (const entry of matching) {
    const error = entry.status >= 400 && entry.status < 600;
    if (entry.status >= 400 && entry.status < 500) clientErrors++;
    if (entry.status >= 500 && entry.status < 600) serverErrors++;
    durations.push(entry.durationMs);
    if (entry.host) {
      const count = hostCounts.get(entry.host) ?? { requests: 0, errors: 0 };
      count.requests++;
      if (error) count.errors++;
      hostCounts.set(entry.host, count);
    }
    const index = Math.floor((entry.at - plan.start) / plan.bucketMs);
    const bucket = buckets[index];
    if (bucket) {
      bucket.requests++;
      if (error) bucket.errors++;
    }
  }
  durations.sort((a, b) => a - b);
  const requests = matching.length;
  const errors = clientErrors + serverErrors;
  const round = (value: number | null) => (value === null ? null : Math.round(value * 100) / 100);
  const hosts = [...hostCounts]
    .map(([host, count]) => ({ host, requests: count.requests, errors: count.errors }))
    .sort((a, b) => b.requests - a.requests || a.host.localeCompare(b.host))
    .slice(0, ANALYTICS_TOP_HOSTS);
  return {
    stats: {
      requests,
      errors,
      errorRate: requests === 0 ? 0 : errors / requests,
      clientErrors,
      serverErrors,
      medianMs: round(quantile(durations, 0.5)),
      p95Ms: round(quantile(durations, 0.95)),
    },
    chart: { bucketMs: plan.bucketMs, label: plan.label, buckets },
    hosts,
    entries: matching,
  };
}

/** "1–25 of 100". */
export function pageRangeText(page: number, pageSize: number, total: number): string {
  if (total === 0) return "0 of 0";
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);
  return `${first}–${last} of ${total}`;
}

/** A response time in words: "840 µs", "12 ms", "1.4 s". */
export function durationText(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1) return `${Math.round(ms * 1000)} µs`;
  if (ms < 1000) return `${ms < 10 ? Math.round(ms * 10) / 10 : Math.round(ms)} ms`;
  return `${Math.round(ms / 100) / 10} s`;
}

/** The window a range covers, ending now (custom ranges give their own). */
export function rangeWindow(
  range: AnalyticsRange,
  now: number,
  custom?: { from: number; to: number },
): { from: number; to: number } {
  if (range === "custom" && custom && custom.to > custom.from) return custom;
  const span = range === "custom" ? DAY : ANALYTICS_RANGE_MS[range];
  return { from: now - span, to: now };
}
