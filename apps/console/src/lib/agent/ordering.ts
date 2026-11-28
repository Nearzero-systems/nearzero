/**
 * Moving sessions in the list (spec 19.5): "Move up" / "Move down" and dragging. The page sends
 * the rows as it has them (`seen`) and the same ids in their new order; the platform gives the
 * positions those rows hold out again in that order, so a new session still lands on top and
 * sessions beyond the 50 shown keep their place. Dragging starts after a 4px movement; on touch
 * screens only the grip handle drags; Escape puts the rows back.
 */

export const DRAG_THRESHOLD_PX = 4;

export interface Positioned {
  id: string;
  position: number;
}

/** The ids with one moved from `from` to `to` (indexes in the list as shown). */
export function moveIndex<T>(items: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= items.length) return items.slice();
  const target = Math.max(0, Math.min(items.length - 1, to));
  const next = items.slice();
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved as T);
  return next;
}

/** Move up (-1) or down (+1); null when it can't move that way. */
export function moveBy<T extends Positioned>(
  items: readonly T[],
  id: string,
  delta: -1 | 1,
): T[] | null {
  const from = items.findIndex((item) => item.id === id);
  const to = from + delta;
  if (from === -1 || to < 0 || to >= items.length) return null;
  return moveIndex(items, from, to);
}

/** The body of PUT /agent/sessions/order for a list now shown in `next`'s order. */
export function orderRequest(
  seen: readonly Positioned[],
  next: readonly { id: string }[],
): { seen: Positioned[]; order: string[] } {
  return {
    seen: seen.map((item) => ({ id: item.id, position: item.position })),
    order: next.map((item) => item.id),
  };
}

/**
 * What the list looks like right after a move, before the platform answers: the same positions,
 * given out in the new order (highest first), exactly as the platform will.
 */
export function withSwappedPositions<T extends Positioned>(
  seen: readonly T[],
  next: readonly T[],
): T[] {
  const positions = seen.map((item) => item.position).sort((a, b) => b - a);
  return next.map((item, index) => ({ ...item, position: positions[index] ?? item.position }));
}

/** Where a dragged row lands, from the pointer's y and the rows' middles (in list order). */
export function dropIndex(pointerY: number, middles: readonly number[], from: number): number {
  let index = 0;
  for (const middle of middles) {
    if (pointerY > middle) index += 1;
  }
  // The dragged row's own slot doesn't count when it moves down.
  return index > from ? index - 1 : index;
}

/** Whether a pointer moved far enough to start a drag. */
export function passedThreshold(dx: number, dy: number, threshold = DRAG_THRESHOLD_PX): boolean {
  return Math.hypot(dx, dy) >= threshold;
}

/** On touch screens only the grip handle starts a drag; a mouse drags the whole row. */
export function canStartDrag(pointerType: string, onGrip: boolean): boolean {
  return pointerType === "touch" ? onGrip : true;
}
