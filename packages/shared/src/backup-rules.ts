/**
 * The rules and words of backups (spec 08 8.3, 17, 24 G1/G2): destination providers, schedules
 * (presets, 5-field cron in the server's time zone, the schedule in words), folders, file names,
 * the prefixes that say which service a file belongs to, and the messages people see. Pure and
 * browser-safe (no zod), so the console shows the same words the control plane checks with.
 */

// ---- Destinations (spec 17.1)

export const BACKUP_PROVIDERS = [
  "aws",
  "cloudflare-r2",
  "digitalocean",
  "wasabi",
  "scaleway",
  "akamai",
  "minio",
  "other",
] as const;
export type BackupProvider = (typeof BACKUP_PROVIDERS)[number];

export interface ProviderPreset {
  label: string;
  /** The sample endpoint the form fills in when the provider is picked. */
  endpoint: string;
  region: string;
}

export const PROVIDER_PRESETS: Record<BackupProvider, ProviderPreset> = {
  aws: { label: "Amazon S3", endpoint: "https://s3.us-east-1.amazonaws.com", region: "us-east-1" },
  "cloudflare-r2": {
    label: "Cloudflare R2",
    endpoint: "https://<account-id>.r2.cloudflarestorage.com",
    region: "auto",
  },
  digitalocean: {
    label: "DigitalOcean Spaces",
    endpoint: "https://nyc3.digitaloceanspaces.com",
    region: "nyc3",
  },
  wasabi: { label: "Wasabi", endpoint: "https://s3.us-east-1.wasabisys.com", region: "us-east-1" },
  scaleway: { label: "Scaleway", endpoint: "https://s3.fr-par.scw.cloud", region: "fr-par" },
  akamai: {
    label: "Akamai (Linode)",
    endpoint: "https://us-east-1.linodeobjects.com",
    region: "us-east-1",
  },
  minio: { label: "MinIO", endpoint: "https://minio.example.com:9000", region: "us-east-1" },
  other: { label: "Other S3-compatible", endpoint: "https://s3.example.com", region: "auto" },
};

export const DESTINATION_NAME_MAX = 100;
export const BUCKET_MAX = 255;
export const ENDPOINT_MAX = 500;
export const REGION_MAX = 64;
export const ACCESS_KEY_MAX = 256;
export const SECRET_KEY_MAX = 512;

/** Bucket names as S3-compatible stores take them (MinIO and R2 are the strictest). */
const BUCKET = /^[A-Za-z0-9][A-Za-z0-9._-]{1,254}$/;
const REGION = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function bucketProblem(value: string): string | null {
  if (value === "") return "Enter the bucket's name.";
  if (!BUCKET.test(value) || value.includes(".."))
    return "Enter a bucket name: letters, numbers, dots, dashes and underscores.";
  return null;
}

export function regionProblem(value: string): string | null {
  if (value === "") return null;
  return REGION.test(value) ? null : "Enter a region like us-east-1, or auto.";
}

/** An http(s) URL with a host and nothing after it but an optional path. */
export function endpointProblem(value: string): string | null {
  if (value === "") return "Enter the endpoint URL, like https://s3.us-east-1.amazonaws.com.";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Enter the endpoint as a full URL, like https://s3.us-east-1.amazonaws.com.";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    return "The endpoint starts with https:// (or http:// for a store on your own network).";
  if (url.username || url.password) return "Put the keys in their own fields, not in the endpoint.";
  if (url.hostname.includes("<") || url.hostname.includes(">") || url.hostname === "")
    return "Replace the sample part of the endpoint with your own.";
  if (url.search || url.hash) return "Leave the query and # part off the endpoint.";
  return null;
}

export const DESTINATION_MESSAGES = {
  keysHint: "Use a key that can only reach this bucket. Nearzero never shows the keys again.",
  keysSaved: "Saved, leave blank to keep",
  regionHint: "Or auto",
  added: "Destination added",
  saved: "Destination saved",
  deleteText:
    "Backup schedules that write to it are removed too. Files already in the bucket stay there.",
  testFailed: "Could not reach the bucket. Check the endpoint, bucket, region and keys.",
  noServer:
    "Nearzero tests a destination from one of your servers, and none is connected. Add a server, or connect its runner, then test again.",
  keysUnreadable:
    "This destination's keys can't be read any more (the install's secret changed). Edit it and paste the keys again.",
} as const;

