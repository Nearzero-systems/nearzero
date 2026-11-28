import { addFloating } from "./layers.ts";

/**
 * The Dusk pixel glow (spec 21.5). While the pointer is over a primary or outlined button, the
 * dots of its 3px texture within 30px of the pointer light up; a click sends a ripple out from
 * the click point over 650ms. Everything is drawn on one canvas floating above the page (and
 * inside the topmost open dialog), so the buttons' own markup never changes. It only runs in
 * Dusk, never under reduced motion, and draws nothing while nothing is hovered or rippling.
 */

const SELECTOR = ".nz-btn--primary, .nz-btn--outline";
const PITCH = 3;
const RADIUS = 30;
const RIPPLE_MS = 650;
const RIPPLE_BAND = 7;
const CORNER = 6;

interface Ripple {
  button: HTMLElement;
  x: number;
  y: number;
  start: number;
}

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
let canvas: HTMLCanvasElement | null = null;
let context: CanvasRenderingContext2D | null = null;
let hovered: HTMLElement | null = null;
let pointer = { x: 0, y: 0 };
let ripples: Ripple[] = [];
let frame = 0;
let painted = false;

function active(): boolean {
  return document.documentElement.getAttribute("data-theme") === "dusk" && !reducedMotion.matches;
}

function ensureCanvas(): CanvasRenderingContext2D | null {
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    canvas.style.cssText =
      "position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:85;";
    context = canvas.getContext("2d");
    addFloating(canvas);
    resize();
  }
  return context;
}

function resize(): void {
  if (!canvas) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(window.innerWidth * ratio);
  canvas.height = Math.round(window.innerHeight * ratio);
  context?.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function buttonAt(target: EventTarget | null): HTMLElement | null {
  const button = (target as Element | null)?.closest?.<HTMLElement>(SELECTOR) ?? null;
  if (!button) return null;
  if ((button as HTMLButtonElement).disabled || button.getAttribute("aria-disabled") === "true") {
    return null;
  }
  return button;
}

function schedule(): void {
  if (!frame) frame = requestAnimationFrame(draw);
}

/** Lights the dots of `box` whose distance from (x, y) passes `strength`. */
function lightDots(
  ctx: CanvasRenderingContext2D,
  box: DOMRect,
  color: string,
  near: { x0: number; x1: number; y0: number; y1: number },
  strength: (dx: number, dy: number) => number,
): void {
  const originX = box.left + 1 + PITCH / 2;
  const originY = box.top + 1 + PITCH / 2;
  const firstColumn = Math.max(0, Math.floor((near.x0 - originX) / PITCH));
  const lastColumn = Math.floor((Math.min(near.x1, box.right - 1) - originX) / PITCH);
  const firstRow = Math.max(0, Math.floor((near.y0 - originY) / PITCH));
  const lastRow = Math.floor((Math.min(near.y1, box.bottom - 1) - originY) / PITCH);
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(box.left + 1, box.top + 1, box.width - 2, box.height - 2, CORNER - 1);
  ctx.clip();
  ctx.fillStyle = color;
  for (let row = firstRow; row <= lastRow; row++) {
    const y = originY + row * PITCH;
    for (let column = firstColumn; column <= lastColumn; column++) {
      const x = originX + column * PITCH;
      const alpha = strength(x, y);
      if (alpha <= 0.02) continue;
      ctx.globalAlpha = Math.min(1, alpha);
      ctx.fillRect(x - 0.6, y - 0.6, 1.2, 1.2);
    }
  }
  ctx.restore();
}

function colorFor(button: HTMLElement): string {
  return button.classList.contains("nz-btn--primary") ? "#ffffff" : "#c4b5fd";
}

function draw(now: number): void {
  frame = 0;
  if (!canvas && !active()) return;
  const ctx = ensureCanvas();
  if (!ctx || !canvas) return;
  if (painted) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    painted = false;
  }
  if (!active()) {
    ripples = [];
    return;
  }

  if (hovered?.isConnected) {
    const box = hovered.getBoundingClientRect();
    const { x, y } = pointer;
    lightDots(
      ctx,
      box,
      colorFor(hovered),
      { x0: x - RADIUS, x1: x + RADIUS, y0: y - RADIUS, y1: y + RADIUS },
      (dx, dy) => {
        const distance = Math.hypot(dx - x, dy - y);
        return distance > RADIUS ? 0 : (1 - distance / RADIUS) ** 1.6 * 0.9;
      },
    );
    painted = true;
  } else {
    hovered = null;
  }

  ripples = ripples.filter((ripple) => now - ripple.start < RIPPLE_MS && ripple.button.isConnected);
  for (const ripple of ripples) {
    const box = ripple.button.getBoundingClientRect();
    const progress = (now - ripple.start) / RIPPLE_MS;
    const reach = Math.hypot(
      Math.max(ripple.x - box.left, box.right - ripple.x),
      Math.max(ripple.y - box.top, box.bottom - ripple.y),
    );
    const radius = progress * reach;
    const fade = 1 - progress;
    lightDots(
      ctx,
      box,
      colorFor(ripple.button),
      { x0: box.left, x1: box.right, y0: box.top, y1: box.bottom },
      (dx, dy) => {
        const offset = Math.abs(Math.hypot(dx - ripple.x, dy - ripple.y) - radius);
        return offset > RIPPLE_BAND ? 0 : (1 - offset / RIPPLE_BAND) * fade * 0.95;
      },
    );
    painted = true;
  }

  // Keep animating only while a ripple runs; hover redraws on pointer movement.
  if (ripples.length > 0) schedule();
}

function clear(): void {
  hovered = null;
  ripples = [];
  schedule();
}

export function initPixelGlow(): void {
  document.addEventListener(
    "pointermove",
    (event) => {
      if (event.pointerType === "touch" || !active()) {
        if (hovered || painted) clear();
        return;
      }
      const button = buttonAt(event.target);
      if (!button && !hovered) return;
      hovered = button;
      pointer = { x: event.clientX, y: event.clientY };
      schedule();
    },
    { passive: true },
  );

  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!active()) return;
      const button = buttonAt(event.target);
      if (!button) return;
      ripples.push({ button, x: event.clientX, y: event.clientY, start: performance.now() });
      schedule();
    },
    { passive: true },
  );

  document.documentElement.addEventListener("pointerleave", clear);
  window.addEventListener("blur", clear);
  window.addEventListener("resize", () => {
    resize();
    clear();
  });
  window.addEventListener("scroll", clear, { capture: true, passive: true });
  document.addEventListener("astro:after-swap", clear);
  document.addEventListener("nz:theme", clear);
  reducedMotion.addEventListener("change", clear);
}
