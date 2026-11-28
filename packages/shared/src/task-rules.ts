import {
  describeSchedule,
  extendedDayWords,
  isTimeZone,
  nextRunAfter,
  ordinal,
  parseCron,
} from "./backup-rules.ts";

/**
 * The rules and words of tasks (spec 12, 20.12): where a task runs, its schedule presets, the
 * checks a script gets before it is saved, the schedule in words and the messages people see.
 * Pure and browser-safe (no zod), so the console, the Agent and the control plane share them.
 */

// ---- Places and shells (spec 12.2)

export const TASK_PLACES = ["container", "server", "host"] as const;
export type TaskPlace = (typeof TASK_PLACES)[number];

export const TASK_PLACE_LABELS: Record<TaskPlace, string> = {
  container: "Service",
  server: "Server",
  host: "Nearzero host",
};

export const TASK_SHELLS = ["bash", "sh"] as const;
export type TaskShell = (typeof TASK_SHELLS)[number];

export const TASK_NAME_MAX = 100;
export const TASK_DESCRIPTION_MAX = 500;
/** Scripts are at most 64 KB once Windows line endings are converted. */
export const TASK_SCRIPT_MAX_BYTES = 64 * 1024;
/** Each task keeps its newest runs (spec 12.3). */
export const TASK_RUNS_KEPT = 100;
/** A run's log as shown: its last lines (spec 12.3). */
export const TASK_LOG_LINES = 1_000;
/** What the Agent sees of a script when it reviews a task (spec 20.12). */
export const TASK_REVIEW_SCRIPT_CHARS = 6_000;
/** And of its runs. */
export const TASK_REVIEW_RUNS = 10;

export const TASK_PAGE_SIZES = [10, 25, 50, 100] as const;

// ---- Schedules (spec 12.2)

export const TASK_SCHEDULE_PRESETS = [
  { key: "minute", cron: "* * * * *", label: "Every minute" },
  { key: "quarter", cron: "*/15 * * * *", label: "Every 15 minutes" },
  { key: "hourly", cron: "0 * * * *", label: "Every hour" },
  { key: "daily", cron: "0 0 * * *", label: "Every day at midnight" },
  { key: "weekdays", cron: "0 0 * * 1-5", label: "Every weekday at midnight" },
  { key: "sundays", cron: "0 0 * * 0", label: "Every Sunday at midnight" },
  { key: "monthly", cron: "0 0 1 * *", label: "Every month on the 1st at midnight" },
] as const;

export const DEFAULT_TASK_ZONE = "UTC";

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function two(value: number): string {
  return String(value).padStart(2, "0");
}

/** The schedule in words: a preset's label, a few common shapes, or "Cron <expression>". */
export function describeTaskSchedule(expression: string): string {
  const normalized = expression.trim().replace(/\s+/g, " ");
  const preset = TASK_SCHEDULE_PRESETS.find((item) => item.cron === normalized);
  if (preset) return preset.label;
  const parsed = parseCron(normalized);
  if (!parsed.ok) return `Cron ${normalized}`;
  const [minute, hour, typedDay, month, typedWeekday] = parsed.cron.expression.split(" ") as [
    string,
    string,
    string,
    string,
    string,
  ];
  // "?" is any day, the same as "*" (G3-14).
  const day = typedDay === "?" ? "*" : typedDay;
  const weekday = typedWeekday === "?" ? "*" : typedWeekday;
  const rest = [day, month, weekday].every((field) => field === "*");
  const step = /^\*\/(\d{1,2})$/;
  if (rest && hour === "*" && step.test(minute)) {
    const every = Number(step.exec(minute)?.[1]);
    return every === 1 ? "Every minute" : `Every ${every} minutes`;
  }
  if (rest && /^\d{1,2}$/.test(minute) && step.test(hour)) {
    const every = Number(step.exec(hour)?.[1]);
    return every === 1
      ? `Every hour at minute ${minute}`
      : `Every ${every} hours at minute ${minute}`;
  }
  if (rest && /^\d{1,2}$/.test(minute) && hour === "*") return `Every hour at minute ${minute}`;
  if (/^\d{1,2}$/.test(minute) && /^\d{1,2}$/.test(hour) && month === "*") {
    const at = `${two(Number(hour))}:${two(Number(minute))}`;
    const extended = extendedDayWords(day, weekday);
    if (extended) return `Every month on ${extended} at ${at}`;
    if (day === "*" && weekday === "1-5") return `Every weekday at ${at}`;
    if (day === "*" && /^\d$/.test(weekday)) {
      return `Every ${WEEKDAY_NAMES[Number(weekday) % 7]} at ${at}`;
    }
    if (/^\d{1,2}$/.test(day) && weekday === "*") {
      return `Every month on the ${ordinal(Number(day))} at ${at}`;
    }
  }
  return describeSchedule(normalized);
}

