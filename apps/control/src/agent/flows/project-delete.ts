import { AppError, type FormRequest } from "@nearzero/shared";
import { type DeletePlan, projectDeletePlan } from "../../deletion/plan.ts";
import { type DeleteRunView, getRun, startProjectDelete } from "../../deletion/runs.ts";
import { pause } from "../abort.ts";
import type { AgentContext, SubStep } from "../context.ts";
import type { ProjectRef } from "../resolve.ts";
import { count, policyRefusalText } from "./kit.ts";

/**
 * Deleting a project through the Agent (spec 19.7, 19.8, 20.1), used by the guided flow and by
 * the model's own delete alike: never a project with a production environment, the confirmation
 * form with the exact services, a fresh form when they changed in between, one row per service
 * while they are removed, and a Service | Server | Result | Notes table at the end. The project
 * is kept when any service couldn't be removed.
 */

/** What a waiting confirmation keeps: the plan the person saw, by its fingerprint. */
export interface DeleteConfirmation {
  projectId: string;
  name: string;
  fingerprint: string;
  /** Service id → "<server name>", for the rows and the table. */
  servers: Record<string, string>;
  /** Services that were never deployed: nothing of theirs is on a server. */
  idle: string[];
}

/**
 * Whether the project has a production environment, among all of its environments, not only
 * the ones the person can see (C1-18): a member scoped to development must not delete a project
 * whose production they can't see.
 */
export async function hasProduction(
  ctx: AgentContext,
  project: Pick<ProjectRef, "id">,
): Promise<boolean> {
  const row = await ctx.services.db
    .selectFrom("environment")
    .select("id")
    .where("project_id", "=", project.id)
    .where("workspace_id", "=", ctx.actor.workspace.id)
    .where("name", "=", "production")
    .executeTakeFirst();
  return row !== undefined;
}

export function productionRefusal(name: string): string {
  return `${name} has a production environment, so the Agent never deletes it. It can be deleted from the project's page in the console.`;
}

async function serverNames(ctx: AgentContext, plan: DeletePlan): Promise<Record<string, string>> {
  const ids = [
    ...new Set(
      plan.services
        .map((service) => service.serverId)
        .filter((id): id is string => !!id && id !== "host"),
    ),
  ];
  const rows =
    ids.length === 0
      ? []
      : await ctx.services.db
          .selectFrom("server")
          .select(["id", "name"])
          .where("workspace_id", "=", ctx.actor.workspace.id)
          .where("id", "in", ids)
          .execute();
  const names = new Map(rows.map((server) => [server.id, server.name]));
  const out: Record<string, string> = {};
  for (const service of plan.services) {
    if (!service.id) continue;
    out[service.id] =
      service.serverId === "host" || !service.serverId
        ? "Nearzero host"
        : (names.get(service.serverId) ?? "its server");
  }
  return out;
}

/**
 * Checked every time a delete is prepared and again right before it runs, with the policies and
 * environments as they are then (spec 19.9, 20.1; B1-21, B1-55): a production environment added,
 * or "Delete projects without production" turned off, while the confirmation waited stops it.
 */
export async function ensureAgentMayDelete(
  ctx: AgentContext,
  project: { id: string; name: string },
): Promise<void> {
  if (!ctx.policies["projects.delete-without-production"]) {
    throw new AppError("forbidden", policyRefusalText("projects.delete-without-production"));
  }
  if (await hasProduction(ctx, project)) {
    throw new AppError("forbidden", productionRefusal(project.name));
  }
}

export type DeletePrepared =
  | { kind: "empty"; confirmation: DeleteConfirmation }
  | { kind: "confirm"; confirmation: DeleteConfirmation; form: FormRequest };

/**
 * The plan and, when the project has services, the confirmation form. Refuses (AppError) when a
 * delete is already running or the person may not delete some of the services.
 */
export async function prepareDelete(
  ctx: AgentContext,
  project: { id: string; name: string },
  changed = false,
): Promise<DeletePrepared> {
  await ensureAgentMayDelete(ctx, project);
  const plan = await projectDeletePlan(ctx.services, ctx.actor, project.id);
  if (plan.inProgress) throw new AppError("conflict", plan.inProgress.message);
  if (!plan.canDelete) throw new AppError("forbidden", plan.blockers.join(" "));
  const servers = await serverNames(ctx, plan);
  const confirmation: DeleteConfirmation = {
    projectId: project.id,
    name: project.name,
    fingerprint: plan.fingerprint,
    servers,
    idle: plan.services
      .filter((service) => service.id && service.status === "idle")
      .map((service) => service.id as string),
  };
  if (plan.services.length === 0) return { kind: "empty", confirmation };
  const n = count(plan.services.length, "service");
  return {
    kind: "confirm",
    confirmation,
    form: {
      kind: "project_delete",
      project: { id: project.id, name: project.name },
      summary: `${changed ? `The services of ${project.name} changed since you were asked. ` : ""}Delete ${project.name} and remove these ${n} from their servers? Their containers, volumes, files, logs, images, domains and DNS records are wiped. This cannot be undone.`,
      services: plan.services.map((service) => ({
        line: `${service.name ?? "A service you can't see"} — ${service.kindLabel ?? "service"} on ${(service.id && servers[service.id]) || "its server"} (${service.environment?.name ?? "an environment you can't see"})`,
      })),
      confirmLabel: `Delete ${project.name} and ${n}`,
      confirmHint: "Wipes their data from the servers",
      keepLabel: "Keep it",
    },
  };
}

