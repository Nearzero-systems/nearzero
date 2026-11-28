import type { TransitionBeforeSwapEvent } from "astro:transitions/client";
import {
  DEFAULT_THEME,
  PAGE_COLORS,
  parseThemeChoice,
  THEME_COOKIE,
  THEME_COOKIE_MAX_AGE,
  type ThemeName,
  themeFromCookieString,
  toneOf,
} from "../lib/theme.ts";
import { writeCookie } from "./cookies.ts";
import { dropPrefetched } from "./prefetch.ts";

/**
 * The theme picker (spec 21.2). Picking a theme applies it at once, saves it for this browser,
 * and every page swapped in by in-app navigation gets it before it is shown. The browser's own
 * bars follow through `<meta name="theme-color">`, the theme's `page` token (spec 21.9b).
 */

export function savedTheme(): ThemeName {
  return themeFromCookieString(document.cookie) ?? DEFAULT_THEME;
}

function applyTo(doc: Document, theme: ThemeName): void {
  const root = doc.documentElement;
  root.setAttribute("data-theme", theme);
  root.setAttribute("data-tone", toneOf(theme));
  let meta = doc.head.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = doc.createElement("meta");
    meta.name = "theme-color";
    doc.head.prepend(meta);
  }
  if (meta.content !== PAGE_COLORS[theme]) meta.content = PAGE_COLORS[theme];
}

function syncPickers(theme: ThemeName): void {
  for (const input of document.querySelectorAll<HTMLInputElement>("input[data-theme-choice]")) {
    input.checked = input.value === theme;
  }
}

export function chooseTheme(theme: ThemeName): void {
  writeCookie(THEME_COOKIE, theme, THEME_COOKIE_MAX_AGE);
  applyTo(document, theme);
  syncPickers(theme);
  dropPrefetched();
  document.dispatchEvent(new CustomEvent("nz:theme", { detail: theme }));
}

export function initTheme(): void {
  document.addEventListener("change", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.matches("[data-theme-choice]")) return;
    const theme = parseThemeChoice(input.value);
    if (theme) chooseTheme(theme);
  });

  document.addEventListener("astro:before-swap", (event) => {
    const swap = event as TransitionBeforeSwapEvent;
    applyTo(swap.newDocument, savedTheme());
  });

  document.addEventListener("astro:page-load", () => {
    syncPickers(savedTheme());
  });
}
