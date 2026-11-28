import {
  AppError,
  type deleteProjectRequestSchema,
  type deleteServiceRequestSchema,
  type deleteServicesRequestSchema,
  isProductionEnvironment,
  type ServiceKind,
} from "@nearzero/shared";
import type { z } from "zod";
import { isWorkspaceAdmin } from "../access/evaluate.ts";
import { recordAudit } from "../audit/audit.ts";
import type { Db } from "../db/database.ts";
import { auditActor, type WorkspaceActor } from "../http/actor.ts";
import { JobQueue } from "../jobs/queue.ts";
import { isOurId, projectTarget, serviceTarget } from "../projects/objects.ts";
import { copiesOf, loadService } from "../services/records.ts";
import type { ControlServices } from "../services.ts";
import {
  buildProjectPlan,
  buildServicesPlan,
  type Candidate,
  chosenCandidates,
  DEPLOYING_REFUSAL,
  missingService,
  projectCandidates,
} from "./plan.ts";
import {
  closeUntrackedRun,
  isRunTracked,
  RUN_COLUMNS,
  type RunRow,
  runningProjectRun,
} from "./state.ts";

/**
 * Starting deletes and following them (spec 05 5.1, 5.2). A delete runs in the background with
 * a state per service (waiting, removing, removed, not removed). The person can close the
 * dialog; reopening shows the same run.
 */

export const REMOVE_SERVICES_JOB = "deletion.remove-services";

export interface DeleteRunView {
  id: string;
  scope: "project" | "services";
  state: "running" | "succeeded" | "failed";
  /** False when a running delete is no longer being carried out (start it again). */
  tracked: boolean;
  project: { id: string; name: string; kept: boolean };
  items: {
    serviceId: string | null;
    name: string | null;
    kind: ServiceKind | null;
    environmentName: string;
    production: boolean;
    state: "waiting" | "removing" | "removed" | "not_removed";
    reason: string | null;
  }[];
  counts: { waiting: number; removing: number; removed: number; notRemoved: number };
  message: string;
  createdAt: string;
  finishedAt: string | null;
}

function runMessage(run: RunRow, tracked: boolean, counts: DeleteRunView["counts"]): string {
  if (run.state === "running") {
    return tracked
      ? "You can close this; the delete keeps going."
      : "This delete is no longer tracked: the platform restarted before it finished. Start it again to finish it.";
  }
  const total = counts.removed + counts.notRemoved;
  if (run.scope === "project") {
    return run.state === "succeeded"
      ? `${run.project_name} was deleted.`
      : "The project was kept. Some services couldn't be removed; each shows why. Fix that, then delete again.";
  }
  if (run.state === "succeeded") {
    return total === 1 ? "Service removed" : `${total} services removed`;
  }
  return counts.removed > 0 ? "Service removed, but not everywhere" : "Nothing was removed.";
}

export async function runView(db: Db, actor: WorkspaceActor, run: RunRow): Promise<DeleteRunView> {
  const rows = await db
    .selectFrom("delete_run_item")
    .select([
      "service_id",
      "environment_id",
      "environment_name",
      "service_name",
      "kind",
      "production",
      "state",
      "reason",
    ])
    .where("run_id", "=", run.id)
    .orderBy("position")
    .execute();
  const tracked = await isRunTracked(db, run);
  const mine = run.requested_by === actor.personId;
  const counts = {
    waiting: rows.filter((row) => row.state === "waiting").length,
    removing: rows.filter((row) => row.state === "removing").length,
    removed: rows.filter((row) => row.state === "removed").length,
    notRemoved: rows.filter((row) => row.state === "not_removed").length,
  };
  return {
    id: run.id,
    scope: run.scope,
    state: run.state,
    tracked,
    project: {
      id: run.project_id,
      name: run.project_name,
      kept: run.scope === "services" || run.state !== "succeeded",
    },
    items: rows.map((row) => {
      const seen =
        mine ||
        actor.access.can(
          "service.see",
          serviceTarget({
            id: row.service_id,
            project_id: run.project_id,
            environment_id: row.environment_id,
          }),
        );
      return {
        serviceId: seen ? row.service_id : null,
        name: seen ? row.service_name : null,
        kind: seen ? row.kind : null,
        environmentName: row.environment_name,
        production: row.production,
        state: row.state,
        reason: row.reason,
      };
    }),
    counts,
    message: runMessage(run, tracked, counts),
    createdAt: run.created_at.toISOString(),
    finishedAt: run.finished_at?.toISOString() ?? null,
  };
}

