import type { Page } from "playwright";

/**
 * Helpers for the browser checks of interface motion (spec 21.7): hold every animation at a point
 * of its run to read or draw a frame, let them go on, wait until nothing that ends is running,
 * and find any element drawn with a shadow. Infinite animations (stars, spinners, pulses) are left
 * alone.
 */

/** Holds every finite animation at `fraction` of its own run. Returns how many it holds. */
export function freezeAt(page: Page, fraction: number): Promise<number> {
  return page.evaluate((fraction) => {
    let count = 0;
    for (const animation of document.getAnimations()) {
      const timing = animation.effect?.getComputedTiming();
      if (!timing || timing.iterations === Number.POSITIVE_INFINITY) continue;
      animation.pause();
      animation.currentTime = Number(timing.delay ?? 0) + fraction * Number(timing.duration ?? 0);
      count++;
    }
    return count;
  }, fraction);
}

export function thawAll(page: Page): Promise<void> {
  return page.evaluate(() => {
    for (const animation of document.getAnimations()) {
      if (animation.playState === "paused") animation.play();
    }
  });
}

/** Waits until no finite animation is running. */
export async function settled(page: Page, timeout = 5_000): Promise<void> {
  await page.waitForFunction(
    () =>
      document
        .getAnimations()
        .every(
          (animation) =>
            animation.playState !== "running" ||
            animation.effect?.getComputedTiming().iterations === Number.POSITIVE_INFINITY,
        ),
    undefined,
    { timeout },
  );
}

/** Finite animations still running, by property or name and target. */
export function finiteAnimations(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    document
      .getAnimations()
      .filter(
        (animation) =>
          animation.playState === "running" &&
          animation.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY,
      )
      .map((animation) => {
        const target = (animation.effect as KeyframeEffect | null)?.target as Element | null;
        const name =
          (animation as CSSTransition).transitionProperty ??
          (animation as CSSAnimation).animationName ??
          "script";
        return `${name} on ${target?.className || target?.tagName}`;
      }),
  );
}

/** Elements (and their ::before, ::after and ::backdrop) drawn with a box shadow or drop shadow. */
export function shadowedElements(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const found: string[] = [];
    for (const element of document.querySelectorAll("*")) {
      for (const pseudo of [null, "::before", "::after", "::backdrop"]) {
        const style = getComputedStyle(element, pseudo);
        if (style.boxShadow !== "none" || style.filter.includes("drop-shadow")) {
          const name = typeof element.className === "string" ? element.className : "";
          found.push(`${element.tagName.toLowerCase()}.${name}${pseudo ?? ""}`);
        }
      }
    }
    return found;
  });
}

/**
 * Runs `start` (which sets something moving), then checks the page halfway through: returns the
 * shadows drawn at that moment, and lets the motion finish.
 */
export async function shadowsMidway(page: Page, start: () => Promise<void>): Promise<string[]> {
  await start();
  await freezeAt(page, 0.5);
  const found = await shadowedElements(page);
  await thawAll(page);
  await settled(page);
  return found;
}
