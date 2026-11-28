import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { badgeCount, bellRefreshDue } from "../src/client/bell.ts";
import { isEmail, splitEmailList } from "../src/client/forms.ts";
import { userButtonText } from "../src/client/user-button.ts";
import type { ProjectView } from "../src/lib/data/index.ts";
import { bellDeployments } from "../src/lib/deploys.ts";
import { greetingLines, greetingName, looksEmailDerived } from "../src/lib/names.ts";
import {
  countLabel,
  matchesSearch,
  openingEnvironment,
  parseProjectSort,
  sortProjects,
} from "../src/lib/projects.ts";
import { pathAfterWorkspace, projectPath } from "../src/lib/routes.ts";
import { skyStars } from "../src/lib/sky.ts";
import { pastTime, relativeTime, shortPastTime } from "../src/lib/time.ts";

describe("real names only (spec 19.2)", () => {
  test("names with digits, over 12 letters, or generic handles look derived", () => {
    expect(looksEmailDerived("owner")).toBe(true);
    expect(looksEmailDerived("Admin")).toBe(true);
    expect(looksEmailDerived("maya2")).toBe(true);
    expect(looksEmailDerived("Bartholomewsky")).toBe(true);
    expect(looksEmailDerived("")).toBe(true);
    expect(looksEmailDerived("Maya")).toBe(false);
    expect(looksEmailDerived("Jean-Luc")).toBe(false);
  });

  test("greetings say 'there' instead of a derived name", () => {
    expect(greetingName("owner")).toBe("there");
    expect(greetingLines("Maya", 9, () => 0)).toEqual([
      "Good morning, Maya",
      "What should we deploy today?",
    ]);
    expect(greetingLines("Maya", 14, () => 0)[0]).toBe("Good afternoon, Maya");
    expect(greetingLines("Maya", 22, () => 0)[0]).toBe("Good evening, Maya");
    expect(greetingLines("admin", 22, () => 1)).toEqual(["Hi there,", "What are we shipping?"]);
  });
});

describe("the Dusk sky (spec 21.6)", () => {
  test("110 stars at the same positions every time, 84% of them 1px", () => {
    const first = skyStars();
    expect(first).toHaveLength(110);
    expect(skyStars()).toEqual(first);
    expect(first.filter((star) => star.size === 1)).toHaveLength(92);
    expect(first.every((star) => star.delay >= 0 && star.delay <= 5)).toBe(true);
    expect(first.every((star) => star.x >= 0 && star.x < 100 && star.y >= 0 && star.y < 100)).toBe(
      true,
    );
  });
});

describe("the bell's badge (spec 11.5)", () => {
  const now = Date.UTC(2026, 10, 25, 12);
  const hour = 3_600_000;
  test("counts invitations plus failures since the bell was last opened", () => {
    expect(badgeCount(1, [now - hour, now - 3 * hour], now - 2 * hour, now)).toBe(2);
  });
  test("on a first visit counts failures from the last 24 hours", () => {
    expect(badgeCount(0, [now - hour, now - 30 * hour], null, now)).toBe(1);
  });

  test("reloads every 60 s while the tab shows and the panel is closed (30a R1-06)", () => {
    const shown = { visible: true, open: false };
    expect(bellRefreshDue("tick", 60_000, shown)).toBe(true);
    expect(bellRefreshDue("tick", 60_000, { visible: false, open: false })).toBe(false);
    expect(bellRefreshDue("tick", 60_000, { visible: true, open: true })).toBe(false);
    // Back to a visible tab: only when what it shows is over a minute old.
    expect(bellRefreshDue("visible", 61_000, shown)).toBe(true);
    expect(bellRefreshDue("visible", 30_000, shown)).toBe(false);
    // Opening the panel on data older than 15 seconds loads it first.
    expect(bellRefreshDue("open", 16_000, { visible: true, open: true })).toBe(true);
    expect(bellRefreshDue("open", 10_000, { visible: true, open: true })).toBe(false);
  });

  test("cards are in the order of the times they show (B3-20)", () => {
    const at = (h: number, m: number) => new Date(Date.UTC(2026, 10, 25, h, m)).toISOString();
    const list = [
      { id: "web", createdAt: at(3, 10), finishedAt: at(3, 13) },
      { id: "orders-db", createdAt: at(3, 5), finishedAt: at(3, 7) },
      { id: "api", createdAt: at(3, 0), finishedAt: at(3, 17) },
      { id: "running", createdAt: at(2, 59), finishedAt: null },
      { id: "db", createdAt: at(2, 55), finishedAt: at(2, 57) },
    ];
    expect(bellDeployments(list).map((item) => item.id)).toEqual([
      "api",
      "web",
      "orders-db",
      "running",
      "db",
    ]);
    const many = Array.from({ length: 12 }, (_, index) => ({
      id: String(index),
      createdAt: at(1, 59 - index),
      finishedAt: null,
    }));
    expect(bellDeployments(many)).toHaveLength(8);
  });
});