function canFollow(actor: WorkspaceActor, run: RunRow): boolean {
  return (
    run.requested_by === actor.personId ||
    isWorkspaceAdmin(actor.role) ||
    actor.access.can("project.see", projectTarget(run.project_id))
  );
}

function runNotFound(): AppError {
  return new AppError(
    "not_found",
    "This delete doesn't exist in this workspace, or you don't have access to it.",
  );
}

export async function getRun(
  services: ControlServices,
  actor: WorkspaceActor,
  runId: string,
): Promise<DeleteRunView> {
  if (!isOurId(runId)) throw runNotFound();
  const run = await services.db
    .selectFrom("delete_run")
    .select(RUN_COLUMNS)
    .where("workspace_id", "=", actor.workspace.id)
    .where("id", "=", runId)
    .executeTakeFirst();
  if (!run || !canFollow(actor, run)) throw runNotFound();
  return runView(services.db, actor, run);
}

/** The latest delete of a whole project, for "X is already being deleted." and its results. */
export async function latestProjectRun(
  services: ControlServices,
  actor: WorkspaceActor,
  projectId: string,
): Promise<DeleteRunView | null> {
  if (!isOurId(projectId)) throw runNotFound();
  const run = await services.db
    .selectFrom("delete_run")
    .select(RUN_COLUMNS)
    .where("workspace_id", "=", actor.workspace.id)
    .where("project_id", "=", projectId)
    .where("scope", "=", "project")
    .orderBy("created_at", "desc")
    .limit(1)
    .executeTakeFirst();
  if (!run) {
    // Nothing to show; still answer "not found" for projects the person can't see.
    await actor.access.require("project.see", { kind: "project", id: projectId });
    return null;
  }
  if (!canFollow(actor, run)) throw runNotFound();
  return runView(services.db, actor, run);
}

function confirmMismatch(what: string, name: string): AppError {
  const message = `Type the ${what} name, ${name}, to confirm.`;
  return new AppError("invalid_request", message, { fields: { confirm: message } });
}

function stalePlan(): AppError {
  return new AppError(
    "conflict",
    "This changed after the plan was shown, so nothing was deleted. Review the new plan and try again.",
  );
}

/** Services in another delete: refuse while that one is tracked, otherwise end it. */
async function releaseStaleRuns(db: Db, candidates: Candidate[]): Promise<void> {
  for (const row of candidates) {
    if (!row.deleting_run_id) continue;
    const run = await db
      .selectFrom("delete_run")
      .select(["id", "state", "job_id"])
      .where("id", "=", row.deleting_run_id)
      .executeTakeFirst();
    if (run && (await isRunTracked(db, run))) {
      throw new AppError("conflict", `${row.name} is already being deleted.`);
    }
    if (run) await closeUntrackedRun(db, run.id);
  }
}

function refuseDeploying(candidates: Candidate[]): void {
  const deploying = candidates.find((row) => row.status === "deploying");
  if (deploying) {
    throw new AppError(
      "conflict",
      candidates.length === 1
        ? DEPLOYING_REFUSAL
        : `${deploying.name} is deploying. ${DEPLOYING_REFUSAL}`,
    );
  }
}

/** Writes the run, its items and its job in the caller's transaction. */
async function createRun(
  db: Db,
  actor: WorkspaceActor,
  input: {
    scope: "project" | "services";
    project: { id: string; name: string };
    candidates: Candidate[];
    fingerprint: string | null;
  },
): Promise<RunRow> {
  const run = await db
    .insertInto("delete_run")
    .values({
      workspace_id: actor.workspace.id,
      scope: input.scope,
      project_id: input.project.id,
      project_name: input.project.name,
      fingerprint: input.fingerprint,
      requested_by: actor.personId,
    })
    .returning(RUN_COLUMNS)
    .executeTakeFirstOrThrow();
  if (input.candidates.length > 0) {
    await db
      .insertInto("delete_run_item")
      .values(
        input.candidates.map((row, position) => ({
          run_id: run.id,
          position,
          service_id: row.id,
          environment_id: row.environment_id,
          environment_name: row.environment_name,
          service_name: row.name,
          kind: row.kind,
          app_name: row.app_name,
          server_id: row.server_id,
          production: isProductionEnvironment(row.environment_name),
          stop_first: row.status === "running",
        })),
      )
      .execute();
    await db
      .updateTable("service")
      .set({ deleting_run_id: run.id })
      .where(
        "id",
        "in",
        input.candidates.map((row) => row.id),
      )
      .execute();
  }
  // The job is written in the same transaction, so a run never exists without its job.
  const queue = new JobQueue(db, { workerId: "control-api" });
  const job = await queue.enqueue({
    kind: REMOVE_SERVICES_JOB,
    payload: { runId: run.id },
    maxAttempts: 10,
    idempotencyKey: `delete-run:${run.id}`,
  });
  await db.updateTable("delete_run").set({ job_id: job.id }).where("id", "=", run.id).execute();
  return { ...run, job_id: job.id };
}

