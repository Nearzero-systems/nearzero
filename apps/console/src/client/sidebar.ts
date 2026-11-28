import type { TransitionBeforeSwapEvent } from "astro:transitions/client";
import {
  afterTransition,
  prefersReducedMotion,
  slideFrom,
  stopSlide,
  transitionFor,
} from "../lib/motion.ts";
import { NAV_COOKIE, NAV_COOKIE_MAX_AGE, type NavState, parseNavState } from "../lib/nav-state.ts";
import { writeCookie } from "./cookies.ts";

/**
 * The primary sidebar on rail pages opens and closes from its toggle; the choice is saved in a
 * cookie so every rail page renders it the same way on first paint (spec 21.6).
 *
 * Its width animates over 200ms (spec 21.7) and the content beside it follows, since it is laid
 * out next to it. The rail and the open sidebar place their icons, the group label and the user
 * button differently, so those parts slide from where they were to where they will be with
 * transforms (measured before and after the change), while the labels fade out first or back in
 * last (styles/motion.css). A click midway starts from wherever everything is drawn, so nothing
 * jumps and nothing queues.
 *
 * In-app navigation keeps the shell continuous too: when the next page's sidebar is in the other
 * state, or it adds, removes or swaps the secondary column (the Agent's sessions, a project's
 * menu), the new page starts as the old one looked and moves into place the same way.
 */

const MOVERS =
  ".nz-nav-item, .nz-nav-group, .nz-nav-foot .nz-avatar, .nz-nav-foot .nz-user-text, .nz-nav-foot .nz-user-chevron";

function shown(element: Element): boolean {
  return element.getClientRects().length > 0;
}

/** Moves the sidebar to `next`, animating from however it is drawn right now. */
export function moveSidebar(nav: HTMLElement, next: NavState): void {
  if (prefersReducedMotion() || !shown(nav)) {
    nav.dataset.state = next;
    nav.removeAttribute("data-motion");
    return;
  }
  const parts = Array.from(nav.querySelectorAll<HTMLElement>(MOVERS)).filter(shown);
  const before = parts.map((part) => part.getBoundingClientRect());
  nav.dataset.state = next;
  nav.setAttribute("data-motion", "");
  for (const part of parts) stopSlide(part);
  // The parts slide as long as the width takes: 200ms, or less when it turned back midway (the
  // browser shortens a reversed transition).
  const width = nav
    .getAnimations()
    .find((animation) => (animation as CSSTransition).transitionProperty === "width");
  const duration = Number(
    width?.effect?.getComputedTiming().duration ?? transitionFor(nav, "width"),
  );
  parts.forEach((part, index) => {
    const from = before[index];
    if (!from) return;
    const to = part.getBoundingClientRect();
    // The group label shrinks to the rail's hairline: it keeps to the items under it, so it
    // moves by its bottom edge.
    const dy = part.matches(".nz-nav-group") ? from.bottom - to.bottom : from.top - to.top;
    slideFrom(part, from.left - to.left, dy, duration);
  });
  afterTransition(nav, () => nav.removeAttribute("data-motion"));
}

function labelToggle(toggle: Element, state: NavState): void {
  const label = state === "open" ? "Collapse sidebar" : "Expand sidebar";
  toggle.setAttribute("aria-expanded", state === "open" ? "true" : "false");
  toggle.setAttribute("aria-label", label);
  toggle.setAttribute("title", label);
}

// ---- In-app navigation: the shell moves from the old page's shape to the new one's

type ColumnKind = "project" | "sessions" | "other";

interface ShellShape {
  nav: NavState | null;
  column: { kind: ColumnKind; width: number; inner: number; copy: HTMLElement } | null;
}

let leaving: ShellShape | null = null;

function kindOf(column: Element): ColumnKind {
  if (column.classList.contains("nz-secondary--project")) return "project";
  if (column.classList.contains("nz-secondary--sessions")) return "sessions";
  return "other";
}