/** An IANA time zone name, or UTC (fixed offsets like UTC+05:30 are not names). */
export function isIanaTimeZone(zone: string): boolean {
  if (zone === "UTC") return true;
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/.test(zone)) return false;
  return isTimeZone(zone);
}

export function timeZoneProblem(zone: string): string | null {
  if (zone === "") return null;
  if (isIanaTimeZone(zone)) return null;
  return `"${zone}" isn't a time zone. Use a name like Europe/Berlin, Asia/Kolkata or UTC.`;
}

/** The next time a task runs, or null when its cron is invalid. */
export function nextTaskRun(cron: string, zone: string, afterMs: number): number | null {
  const parsed = parseCron(cron);
  if (!parsed.ok) return null;
  return nextRunAfter(parsed.cron, afterMs, isIanaTimeZone(zone) ? zone : DEFAULT_TASK_ZONE);
}

/** A time as the task's zone sees it, like "Mon, Nov 30, 14:05 (Asia/Kolkata)". */
export function zonedTimeText(instantMs: number, zone: string): string {
  const parts: Record<string, string> = {};
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: isIanaTimeZone(zone) ? zone : DEFAULT_TASK_ZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  for (const part of format.formatToParts(new Date(instantMs))) parts[part.type] = part.value;
  const hour = String(Number(parts.hour ?? "0") % 24).padStart(2, "0");
  return `${parts.weekday}, ${parts.month} ${parts.day}, ${hour}:${parts.minute} (${zone || DEFAULT_TASK_ZONE})`;
}

// ---- Script checks (spec 12.2)

export interface ScriptNote {
  /** The 1-based line the note is about, when it is about one. */
  line: number | null;
  message: string;
}

export interface ScriptInspection {
  /** The script as it will be saved: Windows line endings converted. */
  script: string;
  /** True when Windows line endings were converted. */
  converted: boolean;
  errors: ScriptNote[];
  warnings: ScriptNote[];
}

/** Interpreters that are shells: a shebang naming one is fine. */
const SHELLS = new Set(["sh", "bash", "dash", "ash", "ksh", "mksh", "zsh", "busybox"]);

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** The interpreter a `#!` line names, or null when the line is not a shebang. */
export function shebangInterpreter(firstLine: string): string | null {
  if (!firstLine.startsWith("#!")) return null;
  const parts = firstLine.slice(2).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  const program = (parts[0] ?? "").split("/").at(-1) ?? "";
  if (program === "env") {
    const named = parts.slice(1).find((part) => !part.startsWith("-"));
    return named ? (named.split("/").at(-1) ?? named) : "env";
  }
  return program;
}

/**
 * A container task's command runs as one shell command, so a failing line before the last one
 * doesn't fail the run (G3-15). Said for a command of two or more lines (a line continued with
 * "\" counts once, comments and blank lines not at all), unless it turns on errexit itself.
 */
