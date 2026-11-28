import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  afterTransition,
  holdHeight,
  prefersReducedMotion,
  releaseHeight,
} from "../../lib/motion.ts";

/**
 * Motion for the Agent's island (spec 21.7), with the same CSS durations as the rest of the
 * console (styles/motion.css), so reduced motion makes them instant here too:
 * - `Expand`: a step's details open and close by their height over 180ms;
 * - `useHeightChange`: a folded result ("Show more", "Show less") grows or shrinks to its new
 *   height instead of jumping;
 * - `usePresence`: a menu the island mounts while open stays for its 100ms fade out.
 * A change midway turns back from where it is; nothing runs at rest.
 */

/** Shows `children` while `open`, opening and closing by height (a step's details). */
export function Expand({ open, children }: { open: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [present, setPresent] = useState(open);
  const shownAs = useRef(open);

  useLayoutEffect(() => {
    if (open === shownAs.current) return;
    shownAs.current = open;
    const element = ref.current;
    if (!element) return;
    if (open) {
      setPresent(true);
      // Mid-close it turns back from where it is; just mounted, it grows from nothing.
      if (element.style.height) holdHeight(element);
      else element.style.height = "0px";
      releaseHeight(element);
    } else {
      holdHeight(element);
      releaseHeight(element, 0, () => setPresent(false));
    }
  }, [open]);

  if (!open && !present) return null;
  return (
    <div ref={ref} className="nz-expand">
      {children}
    </div>
  );
}

/**
 * For content that changes height when its owner flips a state (a folded result's "Show more"):
 * `change(() => setState(...))` holds the element at its height, and the next render animates it
 * to the new one.
 */
export function useHeightChange<T extends HTMLElement>(): [
  RefObject<T | null>,
  (apply: () => void) => void,
] {
  const ref = useRef<T>(null);
  const changing = useRef(false);
  useLayoutEffect(() => {
    if (!changing.current) return;
    changing.current = false;
    if (ref.current) releaseHeight(ref.current);
  });
  const change = useCallback((apply: () => void) => {
    if (ref.current && !prefersReducedMotion()) {
      holdHeight(ref.current);
      changing.current = true;
    }
    apply();
  }, []);
  return [ref, change];
}

/**
 * Keeps something mounted for its fade out after `open` turns false (a session's menu, a
 * picker's list): `leaving` is true meanwhile, for data-motion="out". Reopening mid-fade turns it
 * back.
 */
export function usePresence<T extends HTMLElement>(
  open: boolean,
): { ref: RefObject<T | null>; mounted: boolean; leaving: boolean } {
  const ref = useRef<T>(null);
  const [present, setPresent] = useState(open);
  useLayoutEffect(() => {
    if (open) setPresent(true);
  }, [open]);
  useEffect(() => {
    if (open || !present) return;
    const element = ref.current;
    if (!element) {
      setPresent(false);
      return;
    }
    return afterTransition(element, () => setPresent(false));
  }, [open, present]);
  return { ref, mounted: open || present, leaving: !open && present };
}
