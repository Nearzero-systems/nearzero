import {
  AGENT_POLICIES_NEEDING_CONFIGURE,
  AGENT_POLICY_KEYS,
  type AgentPolicy,
  type AgentPolicySwitches,
  AppError,
  defaultAgentPolicies,
  PRODUCTION_CONFIRMATION_PHRASE,
} from "@nearzero/shared";
import { sql } from "kysely";
import { z } from "zod";
import { recordAudit } from "../audit/audit.ts";
import type { Db } from "../db/database.ts";
import { auditActor, type WorkspaceActor } from "../http/actor.ts";
import { displayName } from "../identity/names.ts";
import type { ControlServices } from "../services.ts";

/**
 * The Agent's policies per workspace (spec 19.9). Stored here in M1; the Agent (M11) reads them
 * with {@link agentPoliciesFor}. Defaults apply until the page is saved.
 */

export interface AgentPoliciesView {
  switches: AgentPolicySwitches;
  /** True while the workspace has never saved the page. */
  usingDefaults: boolean;
  savedAt: string | null;
  savedBy: { id: string; name: string } | null;
}

function parseStored(value: unknown): AgentPolicySwitches {
  const switches = defaultAgentPolicies();
  if (value && typeof value === "object") {
    for (const key of AGENT_POLICY_KEYS) {
      const stored = (value as Record<string, unknown>)[key];
      if (typeof stored === "boolean") switches[key] = stored;
    }
  }
  return enforceDependencies(switches, {});
}

/**
 * Import from Git and Assign domains need Create and configure: turning either on turns it on,
 * and turning it off turns both off (spec 19.9).
 */
export function enforceDependencies(
  next: AgentPolicySwitches,
  requested: Partial<AgentPolicySwitches>,
): AgentPolicySwitches {
  const result = { ...next };
  if (requested["services.configure"] === false) {
    for (const key of AGENT_POLICIES_NEEDING_CONFIGURE) result[key] = false;
  } else if (AGENT_POLICIES_NEEDING_CONFIGURE.some((key) => result[key])) {
    result["services.configure"] = true;
  }
  return result;
}

export async function agentPoliciesFor(db: Db, workspaceId: string): Promise<AgentPoliciesView> {
  const row = await db
    .selectFrom("workspace_settings as s")
    .leftJoin("person as p", "p.id", "s.agent_policies_saved_by")
    .select([
      "s.agent_policies",
      "s.agent_policies_saved_at",
      "p.id as saver_id",
      "p.email",
      "p.first_name",
      "p.last_name",
    ])
    .where("s.workspace_id", "=", workspaceId)
    .executeTakeFirst();
  if (!row || row.agent_policies === null) {
    return { switches: defaultAgentPolicies(), usingDefaults: true, savedAt: null, savedBy: null };
  }
  return {
    switches: parseStored(row.agent_policies),
    usingDefaults: false,
    savedAt: row.agent_policies_saved_at?.toISOString() ?? null,
    savedBy:
      row.saver_id && row.email
        ? {
            id: row.saver_id,
            name: displayName({
              first_name: row.first_name,
              last_name: row.last_name,
              email: row.email,
            }),
          }
        : null,
  };
}

const switchesShape = Object.fromEntries(
  AGENT_POLICY_KEYS.map((key) => [key, z.boolean().optional()]),
) as Record<AgentPolicy, z.ZodOptional<z.ZodBoolean>>;

export const saveAgentPoliciesRequestSchema = z.object({
  switches: z.object(switchesShape).strict(),
  /** Required, exactly, when this save turns production changes on. */
  productionConfirmation: z.string().optional(),
});

export async function saveAgentPolicies(
  services: ControlServices,
  actor: WorkspaceActor,
  input: z.output<typeof saveAgentPoliciesRequestSchema>,
): Promise<AgentPoliciesView> {
  await actor.access.require("agent-policies.manage");
  const { db } = services;
  const workspaceId = actor.workspace.id;
  const current = await agentPoliciesFor(db, workspaceId);
  const requested: Partial<AgentPolicySwitches> = {};
  for (const key of AGENT_POLICY_KEYS) {
    const value = input.switches[key];
    if (value !== undefined) requested[key] = value;
  }
  const next = enforceDependencies({ ...current.switches, ...requested }, requested);
  if (next.production && !current.switches.production) {
    if (input.productionConfirmation !== PRODUCTION_CONFIRMATION_PHRASE) {
      const message = `Type ${PRODUCTION_CONFIRMATION_PHRASE} to let the Agent change production environments.`;
      throw new AppError("invalid_request", message, {
        fields: { productionConfirmation: message },
      });
    }
  }
  await db
    .insertInto("workspace_settings")
    .values({
      workspace_id: workspaceId,
      agent_policies: JSON.stringify(next),
      agent_policies_saved_by: actor.personId,
      agent_policies_saved_at: new Date(),
    })
    .onConflict((conflict) =>
      conflict.column("workspace_id").doUpdateSet({
        agent_policies: JSON.stringify(next),
        agent_policies_saved_by: actor.personId,
        agent_policies_saved_at: sql<Date>`now()`,
        updated_at: sql<Date>`now()`,
      }),
    )
    .execute();
  const changed = AGENT_POLICY_KEYS.filter((key) => next[key] !== current.switches[key]);
  await recordAudit(db, services.log, auditActor(actor), {
    action: "agent-policies.saved",
    workspaceId,
    details: { changed: Object.fromEntries(changed.map((key) => [key, next[key]])) },
  });
  return agentPoliciesFor(db, workspaceId);
}
