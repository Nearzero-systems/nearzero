import {
  DEFAULT_TASK_ZONE,
  describeTaskSchedule,
  inspectScript,
  nextTaskRun,
  notRunningMessage,
  parseCron,
  syntaxErrorNote,
  type TaskCheckAnswer,
  type TaskPlace,
  type TaskShell,
  timeZoneProblem,
  uncheckedWarning,
  zonedTimeText,
} from "@nearzero/shared";
import { reasonOf } from "../service-runtime/server-ops.ts";
import type { ControlServices } from "../services.ts";
import { opsFor, type ResolvedPlace, runningContainer } from "./places.ts";

/**
 * The checks a task gets before it is saved (spec 12.2, "Check and save"): the script is read
 * by the place's own shell without running (`<shell> -n`), Windows line endings are converted,
 * null bytes and more than 64 KB are refused, a shebang for something other than a shell gets a
 * warning, the cron needs 5 valid fields and the time zone must exist. The next run is computed
 * in the task's zone. Warnings turn the button into "Save anyway"; errors block and name the line.
 */

export type TaskCheckField = "script" | "cron" | "timeZone";

export interface TaskCheckNote {
  field: TaskCheckField;
  line: number | null;
  message: string;
}

export interface TaskCheck {
  ok: boolean;
  errors: TaskCheckNote[];
  warnings: TaskCheckNote[];
  /** The script as it will be saved. */
  script: string;
  /** Windows line endings were converted. */
  converted: boolean;
  shell: TaskShell;
  cron: string;
  scheduleText: string;
  timeZone: string;
  nextRunAt: string | null;
  /** The next run as the task's zone sees it. */
  nextRunText: string | null;
  /** Whether the place's shell read the script ("unchecked" when it couldn't be reached). */
  syntax: "checked" | "unchecked" | "skipped";
}

export interface CheckInput {
  shell: TaskShell;
  cron: string;
  timeZone: string;
  script: string;
  /** Where it runs: a container's multi-line command gets a warning (G3-15). */
  place?: TaskPlace;
}

/** The checks that need no server. */
export function staticChecks(input: CheckInput, now = Date.now()): TaskCheck {
  const inspection = inspectScript(input.script, input.shell, input.place ?? null);
  const errors: TaskCheckNote[] = inspection.errors.map((note) => ({ field: "script", ...note }));
  const warnings: TaskCheckNote[] = inspection.warnings.map((note) => ({
    field: "script",
    ...note,
  }));
  const zone = input.timeZone.trim() || DEFAULT_TASK_ZONE;
  const zoneProblem = timeZoneProblem(zone);
  if (zoneProblem) errors.push({ field: "timeZone", line: null, message: zoneProblem });
  const cron = input.cron.trim().replace(/\s+/g, " ");
  const parsed = parseCron(cron);
  if (!parsed.ok) errors.push({ field: "cron", line: null, message: parsed.message });
  const next = parsed.ok && !zoneProblem ? nextTaskRun(cron, zone, now) : null;
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    script: inspection.script,
    converted: inspection.converted,
    shell: input.shell,
    cron,
    scheduleText: describeTaskSchedule(cron),
    timeZone: zone,
    nextRunAt: next === null ? null : new Date(next).toISOString(),
    nextRunText: next === null ? null : zonedTimeText(next, zone),
    syntax: "skipped",
  };
}

/** Asks the place's shell to read the script, adding its verdict to the check. */
export async function syntaxCheck(
  services: ControlServices,
  place: ResolvedPlace,
  check: TaskCheck,
): Promise<TaskCheck> {
  if (check.errors.some((note) => note.field === "script")) return check;
  const ops = opsFor(services, place.target);
  const unchecked = (reason: string): TaskCheck => ({
    ...check,
    warnings: [
      ...check.warnings,
      { field: "script", line: null, message: uncheckedWarning(reason) },
    ],
    syntax: "unchecked",
  });
  try {
    let container: string | undefined;
    if (place.place === "container" && place.service) {
      const found = await runningContainer(
        ops,
        place.service.id,
        place.service.appName,
        place.innerService,
      );
      if (!found) return unchecked(notRunningMessage(place.service.name));
      container = found.id;
    }
    const answer = (await ops.command(
      "task.check",
      {
        place: place.place === "container" ? "container" : "server",
        ...(container ? { container } : {}),
        shell: check.shell,
        script: check.script,
      },
      60_000,
    )) as TaskCheckAnswer;
    if (answer.ok) return { ...check, syntax: "checked" };
    // No exit code: the shell's verdict is unknown, which is a warning, not an error.
    if (answer.exitCode === null) return unchecked("the shell didn't report a result");
    const note = syntaxErrorNote(
      answer.output || `the shell exited with ${answer.exitCode ?? "no code"}`,
      check.script,
    );
    return {
      ...check,
      ok: false,
      errors: [...check.errors, { field: "script", line: note.line, message: note.message }],
      syntax: "checked",
    };
  } catch (error) {
    return unchecked(reasonOf(error));
  }
}

export async function checkTask(
  services: ControlServices,
  place: ResolvedPlace,
  input: CheckInput,
  now = Date.now(),
): Promise<TaskCheck> {
  const shell: TaskShell = place.place === "container" ? input.shell : "bash";
  const basic = staticChecks({ ...input, shell, place: place.place }, now);
  return syntaxCheck(services, place, basic);
}

/** The field messages of a check's errors, for an invalid_request answer. */
export function errorFields(check: TaskCheck): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const note of check.errors) fields[note.field] ??= note.message;
  return fields;
}
