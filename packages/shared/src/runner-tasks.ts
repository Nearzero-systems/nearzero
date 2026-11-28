import { z } from "zod";
import { TASK_SHELLS } from "./task-rules.ts";

/**
 * Runner commands for tasks (spec 12): a syntax check that never runs the script, a run whose
 * output streams into the run's log, and a stop. They are new command kinds of the runner
 * protocol (runner-protocol.ts spreads them into its list), so older runners answer them with
 * "unsupported".
 *
 * The script reaches the shell as one argument (`<shell> -c <script>`), never through a shell of
 * the runner's own, so no quoting rule applies (the single-quote limit of spec 12.2 is gone).
 * Standard input is closed, so a script that reads it gets end-of-file (spec 23.1).
 *
 * Places: "container" runs inside a service's running container (Docker exec); "server" runs on
 * the server itself. On the Nearzero host, whose runner runs in a container, "server" runs on
 * the host through a short-lived helper container that enters the host's namespaces.
 */

const runId = z.string().regex(/^[0-9a-f-]{36}$/);
const containerRef = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/);
const place = z.enum(["container", "server"]);
const script = z
  .string()
  .min(1)
  .max(96 * 1024);

export const taskCommandSchemas = {
  /** `<shell> -n -c <script>`: reads the script and reports syntax errors without running it. */
  "task.check": z.object({
    place,
    container: containerRef.optional(),
    shell: z.enum(TASK_SHELLS),
    script,
  }),
  /** Runs the script and streams what it prints; the result carries its exit code. */
  "task.run": z.object({
    runId,
    place,
    container: containerRef.optional(),
    shell: z.enum(TASK_SHELLS),
    script,
    /** The run is stopped (TERM, then KILL) when it runs over. */
    timeoutSeconds: z
      .number()
      .int()
      .min(1)
      .max(24 * 3600)
      .default(6 * 3600),
  }),
  /** Stops a run: its processes get TERM, then KILL after 5 seconds. */
  "task.stop": z.object({ runId, place, container: containerRef.optional() }),
} as const;

export type TaskCommandKind = keyof typeof taskCommandSchemas;
export const TASK_STREAMING_COMMANDS = ["task.run"] as const;

/** What `task.check` answers. */
export interface TaskCheckAnswer {
  ok: boolean;
  exitCode: number | null;
  /** What the shell printed (its syntax error), at most 8 KB. */
  output: string;
}

/** What `task.run` answers when the script ended (or was stopped). */
export interface TaskRunAnswer {
  exitCode: number | null;
  stopped: boolean;
  timedOut: boolean;
}

/** The variable each run's processes carry, which is how Stop finds them in a container. */
export const TASK_RUN_MARKER = "NEARZERO_TASK_RUN";
