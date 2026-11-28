import { describe, expect, test } from "bun:test";
import {
  ANALYTICS_MAX_BUCKETS,
  deleteLogsWarning,
  durationText,
  loggingSwitchWarning,
  pageRangeText,
  parseAccessLine,
  planBuckets,
  quantile,
  type RequestEntry,
  rangeWindow,
  summarize,
} from "../src/index.ts";

/** Analytics aggregation (spec 13.2): parsing, stats, chart buckets, busiest hosts. */

const HOUR = 3_600_000;
const T0 = Date.parse("2026-11-25T00:00:00Z");

function entry(
  at: number,
  status: number,
  durationMs: number,
  host = "app.example.com",
  path = "/",
): RequestEntry {
  return {
    id: `1-${at}-${status}-${durationMs}`,
    at,
    method: "GET",
    host,
    path,
    status,
    durationMs,
    client: "203.0.113.9",
    fields: {},
  };
}

describe("reading Traefik's JSON access log", () => {
  test("a request line", () => {
    const line = JSON.stringify({
      ClientHost: "203.0.113.9",
      DownstreamStatus: 404,
      Duration: 2_500_000,
      RequestHost: "App.Example.com",
      RequestMethod: "POST",
      RequestPath: "/api?x=1",
      StartUTC: "2026-11-25T10:00:00.123456789Z",
      RouterName: "nz-web-https@file",
    });
    const parsed = parseAccessLine(line, "7-0");
    expect(parsed).toMatchObject({
      id: "7-0",
      method: "POST",
      host: "app.example.com",
      path: "/api?x=1",
      status: 404,
      durationMs: 2.5,
      client: "203.0.113.9",
    });
    expect(parsed?.at).toBe(Date.parse("2026-11-25T10:00:00.123Z"));
    expect(parsed?.fields.RouterName).toBe("nz-web-https@file");
  });
  test("lines that aren't requests are skipped", () => {
    expect(parseAccessLine("", "x")).toBeNull();
    expect(parseAccessLine("not json", "x")).toBeNull();
    expect(parseAccessLine('{"level":"info","msg":"hello"}', "x")).toBeNull();
    expect(parseAccessLine("[1,2]", "x")).toBeNull();
  });
});

describe("median and 95th percentile", () => {
  test("interpolates between the nearest ranks", () => {
    expect(quantile([], 0.5)).toBeNull();
    expect(quantile([7], 0.95)).toBe(7);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3], 0.5)).toBe(2);
    const hundred = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(quantile(hundred, 0.5)).toBe(50.5);
    expect(quantile(hundred, 0.95)).toBeCloseTo(95.05, 5);
  });
});

describe("chart buckets (at most 200, zero-filled)", () => {
  test("24 hours, 3 days and 7 days are per hour", () => {
    expect(planBuckets(T0, T0 + 24 * HOUR)).toMatchObject({
      bucketMs: HOUR,
      label: "Requests per hour",
      count: 24,
    });
    expect(planBuckets(T0, T0 + 72 * HOUR).count).toBe(72);
    expect(planBuckets(T0, T0 + 168 * HOUR)).toMatchObject({
      label: "Requests per hour",
      count: 168,
    });
  });
  test("30 days is per 4 hours", () => {
    expect(planBuckets(T0, T0 + 720 * HOUR)).toMatchObject({
      bucketMs: 4 * HOUR,
      label: "Requests per 4 hours",
      count: 180,
    });
  });
  test("a long custom range is per day or more, never more than 200 buckets", () => {
    const year = planBuckets(T0, T0 + 365 * 24 * HOUR);
    expect(year.count).toBeLessThanOrEqual(ANALYTICS_MAX_BUCKETS);
    expect(year.label).toBe("Requests per 2 days");
    expect(planBuckets(T0, T0 + 150 * 24 * HOUR).label).toBe("Requests per day");
  });
  test("an unaligned window starts on the hour", () => {
    const plan = planBuckets(T0 + 20 * 60_000, T0 + 24 * HOUR + 20 * 60_000);
    expect(plan.start).toBe(T0);
    expect(plan.count).toBe(25);
  });
});

