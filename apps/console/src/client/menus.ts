/**
 * Menus and popovers (spec 21.5, 21.8). They use the browser's popover attribute for light
 * dismiss and Escape; this places each one beside the button that opened it and keeps it inside
 * the screen, flips it above or below when it doesn't fit, and adds arrow-key movement.
 *
 * Motion (spec 21.7, styles/motion.css): a menu fades in over 140ms with a 4px drop away from its
 * button (data-side says which way) and fades out over 100ms (data-motion="out", while the
 * browser keeps it on screen). Reopening one that is still fading out turns it back from where it
 * is. Focus and the keys work from the first frame.
 */

const EDGE = 8;
const GAP = 4;
let lastInvoker: HTMLElement | null = null;

function invokerFor(popover: HTMLElement): HTMLElement | null {
  if (lastInvoker?.getAttribute("popovertarget") === popover.id && lastInvoker.isConnected) {
    return lastInvoker;
  }
  return document.querySelector<HTMLElement>(`[popovertarget="${CSS.escape(popover.id)}"]`);
}

export function placePopover(popover: HTMLElement, anchor: HTMLElement): void {
  const placement = popover.dataset.placement ?? "bottom-start";
  const [side, align] = placement.split("-");
  // A menu may ask for its own distance from the button (the user menu sits 8px above it).
  const gap = Number(popover.dataset.gap ?? GAP) || GAP;
  const anchorBox = anchor.getBoundingClientRect();
  const width = popover.offsetWidth;
  const height = popover.offsetHeight;
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight;

  let left = align === "end" ? anchorBox.right - width : anchorBox.left;
  left = Math.min(Math.max(EDGE, left), Math.max(EDGE, viewportWidth - width - EDGE));

  const below = anchorBox.bottom + gap;
  const above = anchorBox.top - gap - height;
  let top: number;
  if (side === "top") top = above >= EDGE ? above : below;
  else top = below + height <= viewportHeight - EDGE || above < EDGE ? below : above;
  top = Math.min(Math.max(EDGE, top), Math.max(EDGE, viewportHeight - height - EDGE));

  popover.style.left = `${Math.round(left)}px`;
  popover.style.top = `${Math.round(top)}px`;
  popover.dataset.side = top < anchorBox.top ? "top" : "bottom";
}

/** Still on screen while it fades out. */
function fadingOut(popover: HTMLElement): boolean {
  return (
    popover.dataset.motion === "out" &&
    popover.getAnimations().some((animation) => animation.playState === "running")
  );
}

function items(popover: HTMLElement): HTMLElement[] {
  return Array.from(
    popover.querySelectorAll<HTMLElement>(
      '[role="menuitem"]:not([aria-disabled="true"]), [role="menuitemradio"], [role="menuitemcheckbox"]',
    ),
  ).filter((element) => !(element as HTMLButtonElement).disabled);
}

export function initMenus(): void {
  document.addEventListener(
    "click",
    (event) => {
      const invoker = (event.target as Element | null)?.closest<HTMLElement>("[popovertarget]");
      if (invoker) lastInvoker = invoker;
    },
    true,
  );

  document.addEventListener(
    "beforetoggle",
    (event) => {
      const popover = event.target;
      if (!(popover instanceof HTMLElement) || !popover.matches("[data-menu]")) return;
      const toggle = event as ToggleEvent;
      const invoker = invokerFor(popover);
      invoker?.setAttribute("aria-expanded", toggle.newState === "open" ? "true" : "false");
      if (toggle.newState === "open") {
        // Hidden until placed, then from its starting place; one still fading out stays drawn
        // and turns back from where it is.
        if (!fadingOut(popover)) {
          popover.style.visibility = "hidden";
          popover.dataset.motion = "from";
        }
      } else {
        popover.dataset.motion = "out";
      }
    },
    true,
  );

  document.addEventListener(
    "toggle",
    (event) => {
      const popover = event.target;
      if (!(popover instanceof HTMLElement) || !popover.matches("[data-menu]")) return;
      if ((event as ToggleEvent).newState !== "open" || !popover.matches(":popover-open")) return;
      const invoker = invokerFor(popover);
      if (invoker) placePopover(popover, invoker);
      popover.style.visibility = "";
      // The start (placed, on its side) takes effect, then it fades and drops into place.
      void popover.offsetWidth;
      popover.removeAttribute("data-motion");
      if (popover.getAttribute("role") === "menu") {
        const checked = popover.querySelector<HTMLElement>('[aria-checked="true"]');
        (checked ?? items(popover)[0])?.focus({ preventScroll: true });
      }
      popover.dispatchEvent(new CustomEvent("nz:menu-open", { bubbles: true }));
    },
    true,
  );

  document.addEventListener("keydown", (event) => {
    const popover = (document.activeElement as Element | null)?.closest<HTMLElement>(
      '[data-menu][role="menu"]:popover-open',
    );
    if (!popover) return;
    const list = items(popover);
    const index = list.indexOf(document.activeElement as HTMLElement);
    let next: HTMLElement | undefined;
    if (event.key === "ArrowDown") next = list[(index + 1) % list.length];
    else if (event.key === "ArrowUp") next = list[(index - 1 + list.length) % list.length];
    else if (event.key === "Home") next = list[0];
    else if (event.key === "End") next = list[list.length - 1];
    else if (event.key === "Tab") popover.hidePopover();
    if (next) {
      event.preventDefault();
      next.focus();
    }
  });

  // Picking an item closes its menu (links close as the page changes).
  document.addEventListener("click", (event) => {
    const item = (event.target as Element | null)?.closest<HTMLElement>(
      '[data-menu] [role="menuitem"], [data-menu] [role="menuitemradio"]',
    );
    if (!item || item.hasAttribute("data-keep-open")) return;
    const popover = item.closest<HTMLElement>("[data-menu]");
    if (popover?.matches(":popover-open")) popover.hidePopover();
  });

  window.addEventListener("resize", () => {
    for (const popover of document.querySelectorAll<HTMLElement>("[data-menu]:popover-open")) {
      const invoker = invokerFor(popover);
      if (invoker) placePopover(popover, invoker);
    }
  });
}
