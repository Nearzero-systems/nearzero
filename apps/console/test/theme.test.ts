import { describe, expect, test } from "bun:test";
import { NAV_COOKIE, parseNavState, resolveNavState } from "../src/lib/nav-state.ts";
import {
  DEFAULT_THEME,
  LEGACY_THEME_KEY,
  PAGE_COLORS,
  parseThemeChoice,
  resolveTheme,
  THEME_COOKIE,
  themeBootScript,
  themeFromCookieString,
  toneOf,
} from "../src/lib/theme.ts";

describe("theme choice (spec 21.2)", () => {
  test("someone who never picked a theme gets Light", () => {
    expect(DEFAULT_THEME).toBe("light");
    expect(resolveTheme(undefined)).toEqual({ theme: "light", tone: "light" });
    expect(resolveTheme(null)).toEqual({ theme: "light", tone: "light" });
  });

  test("a saved choice wins, and unknown values fall back to Light", () => {
    expect(resolveTheme("light")).toEqual({ theme: "light", tone: "light" });
    expect(resolveTheme("dark")).toEqual({ theme: "dark", tone: "dark" });
    expect(resolveTheme(" Dusk ")).toEqual({ theme: "dusk", tone: "dark" });
    expect(resolveTheme("sepia")).toEqual({ theme: "light", tone: "light" });
    expect(parseThemeChoice(42)).toBeNull();
  });

  test("Dusk is layered on Dark: both have the dark tone", () => {
    expect(toneOf("dusk")).toBe("dark");
    expect(toneOf("dark")).toBe("dark");
    expect(toneOf("light")).toBe("light");
  });

  test("every page, sign-in and onboarding included, uses the saved choice, else Light", () => {
    expect(resolveTheme(undefined)).toEqual({ theme: "light", tone: "light" });
    expect(resolveTheme("dusk")).toEqual({ theme: "dusk", tone: "dark" });
    expect(resolveTheme("dark")).toEqual({ theme: "dark", tone: "dark" });
    expect(resolveTheme("neon")).toEqual({ theme: "light", tone: "light" });
  });

  test("reads the choice from a cookie string", () => {
    expect(themeFromCookieString(`a=1; ${THEME_COOKIE}=light; b=2`)).toBe("light");
    expect(themeFromCookieString(`${THEME_COOKIE}=dark`)).toBe("dark");
    expect(themeFromCookieString("a=1")).toBeNull();
    expect(themeFromCookieString(`${THEME_COOKIE}=neon`)).toBeNull();
  });
});

/** Runs the inline head script against a stand-in document with a theme-color meta. */
function runBootScript(
  cookie: string,
  attributes: Record<string, string>,
  themeColor = "",
  stored: Record<string, string> = {},
) {
  const attrs = new Map(Object.entries(attributes));
  const listeners: Record<string, (event: { persisted: boolean }) => void> = {};
  const element = (store: Map<string, string>) => ({
    hasAttribute: (name: string) => store.has(name),
    getAttribute: (name: string) => store.get(name) ?? null,
    setAttribute: (name: string, value: string) => store.set(name, value),
  });
  const root = element(attrs);
  const meta = new Map([["content", themeColor]]);
  const fakeDocument = {
    documentElement: root,
    cookie,
    querySelector: (selector: string) =>
      selector === 'meta[name="theme-color"]' ? element(meta) : null,
  };
  const addEventListener = (name: string, listener: (event: { persisted: boolean }) => void) => {
    listeners[name] = listener;
  };
  const storage = new Map(Object.entries(stored));
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    removeItem: (key: string) => storage.delete(key),
  };
  new Function("document", "addEventListener", "localStorage", "location", themeBootScript())(
    fakeDocument,
    addEventListener,
    localStorage,
    { protocol: "http:" },
  );
  return { attrs, meta, listeners, fakeDocument, storage };
}

