import {
  AppError,
  type CheckTaskRequest,
  type CreateTaskRequest,
  checkTaskRequestSchema,
  createTaskRequestSchema,
  DEFAULT_TASK_ZONE,
  describeTaskSchedule,
  isOpenTaskRun,
  type ListTasksQuery,
  listTasksQuerySchema,
  OPEN_TASK_RUN_STATUSES,
  TASK_MESSAGES,
  TASK_PLACE_LABELS,
  TASK_REVIEW_RUNS,
  TASK_REVIEW_SCRIPT_CHARS,
  TASK_RUN_LABELS,
  TASK_RUNS_KEPT,
  type TaskPlace,
  type TaskRunStatus,
  type TaskShell,
  type TaskTrigger,
  type UpdateTaskRequest,
  updateTaskRequestSchema,
  zonedTimeText,
} from "@nearzero/shared";
import { sql } from "kysely";
import { recordAudit } from "../audit/audit.ts";
import { auditActor, type WorkspaceActor } from "../http/actor.ts";
import { check } from "../http/validate.ts";
import { isOurId } from "../projects/objects.ts";
import { HOST_NAME } from "../servers/targets.ts";
import type { ControlServices } from "../services.ts";
import { checkTask, errorFields, staticChecks, type TaskCheck } from "./checks.ts";
import {
  canUsePlace,
  type PlaceChoices,
  placeChoices,
  resolvePlace,
  serviceLabel,
} from "./places.ts";
import { finishRun, runView, startRun, stopLocally, type TaskRunView } from "./runs.ts";
import { wakeTaskScheduler } from "./scheduler.ts";
import type { TaskRow, TaskRunRow } from "./tables.ts";

/**
 * The tasks area (spec 12, 20.12) as functions the HTTP routes and the Agent both call with the
 * asking person's identity: list, review, check, create, update, delete, run now, stop, runs.
 * Every one checks the person's rights on the task's place first (spec 12.4); a task someone
 * can't reach is "not found", like one that doesn't exist (spec 22.4 rule 3).
 */

export interface TaskView {
  id: string;
  name: string;
  description: string;
  place: TaskPlace;
  placeLabel: string;
  runsOn: {
    label: string;
    service: {
      id: string;
      name: string;
      projectId: string;
      projectName: string;
      environmentId: string;
      environmentName: string;
      innerService: string | null;
    } | null;
    server: { id: string; name: string } | null;
  };
  shell: TaskShell;
  cron: string;
  scheduleText: string;
  timeZone: string;
  enabled: boolean;
  statusLabel: "Enabled" | "Disabled";
  nextRunAt: string | null;
  nextRunText: string | null;
  lastRun: { id: string; status: TaskRunStatus; statusLabel: string; at: string } | null;
  running: boolean;
  createdVia: "console" | "agent";
  createdAt: string;
  updatedAt: string;
  /** Only when one task is asked for. */
  script?: string;
}

export interface TaskList {
  tasks: TaskView[];
  total: number;
  page: number;
  pageSize: number;
  can: { create: boolean };
}

interface Joined extends TaskRow {
  service_name: string | null;
  project_id: string | null;
  project_name: string | null;
  environment_id: string | null;
  environment_name: string | null;
  server_name: string | null;
}

function baseQuery(services: ControlServices) {
  return services.db
    .selectFrom("task as t")
    .leftJoin("service as s", "s.id", "t.service_id")
    .leftJoin("project as p", "p.id", "s.project_id")
    .leftJoin("environment as e", "e.id", "s.environment_id")
    .leftJoin("server as v", "v.id", "t.server_id")
    .selectAll("t")
    .select([
      "s.name as service_name",
      "s.project_id as project_id",
      "p.name as project_name",
      "s.environment_id as environment_id",
      "e.name as environment_name",
      "v.name as server_name",
    ]);
}

async function lastRuns(
  services: ControlServices,
  ids: string[],
): Promise<Map<string, TaskRunRow>> {
  if (ids.length === 0) return new Map();
  // A run still going wins over the "Skipped" runs its due times recorded meanwhile, so the
  // list says the task is running, as Run's 409 does (B1-53).
  const rows = await services.db
    .selectFrom("task_run")
    .selectAll()
    .distinctOn("task_id")
    .where("task_id", "in", ids)
    .orderBy("task_id")
    .orderBy(sql`status in ('queued', 'running')`, "desc")
    .orderBy("started_at", "desc")
    .execute();
  return new Map(rows.map((row) => [row.task_id, row]));
}