export function destinationTestOk(bucket: string): string {
  return `Connected. Nearzero can list ${bucket}.`;
}

/**
 * A Test from the Nearzero host, for a workspace with no server of its own, reaches only stores
 * on the public internet (R3-49).
 */
export function destinationNotPublicMessage(host: string): string {
  return `Nearzero tests this destination from the Nearzero host, which only reaches stores on the public internet, and ${host} isn't one. Test it from one of your servers instead.`;
}

export function duplicateDestinationMessage(name: string): string {
  return `A destination named "${name}" already exists in this workspace. Pick another name.`;
}

export function destinationDeletedMessage(schedules: number): string {
  if (schedules === 0) return "Destination deleted. Files already in the bucket stay there.";
  return `Destination deleted with the ${schedules === 1 ? "backup schedule" : `${schedules} backup schedules`} that wrote to it. Files already in the bucket stay there.`;
}

// ---- Schedules (spec 08 8.3, 17.3)

export const SCHEDULE_PRESETS = [
  { key: "hourly", cron: "0 * * * *", label: "Every hour" },
  { key: "daily", cron: "0 3 * * *", label: "Every day at 03:00" },
  { key: "weekly", cron: "0 3 * * 0", label: "Every Sunday at 03:00" },
  { key: "monthly", cron: "0 3 1 * *", label: "On the 1st of each month at 03:00" },
] as const;

export const KEEP_MAX = 1000;
export const FOLDER_MAX = 200;

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_WORDS = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];
const DAY_WORDS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

export interface CronSchedule {
  /** The expression as written, single-spaced. */
  expression: string;
  minutes: number[];
  hours: number[];
  days: number[];
  months: number[];
  /** 0 is Sunday (7 is accepted and read as 0). */
  weekdays: number[];
  dayRestricted: boolean;
  weekdayRestricted: boolean;
  /** "L" in the day of month: the month's last day (G3-14). */
  lastDayOfMonth?: boolean;
  /** "1#1" in the day of week: the nth such weekday of the month, 1 to 5 (G3-14). */
  nthWeekdays?: { weekday: number; nth: number }[];
  /** "5L" in the day of week: the month's last such weekday (G3-14). */
  lastWeekdays?: number[];
}

export type CronResult = { ok: true; cron: CronSchedule } | { ok: false; message: string };

export const CRON_HINT =
  "Five fields: minute, hour, day of month, month, day of week. For example 30 2 * * 1-5.";

function fieldValues(
  text: string,
  min: number,
  max: number,
  names: string[] | null,
  label: string,
): number[] | string {
  const values = new Set<number>();
  const read = (part: string): number | null => {
    const upper = part.toUpperCase();
    if (names) {
      const index = names.indexOf(upper);
      if (index >= 0) return index + (label === "month" ? 1 : 0);
    }
    if (!/^\d{1,2}$/.test(part)) return null;
    return Number(part);
  };
  for (const item of text.split(",")) {
    if (item === "") return `The ${label} field has an empty part.`;
    const [range = "", stepText, extra] = item.split("/");
    if (extra !== undefined) return `The ${label} field has more than one "/".`;
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d{1,2}$/.test(stepText) || Number(stepText) === 0)
        return `The step after "/" in the ${label} field must be a number from 1.`;
      step = Number(stepText);
    }
    let from: number;
    let to: number;
    if (range === "*") {
      from = min;
      to = max;
    } else {
      const [startText = "", endText, more] = range.split("-");
      if (more !== undefined) return `The ${label} field has a range with more than one "-".`;
      const start = read(startText);
      if (start === null) return `"${startText}" isn't a valid ${label}.`;
      from = start;
      to = start;
      if (endText !== undefined) {
        const end = read(endText);
        if (end === null) return `"${endText}" isn't a valid ${label}.`;
        to = end;
      } else if (stepText !== undefined) {
        to = max;
      }
    }
    if (from < min || to > max || from > to)
      return `The ${label} field takes values from ${min} to ${max}.`;
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return [...values].sort((a, b) => a - b);
}

