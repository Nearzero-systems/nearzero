import { afterTransition } from "../lib/motion.ts";

/**
 * Floating pieces (toasts, the progress bar, the pixel-glow canvas) live at the end of <body>.
 * While a modal dialog is open the rest of the page is inert and drawn under the dialog, so they
 * move into the topmost open dialog and come back when it closes. They also move into the new
 * <body> after an in-app page change.
 *
 * A dialog that is still scaling or sliding in (spec 21.7) would be their containing block, so
 * they would be placed against it instead of the window: they move in once it has arrived.
 */

const floating = new Set<HTMLElement>();
let observing = false;

export function topModalDialog(): HTMLDialogElement | null {
  const open = Array.from(document.querySelectorAll<HTMLDialogElement>("dialog[open]")).filter(
    (dialog) => dialog.matches(":modal"),
  );
  return open[open.length - 1] ?? null;
}

function arriving(dialog: HTMLDialogElement): boolean {
  return dialog
    .getAnimations()
    .some(
      (animation) =>
        (animation as CSSTransition).transitionProperty === "transform" &&
        animation.playState !== "finished",
    );
}

export function syncFloating(): void {
  const dialog = topModalDialog();
  if (dialog && arriving(dialog)) {
    afterTransition(dialog, syncFloating);
    return;
  }
  const host: HTMLElement = dialog ?? document.body;
  for (const element of floating) {
    if (element.parentNode !== host) host.append(element);
  }
}

export function addFloating(element: HTMLElement): void {
  floating.add(element);
  if (!observing) {
    observing = true;
    new MutationObserver(syncFloating).observe(document.documentElement, {
      subtree: true,
      attributes: true,
      attributeFilter: ["open"],
    });
    document.addEventListener("astro:after-swap", syncFloating);
  }
  syncFloating();
}
