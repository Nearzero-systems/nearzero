import {
  AppError,
  BACKUP_MESSAGES,
  BACKUP_RUN_LABELS,
  backupPrefix,
  type CreateScheduleRequest,
  describeSchedule,
  isDatabaseKind,
  keepWords,
  MYSQL_SYSTEM_DATABASES,
  nextRunAfter,
  parseCron,
  SCHEDULE_PRESETS,
  systemDatabaseMessage,
  timeZoneHint,
  type UpdateScheduleRequest,
  usableTimeZone,
} from "@nearzero/shared";
import { type Selectable, sql, type Updateable } from "kysely";
import { recordAudit } from "../audit/audit.ts";
import type { Db } from "../db/database.ts";
import { auditActor, type WorkspaceActor } from "../http/actor.ts";
import { isOurId, serviceTarget } from "../projects/objects.ts";
import { readDatabaseSettings } from "../service-runtime/databases.ts";
import { loadService, type ServiceRow } from "../services/records.ts";
import type { ControlServices } from "../services.ts";
import { destinationChoices, destinationRights } from "./destinations.ts";
import {
  cancelWaitingRuns,
  latestRuns,
  type RequestedRun,
  type RunRow,
  type RunView,
  requestScheduleRun,
  runView,
} from "./runs.ts";
import { wakeScheduler } from "./scheduler-wake.ts";
import type { BackupScheduleKind, BackupScheduleTable } from "./tables.ts";
import { discoverVolumes, type VolumeDiscovery } from "./volumes.ts";

/**
 * Backup schedules of a service (spec 08 8.3 databases, 17.3 volumes) and the Backups panel's
 * state. A schedule names a destination of the same workspace (checked here and by the
 * database), a folder, a 5-field cron in the server's time zone, and how many files to keep.
 */

export type ScheduleRow = Selectable<BackupScheduleTable>;

/**
 * The database a database service dumps when its schedule names none: its own, with the type's
 * default filled in (null: libSQL, and MongoDB's every database).
 */
export function ownDatabase(
  row: Pick<ServiceRow, "kind" | "settings" | "app_name">,
): string | null {
  if (!isDatabaseKind(row.kind) || row.kind === "libsql" || row.kind === "redis") return null;
  return readDatabaseSettings(row.kind, row.settings, row.app_name).databaseName;
}

/** Backups of a database are dumps; Redis, apps and Compose back up volumes (spec 8.3, 17.3). */
export function backupKindOf(kind: ServiceRow["kind"]): BackupScheduleKind {
  return isDatabaseKind(kind) && kind !== "redis" ? "database" : "volume";
}

const SCHEDULE_NOT_FOUND =
  "This backup schedule doesn't exist in this workspace, or you don't have access to it.";

export interface ServiceContext {
  row: ServiceRow;
  projectName: string;
  environmentName: string;
}

/** The service, after checking the person may act on its backups (or restores). */
export async function serviceFor(
  services: ControlServices,
  actor: WorkspaceActor,
  serviceId: string,
  action: "service.backups" | "service.restore" = "service.backups",
): Promise<ServiceContext> {
  await actor.access.require(action, { kind: "service", id: serviceId });
  const row = await loadService(services.db, actor.workspace.id, serviceId);
  if (!row)
    throw new AppError("not_found", "This service doesn't exist in this workspace any more.");
  const names = await services.db
    .selectFrom("project as p")
    .innerJoin("environment as e", "e.project_id", "p.id")
    .select(["p.name as project", "e.name as environment"])
    .where("e.id", "=", row.environment_id)
    .executeTakeFirstOrThrow();
  return { row, projectName: names.project, environmentName: names.environment };
}

/** The server's time zone as its runner reported it (spec 08 8.3), or UTC. */
export async function serverTimeZone(db: Db, serverId: string | null): Promise<string> {
  return usableTimeZone(await reportedTimeZone(db, serverId));
}