describe("the no-flash boot script", () => {
  test("keeps a server-rendered theme that already matches the cookie", () => {
    const { attrs } = runBootScript(`${THEME_COOKIE}=light`, {
      "data-theme": "light",
      "data-tone": "light",
    });
    expect(attrs.get("data-theme")).toBe("light");
  });

  test("corrects a cached page whose theme no longer matches the saved choice", () => {
    const { attrs } = runBootScript(`${THEME_COOKIE}=light`, {
      "data-theme": "dusk",
      "data-tone": "dark",
    });
    expect(attrs.get("data-theme")).toBe("light");
    expect(attrs.get("data-tone")).toBe("light");
  });

  test("defaults to Light without a cookie, on every page", () => {
    expect(runBootScript("", { "data-theme": "dusk" }).attrs.get("data-theme")).toBe("light");
  });

  test("re-applies the choice when a page comes back from the back/forward cache", () => {
    const run = runBootScript(
      `${THEME_COOKIE}=dark`,
      { "data-theme": "dark", "data-tone": "dark" },
      PAGE_COLORS.dark,
    );
    run.fakeDocument.cookie = `${THEME_COOKIE}=light`;
    run.listeners.pageshow?.({ persisted: true });
    expect(run.attrs.get("data-theme")).toBe("light");
    expect(run.meta.get("content")).toBe(PAGE_COLORS.light);
  });

  test("keeps theme-color on the theme's page token (spec 21.9b)", () => {
    const run = runBootScript(
      `${THEME_COOKIE}=dusk`,
      { "data-theme": "light", "data-tone": "light" },
      PAGE_COLORS.light,
    );
    expect(run.attrs.get("data-theme")).toBe("dusk");
    expect(run.meta.get("content")).toBe(PAGE_COLORS.dusk);
  });
});

describe("the theme picked in 0.1.x (30a R1-10)", () => {
  test("a stored Dark with no 1.0 cookie opens in Dark and is saved the 1.0 way", () => {
    const run = runBootScript("", { "data-theme": "light", "data-tone": "light" }, "", {
      [LEGACY_THEME_KEY]: "dark",
    });
    expect(run.attrs.get("data-theme")).toBe("dark");
    expect(run.attrs.get("data-tone")).toBe("dark");
    expect(run.meta.get("content")).toBe(PAGE_COLORS.dark);
    expect(themeFromCookieString(run.fakeDocument.cookie)).toBe("dark");
    expect(run.fakeDocument.cookie).toContain("Path=/");
    // The old value is no longer needed once the cookie holds the choice.
    expect(run.storage.has(LEGACY_THEME_KEY)).toBe(false);
  });

  test("a stored Dusk counts as chosen", () => {
    const run = runBootScript("", { "data-theme": "light" }, "", { [LEGACY_THEME_KEY]: "dusk" });
    expect(run.attrs.get("data-theme")).toBe("dusk");
  });

  test("a 1.0 choice wins over the old one, and junk is ignored", () => {
    const kept = runBootScript(`${THEME_COOKIE}=light`, { "data-theme": "light" }, "", {
      [LEGACY_THEME_KEY]: "dark",
    });
    expect(kept.attrs.get("data-theme")).toBe("light");
    expect(kept.storage.get(LEGACY_THEME_KEY)).toBe("dark");
    const junk = runBootScript("", { "data-theme": "light" }, "", { [LEGACY_THEME_KEY]: "neon" });
    expect(junk.attrs.get("data-theme")).toBe("light");
    expect(junk.fakeDocument.cookie).toBe("");
  });

  test("storage that throws (a private window) changes nothing", () => {
    const attrs = new Map([["data-theme", "light"]]);
    const root = {
      getAttribute: (name: string) => attrs.get(name) ?? null,
      setAttribute: (name: string, value: string) => attrs.set(name, value),
    };
    const fakeDocument = { documentElement: root, cookie: "", querySelector: () => null };
    const broken = {
      getItem: () => {
        throw new Error("SecurityError");
      },
    };
    new Function("document", "addEventListener", "localStorage", "location", themeBootScript())(
      fakeDocument,
      () => {},
      broken,
      { protocol: "http:" },
    );
    expect(attrs.get("data-theme")).toBe("light");
  });
});

describe("primary sidebar state (spec 21.6)", () => {
  test("open on the Agent page and collapsed on project pages until the person chooses", () => {
    expect(resolveNavState(undefined, "agent")).toBe("open");
    expect(resolveNavState(undefined, "project")).toBe("closed");
  });

  test("a saved choice holds on every rail page", () => {
    expect(resolveNavState("closed", "agent")).toBe("closed");
    expect(resolveNavState("open", "project")).toBe("open");
    expect(resolveNavState("sideways", "agent")).toBe("open");
    expect(parseNavState("open")).toBe("open");
    expect(NAV_COOKIE).toBe("nz_nav");
  });
});