/**
 * The day fields' extensions 0.1.x ran (G3-14, spec 12.2): "?" means any day, "L" in the day of
 * month is its last day, "n#k" in the day of week is the k-th weekday n of the month (k from 1
 * to 5), and "nL" the month's last weekday n. They may share a list with plain values ("1,15,L").
 */
interface DayExtras {
  /** The parts left for the plain reader, or "*" when the field is "?". */
  plain: string | null;
  last: boolean;
  nth: { weekday: number; nth: number }[];
  lastWeekdays: number[];
}

function weekdayNumber(text: string): number | null {
  const index = DAY_WORDS.indexOf(text.toUpperCase());
  if (index >= 0) return index;
  if (!/^\d$/.test(text) || Number(text) > 7) return null;
  return Number(text) % 7;
}

function dayExtras(text: string, label: "day of month" | "day of week"): DayExtras | string {
  if (text === "?") return { plain: "*", last: false, nth: [], lastWeekdays: [] };
  const extras: DayExtras = { plain: null, last: false, nth: [], lastWeekdays: [] };
  const plain: string[] = [];
  for (const item of text.split(",")) {
    if (label === "day of month") {
      if (item.toUpperCase() === "L") extras.last = true;
      else plain.push(item);
      continue;
    }
    const nth = /^([^#]+)#(.*)$/.exec(item);
    if (nth) {
      const weekday = weekdayNumber(nth[1] as string);
      if (weekday === null) return `"${item}" isn't a valid day of week.`;
      if (!/^[1-5]$/.test(nth[2] as string))
        return `In "${item}", the number after "#" must be from 1 to 5 (1#1 is the first Monday).`;
      extras.nth.push({ weekday, nth: Number(nth[2]) });
      continue;
    }
    const last = /^(.+)L$/i.exec(item);
    if (last && weekdayNumber(last[1] as string) !== null) {
      extras.lastWeekdays.push(weekdayNumber(last[1] as string) as number);
      continue;
    }
    if (item.toUpperCase() === "L")
      return 'A day of week of "L" needs the weekday before it, like 5L for the last Friday.';
    plain.push(item);
  }
  extras.plain = plain.length > 0 ? plain.join(",") : null;
  return extras;
}

/**
 * Reads a 5-field cron expression (minute hour day-of-month month day-of-week), with the day
 * fields' "?", "L", "nL" and "#" extensions (dayExtras).
 */
export function parseCron(input: string): CronResult {
  const expression = input.trim().replace(/\s+/g, " ");
  const fields = expression.split(" ");
  if (expression === "" || fields.length !== 5) {
    return {
      ok: false,
      message:
        "Enter a cron schedule with five fields: minute, hour, day of month, month, day of week. For example 30 2 * * 1-5.",
    };
  }
  const [minuteText, hourText, dayText, monthText, weekdayText] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  const minutes = fieldValues(minuteText, 0, 59, null, "minute");
  if (typeof minutes === "string") return { ok: false, message: minutes };
  const hours = fieldValues(hourText, 0, 23, null, "hour");
  if (typeof hours === "string") return { ok: false, message: hours };
  const dayParts = dayExtras(dayText, "day of month");
  if (typeof dayParts === "string") return { ok: false, message: dayParts };
  const days =
    dayParts.plain === null ? [] : fieldValues(dayParts.plain, 1, 31, null, "day of month");
  if (typeof days === "string") return { ok: false, message: days };
  const months = fieldValues(monthText, 1, 12, MONTH_WORDS, "month");
  if (typeof months === "string") return { ok: false, message: months };
  const weekdayParts = dayExtras(weekdayText, "day of week");
  if (typeof weekdayParts === "string") return { ok: false, message: weekdayParts };
  const weekdaysRaw =
    weekdayParts.plain === null
      ? []
      : fieldValues(weekdayParts.plain, 0, 7, DAY_WORDS, "day of week");
  if (typeof weekdaysRaw === "string") return { ok: false, message: weekdaysRaw };
  const weekdays = [...new Set(weekdaysRaw.map((day) => (day === 7 ? 0 : day)))].sort(
    (a, b) => a - b,
  );
  const any = (text: string) => text === "*" || text === "?" || text.startsWith("*/");
  return {
    ok: true,
    cron: {
      expression,
      minutes,
      hours,
      days,
      months,
      weekdays,
      dayRestricted: !any(dayText),
      weekdayRestricted: !any(weekdayText),
      ...(dayParts.last ? { lastDayOfMonth: true } : {}),
      ...(weekdayParts.nth.length > 0 ? { nthWeekdays: weekdayParts.nth } : {}),
      ...(weekdayParts.lastWeekdays.length > 0
        ? { lastWeekdays: [...new Set(weekdayParts.lastWeekdays)].sort((a, b) => a - b) }
        : {}),
    },
  };
}

/** Whether a date matches the schedule's day of month and day of week, as cron reads them. */
function dayMatches(cron: CronSchedule, year: number, month: number, day: number): boolean {
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const monthLength = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const dayMatch = cron.days.includes(day) || (cron.lastDayOfMonth === true && day === monthLength);
  const weekdayMatch =
    cron.weekdays.includes(weekday) ||
    (cron.nthWeekdays ?? []).some(
      (item) => item.weekday === weekday && Math.ceil(day / 7) === item.nth,
    ) ||
    ((cron.lastWeekdays ?? []).includes(weekday) && day + 7 > monthLength);
  // Both restricted: either one matching is enough, as in every cron.
  if (cron.dayRestricted && cron.weekdayRestricted) return dayMatch || weekdayMatch;
  if (cron.dayRestricted) return dayMatch;
  if (cron.weekdayRestricted) return weekdayMatch;
  return true;
}

function two(value: number): string {
  return String(value).padStart(2, "0");
}

export function ordinal(day: number): string {
  const tens = day % 100;
  if (tens >= 11 && tens <= 13) return `${day}th`;
  const suffix = day % 10 === 1 ? "st" : day % 10 === 2 ? "nd" : day % 10 === 3 ? "rd" : "th";
  return `${day}${suffix}`;
}

const NTH_WORDS = ["", "first", "second", "third", "fourth", "fifth"];

/**
 * The day part of a schedule that uses the "L", "nL" or "#" extensions, in words ("the last day",
 * "the first Monday", "the last Friday"), or null for any other shape (G3-14).
 */
export function extendedDayWords(day: string, weekday: string): string | null {
  const anyDay = day === "*" || day === "?";
  const anyWeekday = weekday === "*" || weekday === "?";
  if (day.toUpperCase() === "L" && anyWeekday) return "the last day";
  if (!anyDay) return null;
  const nth = /^([0-7]|[A-Za-z]{3})#([1-5])$/.exec(weekday);
  if (nth) {
    const index = weekdayNumber(nth[1] as string);
    if (index !== null) return `the ${NTH_WORDS[Number(nth[2])]} ${DAY_NAMES[index]}`;
  }
  const last = /^([0-7]|[A-Za-z]{3})L$/i.exec(weekday);
  if (last) {
    const index = weekdayNumber(last[1] as string);
    if (index !== null) return `the last ${DAY_NAMES[index]}`;
  }
  return null;
}

/** The schedule in words (spec 08 8.3): "Every hour", "Every day at 03:00", … or "Cron …". */
export function describeSchedule(expression: string): string {
  const parsed = parseCron(expression);
  if (!parsed.ok) return `Cron ${expression.trim()}`;
  const [minute, hour, typedDay, month, typedWeekday] = parsed.cron.expression.split(" ") as [
    string,
    string,
    string,
    string,
    string,
  ];
  // "?" is any day, the same as "*".
  const day = typedDay === "?" ? "*" : typedDay;
  const weekday = typedWeekday === "?" ? "*" : typedWeekday;
  const single = (text: string) => /^\d{1,2}$/.test(text);
  if (minute === "0" && hour === "*" && day === "*" && month === "*" && weekday === "*")
    return "Every hour";
  if (single(minute) && single(hour) && month === "*") {
    const at = `${two(Number(hour))}:${two(Number(minute))}`;
    const extended = extendedDayWords(day, weekday);
    if (extended) return `On ${extended} of each month at ${at}`;
    if (day === "*" && weekday === "*") return `Every day at ${at}`;
    if (day === "*" && (single(weekday) || DAY_WORDS.includes(weekday.toUpperCase()))) {
      const index = parsed.cron.weekdays[0] ?? 0;
      return `Every ${DAY_NAMES[index]} at ${at}`;
    }
    if (single(day) && weekday === "*")
      return `On the ${ordinal(Number(day))} of each month at ${at}`;
  }
  return `Cron ${parsed.cron.expression}`;
}

// ---- Time zones: an IANA name, "UTC", or a fixed offset like "UTC+05:30"

const OFFSET_ZONE = /^UTC([+-])(\d{2}):(\d{2})$/;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let found = formatters.get(zone);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    formatters.set(zone, found);
  }
  return found;
}