export const MULTI_LINE_COMMAND_WARNING =
  "It runs as one shell command; lines run one after another and the task fails only if the last one does. Join them with && to stop at the first failure.";

function runsLineByLine(script: string): boolean {
  const lines = script
    .replace(/\\\n/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  if (lines.length < 2) return false;
  const errexit = lines.some((line) => /^set\s+(-[a-zA-Z]*e[a-zA-Z]*|-o\s+errexit)\b/.test(line));
  return !errexit;
}

/**
 * The checks that need no shell: Windows line endings are converted, null bytes are refused
 * with their line, at most 64 KB, an empty script is refused, and a shebang for an interpreter
 * that isn't a shell gets a warning (the script still runs under the chosen shell). A
 * container's multi-line command gets the warning above.
 */
export function inspectScript(
  input: string,
  shell: TaskShell | "bash",
  place: TaskPlace | null = null,
): ScriptInspection {
  const converted = /\r/.test(input);
  const script = input.replace(/\r\n?/g, "\n");
  const errors: ScriptNote[] = [];
  const warnings: ScriptNote[] = [];
  if (script.trim() === "") {
    errors.push({ line: null, message: "Enter the script to run." });
    return { script, converted, errors, warnings };
  }
  const nul = script.indexOf("\0");
  if (nul >= 0) {
    const line = script.slice(0, nul).split("\n").length;
    errors.push({
      line,
      message: `Line ${line} contains a null byte, which a shell script can't hold. Remove it and check again.`,
    });
  }
  if (byteLength(script) > TASK_SCRIPT_MAX_BYTES) {
    errors.push({
      line: null,
      message:
        "The script is larger than 64 KB. Shorten it, or keep the long part in a file on the server and call that.",
    });
  }
  const interpreter = shebangInterpreter(script.split("\n")[0] ?? "");
  if (interpreter && !SHELLS.has(interpreter)) {
    warnings.push({
      line: 1,
      message: `The first line asks for ${interpreter}, but the script still runs under ${shell}. Call ${interpreter} from the script if you need it.`,
    });
  }
  if (place === "container" && runsLineByLine(script))
    warnings.push({ line: null, message: MULTI_LINE_COMMAND_WARNING });
  return { script, converted, errors, warnings };
}

/** How bash, dash and BusyBox say a script ended too soon. */
const ENDS_TOO_SOON = /end of file|\bEOF\b|unterminated/i;

/** The number of the script's last line that isn't blank, or 0 when every line is. */
function lastLineWithContent(script: string): number {
  const lines = script.replace(/\r\n?/g, "\n").split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    if ((lines[index] ?? "").trim() !== "") return index + 1;
  }
  return 0;
}

/**
 * Reads a shell's own syntax-check output (`<shell> -n`) and names the line. Bash says
 * "bash: -c: line 3: …", dash says "sh: 3: Syntax error: …", BusyBox says "sh: line 3: …".
 *
 * Given the script, one that ends too soon (an `if` without `fi`, an open quote) is named by its
 * last line with content, whatever the shell: bash 5 and dash name the line they stopped reading
 * on, usually the one after it (later still after blank lines at the end), BusyBox names none,
 * and macOS's bash 3.2, which counts `-c` lines from 0, names the last line itself. A line the
 * shell names inside the script is kept: bash names the line an open quote starts on.
 */