describe("summarize (spec 13.2 stats, chart, hosts, table)", () => {
  const entries = [
    entry(T0 + 10 * 60_000, 200, 10),
    entry(T0 + 20 * 60_000, 200, 20),
    entry(T0 + 70 * 60_000, 404, 30, "api.example.com", "/missing"),
    entry(T0 + 80 * 60_000, 500, 40, "api.example.com", "/boom"),
    entry(T0 + 5 * HOUR, 301, 50, "www.example.com"),
    entry(T0 - HOUR, 200, 1), // before the window
  ];
  const window = { from: T0, to: T0 + 24 * HOUR };

  test("requests, errors with the 4xx/5xx split, median and p95", () => {
    const { stats } = summarize(entries, window);
    expect(stats).toEqual({
      requests: 5,
      errors: 2,
      errorRate: 0.4,
      clientErrors: 1,
      serverErrors: 1,
      medianMs: 30,
      p95Ms: 48,
    });
  });

  test("the chart is zero-filled, with requests and errors per bucket", () => {
    const { chart } = summarize(entries, window);
    expect(chart.buckets).toHaveLength(24);
    expect(chart.buckets[0]).toEqual({ start: T0, requests: 2, errors: 0 });
    expect(chart.buckets[1]).toEqual({ start: T0 + HOUR, requests: 2, errors: 2 });
    expect(chart.buckets[2]).toEqual({ start: T0 + 2 * HOUR, requests: 0, errors: 0 });
    expect(chart.buckets[5]?.requests).toBe(1);
    expect(chart.buckets.reduce((sum, bucket) => sum + bucket.requests, 0)).toBe(5);
  });

  test("busiest hosts, top 5, most requests first", () => {
    const many = Array.from({ length: 7 }, (_, index) =>
      Array.from({ length: index + 1 }, (_, n) =>
        entry(T0 + n * 1000, 200, 1, `h${index}.example.com`),
      ),
    ).flat();
    const { hosts } = summarize(many, window);
    expect(hosts.map((host) => host.host)).toEqual([
      "h6.example.com",
      "h5.example.com",
      "h4.example.com",
      "h3.example.com",
      "h2.example.com",
    ]);
    expect(hosts[0]?.requests).toBe(7);
  });

  test("status chips and host-or-path search filter everything", () => {
    const errors = summarize(entries, { ...window, statuses: ["4xx", "5xx"] });
    expect(errors.stats.requests).toBe(2);
    const search = summarize(entries, { ...window, search: "API.example.com/m" });
    expect(search.entries.map((item) => item.path)).toEqual(["/missing"]);
    expect(summarize(entries, { ...window, statuses: ["3xx"] }).hosts).toEqual([
      { host: "www.example.com", requests: 1, errors: 0 },
    ]);
  });

  test("entries come newest first; an empty window has nulls, not zeros, for times", () => {
    const { entries: rows } = summarize(entries, window);
    expect(rows[0]?.status).toBe(301);
    const empty = summarize([], window);
    expect(empty.stats).toMatchObject({ requests: 0, errorRate: 0, medianMs: null, p95Ms: null });
    expect(empty.chart.buckets.every((bucket) => bucket.requests === 0)).toBe(true);
  });

  test("100 requests with a status mix (spec 13 acceptance, in miniature)", () => {
    const hundred = Array.from({ length: 100 }, (_, index) =>
      entry(T0 + index * 60_000, index % 10 === 0 ? 500 : index % 5 === 0 ? 404 : 200, index),
    );
    const { stats, hosts } = summarize(hundred, window);
    expect(stats.requests).toBe(100);
    expect(stats.serverErrors).toBe(10);
    expect(stats.clientErrors).toBe(10);
    expect(hosts[0]).toEqual({ host: "app.example.com", requests: 100, errors: 20 });
  });

  test("R3-27: each busiest host carries its 4xx and 5xx count; none shows as 0", () => {
    const ten = [
      ...Array.from({ length: 7 }, (_, n) => entry(T0 + n * 1000, 200, 1, "shop.example.com")),
      entry(T0 + 8000, 404, 1, "shop.example.com"),
      entry(T0 + 9000, 500, 1, "shop.example.com"),
      entry(T0 + 9500, 503, 1, "shop.example.com"),
      entry(T0 + 9600, 200, 1, "calm.example.com"),
    ];
    expect(summarize(ten, window).hosts).toEqual([
      { host: "shop.example.com", requests: 10, errors: 3 },
      { host: "calm.example.com", requests: 1, errors: 0 },
    ]);
  });

  test("R3-26: the console's own hostname is never counted, with or without a port", () => {
    const mixed = [
      ...Array.from({ length: 100 }, (_, n) => entry(T0 + n * 1000, 200, 1, "app.example.com")),
      ...Array.from({ length: 60 }, (_, n) =>
        entry(
          T0 + n * 1000 + 1,
          200,
          1,
          n % 2 ? "nearzero.example.com" : "Nearzero.example.com:443",
        ),
      ),
    ];
    const summary = summarize(mixed, { ...window, excludeHosts: ["nearzero.example.com"] });
    expect(summary.stats.requests).toBe(100);
    expect(summary.hosts.map((host) => host.host)).toEqual(["app.example.com"]);
    expect(summary.entries).toHaveLength(100);
  });
});

describe("words", () => {
  test("page ranges and durations", () => {
    expect(pageRangeText(1, 25, 100)).toBe("1–25 of 100");
    expect(pageRangeText(4, 25, 90)).toBe("76–90 of 90");
    expect(pageRangeText(1, 25, 0)).toBe("0 of 0");
    expect(durationText(0.84)).toBe("840 µs");
    expect(durationText(4.26)).toBe("4.3 ms");
    expect(durationText(120)).toBe("120 ms");
    expect(durationText(1420)).toBe("1.4 s");
    expect(durationText(null)).toBe("—");
  });
  test("ranges end now", () => {
    expect(rangeWindow("24h", T0)).toEqual({ from: T0 - 24 * HOUR, to: T0 });
    expect(rangeWindow("custom", T0, { from: 1, to: 2 })).toEqual({ from: 1, to: 2 });
  });
});

describe("the confirm dialogs say what happens next (G3-16, spec 13.1)", () => {
  test("delete all: logging stays on and new requests show again, or stays off", () => {
    expect(deleteLogsWarning(true)).toBe(
      "Every request recorded so far is deleted and can't be brought back. Request logging stays on, so new requests show up again right away.",
    );
    expect(deleteLogsWarning(false)).toBe(
      "Every request recorded so far is deleted and can't be brought back. Request logging stays off.",
    );
    expect(deleteLogsWarning(false)).not.toContain("new requests");
  });

  test("turning logging off keeps what was recorded until the next cleanup", () => {
    expect(loggingSwitchWarning(true)).toBe(
      "The router restarts to apply this, so sites can be unreachable for a few seconds. Requests already recorded stay until the next cleanup.",
    );
    expect(loggingSwitchWarning(false)).toBe(
      "The router restarts to apply this, so sites can be unreachable for a few seconds.",
    );
  });
});