export function isTimeZone(zone: string): boolean {
  if (zone === "UTC" || OFFSET_ZONE.test(zone)) return true;
  try {
    formatter(zone);
    return true;
  } catch {
    return false;
  }
}

/** The zone to use: the given one when it is valid, else UTC. */
export function usableTimeZone(zone: string | null | undefined): string {
  return zone && isTimeZone(zone) ? zone : "UTC";
}

export interface LocalTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

function fixedOffsetMinutes(zone: string): number | null {
  if (zone === "UTC") return 0;
  const match = OFFSET_ZONE.exec(zone);
  if (!match) return null;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

/** The wall-clock time in a zone at an instant. */
export function localTime(instantMs: number, zone: string): LocalTime {
  const fixed = fixedOffsetMinutes(zone);
  if (fixed !== null) {
    const shifted = new Date(instantMs + fixed * 60_000);
    return {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: shifted.getUTCHours(),
      minute: shifted.getUTCMinutes(),
      weekday: shifted.getUTCDay(),
    };
  }
  const parts: Record<string, string> = {};
  for (const part of formatter(zone).formatToParts(new Date(instantMs))) {
    parts[part.type] = part.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: DAY_WORDS.indexOf((parts.weekday ?? "Sun").slice(0, 3).toUpperCase()),
  };
}

function wallAsUtc(time: Omit<LocalTime, "weekday">): number {
  return Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute);
}

