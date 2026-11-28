import { navigate, type TransitionBeforePreparationEvent } from "astro:transitions/client";
import { closeOpenSheets, openDialog } from "./dialogs.ts";
import { addFloating } from "./layers.ts";
import { takePrefetched } from "./prefetch.ts";
import { showToast } from "./toasts.ts";

/**
 * In-app navigation (spec 21.7). Astro's client router fetches the next page and swaps it in
 * without a full reload. Around it:
 * - the page being left stays exactly as it is (full brightness) and takes no clicks;
 * - a 2px bar runs along the top: to 85% over 2.4s, then it fills and fades;
 * - a page that hasn't loaded after 25 seconds stops waiting and offers Retry;
 * - a prefetched copy of the page is used when there is a fresh one;
 * - the phone navigation sheet closes as soon as navigation starts;
 * - a page with unsaved changes (a visible `[data-leave-guard]`, like Agent policies' "You have
 *   unsaved changes.") asks first in its `#nz-leave-unsaved` dialog: Stay keeps the page and
 *   the changes, Leave goes on; closing the tab or reloading gets the browser's own question.
 * The new content's 180ms fade-in with a 4px rise is CSS on [data-page-content].
 */

const TIMEOUT_MS = 25_000;
const TRICKLE_MS = 2400;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

let bar: HTMLElement | null = null;
let fill: HTMLElement | null = null;
let fadeTimer = 0;
let navigationCount = 0;

function progressBar(): HTMLElement {
  if (!bar || !fill) {
    bar = document.createElement("div");
    bar.className = "nz-progress";
    bar.setAttribute("aria-hidden", "true");
    fill = document.createElement("div");
    fill.className = "nz-progress-bar";
    bar.append(fill);
    addFloating(bar);
  }
  return fill as HTMLElement;
}

function startProgress(): void {
  const element = progressBar();
  window.clearTimeout(fadeTimer);
  element.style.transition = "none";
  element.style.opacity = "1";
  if (reducedMotion.matches) {
    element.style.width = "85%";
    return;
  }
  element.style.width = "0%";
  void element.offsetWidth;
  element.style.transition = `width ${TRICKLE_MS}ms cubic-bezier(0.08, 0.6, 0.3, 1)`;
  element.style.width = "85%";
}

function finishProgress(): void {
  const element = progressBar();
  if (reducedMotion.matches) {
    element.style.transition = "none";
    element.style.opacity = "0";
    element.style.width = "0%";
    return;
  }
  element.style.transition = "width 160ms ease-out, opacity 220ms ease 160ms";
  element.style.width = "100%";
  element.style.opacity = "0";
  fadeTimer = window.setTimeout(() => {
    element.style.transition = "none";
    element.style.width = "0%";
  }, 420);
}

function lockPage(): void {
  document.documentElement.setAttribute("data-navigating", "");
  document.querySelector("[data-shell]")?.setAttribute("inert", "");
}

function unlockPage(): void {
  document.documentElement.removeAttribute("data-navigating");
  document.querySelector("[data-shell]")?.removeAttribute("inert");
}

function adoptCachedPage(
  event: TransitionBeforePreparationEvent,
  html: string,
  url: string,
  type: DOMParserSupportedType,
): boolean {
  const doc = new DOMParser().parseFromString(html, type);
  if (!doc.querySelector('[name="astro-view-transitions-enabled"]')) return false;
  for (const element of doc.querySelectorAll("noscript")) element.remove();
  if (url !== event.to.href) {
    const target = new URL(url);
    if (target.origin !== location.origin) return false;
    target.hash = event.to.hash;
    event.to = target;
  }
  event.newDocument = doc;
  return true;
}

/** Unsaved changes on this page that leaving would lose (B3-17). */
export function unsavedChanges(doc: Document = document): boolean {
  return doc.querySelector("[data-leave-guard]:not([hidden])") !== null;
}

let leaveApproved: string | null = null;

/**
 * Holds a navigation away from unsaved changes until the person answers: the navigation is
 * left pending (the next one, Leave or any link, replaces it), and Leave starts it again.
 */
function askBeforeLeaving(preparation: TransitionBeforePreparationEvent): boolean {
  const href = preparation.to.href;
  if (leaveApproved === href) {
    leaveApproved = null;
    return false;
  }
  // A form sent from the page (its own Save) and history moves (the address already changed)
  // go ahead; only links and scripted navigation ask.
  if (preparation.formData || preparation.navigationType === "traverse") return false;
  if (!unsavedChanges()) return false;
  const dialog = document.getElementById("nz-leave-unsaved");
  if (!(dialog instanceof HTMLDialogElement)) return false;
  preparation.loader = () => new Promise<void>(() => {});
  const leave = dialog.querySelector<HTMLElement>("[data-leave-confirm]");
  if (leave) {
    leave.onclick = () => {
      leaveApproved = href;
      dialog.close();
      void navigate(href);
    };
  }
  closeOpenSheets();
  openDialog(dialog);
  return true;
}

export function initNavigation(): void {
  window.addEventListener("beforeunload", (event) => {
    if (!unsavedChanges()) return;
    event.preventDefault();
    // Older browsers ask only when returnValue is set.
    event.returnValue = "";
  });

  document.addEventListener("astro:before-preparation", (event) => {
    const preparation = event as TransitionBeforePreparationEvent;
    if (askBeforeLeaving(preparation)) return;
    const id = ++navigationCount;
    const href = preparation.to.href;
    closeOpenSheets();
    startProgress();
    lockPage();

    const prefetched =
      !preparation.formData && preparation.navigationType !== "traverse"
        ? takePrefetched(href)
        : null;
    const original = preparation.loader;

    preparation.loader = () =>
      new Promise<void>((resolve, reject) => {
        let timedOut = false;
        const timer = window.setTimeout(() => {
          timedOut = true;
          if (id !== navigationCount) return;
          // Leave this navigation pending forever: the next one (Retry or any link) replaces it.
          finishProgress();
          unlockPage();
          showToast("This page is taking too long to load.", {
            tone: "error",
            action: { label: "Retry", run: () => void navigate(href) },
          });
        }, TIMEOUT_MS);

        const run = async () => {
          const page = prefetched ? await prefetched : null;
          if (
            page &&
            !preparation.signal.aborted &&
            adoptCachedPage(preparation, page.html, page.url, page.mediaType)
          ) {
            return;
          }
          await original();
        };

        run().then(
          () => {
            window.clearTimeout(timer);
            if (!timedOut) resolve();
          },
          (error: unknown) => {
            window.clearTimeout(timer);
            if (!timedOut) reject(error);
          },
        );
      });
  });

  document.addEventListener("astro:after-swap", () => {
    finishProgress();
    unlockPage();
  });

  // A navigation the router hands back to the browser (a full load) or one that was aborted.
  document.addEventListener("astro:page-load", unlockPage);
  window.addEventListener("pageshow", unlockPage);
}