describe("the user button after a name is saved in the page (B3-10)", () => {
  test("a real name shows over the email; otherwise the email alone", () => {
    expect(userButtonText({ email: "pat@example.com", name: "Pat", hasRealName: true })).toEqual({
      name: "Pat",
      email: "pat@example.com",
    });
    expect(
      userButtonText({ email: "admin7@example.com", name: "admin7", hasRealName: false }),
    ).toEqual({ name: "admin7@example.com", email: null });
  });
});

describe("projects list (spec 5.1)", () => {
  const make = (name: string, days: number, services: number, environments = 1): ProjectView => ({
    id: name,
    name,
    description: `${name} description`,
    createdAt: new Date(Date.UTC(2026, 0, 1) + days * 86_400_000),
    updatedAt: new Date(Date.UTC(2026, 0, 1) + days * 86_400_000),
    serviceCount: services,
    environments: Array.from({ length: environments }, (_, i) => ({
      id: `${name}-${i}`,
      name: i === 0 ? "staging" : "development",
      isDefault: i === 0,
      isProduction: false,
    })),
    openEnvironmentId: null,
    can: { update: true, delete: true, createEnvironment: true },
  });
  const list = [make("beta", 2, 5), make("alpha", 1, 1), make("gamma", 3, 5)];

  test("sorts six ways, newest first by default", () => {
    expect(parseProjectSort("bogus")).toBe("newest");
    expect(sortProjects(list, "newest").map((p) => p.name)).toEqual(["gamma", "beta", "alpha"]);
    expect(sortProjects(list, "oldest").map((p) => p.name)).toEqual(["alpha", "beta", "gamma"]);
    expect(sortProjects(list, "name-desc").map((p) => p.name)).toEqual(["gamma", "beta", "alpha"]);
    expect(sortProjects(list, "most-services").map((p) => p.name)).toEqual([
      "beta",
      "gamma",
      "alpha",
    ]);
    expect(sortProjects(list, "least-services")[0]?.name).toBe("alpha");
  });

  test("search covers name and description, case-insensitively", () => {
    expect(matchesSearch(make("Shop", 0, 0), "SHOP")).toBe(true);
    expect(matchesSearch(make("Shop", 0, 0), "description")).toBe(true);
    expect(matchesSearch(make("Shop", 0, 0), "billing")).toBe(false);
  });

  test("a card opens the API's choice, else development, else the default, else the first", () => {
    expect(openingEnvironment({ ...make("two", 0, 0, 2), openEnvironmentId: "two-0" })?.name).toBe(
      "staging",
    );
    expect(openingEnvironment(make("two", 0, 0, 2))?.name).toBe("development");
    expect(openingEnvironment(make("one", 0, 0, 1))?.name).toBe("staging");
    expect(openingEnvironment(make("none", 0, 0, 0))).toBeNull();
  });

  test('the footer says "N total" or "N of M total"', () => {
    expect(countLabel(3, 3)).toBe("3 total");
    expect(countLabel(1, 3)).toBe("1 of 3 total");
  });
});