/**
 * The instant a wall-clock time happens in a zone. A time that happens twice (clocks going
 * back) is the first; one that never happens (clocks going forward) is the moment after the gap.
 */
export function zonedInstant(time: Omit<LocalTime, "weekday">, zone: string): number {
  const wall = wallAsUtc(time);
  const offsetAt = (instant: number) => wallAsUtc(localTime(instant, zone)) - instant;
  const first = wall - offsetAt(wall);
  const second = wall - offsetAt(first);
  const candidates = [first, second].filter(
    (instant) => wallAsUtc(localTime(instant, zone)) === wall,
  );
  if (candidates.length > 0) return Math.min(...candidates);
  return Math.max(first, second);
}

/** The first time after `afterMs` the schedule fires, in the zone's wall-clock time, or null. */
export function nextRunAfter(cron: CronSchedule, afterMs: number, zone: string): number | null {
  const start = Math.floor(afterMs / 60_000) * 60_000 + 60_000;
  const now = localTime(start, zone);
  for (let offset = 0; offset < 366 * 5; offset++) {
    const date = new Date(Date.UTC(now.year, now.month - 1, now.day + offset));
    const month = date.getUTCMonth() + 1;
    if (!cron.months.includes(month)) continue;
    const day = date.getUTCDate();
    if (!dayMatches(cron, date.getUTCFullYear(), month, day)) continue;
    for (const hour of cron.hours) {
      if (offset === 0 && hour < now.hour) continue;
      for (const minute of cron.minutes) {
        if (offset === 0 && hour === now.hour && minute < now.minute) continue;
        const instant = zonedInstant(
          { year: date.getUTCFullYear(), month, day, hour, minute },
          zone,
        );
        if (instant >= start) return instant;
      }
    }
  }
  return null;
}

export function timeZoneHint(zone: string): string {
  return `Times are in the server's time zone (${zone}).`;
}

// ---- Folders, files and prefixes (spec 08 8.3, 17.3, 24 G1/G2)

const FOLDER_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const INNER_SERVICE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;