function taskView(row: Joined, last: TaskRunRow | undefined, withScript = false): TaskView {
  const service =
    row.place === "container" && row.service_id
      ? {
          id: row.service_id,
          name: row.service_name ?? "",
          projectId: row.project_id ?? "",
          projectName: row.project_name ?? "",
          environmentId: row.environment_id ?? "",
          environmentName: row.environment_name ?? "",
          innerService: row.inner_service,
        }
      : null;
  const server =
    row.place === "server" && row.server_id
      ? { id: row.server_id, name: row.server_name ?? "" }
      : null;
  const label = service
    ? serviceLabel(
        {
          name: service.name,
          projectName: service.projectName,
          environmentName: service.environmentName,
        },
        row.inner_service,
      )
    : server
      ? server.name
      : HOST_NAME;
  const zone = row.time_zone || DEFAULT_TASK_ZONE;
  const next = row.enabled && row.next_run_at ? new Date(row.next_run_at) : null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    place: row.place,
    placeLabel: TASK_PLACE_LABELS[row.place],
    runsOn: { label, service, server },
    shell: row.shell,
    cron: row.cron,
    scheduleText: describeTaskSchedule(row.cron),
    timeZone: zone,
    enabled: row.enabled,
    statusLabel: row.enabled ? "Enabled" : "Disabled",
    nextRunAt: next?.toISOString() ?? null,
    nextRunText: next ? zonedTimeText(next.getTime(), zone) : null,
    lastRun: last
      ? {
          id: last.id,
          status: last.status,
          statusLabel: TASK_RUN_LABELS[last.status],
          at: new Date(last.finished_at ?? last.started_at).toISOString(),
        }
      : null,
    // Queued counts too: Run refuses while either is open.
    running: last ? isOpenTaskRun(last.status) : false,
    createdVia: row.created_via,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    ...(withScript ? { script: row.script } : {}),
  };
}

/**
 * The tasks this person can reach: their workspace's, plus, for an instance administrator, the
 * host tasks they made. A host task belongs to its maker; other administrators don't see it
 * (spec 12.4, R3-29).
 */
async function reachable(services: ControlServices, actor: WorkspaceActor): Promise<Joined[]> {
  const rows = (await baseQuery(services)
    .where((eb) =>
      actor.isInstanceAdmin
        ? eb.or([
            eb("t.workspace_id", "=", actor.workspace.id),
            eb.and([eb("t.workspace_id", "is", null), eb("t.owner_id", "=", actor.personId)]),
          ])
        : eb("t.workspace_id", "=", actor.workspace.id),
    )
    .execute()) as Joined[];
  return rows.filter((row) => canUsePlace(actor, row));
}

/** Tasks for the Tasks page and the Agent (spec 12.1, 20.12). */
export async function listTasks(
  services: ControlServices,
  actor: WorkspaceActor,
  input: ListTasksQuery = {},
): Promise<TaskList> {
  const query = check(listTasksQuerySchema, input);
  let rows = await reachable(services, actor);
  if (query.serviceId) rows = rows.filter((row) => row.service_id === query.serviceId);
  if (query.serverId) {
    rows = rows.filter((row) =>
      query.serverId === "host" ? row.place === "host" : row.server_id === query.serverId,
    );
  }
  if (query.status !== "all")
    rows = rows.filter((row) => row.enabled === (query.status === "enabled"));
  if (query.place !== "all") {
    const place: TaskPlace =
      query.place === "services" ? "container" : query.place === "servers" ? "server" : "host";
    rows = rows.filter((row) => row.place === place);
  }
  const lasts = await lastRuns(
    services,
    rows.map((row) => row.id),
  );
  let views = rows.map((row) => taskView(row, lasts.get(row.id)));
  const search = query.search?.toLowerCase();
  if (search) {
    views = views.filter((view) =>
      [view.name, view.description, view.cron, view.scheduleText, view.timeZone, view.runsOn.label]
        .join(" ")
        .toLowerCase()
        .includes(search),
    );
  }
  const direction = query.order === "asc" ? 1 : -1;
  const key = (view: TaskView): string => {
    switch (query.sort) {
      case "name":
        return view.name.toLowerCase();
      case "schedule":
        return view.cron;
      case "timezone":
        return view.timeZone.toLowerCase();
      case "status":
        return view.enabled ? "0" : "1";
      default:
        return view.createdAt;
    }
  };
  views.sort((a, b) =>
    key(a) < key(b) ? -direction : key(a) > key(b) ? direction : a.id < b.id ? -1 : 1,
  );
  const total = views.length;
  const start = (query.page - 1) * query.pageSize;
  const choices = await placeChoices(services, actor);
  return {
    tasks: views.slice(start, start + query.pageSize),
    total,
    page: query.page,
    pageSize: query.pageSize,
    can: { create: choices.host || choices.servers.length > 0 || choices.services.length > 0 },
  };
}