/** True when the services are still exactly the ones the person confirmed. */
export async function stillConfirmed(
  ctx: AgentContext,
  confirmation: DeleteConfirmation,
): Promise<boolean> {
  const plan = await projectDeletePlan(ctx.services, ctx.actor, confirmation.projectId);
  return plan.fingerprint === confirmation.fingerprint;
}

export interface DeleteOutcome {
  state: DeleteRunView["state"] | "running";
  kept: boolean;
  removed: number;
  notRemoved: number;
  table: string | null;
  message: string;
}

function resultWord(
  item: DeleteRunView["items"][number],
  confirmation: DeleteConfirmation,
): string {
  if (item.state === "not_removed") return "Not removed";
  if (item.state !== "removed") return "Still removing";
  return item.serviceId && confirmation.idle.includes(item.serviceId) ? "Already gone" : "Removed";
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

export function deleteTable(run: DeleteRunView, confirmation: DeleteConfirmation): string | null {
  if (run.items.length === 0) return null;
  const lines = ["| Service | Server | Result | Notes |", "| --- | --- | --- | --- |"];
  for (const item of run.items) {
    const server = (item.serviceId && confirmation.servers[item.serviceId]) || "—";
    const note =
      item.reason ??
      (resultWord(item, confirmation) === "Already gone" ? "It was never deployed." : "");
    lines.push(
      `| ${cell(item.name ?? "A service you can't see")} | ${cell(server)} | ${resultWord(item, confirmation)} | ${cell(note)} |`,
    );
  }
  return lines.join("\n");
}

/**
 * Starts the delete for exactly the confirmed services and follows it, one row per service
 * ("Removing service · web on prod-1"), for up to 15 minutes; after that it keeps going alone.
 */
export async function runDelete(
  ctx: AgentContext,
  confirmation: DeleteConfirmation,
): Promise<DeleteOutcome> {
  await ensureAgentMayDelete(ctx, { id: confirmation.projectId, name: confirmation.name });
  const started = await startProjectDelete(ctx.services, ctx.actor, confirmation.projectId, {
    fingerprint: confirmation.fingerprint,
    confirm: confirmation.name,
  });
  const rows = new Map<string, SubStep>();
  const finished = new Set<string>();
  const deadline = Date.now() + 15 * 60_000;
  let run = started;
  for (;;) {
    for (const [index, item] of run.items.entries()) {
      const key = item.serviceId ?? `#${index}`;
      const where = (item.serviceId && confirmation.servers[item.serviceId]) || "its server";
      if (!rows.has(key) && item.state !== "waiting") {
        rows.set(key, ctx.subStep("Removing service", `${item.name ?? "a service"} on ${where}`));
        ctx.status("Removing service");
      }
      const step = rows.get(key);
      if (
        step &&
        !finished.has(key) &&
        (item.state === "removed" || item.state === "not_removed")
      ) {
        finished.add(key);
        await step.finish(
          item.state === "removed" ? "succeeded" : "failed",
          item.state === "removed" ? "Removed service" : "Removing service",
          item.state === "not_removed" ? (item.reason ?? "It couldn't be removed.") : null,
        );
      }
    }
    if (run.state !== "running" || Date.now() > deadline) break;
    if (!(await pause(ctx.settings.followDeployIntervalMs, ctx.signal))) break;
    run = await getRun(ctx.services, ctx.actor, started.id);
  }
  return {
    state: run.state,
    kept: run.project.kept || run.counts.notRemoved > 0,
    removed: run.counts.removed,
    notRemoved: run.counts.notRemoved,
    table: deleteTable(run, confirmation),
    message: run.message,
  };
}

/** The reply after a delete, for the person (the model gets the same facts). */
export function deleteReply(name: string, outcome: DeleteOutcome, bolded: string): string {
  const table = outcome.table ? `\n\n${outcome.table}` : "";
  if (outcome.state === "running") {
    return `${bolded} is still being deleted; it keeps going on its own. Its progress is on the project's page.${table}`;
  }
  if (outcome.kept) {
    return `I kept ${bolded}: ${count(outcome.notRemoved, "service")} couldn't be removed, and each row says why. Fix that, then ask me to delete ${name} again.${table}`;
  }
  if (outcome.removed === 0) return `Deleted ${bolded}. It had no services.`;
  return `Deleted ${bolded} and removed ${outcome.removed === 1 ? "its service" : `its ${outcome.removed} services`} from their servers.${table}`;
}
