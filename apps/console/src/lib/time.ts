/** Relative and full times shown across the console ("Created 3 days ago", full date on hover). */

const UNITS: [limitSeconds: number, seconds: number, name: string][] = [
  [3600, 60, "minute"],
  [86_400, 3600, "hour"],
  [2_592_000, 86_400, "day"],
  [31_536_000, 2_592_000, "month"],
  [Number.POSITIVE_INFINITY, 31_536_000, "year"],
];

/**
 * "3 days ago", "in 7 days". Past spans count whole units gone by; future spans round to the
 * nearest unit, so a 7-day invitation sent a minute ago reads "in 7 days", not "in 6 days"
 * (spec 4.5).
 */
export function relativeTime(date: Date, now: Date = new Date()): string {
  const seconds = Math.round((now.getTime() - date.getTime()) / 1000);
  const future = seconds < 0;
  const span = Math.abs(seconds);
  if (span < 60) return future ? "in a moment" : "just now";
  for (const [limit, size, name] of UNITS) {
    if (span < limit) {
      const count = future ? Math.round(span / size) : Math.floor(span / size);
      // 59.6 minutes ahead rounds to the next unit: "in 1 hour".
      if (count * size >= limit) continue;
      const label = `${count} ${name}${count === 1 ? "" : "s"}`;
      return future ? `in ${label}` : `${label} ago`;
    }
  }
  return "";
}

/**
 * The relative time of something that already happened, like a session's last message: never
 * "in a moment", even when the page's clock lags behind the message (an older tick, or a
 * browser clock a little behind the server's).
 */
export function pastTime(date: Date, now: Date = new Date()): string {
  return relativeTime(date, date.getTime() > now.getTime() ? date : now);
}

/**
 * The compact relative time a session row shows (spec 19.5, C3-05): "just now", "4m", "3h", "2d",
 * "5w", "3mo", "2y". It is short enough to stay whole beside any title, so it is never cut.
 */
export function shortPastTime(date: Date, now: Date = new Date()): string {
  const seconds = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  if (days < 35) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.max(1, Math.floor(days / 30))}mo`;
  return `${Math.floor(days / 365)}y`;
}

export function fullDate(date: Date): string {
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
}

/** The hour in a named time zone, or in the server's own zone when the name is unknown. */
export function hourIn(timeZone: string | undefined, now: Date = new Date()): number {
  if (timeZone) {
    try {
      const formatted = new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        hourCycle: "h23",
        timeZone,
      }).format(now);
      const hour = Number.parseInt(formatted, 10);
      if (Number.isInteger(hour)) return hour % 24;
    } catch {
      // Unknown zone name: fall back to the server's clock.
    }
  }
  return now.getHours();
}

/** A time zone name the browser reported (the `nz_tz` cookie), when the runtime knows it. */
export function knownTimeZone(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch {
    return undefined;
  }
}

function dayKey(date: Date, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  }).format(date);
}

/**
 * Calendar times for tables and service pages (spec 21.10): "Today, 8:23 PM",
 * "Yesterday, 8:23 PM", "Nov 24, 8:23 PM", or with the year when it isn't this year.
 */
export function calendarTime(date: Date, now: Date = new Date(), timeZone?: string): string {
  const clock = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(date);
  const day = dayKey(date, timeZone);
  if (day === dayKey(now, timeZone)) return `Today, ${clock}`;
  if (day === dayKey(new Date(now.getTime() - 86_400_000), timeZone)) return `Yesterday, ${clock}`;
  const sameYear =
    new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone }).format(date) ===
    new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone }).format(now);
  const dayText = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone,
  }).format(date);
  return `${dayText}, ${clock}`;
}

/** A full date and time, as the bell and the Tasks table show it: "11/26/2026, 8:33:41 PM". */
export function dateTime(date: Date, timeZone?: string): string {
  return date.toLocaleString("en-US", { timeZone });
}