function visibleColumn(): HTMLElement | null {
  for (const column of document.querySelectorAll<HTMLElement>(
    ".nz-frame .nz-secondary:not([data-closing])",
  )) {
    if (column.getBoundingClientRect().width > 0) return column;
  }
  return null;
}

function shapeOfPage(): ShellShape {
  const nav = document.querySelector<HTMLElement>("[data-primary-nav]");
  const column = visibleColumn();
  return {
    nav: nav && shown(nav) ? parseNavState(nav.dataset.state) : null,
    column: column
      ? {
          kind: kindOf(column),
          width: column.getBoundingClientRect().width,
          inner: column.clientWidth,
          copy: column.cloneNode(true) as HTMLElement,
        }
      : null,
  };
}

/** The new page's column grows from `from` pixels (0 when the old page had none). */
function openColumn(frame: HTMLElement, column: HTMLElement, from: number): void {
  // Its own width first (with no transition), so its content is laid out at that width.
  frame.dataset.column = "measure";
  frame.style.setProperty("--nz-column-inner", `${column.clientWidth}px`);
  frame.style.setProperty("--nz-column-from", `${from}px`);
  frame.dataset.column = "from";
  void column.offsetWidth;
  frame.dataset.column = "opening";
  afterTransition(column, () => {
    frame.removeAttribute("data-column");
    frame.style.removeProperty("--nz-column-from");
    frame.style.removeProperty("--nz-column-inner");
  });
}

/** A column the new page doesn't have folds away: a copy of it stands in until it has. */
function closeColumn(frame: HTMLElement, old: NonNullable<ShellShape["column"]>): void {
  const copy = old.copy;
  for (const element of [copy, ...copy.querySelectorAll("[id]")]) element.removeAttribute("id");
  copy.setAttribute("aria-hidden", "true");
  copy.inert = true;
  copy.style.width = `${old.width}px`;
  copy.style.setProperty("--nz-column-inner", `${old.inner}px`);
  const nav = frame.querySelector("[data-primary-nav]");
  if (nav) nav.after(copy);
  else frame.prepend(copy);
  void copy.offsetWidth;
  copy.style.width = "";
  copy.setAttribute("data-closing", "");
  afterTransition(copy, () => copy.remove());
}

function continueShell(old: ShellShape): void {
  const nav = document.querySelector<HTMLElement>("[data-primary-nav]");
  const target = nav ? parseNavState(nav.dataset.state) : null;
  if (nav && target && old.nav && old.nav !== target && shown(nav)) {
    // Lay the new sidebar out as the old one was (at once), then move it.
    nav.setAttribute("data-motion-pause", "");
    nav.dataset.state = old.nav;
    void nav.offsetWidth;
    nav.removeAttribute("data-motion-pause");
    moveSidebar(nav, target);
  }
  const frame = document.querySelector<HTMLElement>(".nz-frame");
  if (!frame) return;
  const column = visibleColumn();
  if (column && old.column?.kind !== kindOf(column)) {
    openColumn(frame, column, old.column?.width ?? 0);
  } else if (!column && old.column) {
    closeColumn(frame, old.column);
  }
}

export function initSidebarToggle(): void {
  document.addEventListener("click", (event) => {
    const toggle = (event.target as Element | null)?.closest<HTMLElement>("[data-nav-toggle]");
    if (!toggle) return;
    const nav = document.querySelector<HTMLElement>("[data-primary-nav]");
    if (!nav) return;
    const next: NavState = nav.dataset.state === "open" ? "closed" : "open";
    moveSidebar(nav, next);
    writeCookie(NAV_COOKIE, next, NAV_COOKIE_MAX_AGE);
    labelToggle(toggle, next);
  });

  document.addEventListener("astro:before-swap", (event) => {
    leaving = (event as TransitionBeforeSwapEvent).newDocument ? shapeOfPage() : null;
  });

  document.addEventListener("astro:after-swap", () => {
    const old = leaving;
    leaving = null;
    if (old && !prefersReducedMotion()) continueShell(old);
  });
}
