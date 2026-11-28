/**
 * Interface motion helpers (spec 21.7), shared by the console's scripts and the Agent's React
 * island. The durations live in CSS (styles/motion.css), so reduced motion, which sets them to 0,
 * needs no special case here: an element whose transition takes 0ms finishes at once. Nothing
 * here runs while idle; every helper stops by itself when its transition ends.
 */

/** Seconds or milliseconds as CSS writes them ("0.18s", "120ms"), in milliseconds. */
export function parseTime(value: string): number {
  const text = value.trim();
  if (text.endsWith("ms")) return Number.parseFloat(text) || 0;
  if (text.endsWith("s")) return (Number.parseFloat(text) || 0) * 1000;
  return 0;
}

/** The longest duration plus delay in a computed `transition-*` or `animation-*` list. */
export function longestTime(durations: string, delays: string): number {
  const d = durations.split(",").map(parseTime);
  const w = delays.split(",").map(parseTime);
  let longest = 0;
  for (let i = 0; i < d.length; i++) {
    // Shorter lists repeat, as CSS reads them.
    longest = Math.max(longest, (d[i] ?? 0) + (w[i % Math.max(w.length, 1)] ?? 0));
  }
  return longest;
}

/** How long the element's current transitions take, in milliseconds (0 under reduced motion). */
export function transitionTime(element: Element): number {
  const style = getComputedStyle(element);
  return longestTime(style.transitionDuration, style.transitionDelay);
}

/** The duration of the element's transition for one property ("all" counts), in milliseconds. */
export function transitionFor(element: Element, property: string): number {
  const style = getComputedStyle(element);
  const properties = style.transitionProperty.split(",").map((name) => name.trim());
  const durations = style.transitionDuration.split(",").map(parseTime);
  let found = 0;
  properties.forEach((name, index) => {
    if (name === property || name === "all") {
      found = durations[index % Math.max(durations.length, 1)] ?? 0;
    }
  });
  return found;
}

const slides = new WeakMap<Element, Animation>();

/**
 * Draws the element `dx`, `dy` pixels away from where its layout puts it and slides it back over
 * `duration` milliseconds, ease-out. It uses the `translate` property, so it adds to any transform
 * or transition the element has of its own (a toast still rising, a button's press). Measure the
 * element's new place after `stopSlide`, so an earlier slide doesn't count.
 */
export function slideFrom(element: HTMLElement, dx: number, dy: number, duration: number): void {
  stopSlide(element);
  if (duration <= 0 || (Math.abs(dx) < 0.25 && Math.abs(dy) < 0.25)) return;
  const animation = element.animate([{ translate: `${dx}px ${dy}px` }, { translate: "0px 0px" }], {
    duration,
    easing: "ease-out",
  });
  slides.set(element, animation);
  const forget = () => {
    if (slides.get(element) === animation) slides.delete(element);
  };
  animation.addEventListener("finish", forget);
  animation.addEventListener("cancel", forget);
}

export function stopSlide(element: Element): void {
  slides.get(element)?.cancel();
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

const pending = new WeakMap<Element, () => void>();

/** The element's own CSS transitions that haven't finished yet. */
function unfinishedTransitions(element: Element): Animation[] {
  return element
    .getAnimations()
    .filter(
      (animation) =>
        "transitionProperty" in animation &&
        animation.playState !== "finished" &&
        animation.playState !== "idle",
    );
}

/**
 * Calls `done` once the element's own transitions have ended: right away when they take no time
 * (reduced motion) or nothing is moving (nothing changed, or the element isn't rendered), else
 * when the transitions running now, and any that replace them, have finished. It follows the
 * transitions themselves, not a clock, so it ends exactly when they do. A newer call for the same
 * element cancels the older one, so fast repeated changes never queue up work. Returns a cancel.
 */
export function afterTransition(element: Element, done: () => void): () => void {
  pending.get(element)?.();
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    if (pending.get(element) === cancel) pending.delete(element);
  };
  const check = () => {
    if (cancelled) return;
    const moving = transitionTime(element) > 0 ? unfinishedTransitions(element) : [];
    if (moving.length === 0) {
      cancel();
      done();
      return;
    }
    // A transition cancelled midway (it turned back) is replaced by a new one: look again.
    void Promise.all(moving.map((animation) => animation.finished.catch(() => undefined))).then(
      check,
    );
  };
  pending.set(element, cancel);
  check();
  return cancel;
}

/** Stops waiting on the element's transitions without calling their `done`. */
export function cancelAfterTransition(element: Element): void {
  pending.get(element)?.();
}

/** The element's layout height right now, mid-transition included, ignoring transforms. */
export function currentHeight(element: HTMLElement): number {
  return Number.parseFloat(getComputedStyle(element).height) || 0;
}

/**
 * Keeps the element at its current height, so a change to its content doesn't move what follows
 * until `releaseHeight` animates to the new height. Safe to call mid-animation.
 */
export function holdHeight(element: HTMLElement): void {
  cancelAfterTransition(element);
  element.style.height = `${currentHeight(element)}px`;
  element.setAttribute("data-height-motion", "");
}

/**
 * Animates the element from the height it is held at to `target` (its natural height when
 * omitted), over its CSS height transition (180ms for expandable parts, spec 21.7). Released to
 * its natural height it then sizes itself again; to a fixed one it stays there, clipped. `done`
 * runs at the end, or at once under reduced motion.
 */
export function releaseHeight(element: HTMLElement, target?: number, done?: () => void): void {
  const held = element.style.height || `${currentHeight(element)}px`;
  element.setAttribute("data-height-motion", "");
  element.style.height = "auto";
  const to = target ?? currentHeight(element);
  element.style.height = held;
  void element.offsetHeight;
  element.style.height = `${to}px`;
  afterTransition(element, () => {
    if (target === undefined) {
      element.style.height = "";
      element.removeAttribute("data-height-motion");
    }
    done?.();
  });
}

/** A box in an element's layout coordinates: where it is drawn, and how wide. */
export interface Span {
  left: number;
  width: number;
}

/**
 * Where an element positioned by `translateX(x) scaleX(s)` from its own left edge is drawn right
 * now, mid-transition included (the tab strip's glider uses this to pick up where it is).
 */
export function drawnSpan(element: HTMLElement): Span {
  const style = getComputedStyle(element);
  const width = Number.parseFloat(style.width) || 0;
  const left = Number.parseFloat(style.left) || 0;
  const matrix = style.transform;
  if (!matrix || matrix === "none") return { left, width };
  const values = matrix
    .replace(/^matrix\(|\)$/g, "")
    .split(",")
    .map((part) => Number.parseFloat(part));
  const scale = values[0] ?? 1;
  const shift = values[4] ?? 0;
  return { left: left + shift, width: width * scale };
}

/** The transform that draws a box of `to` at `from`, scaling from its left edge. */
export function spanTransform(from: Span, to: Span): string {
  const scale = to.width > 0 ? from.width / to.width : 1;
  const shift = from.left - to.left;
  if (Math.abs(shift) < 0.01 && Math.abs(scale - 1) < 0.0001) return "none";
  return `translateX(${round(shift)}px) scaleX(${round(scale, 4)})`;
}

function round(value: number, places = 2): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
