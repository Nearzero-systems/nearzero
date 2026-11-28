/**
 * Theme choice (spec 21.2). Three themes; Dusk is layered on Dark, so every theme also has a
 * tone (light or dark) that terminals, charts and editors read. The choice lives in a cookie so
 * the server renders the right theme on the first byte, and the page never flashes another one.
 */

export const THEME_NAMES = ["light", "dark", "dusk"] as const;
export type ThemeName = (typeof THEME_NAMES)[number];
export type Tone = "light" | "dark";

/** Anyone who has never picked a theme gets Light (spec 21.2). */
export const DEFAULT_THEME: ThemeName = "light";
export const THEME_COOKIE = "nz_theme";
/** Browsers cap cookie lifetimes at 400 days. */
export const THEME_COOKIE_MAX_AGE = 400 * 24 * 60 * 60;

/**
 * Each theme's `page` token (spec 21.3), which `<meta name="theme-color">` carries so the browser's
 * own bars match the page (spec 21.9b). styles/tokens.css holds the same values; a test keeps
 * them equal.
 */
export const PAGE_COLORS: Record<ThemeName, string> = {
  light: "#f3f4f6",
  dark: "#050506",
  dusk: "#050507",
};

export interface ResolvedTheme {
  theme: ThemeName;
  tone: Tone;
}

export function parseThemeChoice(value: unknown): ThemeName | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return (THEME_NAMES as readonly string[]).includes(normalized) ? (normalized as ThemeName) : null;
}

export function toneOf(theme: ThemeName): Tone {
  return theme === "light" ? "light" : "dark";
}

/**
 * The theme a page renders in: this browser's saved choice, else Light. Every page uses it, sign-in,
 * registration, invitation and onboarding included, so the theme never changes on the way in
 * (spec 21.2).
 */
export function resolveTheme(saved: string | null | undefined): ResolvedTheme {
  const theme = parseThemeChoice(saved) ?? DEFAULT_THEME;
  return { theme, tone: toneOf(theme) };
}

/** Reads the saved choice from a `document.cookie`-style string. */
export function themeFromCookieString(cookies: string): ThemeName | null {
  for (const part of cookies.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === THEME_COOKIE) return parseThemeChoice(decodeURIComponent(rest.join("=")));
  }
  return null;
}

/**
 * Where 0.1.x kept the theme a person picked: local storage, `light`, `dark` or `dusk`
 * (30a R1-10). With nothing saved 0.1.x showed Dusk, but it wrote the key only when someone
 * picked a theme, so a stored value, Dusk included, counts as chosen and is carried over as is.
 * People who never picked one in 0.1.x get 1.0's Light default.
 */
export const LEGACY_THEME_KEY = "nearzero-theme";

/**
 * A tiny script inlined at the top of <head>. The server already rendered the theme from the
 * cookie; this only corrects a page restored from the browser's back/forward cache or another
 * cached copy after the choice changed, before that page paints, theme-color included. On the
 * first visit after a move from 0.1.x, a browser with no theme cookie but 0.1.x's stored choice
 * saves that choice as the cookie and shows it at once; the old value is then removed.
 */
export function themeBootScript(): string {
  const names = JSON.stringify(THEME_NAMES);
  return [
    "(function(){",
    "var d=document.documentElement;",
    `var c=${JSON.stringify(PAGE_COLORS)};`,
    "try{",
    `if(!/(?:^|;\\s*)${THEME_COOKIE}=/.test(document.cookie)){`,
    `var o=localStorage.getItem('${LEGACY_THEME_KEY}');`,
    `if(${names}.indexOf(o)>=0){`,
    `var p=['${THEME_COOKIE}='+o,'Path=/','Max-Age=${THEME_COOKIE_MAX_AGE}','SameSite=Lax'];`,
    "if(location.protocol==='https:')p.push('Secure');",
    "document.cookie=p.join('; ');",
    `if(document.cookie.indexOf('${THEME_COOKIE}='+o)>=0)localStorage.removeItem('${LEGACY_THEME_KEY}');`,
    "}}",
    "}catch(e){}",
    "function apply(){",
    `var m=document.cookie.match(/(?:^|;\\s*)${THEME_COOKIE}=([a-z]+)/);`,
    `var t=m&&${names}.indexOf(m[1])>=0?m[1]:'${DEFAULT_THEME}';`,
    "if(d.getAttribute('data-theme')!==t){d.setAttribute('data-theme',t);d.setAttribute('data-tone',t==='light'?'light':'dark');}",
    "var e=document.querySelector('meta[name=\"theme-color\"]');",
    "if(e&&e.getAttribute('content')!==c[t])e.setAttribute('content',c[t]);",
    "}",
    "apply();",
    "addEventListener('pageshow',function(e){if(e.persisted)apply();});",
    "})();",
  ].join("");
}