/** One task, after checking the person may reach its place. */
export async function taskFor(
  services: ControlServices,
  actor: WorkspaceActor,
  taskId: string,
): Promise<Joined> {
  if (!isOurId(taskId)) throw new AppError("not_found", TASK_MESSAGES.notFound);
  const row = (await baseQuery(services).where("t.id", "=", taskId).executeTakeFirst()) as
    | Joined
    | undefined;
  if (!row) throw new AppError("not_found", TASK_MESSAGES.notFound);
  if (row.place === "host") {
    // Only the instance administrator who made it may see or manage it (spec 12.4, R3-29).
    if (row.owner_id !== actor.personId) {
      throw new AppError("forbidden", TASK_MESSAGES.notYourHostTask);
    }
    if (!actor.isInstanceAdmin) throw new AppError("forbidden", TASK_MESSAGES.hostOnly);
    return row;
  }
  if (row.workspace_id !== actor.workspace.id || !canUsePlace(actor, row)) {
    throw new AppError("not_found", TASK_MESSAGES.notFound);
  }
  return row;
}

export async function getTask(
  services: ControlServices,
  actor: WorkspaceActor,
  taskId: string,
): Promise<TaskView> {
  const row = await taskFor(services, actor, taskId);
  const lasts = await lastRuns(services, [row.id]);
  return taskView(row, lasts.get(row.id), true);
}

/** What the Agent reads before changing a task (spec 20.12): its script and last 10 runs. */
export async function reviewTask(services: ControlServices, actor: WorkspaceActor, taskId: string) {
  const task = await getTask(services, actor, taskId);
  const script = task.script ?? "";
  const runs = await services.db
    .selectFrom("task_run")
    .selectAll()
    .where("task_id", "=", taskId)
    .orderBy("started_at", "desc")
    .limit(TASK_REVIEW_RUNS)
    .execute();
  return {
    task: { ...task, script: script.slice(0, TASK_REVIEW_SCRIPT_CHARS) },
    scriptTruncated: script.length > TASK_REVIEW_SCRIPT_CHARS,
    runs: runs.map((row) => runView(row)),
  };
}

export { type PlaceChoices, placeChoices };

/** "Check" without saving: the place's shell reads the script; nothing runs. */
export async function checkTaskRequest(
  services: ControlServices,
  actor: WorkspaceActor,
  input: CheckTaskRequest,
): Promise<TaskCheck> {
  const request = check(checkTaskRequestSchema, input);
  let placeInput = request;
  if (request.taskId) {
    const row = await taskFor(services, actor, request.taskId);
    placeInput = {
      ...request,
      place: row.place,
      serviceId: row.service_id,
      serverId: row.server_id,
      innerService: row.inner_service,
    };
  }
  const place = await resolvePlace(services, actor, placeInput);
  return checkTask(services, place, {
    shell: request.shell,
    cron: request.cron,
    timeZone: request.timeZone,
    script: request.script,
  });
}

export type SaveResult =
  | { saved: true; task: TaskView; check: TaskCheck }
  | { saved: false; check: TaskCheck };

function refuseErrors(result: TaskCheck): void {
  if (result.ok) return;
  const first = result.errors[0];
  throw new AppError("invalid_request", first?.message ?? "Check the task and try again.", {
    fields: errorFields(result),
  });
}

export interface ActOptions {
  /** The Agent marks what it created; it also checks production rights itself (spec 12.2). */
  via?: "console" | "agent";
}

/**
 * Creates a task after its checks. Errors refuse (400, naming the line); warnings return
 * `{ saved: false }` unless `force` ("Save anyway").
 */
