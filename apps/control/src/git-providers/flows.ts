import { AppError, GIT_FLOW_MINUTES } from "@nearzero/shared";
import { sql } from "kysely";
import type { WorkspaceActor } from "../http/actor.ts";
import { randomToken, sha256Hex } from "../security/tokens.ts";
import type { ControlServices } from "../services.ts";
import type { GitFlowPurpose } from "./tables.ts";

/**
 * Connect flows (spec 16.1, 16.2): the state sent to GitHub, GitLab or Gitea and back. Only its
 * SHA-256 is stored. A state belongs to the person who started it and the workspace they were
 * in, works once, and expires after 30 minutes, so a link or a stolen state can't finish someone
 * else's connection.
 */

export interface FlowRecord {
  id: string;
  workspaceId: string;
  personId: string;
  providerId: string | null;
  purpose: GitFlowPurpose;
  returnTo: string | null;
  details: Record<string, unknown>;
  expiresAt: Date;
  usedAt: Date | null;
}

export const FLOW_UNKNOWN =
  "This connection link isn't valid. Start connecting again from Settings → Git providers.";
export const FLOW_USED = "This connection was already finished. Check Settings → Git providers.";
export const FLOW_EXPIRED = `This connection wasn't finished within ${GIT_FLOW_MINUTES} minutes, so it expired. Start connecting again.`;
export const FLOW_OTHER_PERSON =
  "This connection was started by someone else. Sign in as the person who started it, or start connecting again.";
export const FLOW_OTHER_WORKSPACE =
  "This connection was started in another workspace. Switch to that workspace, then try again.";

/** Whether a flow may be finished by this person now; null when it may. Pure, for tests. */
export function flowProblem(
  flow: Pick<FlowRecord, "personId" | "workspaceId" | "purpose" | "expiresAt" | "usedAt"> | null,
  who: { personId: string; workspaceId: string; purpose: GitFlowPurpose; now: number },
): string | null {
  if (!flow || flow.purpose !== who.purpose) return FLOW_UNKNOWN;
  if (flow.personId !== who.personId) return FLOW_OTHER_PERSON;
  if (flow.usedAt) return FLOW_USED;
  if (flow.expiresAt.getTime() <= who.now) return FLOW_EXPIRED;
  if (flow.workspaceId !== who.workspaceId) return FLOW_OTHER_WORKSPACE;
  return null;
}

export async function startFlow(
  services: ControlServices,
  actor: WorkspaceActor,
  input: {
    purpose: GitFlowPurpose;
    providerId?: string | null;
    returnTo?: string | null | undefined;
    details?: Record<string, unknown>;
  },
): Promise<string> {
  const { db } = services;
  // Old states are of no use to anyone; drop them on the way.
  await db
    .deleteFrom("git_provider_flow")
    .where("expires_at", "<", sql<Date>`now() - interval '1 day'`)
    .execute();
  const token = randomToken(32);
  await db
    .insertInto("git_provider_flow")
    .values({
      token_hash: sha256Hex(token),
      workspace_id: actor.workspace.id,
      person_id: actor.personId,
      provider_id: input.providerId ?? null,
      purpose: input.purpose,
      return_to: input.returnTo ?? null,
      details: JSON.stringify(input.details ?? {}),
      expires_at: sql<Date>`now() + make_interval(mins => ${GIT_FLOW_MINUTES})`,
    })
    .execute();
  return token;
}

function recordOf(row: {
  id: string;
  workspace_id: string;
  person_id: string;
  provider_id: string | null;
  purpose: GitFlowPurpose;
  return_to: string | null;
  details: unknown;
  expires_at: Date | string;
  used_at: Date | null;
}): FlowRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    personId: row.person_id,
    providerId: row.provider_id,
    purpose: row.purpose,
    returnTo: row.return_to,
    details: (row.details ?? {}) as Record<string, unknown>,
    expiresAt: new Date(row.expires_at),
    usedAt: row.used_at,
  };
}

export async function findFlow(
  services: ControlServices,
  token: string,
): Promise<FlowRecord | null> {
  const row = await services.db
    .selectFrom("git_provider_flow")
    .selectAll()
    .where("token_hash", "=", sha256Hex(token))
    .executeTakeFirst();
  return row ? recordOf(row) : null;
}

async function databaseNow(services: ControlServices): Promise<number> {
  const row = await sql<{ now: Date }>`select now() as now`.execute(services.db);
  return new Date(row.rows[0]?.now ?? Date.now()).getTime();
}

/** Finishes a flow: checks it, marks it used (once, even when two callbacks race), returns it. */
export async function consumeFlow(
  services: ControlServices,
  actor: WorkspaceActor,
  token: string,
  purpose: GitFlowPurpose,
): Promise<FlowRecord> {
  const flow = await findFlow(services, token);
  const problem = flowProblem(flow, {
    personId: actor.personId,
    workspaceId: actor.workspace.id,
    purpose,
    now: await databaseNow(services),
  });
  if (problem || !flow) {
    const code = problem === FLOW_OTHER_PERSON ? "forbidden" : "conflict";
    throw new AppError(code, problem ?? FLOW_UNKNOWN);
  }
  const marked = await services.db
    .updateTable("git_provider_flow")
    .set({ used_at: sql<Date>`now()` })
    .where("id", "=", flow.id)
    .where("used_at", "is", null)
    .returning("id")
    .executeTakeFirst();
  if (!marked) throw new AppError("conflict", FLOW_USED);
  return flow;
}

/** A flow that may still be finished by this person, or null (never throws). */
export async function usableFlow(
  services: ControlServices,
  actor: WorkspaceActor,
  token: string | undefined,
  purpose: GitFlowPurpose,
): Promise<FlowRecord | null> {
  if (!token) return null;
  const flow = await findFlow(services, token);
  const problem = flowProblem(flow, {
    personId: actor.personId,
    workspaceId: actor.workspace.id,
    purpose,
    now: await databaseNow(services),
  });
  return problem ? null : flow;
}

export async function markFlowUsed(services: ControlServices, flowId: string): Promise<void> {
  await services.db
    .updateTable("git_provider_flow")
    .set({ used_at: sql<Date>`now()` })
    .where("id", "=", flowId)
    .where("used_at", "is", null)
    .execute();
}