/** The time zone the server's runner reported, or null before it has (or when it's unusable). */
export async function reportedTimeZone(db: Db, serverId: string | null): Promise<string | null> {
  let query = db.selectFrom("runner").select("system").orderBy("updated_at", "desc").limit(1);
  query =
    serverId === null
      ? query.where("server_id", "is", null)
      : query.where("server_id", "=", serverId);
  const row = await query.executeTakeFirst();
  const system = row?.system as { timeZone?: unknown } | null | undefined;
  const zone = typeof system?.timeZone === "string" ? system.timeZone : null;
  return zone && usableTimeZone(zone) === zone ? zone : null;
}

export function nextRunFor(cron: string, zone: string, after = Date.now()): Date | null {
  const parsed = parseCron(cron);
  if (!parsed.ok) return null;
  const next = nextRunAfter(parsed.cron, after, zone);
  return next === null ? null : new Date(next);
}

export interface ScheduleView {
  id: string;
  kind: BackupScheduleKind;
  enabled: boolean;
  stateLabel: "On" | "Paused";
  cron: string;
  scheduleText: string;
  preset: string | null;
  destination: { id: string; name: string } | null;
  folder: string;
  /** `<app name>[_<inner service>]/<folder>/`, where its files go. */
  prefix: string;
  keep: number | null;
  keepText: string;
  database: string | null;
  volume: string | null;
  innerService: string | null;
  stopService: boolean;
  nextRunAt: string | null;
  lastRun: RunView | null;
  /** A queued or running run, shown on the row until it ends. */
  openRun: RunView | null;
  lastRunText: string;
}

export function scheduleView(
  row: ScheduleRow,
  appName: string,
  destinationName: string | null,
  runs: { last: RunRow | null; open: RunRow | null } | undefined,
): ScheduleView {
  const last = runs?.last ? runView(runs.last) : null;
  const open = runs?.open ? runView(runs.open) : null;
  const preset = SCHEDULE_PRESETS.find((item) => item.cron === row.cron)?.key ?? null;
  return {
    id: row.id,
    kind: row.kind,
    enabled: row.enabled,
    stateLabel: row.enabled ? "On" : "Paused",
    cron: row.cron,
    scheduleText: describeSchedule(row.cron),
    preset,
    destination: destinationName ? { id: row.destination_id, name: destinationName } : null,
    folder: row.folder,
    prefix: backupPrefix(appName, row.folder, row.inner_service),
    keep: row.keep,
    keepText: keepWords(row.keep),
    database: row.database_name,
    volume: row.volume_name,
    innerService: row.inner_service,
    stopService: row.stop_service,
    nextRunAt: row.next_run_at ? new Date(row.next_run_at).toISOString() : null,
    lastRun: last,
    openRun: open,
    lastRunText: open
      ? BACKUP_RUN_LABELS[open.status]
      : last
        ? BACKUP_RUN_LABELS[last.status]
        : BACKUP_MESSAGES.notRunYet,
  };
}

export async function scheduleViews(db: Db, row: ServiceRow): Promise<ScheduleView[]> {
  const schedules = await db
    .selectFrom("backup_schedule as s")
    .innerJoin("backup_destination as d", "d.id", "s.destination_id")
    .selectAll("s")
    .select("d.name as destination_name")
    .where("s.service_id", "=", row.id)
    .where("s.workspace_id", "=", row.workspace_id)
    .orderBy("s.created_at")
    .execute();
  const runs = await latestRuns(
    db,
    schedules.map((schedule) => schedule.id),
  );
  return schedules.map((schedule) =>
    scheduleView(schedule, row.app_name, schedule.destination_name, runs.get(schedule.id)),
  );
}

export interface BackupsPanel {
  kind: BackupScheduleKind;
  service: { id: string; name: string; appName: string; kind: ServiceRow["kind"] };
  schedules: ScheduleView[];
  /** Destinations this person may choose (empty without "Back up to …"). */
  destinations: { id: string; name: string; bucket: string; providerLabel: string }[];
  /** Whether the workspace has any destination at all. */
  hasDestinations: boolean;
  /** "Add a destination first" and what to do about it, or null. */
  notice: { text: string; action: "add-destination" | "ask-admin" | "ask-permission" } | null;
  timeZone: string;
  timeZoneHint: string;
  /** The database dumped by default (databases). */
  defaultDatabase: string | null;
  volumes: VolumeDiscovery | null;
  recentRestores: RunView[];
  can: {
    manage: boolean;
    restore: boolean;
    addDestination: boolean;
  };
}