/** Deletes a whole project in the background, if the plan the person saw still holds. */
export async function startProjectDelete(
  services: ControlServices,
  actor: WorkspaceActor,
  projectId: string,
  input: z.output<typeof deleteProjectRequestSchema>,
): Promise<DeleteRunView> {
  const { db } = services;
  await actor.access.require("project.delete", { kind: "project", id: projectId });
  const run = await db.transaction().execute(async (trx) => {
    const project = await trx
      .selectFrom("project")
      .select(["id", "name"])
      .where("id", "=", projectId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (input.confirm.trim() !== project.name) throw confirmMismatch("project", project.name);
    const running = await runningProjectRun(trx, projectId);
    if (running) {
      if (await isRunTracked(trx, running)) {
        throw new AppError("conflict", `${project.name} is already being deleted.`);
      }
      await closeUntrackedRun(trx, running.id);
    }
    const plan = await buildProjectPlan(trx, actor, projectId, { lock: true });
    if (plan.fingerprint !== input.fingerprint) throw stalePlan();
    if (!plan.canDelete) throw new AppError("forbidden", plan.blockers.join(" "));
    const candidates = await projectCandidates(trx, projectId);
    return createRun(trx, actor, {
      scope: "project",
      project,
      candidates,
      fingerprint: plan.fingerprint,
    });
  });
  await recordAudit(db, services.log, auditActor(actor), {
    action: "project.delete-started",
    workspaceId: actor.workspace.id,
    target: { kind: "project", id: projectId },
    details: { name: run.project_name, runId: run.id },
  });
  return runView(db, actor, run);
}

/** The Services page's bulk delete: the person types the project's name. */
export async function startServicesDelete(
  services: ControlServices,
  actor: WorkspaceActor,
  environmentId: string,
  input: z.output<typeof deleteServicesRequestSchema>,
): Promise<DeleteRunView> {
  const { db } = services;
  await actor.access.require("environment.see", { kind: "environment", id: environmentId });
  const run = await db.transaction().execute(async (trx) => {
    const candidates = await chosenCandidates(trx, actor.workspace.id, input.serviceIds, {
      lock: true,
    });
    for (const row of candidates) {
      if (row.environment_id !== environmentId) throw missingService();
      if (!actor.access.can("service.see", serviceTarget(row))) throw missingService();
    }
    const plan = await buildServicesPlan(trx, actor, candidates);
    if (input.confirm.trim() !== plan.project.name) {
      throw confirmMismatch("project", plan.project.name);
    }
    if (plan.fingerprint !== input.fingerprint) throw stalePlan();
    refuseDeploying(candidates);
    if (plan.counts.noAccess > 0) {
      const refused = candidates.find(
        (row) => !actor.access.can("service.delete", serviceTarget(row)),
      );
      const decision = refused
        ? actor.access.decide("service.delete", serviceTarget(refused))
        : null;
      throw new AppError(
        "forbidden",
        decision && !decision.allowed ? decision.message : plan.blockers.join(" "),
      );
    }
    await releaseStaleRuns(trx, candidates);
    return createRun(trx, actor, {
      scope: "services",
      project: plan.project,
      candidates,
      fingerprint: plan.fingerprint,
    });
  });
  await recordAudit(db, services.log, auditActor(actor), {
    action: "service.delete-started",
    workspaceId: actor.workspace.id,
    target: { kind: "environment", id: environmentId },
    details: { runId: run.id, services: input.serviceIds.length },
  });
  return runView(db, actor, run);
}

export interface ServiceDeletePlan {
  service: {
    id: string;
    name: string;
    kind: ServiceKind;
    environment: { id: string; name: string };
    production: boolean;
    willStop: boolean;
  };
  canDelete: boolean;
  blockers: string[];
  /** "The same service in other environments": copies the viewer can open, all unticked. */
  copies: {
    id: string;
    environmentId: string;
    environmentName: string;
    /** "env (name)". */
    label: string;
    production: boolean;
    canDelete: boolean;
    deploying: boolean;
  }[];
  copiesHint: string | null;
  /** What the person types to confirm: the service's name. */
  confirmText: string;
}

/** The delete dialog of one service, with its copies in other environments. */
export async function serviceDeletePlan(
  services: ControlServices,
  actor: WorkspaceActor,
  serviceId: string,
): Promise<ServiceDeletePlan> {
  const { db } = services;
  await actor.access.require("service.see", { kind: "service", id: serviceId });
  const row = await loadService(db, actor.workspace.id, serviceId);
  if (!row) throw missingService();
  const environment = await db
    .selectFrom("environment")
    .select(["id", "name"])
    .where("id", "=", row.environment_id)
    .executeTakeFirstOrThrow();
  const target = serviceTarget(row);
  const decision = actor.access.decide("service.delete", target);
  const blockers: string[] = [];
  if (!decision.allowed) blockers.push(decision.message);
  if (row.status === "deploying") blockers.push(DEPLOYING_REFUSAL);
  if (row.deleting_run_id) {
    const run = await db
      .selectFrom("delete_run")
      .select(["id", "state", "job_id"])
      .where("id", "=", row.deleting_run_id)
      .executeTakeFirst();
    if (run && (await isRunTracked(db, run)))
      blockers.push(`${row.name} is already being deleted.`);
  }
  const copies = (await copiesOf(db, row))
    .filter((copy) => actor.access.can("service.see", serviceTarget(copy)))
    .map((copy) => ({
      id: copy.id,
      environmentId: copy.environment_id,
      environmentName: copy.environment_name,
      label: `${copy.environment_name} (${copy.name})`,
      production: isProductionEnvironment(copy.environment_name),
      canDelete: actor.access.can("service.delete", serviceTarget(copy)),
      deploying: copy.status === "deploying",
    }));
  return {
    service: {
      id: row.id,
      name: row.name,
      kind: row.kind,
      environment,
      production: isProductionEnvironment(environment.name),
      willStop: row.status === "running",
    },
    canDelete: blockers.length === 0,
    blockers,
    copies,
    copiesHint:
      copies.length > 0 ? "Only this environment's copy is deleted unless you tick others." : null,
    confirmText: row.name,
  };
}

/** Deletes one service, and the copies the person ticked, in the background. */
export async function startServiceDelete(
  services: ControlServices,
  actor: WorkspaceActor,
  serviceId: string,
  input: z.output<typeof deleteServiceRequestSchema>,
): Promise<DeleteRunView> {
  const { db } = services;
  await actor.access.require("service.delete", { kind: "service", id: serviceId });
  const row = await loadService(db, actor.workspace.id, serviceId);
  if (!row) throw missingService();
  if (input.confirm.trim() !== row.name) throw confirmMismatch("service", row.name);
  const copies = await copiesOf(db, row);
  const chosen = [...new Set(input.alsoDeleteCopyIds)];
  for (const id of chosen) {
    const copy = copies.find((candidate) => candidate.id === id);
    if (!copy || !actor.access.can("service.see", serviceTarget(copy))) {
      throw new AppError(
        "invalid_request",
        "One of the ticked services isn't a copy of this service any more. Reload and try again.",
        { fields: { alsoDeleteCopyIds: "Reload and try again." } },
      );
    }
    await actor.access.require("service.delete", { kind: "service", id });
  }
  const run = await db.transaction().execute(async (trx) => {
    const candidates = await chosenCandidates(trx, actor.workspace.id, [row.id, ...chosen], {
      lock: true,
    });
    // This environment's copy first, then the others in environment order.
    candidates.sort((a, b) => (a.id === row.id ? -1 : b.id === row.id ? 1 : 0));
    refuseDeploying(candidates);
    await releaseStaleRuns(trx, candidates);
    const project = await trx
      .selectFrom("project")
      .select(["id", "name"])
      .where("id", "=", row.project_id)
      .executeTakeFirstOrThrow();
    return createRun(trx, actor, { scope: "services", project, candidates, fingerprint: null });
  });
  await recordAudit(db, services.log, auditActor(actor), {
    action: "service.delete-started",
    workspaceId: actor.workspace.id,
    target: { kind: "service", id: row.id },
    details: { runId: run.id, name: row.name, alsoCopies: chosen.length },
  });
  return runView(db, actor, run);
}
