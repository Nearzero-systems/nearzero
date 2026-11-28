import type { TaskRunStatus } from "@nearzero/shared/browser";

/** The status pill's colors (components/ui/StatusPill.astro). */
export type PillStatus = "ok" | "run" | "warn" | "fail" | "idle";

/**
 * Small words and mappings the Tasks, Analytics, monitoring and Channels screens share, on the
 * server and in the browser.
 */

export const RUN_PILLS: Record<TaskRunStatus, PillStatus> = {
  queued: "idle",
  running: "run",
  succeeded: "ok",
  failed: "fail",
  stopped: "warn",
  skipped: "idle",
};

export function statusPill(status: number): PillStatus {
  if (status >= 500) return "fail";
  if (status >= 400) return "warn";
  if (status >= 300) return "idle";
  return "ok";
}

/** "4s", "2m 5s", "1h 3m". */
export function shortDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${total % 60}s`;
  return `${total}s`;
}

/** A local date and time, like "Nov 25, 14:05:09". */
export function localTime(iso: string | number, withSeconds = false): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    ...(withSeconds ? { second: "2-digit" } : {}),
    hourCycle: "h23",
  });
}

/**
 * A custom Analytics range from two picked days, in the browser's own time: from the first day's
 * first moment through the last day's last millisecond, so a request at 23:59:30 on the last day
 * is counted (G3-13). The days may come in either order.
 */
export function customRangeOfDays(from: string, to: string): { from: string; to: string } {
  const [first, last] = from <= to ? [from, to] : [to, from];
  return { from: `${first}T00:00:00.000`, to: `${last}T23:59:59.999` };
}

/** An instant as the browser's wall-clock time to the millisecond, for the range's inputs. */
export function localInputValue(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 23);
}

/**
 * A range input's local time read on the server: `offset` is the browser's
 * getTimezoneOffset() in minutes. Times that name their zone pass unchanged; null when the text
 * isn't a time.
 */
export function utcOfLocalInput(value: string, offset: number): string | null {
  if (/[zZ]|[+-]\d{2}:\d{2}$/.test(value)) return value;
  const parsed = Date.parse(`${value}Z`) + (Number.isFinite(offset) ? offset : 0) * 60_000;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/** Common IANA zones for the time zone field's suggestions. */
export const COMMON_ZONES = [
  "UTC",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Europe/Madrid",
  "Europe/Amsterdam",
  "Europe/Istanbul",
  "Africa/Lagos",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
  "America/Sao_Paulo",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
] as const;
