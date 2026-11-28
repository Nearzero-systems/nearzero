import { describe, expect, test } from "bun:test";
import { matchesFilter } from "@nearzero/shared";
import { navGroups } from "../src/components/shell/nav-items.ts";
import { chartHtml, niceMax, positionOf } from "../src/lib/line-chart.ts";
import {
  customRangeOfDays,
  localInputValue,
  RUN_PILLS,
  shortDuration,
  statusPill,
  utcOfLocalInput,
} from "../src/lib/m10.ts";
import { settingsVisibility } from "../src/lib/routes.ts";

/** The M10 console rules: who sees Analytics and Channels (G8, 15.1), charts, small words. */

describe("navigation shows Analytics only to people who can use it (spec 24 G8)", () => {
  test("hidden without, shown with", () => {
    const without = navGroups("acme", { analytics: false }).main.map((item) => item.key);
    expect(without).not.toContain("analytics");
    expect(without).toContain("tasks");
    const withIt = navGroups("acme", { analytics: true }).main.map((item) => item.key);
    expect(withIt).toEqual(["agent", "projects", "deployments", "tasks", "analytics"]);
  });

  test("Tasks is left out for people with nowhere to run one (spec 12.1, R3-31)", () => {
    const hidden = navGroups("acme", { analytics: false, tasks: false }).main.map(
      (item) => item.key,
    );
    expect(hidden).toEqual(["agent", "projects", "deployments"]);
    const shown = navGroups("acme", { analytics: true, tasks: true }).main.map((item) => item.key);
    expect(shown).toEqual(["agent", "projects", "deployments", "tasks", "analytics"]);
  });

  test("Settings → Channels: owners and admins, or members with Manage notification channels", () => {
    const base = {
      isInstanceAdmin: false,
      can: { manageMembers: false, manageAgentPolicies: false, manageApiKeys: false },
    };
    expect(settingsVisibility({ ...base, role: "member", capabilities: [] }).channels).toBe(false);
    expect(
      settingsVisibility({ ...base, role: "member", capabilities: ["notifications.manage"] })
        .channels,
    ).toBe(true);
    expect(settingsVisibility({ ...base, role: "admin", capabilities: [] }).channels).toBe(true);
  });
});

describe("a custom Analytics range covers its last day to the end (G3-13)", () => {
  // The browser's offset as getTimezoneOffset() gives it: India is 330 minutes ahead of UTC.
  const INDIA = -330;
  const entry = (iso: string) => ({
    at: Date.parse(iso),
    host: "shop.example.com",
    method: "GET",
    path: "/",
    status: 200,
    durationMs: 1,
    size: 1,
    clientIp: "203.0.113.9",
    userAgent: "",
    referer: "",
  });

  test("From and To on the same day count a request at 23:59:30 that day, in the browser's time", () => {
    const range = customRangeOfDays("2026-11-27", "2026-11-27");
    expect(range).toEqual({ from: "2026-11-27T00:00:00.000", to: "2026-11-27T23:59:59.999" });
    const from = Date.parse(utcOfLocalInput(range.from, INDIA) as string);
    const to = Date.parse(utcOfLocalInput(range.to, INDIA) as string);
    const filter = { from, to };
    // 23:59:30 in India is 18:29:30 UTC.
    expect(matchesFilter(entry("2026-11-27T18:29:30.000Z") as never, filter)).toBe(true);
    expect(matchesFilter(entry("2026-11-27T18:29:59.999Z") as never, filter)).toBe(true);
    // The next day's first moment, and the day before's last, aren't.
    expect(matchesFilter(entry("2026-11-27T18:30:00.000Z") as never, filter)).toBe(false);
    expect(matchesFilter(entry("2026-11-26T18:29:59.999Z") as never, filter)).toBe(false);
    expect(customRangeOfDays("2026-11-28", "2026-11-27").from).toBe("2026-11-27T00:00:00.000");
  });

  test("sending the form again keeps the range to the millisecond", () => {
    const end = new Date(Date.parse("2026-11-27T18:29:59.999Z"));
    const local = localInputValue(end);
    expect(local).toMatch(/:59\.999$/);
    const offset = end.getTimezoneOffset();
    expect(utcOfLocalInput(local, offset)).toBe("2026-11-27T18:29:59.999Z");
    expect(utcOfLocalInput("2026-11-27T10:00:00Z", 60)).toBe("2026-11-27T10:00:00Z");
    expect(utcOfLocalInput("not a time", 0)).toBeNull();
  });
});

describe("line charts", () => {
  test("round tops and positions", () => {
    expect(niceMax(0, "count")).toBe(4);
    expect(niceMax(37, "count")).toBe(40);
    expect(niceMax(120, "count")).toBe(200);
    expect(niceMax(3, "percent")).toBe(100);
    expect(positionOf(0, 1)).toBe(0.5);
    expect(positionOf(5, 11)).toBe(0.5);
  });

  test("the markup carries its data for the crosshair and escapes text", () => {
    const html = chartHtml(
      {
        xs: [0, 3_600_000],
        unit: "count",
        xLabel: "hour",
        series: [{ label: "Requests <x>", values: [1, 3], tone: "accent" }],
      },
      'Requests "per hour"',
    );
    expect(html).toContain("data-line-chart=");
    expect(html).toContain("&quot;per hour&quot;");
    expect(html).toContain("Requests &lt;x&gt;");
    expect(html).toContain("<polyline");
    expect(html).not.toContain("<x>");
  });
});

describe("words", () => {
  test("pills and durations", () => {
    expect(statusPill(200)).toBe("ok");
    expect(statusPill(302)).toBe("idle");
    expect(statusPill(404)).toBe("warn");
    expect(statusPill(503)).toBe("fail");
    expect(RUN_PILLS.skipped).toBe("idle");
    expect(shortDuration(4_200)).toBe("4s");
    expect(shortDuration(125_000)).toBe("2m 5s");
    expect(shortDuration(3_780_000)).toBe("1h 3m");
    expect(shortDuration(null)).toBe("—");
  });
});