/** A folder as typed, without slashes at either end, or what is wrong with it. */
export function normalizeFolder(value: string): { folder: string } | { problem: string } {
  const folder = value.trim().replace(/^\/+|\/+$/g, "");
  if (folder === "") return { problem: "Enter a folder, like nightly." };
  if (folder.length > FOLDER_MAX) return { problem: `Use at most ${FOLDER_MAX} characters.` };
  const segments = folder.split("/");
  if (segments.length > 5) return { problem: "Use at most 5 levels of folders." };
  for (const segment of segments) {
    if (!FOLDER_SEGMENT.test(segment) || segment === "." || segment === "..") {
      return {
        problem: "Use letters, numbers, dots, dashes and underscores, with / between folders.",
      };
    }
  }
  return { folder };
}

export function isInnerServiceName(value: string): boolean {
  return INNER_SERVICE.test(value);
}

/**
 * Where a schedule writes: `<app name>[_<inner service>]/<folder>/`. App names never contain an
 * underscore, so a prefix names exactly one service. A schedule moved from 0.1.x may have no
 * folder, and writes straight under `<app name>/` (R2-06).
 */
export function backupPrefix(
  appName: string,
  folder: string,
  innerService?: string | null,
): string {
  const top = `${appName}${innerService ? `_${innerService}` : ""}`;
  return folder === "" ? `${top}/` : `${top}/${folder}/`;
}

export type BackupFileKind = "postgres" | "mysql" | "mariadb" | "mongodb" | "libsql" | "volume";

/**
 * A file's extension: a gzipped dump (`.sql.gz`), a MongoDB archive (`.archive.gz`), or a gzipped
 * tar archive (`.tar.gz`: volumes, and libSQL with namespaces, whose data folder is archived).
 */
export function backupExtension(kind: BackupFileKind, archive = false): string {
  if (kind === "volume" || (kind === "libsql" && archive)) return ".tar.gz";
  if (kind === "mongodb") return ".archive.gz";
  return ".sql.gz";
}

const VOLUME_IN_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;

/**
 * A run's file name: its start time in UTC, like 2026-11-25T03-00-00.sql.gz. A volume backup's
 * name starts with its volume, like data-2026-11-25T03-00-00.tar.gz, so the schedules of two
 * volumes can share a folder without their files meeting (31c G3-20).
 */
export function backupFileName(
  at: Date,
  kind: BackupFileKind,
  archive = false,
  volume?: string | null,
): string {
  const stamp = at.toISOString().slice(0, 19).replaceAll(":", "-");
  const named = kind === "volume" && volume && VOLUME_IN_NAME.test(volume) ? `${volume}-` : "";
  return `${named}${stamp}${backupExtension(kind, archive)}`;
}

const STAMP = "\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}";
const FILE_NAME = new RegExp(`^(${STAMP})(\\.sql\\.gz|\\.archive\\.gz|\\.tar\\.gz)$`);
/** 1.0's volume backups named after their volume (G3-20). */
const VOLUME_FILE_NAME = new RegExp(`^([A-Za-z0-9][A-Za-z0-9_.-]*?)-(${STAMP})\\.tar\\.gz$`);
/**
 * The names 0.1.x wrote (R2-06, R3-44): the start time with milliseconds and a Z, `.sql.gz` for
 * Postgres, MySQL, MariaDB and libSQL, `.bson.gz` for MongoDB, and `<volume>-<time>.tar` (not
 * compressed) for volumes.
 */
const LEGACY_DUMP = new RegExp(`^(${STAMP})-(\\d{3})Z(\\.sql\\.gz|\\.bson\\.gz)$`);
const LEGACY_VOLUME = new RegExp(`^([A-Za-z0-9][A-Za-z0-9_.-]*?)-(${STAMP})-(\\d{3})Z\\.tar$`);

function extensionsOf(kind: BackupFileKind): { current: string[]; legacy: string[] } {
  switch (kind) {
    case "volume":
      return { current: [".tar.gz"], legacy: [".tar"] };
    case "mongodb":
      return { current: [".archive.gz"], legacy: [".bson.gz"] };
    case "libsql":
      return { current: [".sql.gz", ".tar.gz"], legacy: [".sql.gz"] };
    default:
      return { current: [".sql.gz"], legacy: [".sql.gz"] };
  }
}

