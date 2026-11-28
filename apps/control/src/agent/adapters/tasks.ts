import {
  AppError,
  DEFAULT_TASK_ZONE,
  describeTaskSchedule,
  nextTaskRun,
  type TaskPlace,
  type TaskShell,
  timeZoneProblem,
  zonedTimeText,
} from "@nearzero/shared";
import type { WorkspaceActor } from "../../http/actor.ts";
import type { ControlServices } from "../../services.ts";
import {
  getTask,
  listTasks,
  reviewTask,
  runTaskNow,
  type TaskView,
  taskRun,
  taskRuns,
  updateTask,
} from "../../tasks/area.ts";
import { resolvePlace } from "../../tasks/places.ts";

/**
 * The Agent's seam to the tasks area (M10, being finished alongside). Every call goes through
 * the area's exported functions with the person's actor, so its own rights checks apply
 * (spec 12.4, 20.12). The script itself never passes through here: the person saves it in the
 * task form, straight to the tasks API.
 */

export interface TaskSummary {
  id: string;
  name: string;
  description: string;
  where: string;
  schedule: string;
  scheduleText: string;
  timeZone: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRun: { at: string; state: string } | null;
  production: boolean;
}

function summary(view: TaskView): TaskSummary {
  return {
    id: view.id,
    name: view.name,
    description: view.description,
    where: view.runsOn.label,
    schedule: view.cron,
    scheduleText: view.scheduleText,
    timeZone: view.timeZone,
    enabled: view.enabled,
    nextRunAt: view.nextRunText ?? view.nextRunAt,
    lastRun: view.lastRun ? { at: view.lastRun.at, state: view.lastRun.statusLabel } : null,
    production: view.runsOn.service?.environmentName === "production",
  };
}

export interface TaskDraft {
  name: string;
  description: string;
  cron: string;
  timeZone: string;
  shell: TaskShell;
  place: TaskPlace;
  serviceId: string | null;
  innerService: string | null;
  serverId: string | null;
}

export const tasksPort = {
  async list(
    services: ControlServices,
    actor: WorkspaceActor,
    filter: { serviceId?: string; serverId?: string },
  ) {
    const list = await listTasks(services, actor, { ...filter, pageSize: 100 });
    return list.tasks.map(summary);
  },
  async get(services: ControlServices, actor: WorkspaceActor, taskId: string) {
    return summary(await getTask(services, actor, taskId));
  },
  async review(services: ControlServices, actor: WorkspaceActor, taskId: string) {
    const review = await reviewTask(services, actor, taskId);
    return {
      task: summary(review.task),
      script: review.task.script ?? "",
      scriptCut: review.scriptTruncated,
      runs: review.runs.map((run) => ({
        id: run.id,
        at: run.startedAt,
        state: run.statusLabel,
        exitCode: run.exitCode,
      })),
    };
  },
  /** The place (with the person's rights), the schedule and the time zone, before the form opens. */
  async check(services: ControlServices, actor: WorkspaceActor, draft: TaskDraft) {
    const place = await resolvePlace(services, actor, draft);
    const zone = draft.timeZone || DEFAULT_TASK_ZONE;
    const zoneProblem = timeZoneProblem(zone);
    if (zoneProblem) throw new AppError("invalid_request", zoneProblem);
    const next = nextTaskRun(draft.cron, zone, Date.now());
    if (next === null) {
      throw new AppError(
        "invalid_request",
        `"${draft.cron}" isn't a 5-field cron schedule, like 0 2 * * *.`,
      );
    }
    return {
      where: place.label,
      scheduleText: describeTaskSchedule(draft.cron),
      nextRun: zonedTimeText(next, zone),
      production: place.service?.environmentName === "production",
    };
  },
  async update(
    services: ControlServices,
    actor: WorkspaceActor,
    taskId: string,
    change: {
      name?: string;
      description?: string;
      cron?: string;
      timeZone?: string;
      enabled?: boolean;
    },
  ) {
    const saved = await updateTask(
      services,
      actor,
      taskId,
      { ...change, force: true },
      { via: "agent" },
    );
    return saved.saved ? summary(saved.task) : await tasksPort.get(services, actor, taskId);
  },
  /**
   * One run with its log (30d R4-05): the run named by id, else the newest, else the newest that
   * failed. The tasks area checks the person may reach the task's place.
   */
  async runLog(
    services: ControlServices,
    actor: WorkspaceActor,
    taskId: string,
    which: { runId: string | null; failed: boolean },
  ) {
    const runs = await taskRuns(services, actor, taskId);
    const wanted = which.runId?.toLowerCase() ?? null;
    const chosen = wanted
      ? runs.find((run) => run.id === wanted)
      : which.failed
        ? runs.find((run) => run.status === "failed")
        : runs[0];
    if (!chosen) return null;
    return taskRun(services, actor, chosen.id);
  },
  async runNow(services: ControlServices, actor: WorkspaceActor, taskId: string) {
    const run = await runTaskNow(services, actor, taskId, { trigger: "agent" });
    return {
      message: "Started. It runs in the background; its log is on the task's page.",
      run: { state: run.statusLabel },
    };
  },
};