describe("addresses and small helpers", () => {
  test("switching workspaces keeps the page after the slug", () => {
    expect(pathAfterWorkspace("/acme/dashboard/projects")).toBe("/projects");
    expect(pathAfterWorkspace("/acme/dashboard")).toBe("");
    expect(projectPath("acme", "p1", "e1")).toBe("/acme/dashboard/projects/p1/e1/overview");
  });

  test("teammate emails split on commas, semicolons and new lines", () => {
    expect(splitEmailList("a@x.io, b@x.io;c@x.io\n\nd@x.io")).toEqual([
      "a@x.io",
      "b@x.io",
      "c@x.io",
      "d@x.io",
    ]);
    expect(isEmail("bob@")).toBe(false);
    expect(isEmail("bob@example.com")).toBe(true);
  });

  test("relative times read naturally", () => {
    const now = new Date(Date.UTC(2026, 10, 25, 12));
    expect(relativeTime(new Date(now.getTime() - 30_000), now)).toBe("just now");
    expect(relativeTime(new Date(now.getTime() - 3 * 86_400_000), now)).toBe("3 days ago");
    expect(relativeTime(new Date(now.getTime() - 3_600_000), now)).toBe("1 hour ago");
  });

  test("a message sent after the list's clock ticked reads just now (B3-06)", () => {
    const now = new Date(Date.UTC(2026, 10, 25, 12));
    expect(pastTime(new Date(now.getTime() + 6_000), now)).toBe("just now");
    expect(pastTime(new Date(now.getTime() + 600_000), now)).toBe("just now");
    expect(pastTime(new Date(now.getTime() - 120_000), now)).toBe("2 minutes ago");
    // A session row's time is short, so it is never cut mid-word (C3-05).
    const ago = (ms: number) => shortPastTime(new Date(now.getTime() - ms), now);
    expect(ago(5_000)).toBe("just now");
    expect(ago(-5_000)).toBe("just now");
    expect(ago(4 * 60_000)).toBe("4m");
    expect(ago(3 * 3_600_000)).toBe("3h");
    expect(ago(2 * 86_400_000)).toBe("2d");
    expect(ago(15 * 86_400_000)).toBe("2w");
    expect(ago(100 * 86_400_000)).toBe("3mo");
    expect(ago(800 * 86_400_000)).toBe("2y");
  });

  test("a 7-day link sent just now expires in 7 days, not 6 (B3-18)", () => {
    const now = new Date(Date.UTC(2026, 10, 25, 12));
    const week = 7 * 86_400_000;
    expect(relativeTime(new Date(now.getTime() + week - 60_000), now)).toBe("in 7 days");
    expect(relativeTime(new Date(now.getTime() + week), now)).toBe("in 7 days");
    expect(relativeTime(new Date(now.getTime() + 6 * 86_400_000 + 3_600_000), now)).toBe(
      "in 6 days",
    );
    expect(relativeTime(new Date(now.getTime() + 3_590_000), now)).toBe("in 1 hour");
    expect(relativeTime(new Date(now.getTime() + 90_000), now)).toBe("in 2 minutes");
    expect(relativeTime(new Date(now.getTime() + 20_000), now)).toBe("in a moment");
    // Past times still count whole units gone by.
    expect(relativeTime(new Date(now.getTime() - week + 60_000), now)).toBe("6 days ago");
  });
});

/** Each `<form …>` opening tag in an Astro file, with `{…}` expressions skipped over. */
function formTags(source: string): string[] {
  const tags: string[] = [];
  let from = source.indexOf("<form");
  while (from !== -1) {
    let depth = 0;
    let end = from + 5;
    for (; end < source.length; end++) {
      const char = source[end];
      if (char === "{") depth++;
      else if (char === "}") depth--;
      else if (char === ">" && depth === 0) break;
    }
    const tag = source.slice(from, end + 1);
    if (/^<form[\s>]/.test(tag)) tags.push(tag);
    from = source.indexOf("<form", end);
  }
  return tags;
}

function astroFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) return entry.name === "dev" ? [] : astroFiles(path);
    return entry.name.endsWith(".astro") ? [path] : [];
  });
}

describe("forms (spec 22.4, 21.9)", () => {
  test("a form its own script sends is marked, so it never submits as an address", () => {
    // Without a method a form submits as GET, and the client router would put every field
    // (a script, a webhook header, a password) in the address. Scripted forms say data-scripted
    // or data-api; page forms post, reload, or are GET filters by choice.
    const source = resolve(import.meta.dir, "..", "src");
    const unmarked = astroFiles(source).flatMap((file) =>
      formTags(readFileSync(file, "utf8"))
        .filter(
          (tag) => !/\sdata-(scripted|api|astro-reload)[\s=>]|\smethod="(post|get)"/.test(tag),
        )
        .map((tag) => `${relative(source, file)}: ${tag.replace(/\s+/g, " ")}`),
    );
    expect(unmarked).toEqual([]);
  });
});
