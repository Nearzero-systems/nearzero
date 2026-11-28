/**
 * Dragging on the Overview canvas (spec 05 5.2): on desktop a card, with the line and domain
 * cards that hang off it, can be moved to tidy the view once the pointer has moved 6px, never
 * from its buttons or links. Positions aren't saved. At 640px and below the canvas is a list
 * and nothing drags, so a swipe scrolls the page.
 */

const THRESHOLD = 6;
const narrow = () => window.matchMedia("(max-width: 640px)").matches;

interface Drag {
  element: HTMLElement;
  startX: number;
  startY: number;
  baseX: number;
  baseY: number;
  moving: boolean;
  pointerId: number;
}

let drag: Drag | null = null;

function offset(element: HTMLElement): { x: number; y: number } {
  return { x: Number(element.dataset.dx ?? "0"), y: Number(element.dataset.dy ?? "0") };
}

export function initCanvas(): void {
  document.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || narrow()) return;
    const target = event.target as Element | null;
    const element = target?.closest<HTMLElement>("[data-canvas] [data-draggable]");
    if (!element || target?.closest("button, a, input, select, textarea, [popover]")) return;
    const base = offset(element);
    drag = {
      element,
      startX: event.clientX,
      startY: event.clientY,
      baseX: base.x,
      baseY: base.y,
      moving: false,
      pointerId: event.pointerId,
    };
  });

  document.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moving) {
      if (Math.hypot(dx, dy) < THRESHOLD) return;
      drag.moving = true;
      drag.element.dataset.dragging = "true";
      drag.element.setPointerCapture?.(event.pointerId);
    }
    const x = drag.baseX + dx;
    const y = drag.baseY + dy;
    drag.element.dataset.dx = String(x);
    drag.element.dataset.dy = String(y);
    drag.element.style.transform = `translate(${x}px, ${y}px)`;
  });

  const end = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (drag.moving) {
      delete drag.element.dataset.dragging;
      drag.element.releasePointerCapture?.(event.pointerId);
    }
    drag = null;
  };
  document.addEventListener("pointerup", end);
  document.addEventListener("pointercancel", end);

  // A phone-width canvas is a list: drop any offsets from a wider window.
  window.addEventListener("resize", () => {
    if (!narrow()) return;
    for (const element of document.querySelectorAll<HTMLElement>(
      "[data-canvas] [data-draggable]",
    )) {
      element.style.transform = "";
      delete element.dataset.dx;
      delete element.dataset.dy;
    }
  });
}