export async function backupsPanel(
  services: ControlServices,
  actor: WorkspaceActor,
  serviceId: string,
): Promise<BackupsPanel> {
  const { row } = await serviceFor(services, actor, serviceId);
  const kind = backupKindOf(row.kind);
  const rights = destinationRights(actor);
  const [schedules, all, timeZone, volumes, restores] = await Promise.all([
    scheduleViews(services.db, row),
    destinationChoices(services, actor.workspace.id),
    serverTimeZone(services.db, row.server_id),
    kind === "volume" ? discoverVolumes(services, row) : Promise.resolve(null),
    services.db
      .selectFrom("backup_run")
      .selectAll()
      .where("service_id", "=", row.id)
      .where("operation", "=", "restore")
      .orderBy("created_at", "desc")
      .limit(5)
      .execute(),
  ]);
  let notice: BackupsPanel["notice"] = null;
  if (all.length === 0) {
    notice = rights.manage
      ? { text: BACKUP_MESSAGES.noDestination, action: "add-destination" }
      : { text: BACKUP_MESSAGES.noDestination, action: "ask-admin" };
  } else if (!rights.use) {
    notice = { text: BACKUP_MESSAGES.cantUseDestinations, action: "ask-permission" };
  }
  return {
    kind,
    service: { id: row.id, name: row.name, appName: row.app_name, kind: row.kind },
    schedules,
    destinations: rights.use ? all : [],
    hasDestinations: all.length > 0,
    notice,
    timeZone,
    timeZoneHint: timeZoneHint(timeZone),
    defaultDatabase: kind === "database" ? ownDatabase(row) : null,
    volumes,
    recentRestores: restores.map(runView),
    can: {
      manage: rights.use,
      restore: actor.access.can("service.restore", serviceTarget(row)),
      addDestination: rights.manage,
    },
  };
}

async function requireDestination(
  services: ControlServices,
  actor: WorkspaceActor,
  destinationId: string,
): Promise<{ id: string; name: string }> {
  await actor.access.require("destinations.use");
  const row = isOurId(destinationId)
    ? await services.db
        .selectFrom("backup_destination")
        .select(["id", "name"])
        .where("id", "=", destinationId)
        .where("workspace_id", "=", actor.workspace.id)
        .executeTakeFirst()
    : undefined;
  // Another workspace's destination is simply not there (spec 17.3, 22.4 rule 1).
  if (!row) {
    throw new AppError("invalid_request", "Pick a destination from the list.", {
      fields: { destinationId: "Pick a destination from the list." },
    });
  }
  return row;
}

interface VolumeChoice {
  volume: string;
  innerService: string | null;
  stopService: boolean;
}

async function checkVolumeChoice(
  services: ControlServices,
  row: ServiceRow,
  volume: string | undefined,
  stopService: boolean,
): Promise<VolumeChoice> {
  if (!volume) {
    throw new AppError("invalid_request", "Pick a volume.", {
      fields: { volume: "Pick a volume." },
    });
  }
  const discovery = await discoverVolumes(services, row);
  const refused = discovery.excluded.find((item) => item.name === volume);
  if (refused) {
    throw new AppError("forbidden", refused.reason, { fields: { volume: refused.reason } });
  }
  const found = discovery.volumes.find((item) => item.name === volume);
  if (!found) {
    throw new AppError("forbidden", BACKUP_MESSAGES.notMounted, {
      fields: { volume: BACKUP_MESSAGES.notMounted },
    });
  }
  const inner =
    row.kind === "compose" && found.innerServices.length === 1 ? found.innerServices[0] : null;
  if (stopService && row.kind === "compose" && found.innerServices.length === 0) {
    throw new AppError("invalid_request", BACKUP_MESSAGES.composeCantStop, {
      fields: { stopService: BACKUP_MESSAGES.composeCantStop },
    });
  }
  return { volume, innerService: inner ?? null, stopService };
}

/**
 * MySQL and MariaDB never back up their own system database, or restore into it (it can't be
 * restored safely).
 */
