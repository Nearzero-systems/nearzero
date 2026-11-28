import type { TransitionBeforeSwapEvent } from "astro:transitions/client";

/**
 * Page-wide motion rules (spec 21.7, styles/motion.css):
 * - only content swapped in by in-app navigation fades in; a page's first paint never animates;
 * - a theme switch repaints every color at once instead of easing some of them over the 120ms
 *   hover transition.
 */

function pauseMotion(): void {
  const root = document.documentElement;
  root.setAttribute("data-motion-pause", "");
  // Two frames: the new colors are drawn before transitions are back.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => root.removeAttribute("data-motion-pause")),
  );
}

export function initMotion(): void {
  document.addEventListener(
    "change",
    (event) => {
      if ((event.target as Element | null)?.matches?.("[data-theme-choice]")) pauseMotion();
    },
    // Before the theme picker applies the choice (client/theme.ts).
    true,
  );

  document.addEventListener("astro:before-swap", (event) => {
    (event as TransitionBeforeSwapEvent).newDocument.documentElement.setAttribute(
      "data-swapped",
      "",
    );
  });
}
