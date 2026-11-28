import {
  afterTransition,
  drawnSpan,
  prefersReducedMotion,
  type Span,
  spanTransform,
} from "../lib/motion.ts";

/**
 * Tabs (spec 21.7): when the active tab changes, its highlight (or underline) slides to the new
 * tab over 180ms instead of jumping. At rest every tab draws its own highlight; only while it
 * moves does one glider, drawn under the tabs, carry it from the old tab to the new one, scaled
 * from the old width to the new (styles/motion.css). A change midway starts from wherever the
 * glider is drawn, so fast clicks never queue.
 *
 * It follows in-place tabs (aria-selected, client/misc.ts and the Agent's forms) and link tabs
 * across in-app navigation (aria-current: a service's sections, Domains, Servers), matching a
 * strip on the new page to the old one by its accessible name. Nothing runs at rest.
 */

const ACTIVE = '[aria-selected="true"], [aria-current="page"]';

function activeTab(strip: Element): HTMLElement | null {
  return strip.querySelector<HTMLElement>(`:scope > .nz-tab:is(${ACTIVE})`);
}

/** A tab's place in its strip's layout (the strip is the tabs' offset parent). */
function spanOf(tab: HTMLElement): Span {
  return { left: tab.offsetLeft, width: tab.offsetWidth };
}

function gliderOf(strip: HTMLElement): HTMLElement | null {
  return strip.querySelector<HTMLElement>(":scope > .nz-tab-glider");
}

/** Where the strip's highlight is drawn now: the glider mid-slide, else the active tab. */
function drawnHighlight(strip: HTMLElement, fallback: HTMLElement | null): Span | null {
  const glider = gliderOf(strip);
  if (glider) return drawnSpan(glider);
  return fallback ? spanOf(fallback) : null;
}

export function glide(strip: HTMLElement, from: Span, to: HTMLElement): void {
  if (prefersReducedMotion()) return;
  const target = spanOf(to);
  if (Math.abs(from.left - target.left) < 0.5 && Math.abs(from.width - target.width) < 0.5) return;
  let glider = gliderOf(strip);
  if (!glider) {
    glider = document.createElement("span");
    glider.className = "nz-tab-glider";
    glider.setAttribute("aria-hidden", "true");
    strip.prepend(glider);
  }
  glider.style.transition = "none";
  glider.style.left = `${target.left}px`;
  glider.style.top = `${to.offsetTop}px`;
  glider.style.width = `${target.width}px`;
  glider.style.height = `${to.offsetHeight}px`;
  glider.style.transform = spanTransform(from, target);
  strip.setAttribute("data-gliding", "");
  void glider.offsetWidth;
  glider.style.transition = "";
  glider.style.transform = "none";
  const moving = glider;
  afterTransition(moving, () => {
    moving.remove();
    strip.removeAttribute("data-gliding");
  });
}

/** Strips on this page, by accessible name, with where their highlight is drawn. */
function highlights(): Map<string, Span> {
  const found = new Map<string, Span>();
  for (const strip of document.querySelectorAll<HTMLElement>(".nz-tabs[aria-label]")) {
    const span = drawnHighlight(strip, activeTab(strip));
    const name = strip.getAttribute("aria-label");
    if (span && name && strip.getClientRects().length > 0) found.set(name, span);
  }
  return found;
}

export function initTabGlider(): void {
  // In-place tabs: the attribute moves from one tab to another.
  new MutationObserver((records) => {
    const previous = new Map<HTMLElement, HTMLElement>();
    for (const record of records) {
      const tab = record.target;
      if (!(tab instanceof HTMLElement) || !tab.classList.contains("nz-tab")) continue;
      const strip = tab.parentElement;
      if (!strip?.classList.contains("nz-tabs")) continue;
      const was = record.oldValue === "true" || record.oldValue === "page";
      if (was && !tab.matches(ACTIVE) && !previous.has(strip)) previous.set(strip, tab);
    }
    for (const [strip, old] of previous) {
      const next = activeTab(strip);
      if (!next || next === old || strip.getClientRects().length === 0) continue;
      const from = drawnHighlight(strip, old);
      if (from) glide(strip, from, next);
    }
  }).observe(document.documentElement, {
    subtree: true,
    attributes: true,
    attributeOldValue: true,
    attributeFilter: ["aria-selected", "aria-current"],
  });

  // Link tabs: the old page's highlight carries over to the same strip on the new page.
  let leaving: Map<string, Span> | null = null;
  document.addEventListener("astro:before-swap", () => {
    leaving = prefersReducedMotion() ? null : highlights();
  });
  document.addEventListener("astro:after-swap", () => {
    const old = leaving;
    leaving = null;
    if (!old || old.size === 0) return;
    for (const strip of document.querySelectorAll<HTMLElement>(".nz-tabs[aria-label]")) {
      const from = old.get(strip.getAttribute("aria-label") ?? "");
      const next = activeTab(strip);
      if (from && next && strip.getClientRects().length > 0) glide(strip, from, next);
    }
  });
}