interface NameParts {
  /** When the run started, sortable: YYYY-MM-DDTHH-MM-SS-mmm. */
  time: string;
  extension: string;
  legacy: boolean;
  /** The volume a volume backup's name starts with (0.1.x's always do, 1.0's since G3-20). */
  volume: string | null;
}

function nameParts(name: string): NameParts | null {
  const current = FILE_NAME.exec(name);
  if (current) {
    return {
      time: `${current[1]}-000`,
      extension: current[2] as string,
      legacy: false,
      volume: null,
    };
  }
  const named = VOLUME_FILE_NAME.exec(name);
  if (named) {
    return {
      time: `${named[2]}-000`,
      extension: ".tar.gz",
      legacy: false,
      volume: named[1] as string,
    };
  }
  const dump = LEGACY_DUMP.exec(name);
  if (dump) {
    return {
      time: `${dump[1]}-${dump[2]}`,
      extension: dump[3] as string,
      legacy: true,
      volume: null,
    };
  }
  const volume = LEGACY_VOLUME.exec(name);
  if (volume) {
    return {
      time: `${volume[2]}-${volume[3]}`,
      extension: ".tar",
      legacy: true,
      volume: volume[1] as string,
    };
  }
  return null;
}

/**
 * Whether a file name is one Nearzero wrote, 1.0 or 0.1.x (only those are listed, restored and
 * ever pruned), of this kind when one is given.
 */
export function isBackupFileName(name: string, kind?: BackupFileKind): boolean {
  const parts = nameParts(name);
  if (!parts) return false;
  if (kind === undefined) return true;
  if (parts.volume !== null && kind !== "volume") return false;
  const allowed = extensionsOf(kind);
  return (parts.legacy ? allowed.legacy : allowed.current).includes(parts.extension);
}

/** Whether a file name is one 0.1.x wrote. */
export function isLegacyBackupFileName(name: string): boolean {
  return nameParts(name)?.legacy === true;
}

/** The volume a volume backup's file name starts with, when it names one. */
export function backupFileVolume(name: string): string | null {
  return nameParts(name)?.volume ?? null;
}

/**
 * Whether a 0.1.x file in a moved schedule's folder is that schedule's (R3-44, C1-12): any dump
 * for a database schedule, and for a volume schedule only archives of its own volume, so two
 * volumes' schedules sharing a folder never prune each other's files.
 */
export function isLegacyFileOf(name: string, volume: string | null): boolean {
  const parts = nameParts(name);
  if (!parts?.legacy) return false;
  return volume === null || parts.volume === volume;
}

/** When a backup file's run started, as text that sorts in time order (null: not a backup). */
export function backupFileTime(name: string): string | null {
  return nameParts(name)?.time ?? null;
}

/** Newest first, by the time in their names (1.0's and 0.1.x's names sort together). */
export function newestFirst(a: string, b: string): number {
  const left = backupFileTime(a) ?? "";
  const right = backupFileTime(b) ?? "";
  return left === right ? b.localeCompare(a) : right.localeCompare(left);
}

/** A file key that is safe to hand to the store: relative, no empty or dot segments. */
export function isSafeKey(key: string): boolean {
  if (key.length === 0 || key.length > 1024 || key.startsWith("/") || key.endsWith("/"))
    return false;
  return key
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== ".." && !/[\0\r\n\\]/.test(part));
}

/**
 * Whether a file belongs to one service's backups (G2): its first folder is the service's app
 * name, or the app name and "_" and an inner Compose service, and it is a file Nearzero wrote
 * (1.0's or 0.1.x's).
 */
export function fileBelongsToService(key: string, appName: string): boolean {
  if (!isSafeKey(key)) return false;
  const [first = "", ...rest] = key.split("/");
  // A file straight under the app name is one a folderless 0.1.x schedule wrote.
  if (rest.length < 1) return false;
  if (first !== appName) {
    if (!first.startsWith(`${appName}_`)) return false;
    if (!isInnerServiceName(first.slice(appName.length + 1))) return false;
  }
  return isBackupFileName(rest[rest.length - 1] as string);
}

// ---- Runs (spec 08 8.3, 17.2)

