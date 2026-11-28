/**
 * Byte sizes as people read them ("512 B", "12.4 MB", "1.25 GB"), in one place for the control
 * plane, the runner and the console. Browser-safe: no zod, no Node.
 *
 * Sizes use binary steps (1 KB = 1024 B), like the sizes Docker, rclone and file browsers show.
 * Whole bytes have no decimals, KB and MB one, GB and TB two.
 */

export const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;
export type ByteUnit = (typeof BYTE_UNITS)[number];

const STEP = 1024;
const DECIMALS: Record<ByteUnit, number> = { B: 0, KB: 1, MB: 1, GB: 2, TB: 2 };

/** Which unit a size reads in: the largest whose step it reaches, up to `largest`. */
export function byteUnitIndex(bytes: number, largest: ByteUnit = "TB"): number {
  const top = BYTE_UNITS.indexOf(largest);
  if (!(bytes >= STEP)) return 0;
  let index = Math.min(top, Math.floor(Math.log2(bytes) / 10));
  // log2 can land a hair under a whole power of 1024; correct by comparing exactly.
  while (index < top && bytes >= STEP ** (index + 1)) index += 1;
  while (index > 0 && bytes < STEP ** index) index -= 1;
  return index;
}

/**
 * A size in words. Missing, negative or non-finite sizes read "0 B". `largest` caps the unit
 * (upload limits are stated in MB, so an upload never reads in GB). `trimZeros` drops decimals
 * that are all zero ("10 MB", not "10.0 MB"), for limits stated in whole units.
 */
export function formatBytes(
  bytes: number,
  options: { largest?: ByteUnit; trimZeros?: boolean } = {},
): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const index = byteUnitIndex(bytes, options.largest);
  const unit = BYTE_UNITS[index] as ByteUnit;
  if (index === 0) return `${Math.round(bytes)} B`;
  const value = (bytes / STEP ** index).toFixed(DECIMALS[unit]);
  return `${options.trimZeros ? value.replace(/\.0+$/, "") : value} ${unit}`;
}
