import { type IconName, iconSvg } from "../lib/icons.ts";
import {
  afterTransition,
  prefersReducedMotion,
  slideFrom,
  stopSlide,
  transitionFor,
} from "../lib/motion.ts";
import { addFloating, syncFloating } from "./layers.ts";

/**
 * Toasts (spec 21.5): bottom right, up to 28rem wide (full width minus 2rem on phones), 1px
 * border, no shadow. The region survives in-app navigation, so a toast shown just before a page
 * change stays readable after it.
 *
 * Motion (spec 21.7, styles/motion.css): a toast rises 8px and fades in over 180ms and fades out
 * over 140ms; the toasts around it slide to their new places instead of jumping.
 */

export type ToastTone = "info" | "success" | "error";

export interface ToastOptions {
  tone?: ToastTone;
  action?: { label: string; run: () => void };
  /** Stays until closed. Toasts with an action always stay. */
  persist?: boolean;
}

const LIFETIME_MS = 5000;
const MAX_TOASTS = 4;
const ICONS: Record<ToastTone, IconName> = { info: "info", success: "check", error: "alert" };

let host: HTMLElement | null = null;

function region(): HTMLElement {
  if (!host) {
    host = document.createElement("div");
    host.id = "nz-toasts";
    host.className = "nz-toasts";
    host.setAttribute("aria-live", "polite");
    addFloating(host);
  }
  syncFloating();
  return host;
}

export function showToast(message: string, options: ToastOptions = {}): HTMLElement {
  const tone = options.tone ?? "info";
  const container = region();
  // The oldest make room (they fade out like any other); fast repeats never pile up.
  for (let live = staying(container); live.length >= MAX_TOASTS; live = staying(container)) {
    leave(live[0] as HTMLElement);
  }

  const toast = document.createElement("div");
  toast.className = "nz-toast";
  toast.dataset.tone = tone;
  toast.setAttribute("role", tone === "error" ? "alert" : "status");
  toast.innerHTML = iconSvg(ICONS[tone]);

  const text = document.createElement("span");
  text.className = "nz-toast-text";
  text.textContent = message;
  toast.append(text);

  const dismiss = () => leave(toast);
  if (options.action) {
    const action = document.createElement("button");
    action.type = "button";
    action.className = "nz-btn nz-btn--outline";
    action.textContent = options.action.label;
    const run = options.action.run;
    action.addEventListener("click", () => {
      dismiss();
      run();
    });
    toast.append(action);
  }
  const close = document.createElement("button");
  close.type = "button";
  close.className = "nz-btn nz-btn--icon";
  close.setAttribute("aria-label", "Dismiss");
  close.style.width = "16px";
  close.style.height = "16px";
  close.style.minWidth = "16px";
  close.innerHTML = iconSvg("close");
  close.addEventListener("click", dismiss);
  toast.append(close);

  slide(container, () => container.append(toast));
  // Once it has risen it stays put, even when it moves into a dialog or onto a new page.
  afterTransition(toast, () => toast.setAttribute("data-shown", ""));
  if (!options.persist && !options.action) {
    let timer = window.setTimeout(dismiss, LIFETIME_MS);
    // Reading a toast holds it.
    toast.addEventListener("pointerenter", () => window.clearTimeout(timer));
    toast.addEventListener("pointerleave", () => {
      timer = window.setTimeout(dismiss, LIFETIME_MS);
    });
  }
  return toast;
}

function staying(container: HTMLElement): Element[] {
  return Array.from(container.children).filter((toast) => !toast.hasAttribute("data-leaving"));
}

/** Fades a toast out (140ms), then removes it while the others slide into its place. */
function leave(toast: HTMLElement): void {
  if (toast.hasAttribute("data-leaving")) return;
  toast.setAttribute("data-leaving", "");
  afterTransition(toast, () => {
    const container = toast.parentElement;
    if (container) slide(container, () => toast.remove());
    else toast.remove();
  });
}

/**
 * Makes a change to the stack (a toast added or removed) and lets the toasts that stay slide from
 * where they were to where they are now, as long as their rise takes (180ms).
 */
function slide(container: HTMLElement, change: () => void): void {
  if (prefersReducedMotion()) {
    change();
    return;
  }
  const toasts = staying(container) as HTMLElement[];
  const before = toasts.map((toast) => toast.getBoundingClientRect().top);
  change();
  for (const toast of toasts) stopSlide(toast);
  toasts.forEach((toast, index) => {
    if (!toast.isConnected) return;
    const dy = (before[index] ?? 0) - toast.getBoundingClientRect().top;
    slideFrom(toast, 0, dy, transitionFor(toast, "transform"));
  });
}

/** Shows the messages a server redirect left for this page (rendered as <template data-toast>). */
export function showPageToasts(): void {
  for (const template of document.querySelectorAll<HTMLTemplateElement>("template[data-toast]")) {
    const tone = (template.dataset.tone as ToastTone | undefined) ?? "success";
    showToast(template.content.textContent?.trim() ?? "", { tone });
    template.remove();
  }
}