export function checkDatabaseChoice(row: ServiceRow, database: string | null): void {
  if (row.kind !== "mysql" && row.kind !== "mariadb") return;
  const settings = row.settings ?? {};
  const effective =
    database ?? (typeof settings.databaseName === "string" ? settings.databaseName : row.kind);
  if (MYSQL_SYSTEM_DATABASES.includes(effective.toLowerCase())) {
    const message = systemDatabaseMessage(effective);
    throw new AppError("invalid_request", message, { fields: { database: message } });
  }
}

function folderTaken(error: unknown): boolean {
  return (
    (error as { code?: string }).code === "23505" &&
    String((error as { constraint?: string }).constraint ?? "").includes("prefix")
  );
}

/** Volumes may share a folder, one schedule per volume; databases have one per folder (G3-20). */
const FOLDER_TAKEN = (kind: "database" | "volume") => {
  const message =
    kind === "volume" ? BACKUP_MESSAGES.volumeFolderTaken : BACKUP_MESSAGES.folderTaken;
  return new AppError("conflict", message, { fields: { folder: message } });
};

export async function createSchedule(
  services: ControlServices,
  actor: WorkspaceActor,
  serviceId: string,
  input: CreateScheduleRequest,
): Promise<ScheduleView> {
  const { row } = await serviceFor(services, actor, serviceId);
  const destination = await requireDestination(services, actor, input.destinationId);
  const kind = backupKindOf(row.kind);
  const volume =
    kind === "volume"
      ? await checkVolumeChoice(services, row, input.volume, input.stopService)
      : null;
  const zone = await serverTimeZone(services.db, row.server_id);
  const next = input.enabled ? nextRunFor(input.cron, zone) : null;
  const database =
    kind === "database" && row.kind !== "libsql" && input.database ? input.database : null;
  if (kind === "database") checkDatabaseChoice(row, database);
  let id: string;
  try {
    id = await services.db.transaction().execute(async (trx) => {
      const inserted = await trx
        .insertInto("backup_schedule")
        .values({
          workspace_id: actor.workspace.id,
          service_id: row.id,
          destination_id: destination.id,
          kind,
          database_name: database,
          volume_name: volume?.volume ?? null,
          inner_service: volume?.innerService ?? null,
          stop_service: volume?.stopService ?? false,
          folder: input.folder,
          cron: input.cron,
          keep: input.keep,
          enabled: input.enabled,
          next_run_at: next,
          created_by: actor.personId,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await recordAudit(trx, services.log, auditActor(actor), {
        action: "backup-schedule.added",
        workspaceId: actor.workspace.id,
        target: { kind: "backup_schedule", id: inserted.id },
        details: {
          serviceId: row.id,
          destination: destination.name,
          folder: input.folder,
          cron: input.cron,
          keep: input.keep,
          volume: volume?.volume ?? null,
        },
      });
      return inserted.id;
    });
  } catch (error) {
    if (folderTaken(error)) throw FOLDER_TAKEN(kind);
    throw error;
  }
  if (next) await wakeScheduler(services.db, next);
  return oneSchedule(services.db, row, id);
}

async function oneSchedule(db: Db, row: ServiceRow, id: string): Promise<ScheduleView> {
  const view = (await scheduleViews(db, row)).find((item) => item.id === id);
  if (!view) throw new AppError("not_found", SCHEDULE_NOT_FOUND);
  return view;
}

/** A schedule and its service, after checking backup rights on that service. */
async function scheduleFor(
  services: ControlServices,
  actor: WorkspaceActor,
  scheduleId: string,
): Promise<{ schedule: ScheduleRow; service: ServiceContext }> {
  if (!isOurId(scheduleId)) throw new AppError("not_found", SCHEDULE_NOT_FOUND);
  const schedule = await services.db
    .selectFrom("backup_schedule")
    .selectAll()
    .where("id", "=", scheduleId)
    .where("workspace_id", "=", actor.workspace.id)
    .executeTakeFirst();
  if (!schedule) throw new AppError("not_found", SCHEDULE_NOT_FOUND);
  try {
    return { schedule, service: await serviceFor(services, actor, schedule.service_id) };
  } catch (error) {
    if (error instanceof AppError && error.code === "not_found") {
      throw new AppError("not_found", SCHEDULE_NOT_FOUND);
    }
    throw error;
  }
}

export async function updateSchedule(
  services: ControlServices,
  actor: WorkspaceActor,
  scheduleId: string,
  input: UpdateScheduleRequest,
): Promise<ScheduleView> {
  const { schedule, service } = await scheduleFor(services, actor, scheduleId);
  const { row } = service;
  // Changing anything about a schedule needs a destination the person can use (spec 17.5).
  const destination = await requireDestination(
    services,
    actor,
    input.destinationId ?? schedule.destination_id,
  );
  const changes: Updateable<BackupScheduleTable> = {};
  if (destination.id !== schedule.destination_id) changes.destination_id = destination.id;
  if (input.folder !== undefined && input.folder !== schedule.folder) changes.folder = input.folder;
  if (input.cron !== undefined && input.cron !== schedule.cron) changes.cron = input.cron;
  if (input.keep !== undefined && input.keep !== schedule.keep) changes.keep = input.keep;
  if (input.enabled !== undefined && input.enabled !== schedule.enabled)
    changes.enabled = input.enabled;
  if (schedule.kind === "database" && input.database !== undefined && row.kind !== "libsql") {
    const database = input.database === "" ? null : input.database;
    if (database !== schedule.database_name) {
      checkDatabaseChoice(row, database);
      changes.database_name = database;
    }
  }
  if (
    schedule.kind === "volume" &&
    (input.volume !== undefined || input.stopService !== undefined)
  ) {
    const choice = await checkVolumeChoice(
      services,
      row,
      input.volume ?? schedule.volume_name ?? undefined,
      input.stopService ?? schedule.stop_service,
    );
    if (choice.volume !== schedule.volume_name) changes.volume_name = choice.volume;
    if (choice.innerService !== schedule.inner_service) changes.inner_service = choice.innerService;
    if (choice.stopService !== schedule.stop_service) changes.stop_service = choice.stopService;
  }
  const enabled = (changes.enabled as boolean | undefined) ?? schedule.enabled;
  const cron = (changes.cron as string | undefined) ?? schedule.cron;
  let next: Date | null = null;
  if (enabled) {
    next =
      changes.cron !== undefined || changes.enabled !== undefined || !schedule.next_run_at
        ? nextRunFor(cron, await serverTimeZone(services.db, row.server_id))
        : new Date(schedule.next_run_at);
  }
  if (Object.keys(changes).length > 0) {
    try {
      await services.db
        .updateTable("backup_schedule")
        .set({ ...changes, next_run_at: next, updated_at: sql<Date>`now()` })
        .where("id", "=", schedule.id)
        .where("workspace_id", "=", actor.workspace.id)
        .execute();
    } catch (error) {
      if (folderTaken(error))
        throw FOLDER_TAKEN(schedule.kind === "volume" ? "volume" : "database");
      throw error;
    }
    await recordAudit(services.db, services.log, auditActor(actor), {
      action: "backup-schedule.updated",
      workspaceId: actor.workspace.id,
      target: { kind: "backup_schedule", id: schedule.id },
      details: { serviceId: row.id, ...changes },
    });
    if (next) await wakeScheduler(services.db, next);
  }
  return oneSchedule(services.db, row, schedule.id);
}

export async function deleteSchedule(
  services: ControlServices,
  actor: WorkspaceActor,
  scheduleId: string,
): Promise<{ deleted: true; message: string }> {
  const { schedule, service } = await scheduleFor(services, actor, scheduleId);
  await services.db.transaction().execute(async (trx) => {
    await cancelWaitingRuns(trx, schedule.id);
    await trx
      .deleteFrom("backup_schedule")
      .where("id", "=", schedule.id)
      .where("workspace_id", "=", actor.workspace.id)
      .execute();
    await recordAudit(trx, services.log, auditActor(actor), {
      action: "backup-schedule.deleted",
      workspaceId: actor.workspace.id,
      target: { kind: "backup_schedule", id: schedule.id },
      details: { serviceId: service.row.id, folder: schedule.folder },
    });
  });
  return { deleted: true, message: BACKUP_MESSAGES.scheduleDeleted };
}

/** The run fields a schedule's runs carry. */
export async function scheduleRunInput(
  db: Db,
  schedule: ScheduleRow,
  service: ServiceContext,
  trigger: "schedule" | "manual",
  requestedBy: string | null,
) {
  const destination = await db
    .selectFrom("backup_destination")
    .select("name")
    .where("id", "=", schedule.destination_id)
    .executeTakeFirstOrThrow();
  return {
    workspaceId: schedule.workspace_id,
    scheduleId: schedule.id,
    serviceId: service.row.id,
    operation: "backup" as const,
    kind: schedule.kind,
    serviceKind: service.row.kind,
    serviceName: service.row.name,
    appName: service.row.app_name,
    projectName: service.projectName,
    environmentName: service.environmentName,
    serverId: service.row.server_id,
    destinationId: schedule.destination_id,
    destinationName: destination.name,
    databaseName:
      schedule.kind === "database" ? (schedule.database_name ?? ownDatabase(service.row)) : null,
    volumeName: schedule.volume_name,
    fileKey: null,
    trigger,
    dueAt: null,
    requestedBy,
    // A copy with the service stopped never overlaps another one, or a restore (R3-48).
    exclusive: schedule.kind === "volume" && schedule.stop_service,
  };
}

/** Run now (spec 08 8.3): starts in the background and answers at once. */
export async function runScheduleNow(
  services: ControlServices,
  actor: WorkspaceActor,
  scheduleId: string,
  requestKey: string | null = null,
): Promise<{ run: RunView; message: string; replaced: boolean; waiting: boolean }> {
  const { schedule, service } = await scheduleFor(services, actor, scheduleId);
  await requireDestination(services, actor, schedule.destination_id);
  // A retried request (a proxy or a client after a timeout) gets the run it already started.
  const repeated = async () => {
    if (!requestKey) return null;
    const row = await services.db
      .selectFrom("backup_run")
      .selectAll()
      .where("schedule_id", "=", schedule.id)
      .where("request_key", "=", requestKey)
      .executeTakeFirst();
    return row
      ? { run: runView(row), message: BACKUP_MESSAGES.runStarted, replaced: false, waiting: false }
      : null;
  };
  const earlier = await repeated();
  if (earlier) return earlier;
  const input = {
    ...(await scheduleRunInput(services.db, schedule, service, "manual", actor.personId)),
    requestKey,
  };
  let requested: RequestedRun;
  try {
    requested = await services.db.transaction().execute((trx) => requestScheduleRun(trx, input));
  } catch (error) {
    const again = (error as { code?: string }).code === "23505" ? await repeated() : null;
    if (again) return again;
    throw error;
  }
  await recordAudit(services.db, services.log, auditActor(actor), {
    action: "backup.run-requested",
    workspaceId: actor.workspace.id,
    target: { kind: "backup_run", id: requested.run.id },
    details: { scheduleId: schedule.id, serviceId: service.row.id },
  });
  return {
    run: runView(requested.run),
    message: requested.waiting
      ? BACKUP_MESSAGES.runQueued
      : requested.replaced
        ? BACKUP_MESSAGES.runReplaced
        : BACKUP_MESSAGES.runStarted,
    replaced: requested.replaced,
    waiting: requested.waiting,
  };
}

/** For the job: the schedule and service of a run, without a person (the scheduler's own). */
export async function loadScheduleContext(
  db: Db,
  scheduleId: string,
): Promise<{ schedule: ScheduleRow; service: ServiceContext } | null> {
  const schedule = await db
    .selectFrom("backup_schedule")
    .selectAll()
    .where("id", "=", scheduleId)
    .executeTakeFirst();
  if (!schedule) return null;
  const row = await loadService(db, schedule.workspace_id, schedule.service_id);
  if (!row) return null;
  const names = await db
    .selectFrom("project as p")
    .innerJoin("environment as e", "e.project_id", "p.id")
    .select(["p.name as project", "e.name as environment"])
    .where("e.id", "=", row.environment_id)
    .executeTakeFirstOrThrow();
  return {
    schedule,
    service: { row, projectName: names.project, environmentName: names.environment },
  };
}
