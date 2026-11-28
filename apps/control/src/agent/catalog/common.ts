import { AppError, SERVICE_KIND_LABELS } from "@nearzero/shared";
import { z } from "zod";
import { check } from "../../http/validate.ts";
import { HOST_TARGET } from "../../runners/hub.ts";
import { pause } from "../abort.ts";
import type { AccessRef, AgentContext } from "../context.ts";
import { requireProductionAllowed, ServerChoiceNeeded } from "../context.ts";
import {
  type ProjectRef,
  resolveEnvironment,
  resolveProject,
  resolveServer,
  resolveService,
  type ServiceRef,
  visibleServers,
} from "../resolve.ts";

/** Pieces every catalog module uses: input fields, targets, references, gates. */

export const nameRef = (what: string) =>
  z
    .string()
    .trim()
    .min(1)
    .max(300)
    .describe(
      `The ${what}'s name as the person wrote it (typos are fine), or its id from an earlier result.`,
    );

export const serviceInput = {
  service: nameRef("service").describe(
    "The service's name (typos are fine), its internal app name, a container name, a deployment log path, or its id from an earlier result.",
  ),
  project: z
    .string()
    .trim()
    .max(300)
    .optional()
    .describe("The project, when several services share the name."),
  environment: z
    .string()
    .trim()
    .max(100)
    .optional()
    .describe("The environment, when several services share the name."),
};

export async function findService(
  ctx: AgentContext,
  input: { service: string; project?: string | undefined; environment?: string | undefined },
): Promise<ServiceRef> {
  return resolveService(ctx, input.service, {
    project: input.project ?? null,
    environment: input.environment ?? null,
  });
}

export function serviceRefs(service: ServiceRef): AccessRef[] {
  return [
    {
      kind: "service",
      id: service.id,
      projectId: service.projectId,
      environmentId: service.environmentId,
    },
  ];
}

/**
 * Everything a listing of projects shows: each project, each environment and each service in it,
 * so a viewer of a shared chat sees the row only when they could see all of it themselves
 * (spec 19.5, 24 G6; C1-06). Naming only the projects let a member who sees one service read
 * every environment and service of the author's.
 */
export function listingRefs(
  projects: readonly { id: string; environments: readonly { id: string }[] }[],
  services: readonly ServiceRef[],
): AccessRef[] {
  const refs: AccessRef[] = [];
  for (const project of projects) {
    refs.push({ kind: "project", id: project.id });
    for (const environment of project.environments) {
      refs.push({ kind: "environment", id: environment.id, projectId: project.id });
      for (const service of services) {
        if (service.environmentId === environment.id) refs.push(...serviceRefs(service));
      }
    }
  }
  return refs;
}

/** "web on prod-1" (spec 19.4). */
export function onServer(service: ServiceRef): string {
  return `${service.name} on ${service.serverName}`;
}

export function describeService(service: ServiceRef) {
  return {
    id: service.id,
    name: service.name,
    kind: SERVICE_KIND_LABELS[service.kind],
    project: service.projectName,
    environment: service.environmentName,
    production: service.isProduction,
    server: service.serverName,
    status: service.status,
    appName: service.appName,
  };
}

/** A change to a service: production needs its own policy (spec 19.9). */
export function guardService(ctx: AgentContext, service: ServiceRef): void {
  requireProductionAllowed(ctx, service.environmentName);
}

export async function findProjectEnvironment(
  ctx: AgentContext,
  input: { project: string; environment?: string | undefined },
): Promise<{ project: ProjectRef; environment: ProjectRef["environments"][number] }> {
  const project = await resolveProject(ctx, input.project);
  const environment = resolveEnvironment(project, input.environment);
  return { project, environment };
}

/** The Nearzero host as the server picker offers it (the guided import's words). */
export const NEARZERO_HOST_OPTION = "Nearzero host — the machine Nearzero itself runs on";

/**
 * Where a new service goes: the named server; else, when any server is ready, the person picks
 * one (or the Nearzero host when they may use it) in a form, never placed silently (30d R4-08);
 * else the Nearzero host when they may use it (the reply says so, spec 19.12).
 */
/**
 * A server that isn't set up can't take a new service or a deploy (31d G4-03): what the person
 * reads says so and points at setup, instead of a runner that "reconnects by itself". The
 * Nearzero host is set up by the installer.
 */
export async function requireServerReady(
  ctx: AgentContext,
  server: { id: string; name: string },
  nothing: "created" | "deployed" | "changed",
): Promise<void> {
  if (server.id === HOST_TARGET) return;
  const row = await ctx.services.db
    .selectFrom("server")
    .select("setup_state")
    .where("id", "=", server.id)
    .where("workspace_id", "=", ctx.actor.workspace.id)
    .executeTakeFirst();
  if (!row || row.setup_state === "ready") return;
  const why =
    row.setup_state === "failed"
      ? "its setup failed"
      : row.setup_state === "running"
        ? "its setup is still running"
        : "it hasn't been set up yet";
  throw new AppError(
    "conflict",
    `Server "${server.name}" isn't ready for deployments: ${why}, so nothing was ${nothing}. ${
      row.setup_state === "running"
        ? "Wait for setup to finish on the server's page, then ask again."
        : "Run setup from the server's page (or ask me to set it up), then ask again."
    }`,
  );
}

export async function placeService(
  ctx: AgentContext,
  server: string | undefined,
): Promise<{ id: string; name: string; note: string | null }> {
  if (server?.trim()) {
    const found = await resolveServer(ctx, server);
    await requireServerReady(ctx, found, "created");
    return { id: found.id, name: found.name, note: null };
  }
  const reachable = await visibleServers(ctx);
  const others = reachable.filter((item) => !item.isHost);
  const ready = others.length
    ? await ctx.services.db
        .selectFrom("server")
        .select(["id", "name", "address"])
        .where(
          "id",
          "in",
          others.map((item) => item.id),
        )
        .where("setup_state", "=", "ready")
        .orderBy("name")
        .execute()
    : [];
  if (ready.length > 0) {
    throw new ServerChoiceNeeded([
      ...ready.map((item) => ({
        value: item.id,
        label: item.name,
        ...(item.address ? { description: item.address } : {}),
      })),
      ...(reachable.some((item) => item.isHost)
        ? [{ value: HOST_TARGET, label: NEARZERO_HOST_OPTION }]
        : []),
    ]);
  }
  if (reachable.some((item) => item.isHost)) {
    return {
      id: HOST_TARGET,
      name: "Nearzero host",
      note: "No ready server was named or available, so it was placed on the Nearzero host (the machine Nearzero itself runs on). Tell the person.",
    };
  }
  throw new AppError(
    "invalid_request",
    "The person has no ready server to put this on. Ask them to add and set up a server first.",
  );
}

/** Parses with an area's own request schema, so refusals use the console's words. */
export function asRequest<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
): z.output<Schema> {
  return check(schema, value);
}

export function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Waits between checks; false when the person pressed Stop. */
export const sleep = pause;