export const BACKUP_RUN_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type BackupRunStatus = (typeof BACKUP_RUN_STATUSES)[number];

export const BACKUP_RUN_LABELS: Record<BackupRunStatus, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const RESTORE_RUN_LABELS: Record<BackupRunStatus, string> = {
  queued: "Queued",
  running: "Restoring",
  succeeded: "Restored",
  failed: "Restore failed",
  cancelled: "Cancelled",
};

export function keepWords(keep: number | null): string {
  if (keep === null) return "Keeps all";
  return `Keeps last ${keep}`;
}

export const BACKUP_MESSAGES = {
  noDestination: "Add a destination first",
  askAdmin: "Ask an owner or admin to add a backup destination.",
  cantUseDestinations:
    'Backing up needs the "Back up to the workspace\'s destinations" permission. Ask an owner or admin.',
  notRunYet: "Not run yet",
  runStarted: "Backup started. The row shows its result when it finishes.",
  runQueued: "Backup queued. It starts when the running one ends.",
  runReplaced: "A backup was already waiting; this one takes its place.",
  scheduleAdded: "Backup schedule added",
  scheduleSaved: "Backup schedule saved",
  scheduleDeleted: "Backup schedule deleted. Backups already in the bucket stay.",
  deleteScheduleText: "Backups already in the bucket stay.",
  restoreDatabaseWarning: "The restore overwrites the data in this database. It can't be undone.",
  restoreVolumeWarning: "This overwrites the volume. It can't be undone.",
  libsqlRestoreLimit:
    "A libSQL SQL dump restores up to 512 MB of SQL. Backups of a libSQL with namespaces are archives of its data folder and restore at any size.",
  restoreStarted: "Restore started. Follow it in the log.",
  otherService: "This backup belongs to another service.",
  wrongFileKind: "That file isn't a backup of this kind. Pick one from the list.",
  restoreRunning: "A restore of this service is already running. Wait for it to finish.",
  noFiles: "No backups in this folder yet.",
  keepProblem: "Keep at least 1, or leave it blank to keep all.",
  folderTaken:
    "Another backup schedule of this service already writes to this folder on this destination. Pick another folder.",
  volumeFolderTaken:
    "Another backup schedule of this service already backs up this volume to this folder on this destination. Pick another folder, or change that schedule.",
  notRunning: "The database isn't running. Deploy or start it, then try again.",
  uploadedNothing: "The backup produced an empty file, so nothing was uploaded. The run failed.",
  noVolumes: "No named volumes found. Add a volume mount on the Advanced tab to back it up.",
  noComposeVolumes:
    "No named volumes found. Declare a named volume in the Compose file and deploy it to back it up.",
  notMounted:
    "This service doesn't mount that volume, so it can't back it up. Pick one of the volumes listed.",
  sharedVolume: "Another service also uses this volume, so Nearzero won't overwrite it.",
  sharedVolumeBackup: "Another service also uses this volume, so Nearzero won't back it up.",
  reservedVolume: "This volume is Nearzero's own, so no service can back it up or restore over it.",
  foreignVolume:
    "This volume belongs to another service, so this service can't back it up or restore over it.",
  externalVolume:
    "The Compose file declares this volume external: it exists outside the stack, so the stack can't back it up or restore over it.",
  foreignNamedVolume:
    "The Compose file gives this volume a name outside the stack's own, so the stack can't back it up or restore over it.",
  composeCantStop:
    "Nearzero can't tell which service in the Compose file uses this volume, so it can't stop it while copying.",
} as const;

/** MySQL's and MariaDB's own databases, which a restore must never replace. */
export const MYSQL_SYSTEM_DATABASES = ["mysql", "sys", "performance_schema", "information_schema"];

export function systemDatabaseMessage(name: string): string {
  return `${name} is the server's own system database, which Nearzero can't back up and restore safely. Enter the database your app uses.`;
}

/** The restore's warning, naming the database it overwrites (R3-45). */
export function restoreIntoWarning(database: string): string {
  return `The restore overwrites the data in ${database}. It can't be undone.`;
}

export function confirmServiceNameMessage(name: string): string {
  return `Type the service name, ${name}, to confirm.`;
}