export function syntaxErrorNote(output: string, script?: string): ScriptNote {
  const text = output.replace(/\r/g, "").trim();
  const first = text.split("\n").find((line) => line.trim() !== "") ?? "";
  const lineMatch =
    /\bline (\d+)\b/i.exec(first) ?? /^[^:]+:\s*(?:-c:\s*)?(\d+):/.exec(first) ?? null;
  let line = lineMatch ? Number(lineMatch[1]) : null;
  const last = script === undefined ? 0 : lastLineWithContent(script);
  if (last > 0 && (line === null ? ENDS_TOO_SOON.test(first) : line > last)) line = last;
  const detail = first
    .replace(/^[^:]*:\s*(-c:\s*)?/, "")
    .replace(/^line \d+:\s*/i, "")
    .replace(/^\d+:\s*/, "")
    .trim();
  // "syntax error near unexpected token `fi'" → "near unexpected token `fi'".
  const reason = detail.replace(/^syntax error:?\s*/i, "") || "the shell couldn't read it";
  return {
    line,
    message:
      line === null
        ? `The shell found a syntax error: ${reason}`
        : `The shell found a syntax error on line ${line}: ${reason}`,
  };
}

// ---- Runs (spec 12.3)

/**
 * A run is "queued" from when it is due (or Run was pressed) until a task lane starts it, then
 * "running" (C1-09). Both are open: one per task at a time, and Stop ends either.
 */
export const TASK_RUN_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "stopped",
  "skipped",
] as const;
export type TaskRunStatus = (typeof TASK_RUN_STATUSES)[number];

/** The statuses of a run that hasn't ended. */
export const OPEN_TASK_RUN_STATUSES = ["queued", "running"] as const satisfies TaskRunStatus[];

export function isOpenTaskRun(status: TaskRunStatus): boolean {
  return status === "queued" || status === "running";
}

export const TASK_RUN_LABELS: Record<TaskRunStatus, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  stopped: "Stopped",
  skipped: "Skipped",
};

export const TASK_TRIGGERS = ["schedule", "manual", "agent"] as const;
export type TaskTrigger = (typeof TASK_TRIGGERS)[number];

// ---- Words (spec 12)

export const TASK_MESSAGES = {
  created: "Task created",
  updated: "Task updated",
  deleted: "Task deleted",
  started: "Task started",
  stopped: "Run stopped",
  empty: "No tasks found",
  emptyText: "Create your first scheduled task to automate workflows.",
  emptyFiltered: "Try adjusting your search or filters.",
  noRuns: "No runs yet. Use Run to start this task now.",
  never: "Never",
  hostOnly: "Only instance administrators can manage host-level tasks.",
  /** A host task belongs to the instance administrator who made it (spec 30, R3-29). */
  notYourHostTask: "You can only manage your own host-level schedules.",
  notFound: "This task doesn't exist in this workspace, or you don't have access to it.",
  runNotFound: "This run doesn't exist, or you don't have access to it.",
  placeFixed: "Where a task runs can't be changed after it's created. Create a new task instead.",
  skipped: "Skipped: the previous run was still going when this one was due.",
  /** A due time while the run before it still waits for a free task lane (C1-09). */
  skippedQueued: "Skipped: the previous run was still waiting to start when this one was due.",
  restarted: "Nearzero restarted while this run was in progress, so it was stopped. Run it again.",
  searchPlaceholder: "Search by name, schedule, time zone...",
  saveAnyway: "Save anyway",
  checkAndSave: "Check and save",
} as const;

export function deleteTaskTitle(name: string): string {
  return `Delete "${name}"?`;
}

export function notRunningMessage(service: string): string {
  return `${service} isn't running, so the task can't run in its container. Deploy or start it first.`;
}

export function uncheckedWarning(reason: string): string {
  return `Nearzero couldn't check the script's syntax: ${reason}`;
}

/**
 * The Tasks list's empty state (spec 12.1): a search or filter that matches none says to change
 * them, and only an empty list with nothing filtered offers Add task (R3-32).
 */
export function taskListEmptyState(query: { search: string; status: string; place: string }): {
  title: string;
  text: string;
  filtered: boolean;
} {
  const filtered = query.search.trim() !== "" || query.status !== "all" || query.place !== "all";
  return {
    title: TASK_MESSAGES.empty,
    text: filtered ? TASK_MESSAGES.emptyFiltered : TASK_MESSAGES.emptyText,
    filtered,
  };
}
