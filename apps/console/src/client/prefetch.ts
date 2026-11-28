/**
 * Prefetching (spec 21.7): hovering, pressing or focusing a link starts fetching that page. A
 * prefetched page is used once, lives 15 seconds, and is dropped after any change the person
 * makes (a form submit, a theme change, or anything that fires `nz:changed`).
 */

export interface PrefetchedPage {
  html: string;
  /** The final address after redirects. */
  url: string;
  mediaType: DOMParserSupportedType;
}

const LIFETIME_MS = 15_000;
const HOVER_DELAY_MS = 80;
const cache = new Map<string, { at: number; page: Promise<PrefetchedPage | null> }>();
let hoverTimer = 0;

function keyOf(href: string): string {
  const url = new URL(href, location.href);
  url.hash = "";
  return url.href;
}

function eligible(link: Element | null): string | null {
  if (!(link instanceof HTMLAnchorElement) || !link.href) return null;
  if (link.target && link.target !== "_self") return null;
  if (link.hasAttribute("download") || link.dataset.astroReload !== undefined) return null;
  if (link.dataset.prefetch === "false") return null;
  const url = new URL(link.href, location.href);
  if (url.origin !== location.origin || url.pathname.startsWith("/api/")) return null;
  if (url.pathname === location.pathname && url.search === location.search) return null;
  return keyOf(url.href);
}

async function load(key: string): Promise<PrefetchedPage | null> {
  try {
    const response = await fetch(key, {
      credentials: "same-origin",
      headers: { "x-nz-prefetch": "1" },
    });
    if (!response.ok) return null;
    const mediaType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim();
    if (mediaType !== "text/html" && mediaType !== "application/xhtml+xml") return null;
    return { html: await response.text(), url: response.url || key, mediaType };
  } catch {
    return null;
  }
}

export function prefetch(href: string): void {
  const key = keyOf(href);
  const existing = cache.get(key);
  if (existing && Date.now() - existing.at < LIFETIME_MS) return;
  cache.set(key, { at: Date.now(), page: load(key) });
}

/** Takes a fresh prefetched page for `href`, once. */
export function takePrefetched(href: string): Promise<PrefetchedPage | null> | null {
  const key = keyOf(href);
  const entry = cache.get(key);
  if (!entry) return null;
  cache.delete(key);
  if (Date.now() - entry.at >= LIFETIME_MS) return null;
  return entry.page;
}

export function dropPrefetched(): void {
  cache.clear();
}

export function initPrefetch(): void {
  const reducedData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection
    ?.saveData;
  if (reducedData) return;

  document.addEventListener("pointerover", (event) => {
    if ((event as PointerEvent).pointerType === "touch") return;
    const key = eligible((event.target as Element | null)?.closest("a") ?? null);
    if (!key) return;
    window.clearTimeout(hoverTimer);
    hoverTimer = window.setTimeout(() => prefetch(key), HOVER_DELAY_MS);
  });
  document.addEventListener("pointerout", () => window.clearTimeout(hoverTimer));
  document.addEventListener(
    "pointerdown",
    (event) => {
      const key = eligible((event.target as Element | null)?.closest("a") ?? null);
      if (key) prefetch(key);
    },
    { passive: true },
  );
  document.addEventListener("focusin", (event) => {
    const key = eligible((event.target as Element | null)?.closest("a") ?? null);
    if (key) prefetch(key);
  });

  document.addEventListener("submit", dropPrefetched, true);
  document.addEventListener("nz:changed", dropPrefetched);
}
