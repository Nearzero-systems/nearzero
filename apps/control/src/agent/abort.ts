/**
 * Waiting with the person's Stop in mind (spec 19.6): Stop ends a wait at once, while whatever
 * was already started (a deploy, a setup) keeps going by itself. Every wait in the Agent goes
 * through these two helpers, so there is one way a signal ends a wait.
 */

/** One "stopped" promise per wait; `release` forgets it again when the wait ends first. */
function stopped(signal: AbortSignal): { promise: Promise<void>; release: () => void } {
  if (signal.aborted) return { promise: Promise.resolve(), release: () => {} };
  let fire = () => {};
  const promise = new Promise<void>((resolve) => {
    fire = resolve;
  });
  const onSignal = () => fire();
  signal.addEventListener("abort", onSignal);
  return { promise, release: () => signal.removeEventListener("abort", onSignal) };
}

export type Raced<T> = { stopped: true } | { stopped: false; value: T };

/**
 * The work's value, or `stopped` as soon as the signal fires. Work that is left behind keeps
 * running; its late failure is swallowed so it never surfaces as an unhandled rejection.
 */
export async function raceStop<T>(work: Promise<T>, signal: AbortSignal): Promise<Raced<T>> {
  const stop = stopped(signal);
  const left = (): Raced<T> => {
    work.catch(() => {});
    return { stopped: true };
  };
  if (signal.aborted) return left();
  try {
    const value = await Promise.race([work, stop.promise.then(() => STOP)]);
    return value === STOP ? left() : { stopped: false, value: value as T };
  } catch (error) {
    if (signal.aborted) return left();
    throw error;
  } finally {
    stop.release();
  }
}

const STOP: unique symbol = Symbol("stop");

/** Waits `ms`; true when the time passed, false when the signal fired first. */
export async function pause(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  const stop = stopped(signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), ms);
      }),
      stop.promise.then(() => false),
    ]);
  } finally {
    clearTimeout(timer);
    stop.release();
  }
}

/** Forwards the signal to another controller until `release` is called. */
export function forwardStop(
  signal: AbortSignal,
  controller: AbortController,
): { release: () => void } {
  const stop = stopped(signal);
  void stop.promise.then(() => controller.abort());
  return { release: stop.release };
}
