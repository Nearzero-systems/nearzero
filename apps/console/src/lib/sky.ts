/**
 * The Dusk star field (spec 21.6): 110 stars at fixed positions, so every page and every visit
 * shows the same sky. 84% are 1px, the rest 2px; each twinkles with a start delay of up to 5s.
 */

export interface Star {
  /** Percent of the viewport width. */
  x: number;
  /** Percent of the viewport height. */
  y: number;
  size: 1 | 2;
  /** Seconds before the twinkle starts. */
  delay: number;
}

export const STAR_COUNT = 110;
export const SMALL_STAR_SHARE = 0.84;
const SKY_SEED = 0x2b1d_4f37;

/** A small deterministic generator (32-bit xorshift); returns numbers in [0, 1). */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

export function skyStars(seed: number = SKY_SEED): Star[] {
  const next = seededRandom(seed);
  const smallCount = Math.round(STAR_COUNT * SMALL_STAR_SHARE);
  const stars: Star[] = [];
  for (let index = 0; index < STAR_COUNT; index++) {
    stars.push({
      x: round(next() * 100, 2),
      y: round(next() * 100, 2),
      size: 1,
      delay: round(next() * 5, 2),
    });
  }
  // Pick the bigger stars at random (a partial shuffle) so they spread across the sky.
  const pool = stars.map((_, index) => index);
  for (let picked = 0; picked < STAR_COUNT - smallCount; picked++) {
    const swap = picked + Math.floor(next() * (pool.length - picked));
    const chosen = pool[swap] ?? picked;
    pool[swap] = pool[picked] ?? swap;
    pool[picked] = chosen;
    const star = stars[chosen];
    if (star) star.size = 2;
  }
  return stars;
}