export async function createTask(
  services: ControlServices,
  actor: WorkspaceActor,
  input: CreateTaskRequest,
  options: ActOptions = {},
): Promise<SaveResult> {
  const request = check(createTaskRequestSchema, input);
  const place = await resolvePlace(services, actor, request);
  const result = await checkTask(services, place, request);
  refuseErrors(result);
  if (result.warnings.length > 0 && !request.force) return { saved: false, check: result };
  const row = await services.db
    .insertInto("task")
    .values({
      workspace_id: place.place === "host" ? null : actor.workspace.id,
      name: request.name,
      description: request.description,
      place: place.place,
      service_id: place.serviceId,
      inner_service: place.innerService,
      server_id: place.serverId,
      shell: result.shell,
      cron: result.cron,
      time_zone: result.timeZone,
      script: result.script,
      enabled: request.enabled,
      next_run_at: request.enabled && result.nextRunAt ? new Date(result.nextRunAt) : null,
      created_by: actor.personId,
      // A host task belongs to the administrator who made it (R3-29).
      owner_id: place.place === "host" ? actor.personId : null,
      created_via: options.via ?? "console",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  if (request.enabled && result.nextRunAt)
    await wakeTaskScheduler(services.db, new Date(result.nextRunAt));
  await recordAudit(services.db, services.log, auditActor(actor), {
    action: "task.created",
    workspaceId: place.place === "host" ? null : actor.workspace.id,
    target: { kind: "task", id: row.id },
    details: {
      name: request.name,
      place: place.place,
      runsOn: place.label,
      cron: result.cron,
      via: options.via ?? "console",
    },
  });
  return { saved: true, task: await getTask(services, actor, row.id), check: result };
}

/** Changes a task's name, description, schedule, zone, on/off or script; the place is fixed. */
export async function updateTask(
  services: ControlServices,
  actor: WorkspaceActor,
  taskId: string,
  input: UpdateTaskRequest,
  options: ActOptions = {},
): Promise<SaveResult> {
  const request = check(updateTaskRequestSchema, input);
  if ((input as Record<string, unknown>).place !== undefined) {
    throw new AppError("invalid_request", TASK_MESSAGES.placeFixed, {
      fields: { place: TASK_MESSAGES.placeFixed },
    });
  }
  const row = await taskFor(services, actor, taskId);
  const place = await resolvePlace(services, actor, {
    place: row.place,
    serviceId: row.service_id,
    serverId: row.server_id,
    innerService: row.inner_service,
  });
  const shell = request.shell ?? row.shell;
  const scriptChanged = request.script !== undefined && request.script !== row.script;
  const shellChanged = shell !== row.shell;
  const base = {
    shell,
    cron: request.cron ?? row.cron,
    timeZone: request.timeZone ?? row.time_zone,
    script: request.script ?? row.script,
  };
  // The shell reads the script again only when it changed (or the shell did).
  const result =
    scriptChanged || shellChanged
      ? await checkTask(services, place, base)
      : staticChecks({
          ...base,
          shell: place.place === "container" ? shell : "bash",
          place: place.place,
        });
  refuseErrors(result);
  if (result.warnings.length > 0 && !request.force && (scriptChanged || shellChanged)) {
    return { saved: false, check: result };
  }
  const enabled = request.enabled ?? row.enabled;
  await services.db
    .updateTable("task")
    .set({
      name: request.name ?? row.name,
      description: request.description ?? row.description,
      shell: result.shell,
      cron: result.cron,
      time_zone: result.timeZone,
      script: result.script,
      enabled,
      next_run_at: enabled && result.nextRunAt ? new Date(result.nextRunAt) : null,
      updated_at: sql<Date>`now()`,
    })
    .where("id", "=", row.id)
    .execute();
  if (enabled && result.nextRunAt) await wakeTaskScheduler(services.db, new Date(result.nextRunAt));
  const changed = Object.keys(request).filter((key) => key !== "force");
  await recordAudit(services.db, services.log, auditActor(actor), {
    action: "task.updated",
    workspaceId: row.workspace_id,
    target: { kind: "task", id: row.id },
    details: { name: request.name ?? row.name, changed, via: options.via ?? "console" },
  });
  return { saved: true, task: await getTask(services, actor, row.id), check: result };
}

export async function deleteTask(
  services: ControlServices,
  actor: WorkspaceActor,
  taskId: string,
): Promise<void> {
  const row = await taskFor(services, actor, taskId);
  const open = await services.db
    .selectFrom("task_run")
    .select("id")
    .where("task_id", "=", row.id)
    .where("status", "in", OPEN_TASK_RUN_STATUSES)
    .execute();
  for (const run of open) {
    stopLocally(run.id);
    await services.db
      .updateTable("task_run")
      .set({ stop_requested_at: new Date() })
      .where("id", "=", run.id)
      .execute();
  }
  await services.db.deleteFrom("task").where("id", "=", row.id).execute();
  await recordAudit(services.db, services.log, auditActor(actor), {
    action: "task.deleted",
    workspaceId: row.workspace_id,
    target: { kind: "task", id: row.id },
    details: { name: row.name },
  });
}

/** Runs a task once, now, in the background (spec 12.3 "Run", 20.12). */
export async function runTaskNow(
  services: ControlServices,
  actor: WorkspaceActor,
  taskId: string,
  options: { trigger?: TaskTrigger } = {},
): Promise<TaskRunView> {
  const row = await taskFor(services, actor, taskId);
  // Running needs the same rights as managing (spec 12.4); the place is checked again.
  await resolvePlace(services, actor, {
    place: row.place,
    serviceId: row.service_id,
    serverId: row.server_id,
    innerService: row.inner_service,
  });
  const run = await startRun(services.db, row.id, options.trigger ?? "manual", actor.personId);
  if (!run) {
    throw new AppError(
      "conflict",
      "This task is running already. Stop that run, or wait for it to finish, then run it again.",
    );
  }
  await recordAudit(services.db, services.log, auditActor(actor), {
    action: "task.run-started",
    workspaceId: row.workspace_id,
    target: { kind: "task", id: row.id },
    details: { name: row.name, runId: run.id, trigger: run.trigger },
  });
  return runView(run);
}

async function runFor(
  services: ControlServices,
  actor: WorkspaceActor,
  runId: string,
): Promise<TaskRunRow & { task_workspace_id: string | null }> {
  if (!isOurId(runId)) throw new AppError("not_found", TASK_MESSAGES.runNotFound);
  const run = await services.db
    .selectFrom("task_run")
    .selectAll()
    .where("id", "=", runId)
    .executeTakeFirst();
  if (!run) throw new AppError("not_found", TASK_MESSAGES.runNotFound);
  let task: Awaited<ReturnType<typeof taskFor>>;
  try {
    task = await taskFor(services, actor, run.task_id);
  } catch (error) {
    // Another administrator's host task says whose it is, as the task itself does (R3-29).
    if (error instanceof AppError && error.message === TASK_MESSAGES.notYourHostTask) throw error;
    throw new AppError("not_found", TASK_MESSAGES.runNotFound);
  }
  return { ...run, task_workspace_id: task.workspace_id };
}

/** Stops a running run ("Run stopped"); it ends as Stopped. */
export async function stopTaskRun(
  services: ControlServices,
  actor: WorkspaceActor,
  runId: string,
): Promise<TaskRunView> {
  const run = await runFor(services, actor, runId);
  if (!isOpenTaskRun(run.status)) {
    throw new AppError("conflict", "This run isn't running any more.");
  }
  await services.db
    .updateTable("task_run")
    .set({ stop_requested_at: sql<Date>`now()`, updated_at: sql<Date>`now()` })
    .where("id", "=", run.id)
    .execute();
  const here = stopLocally(run.id);
  // A run whose job never started (or is gone) is finished here.
  if (!here) {
    const job = run.job_id
      ? await services.db
          .selectFrom("job")
          .select("state")
          .where("id", "=", run.job_id)
          .executeTakeFirst()
      : undefined;
    if (job?.state !== "running") {
      if (job?.state === "queued") {
        await services.db
          .updateTable("job")
          .set({ state: "failed", finished_at: new Date(), last_error: "Stopped." })
          .where("id", "=", run.job_id as number)
          .where("state", "=", "queued")
          .execute();
      }
      await finishRun(services.db, run.id, { status: "stopped" });
    }
  }
  await recordAudit(services.db, services.log, auditActor(actor), {
    action: "task.run-stopped",
    // The task's workspace, like its other events (none for a host task) (B1-54).
    workspaceId: run.task_workspace_id,
    target: { kind: "task", id: run.task_id },
    details: { runId: run.id },
  });
  const after = await services.db
    .selectFrom("task_run")
    .selectAll()
    .where("id", "=", run.id)
    .executeTakeFirstOrThrow();
  return runView(after);
}

/** A task's run history, newest first (spec 12.3), without logs. */
export async function taskRuns(
  services: ControlServices,
  actor: WorkspaceActor,
  taskId: string,
): Promise<TaskRunView[]> {
  await taskFor(services, actor, taskId);
  const rows = await services.db
    .selectFrom("task_run")
    .selectAll()
    .where("task_id", "=", taskId)
    .orderBy("started_at", "desc")
    .orderBy("id", "desc")
    .limit(TASK_RUNS_KEPT)
    .execute();
  return rows.map((row) => runView(row));
}

/** One run with its log (the last 1,000 lines). */
export async function taskRun(
  services: ControlServices,
  actor: WorkspaceActor,
  runId: string,
): Promise<TaskRunView> {
  const run = await runFor(services, actor, runId);
  return runView(run, true);
}
