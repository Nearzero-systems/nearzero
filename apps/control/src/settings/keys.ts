import { AppError, type KeyKind, maskKey } from "@nearzero/shared";
import { sql } from "kysely";
import { agentSettings } from "../agent/settings.ts";
import { recordAudit } from "../audit/audit.ts";
import type { Db } from "../db/database.ts";
import type { WorkspaceSecretKind } from "../db/schema.ts";
import { secretContext } from "../email/transport.ts";
import { auditActor, type WorkspaceActor } from "../http/actor.ts";
import { displayName } from "../identity/names.ts";
import type { ControlServices, HttpFetch } from "../services.ts";

/**
 * The workspace's model key (OpenRouter) and research key (Firecrawl) (spec 04 4.8). Sealed with
 * the install key, shown only masked, with who added them and when. Nearzero never reads a key
 * from the server's environment for the Agent (spec 23.9).
 */

const SECRET_KIND: Record<KeyKind, WorkspaceSecretKind> = {
  model: "model-key",
  research: "research-key",
};

export type KeyStatus = "not_added" | "added" | "unreadable";

export interface KeyView {
  kind: KeyKind;
  /** unreadable: saved, but the install secret changed, so it must be added again. */
  status: KeyStatus;
  masked: string | null;
  addedAt: string | null;
  addedBy: { id: string; name: string } | null;
}

export async function keyViews(services: ControlServices, workspaceId: string): Promise<KeyView[]> {
  const rows = await services.db
    .selectFrom("workspace_secret as s")
    .leftJoin("person as p", "p.id", "s.added_by")
    .select([
      "s.kind",
      "s.sealed",
      "s.masked",
      "s.added_at",
      "p.id as person_id",
      "p.email",
      "p.first_name",
      "p.last_name",
    ])
    .where("s.workspace_id", "=", workspaceId)
    .where("s.kind", "in", ["model-key", "research-key"])
    .execute();
  return (["model", "research"] as const).map((kind) => {
    const row = rows.find((item) => item.kind === SECRET_KIND[kind]);
    if (!row) return { kind, status: "not_added", masked: null, addedAt: null, addedBy: null };
    const readable = services.secrets.open(row.sealed, secretContext(workspaceId, row.kind)).ok;
    return {
      kind,
      status: readable ? "added" : "unreadable",
      masked: row.masked,
      addedAt: row.added_at.toISOString(),
      addedBy:
        row.person_id && row.email
          ? {
              id: row.person_id,
              name: displayName({
                first_name: row.first_name,
                last_name: row.last_name,
                email: row.email,
              }),
            }
          : null,
    };
  });
}

export type ReadKeyResult =
  | { status: "missing" }
  | { status: "unreadable" }
  | { status: "ok"; value: string };

/** The key itself, for the Agent and research calls. Never sent to a browser. */
export async function readWorkspaceKey(
  services: ControlServices,
  workspaceId: string,
  kind: KeyKind,
): Promise<ReadKeyResult> {
  const row = await services.db
    .selectFrom("workspace_secret")
    .select(["sealed", "kind"])
    .where("workspace_id", "=", workspaceId)
    .where("kind", "=", SECRET_KIND[kind])
    .executeTakeFirst();
  if (!row) return { status: "missing" };
  const opened = services.secrets.open(row.sealed, secretContext(workspaceId, row.kind));
  return opened.ok ? { status: "ok", value: opened.value } : { status: "unreadable" };
}

export async function storeWorkspaceSecret(
  db: Db,
  services: ControlServices,
  workspaceId: string,
  kind: WorkspaceSecretKind,
  value: string,
  personId: string,
): Promise<void> {
  const sealed = services.secrets.seal(value, secretContext(workspaceId, kind));
  // A password is never shown in part, however short (B1-50, spec 23.4.3); keys keep their
  // first and last characters so two keys can be told apart.
  const masked = kind === "email-smtp-password" ? "Saved" : maskKey(value);
  await db
    .insertInto("workspace_secret")
    .values({
      workspace_id: workspaceId,
      kind,
      sealed,
      masked,
      added_by: personId,
    })
    .onConflict((conflict) =>
      conflict.columns(["workspace_id", "kind"]).doUpdateSet({
        sealed,
        masked,
        added_by: personId,
        added_at: sql<Date>`now()`,
      }),
    )
    .execute();
}

export type ResearchKeyCheck = "accepted" | "rejected" | "unreachable";

/**
 * Asks the research provider whether it knows the key, with a short timeout (spec 04 4.8). It
 * goes to the configured provider address (NEARZERO_AGENT_RESEARCH_URL, Firecrawl's public API
 * by default), the same one research calls use, so a test install can point it at its own.
 */
export async function checkResearchKey(
  http: HttpFetch,
  key: string,
  researchUrl = "https://api.firecrawl.dev",
): Promise<ResearchKeyCheck> {
  try {
    const response = await http(`${researchUrl.replace(/\/+$/, "")}/v1/team/credit-usage`, {
      method: "GET",
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8_000),
    });
    // A key that is out of credits (402) is still a key Firecrawl knows.
    if (response.ok || response.status === 402) return "accepted";
    if (response.status === 401 || response.status === 403) return "rejected";
    return "unreachable";
  } catch {
    return "unreachable";
  }
}

export async function saveKey(
  services: ControlServices,
  actor: WorkspaceActor,
  kind: KeyKind,
  key: string,
): Promise<{ key: KeyView; message: string }> {
  await actor.access.require("api-keys.manage");
  const workspaceId = actor.workspace.id;
  let message = "Saved.";
  if (kind === "research") {
    if (!key.startsWith("fc-")) {
      const text = "That doesn't look like a Firecrawl API key. Keys start with fc-.";
      throw new AppError("invalid_request", text, { fields: { key: text } });
    }
    const research = agentSettings(services);
    const check = await checkResearchKey(research.fetch, key, research.researchUrl);
    if (check === "rejected") {
      const text =
        "Firecrawl rejected this key. Check that you copied the whole key from your Firecrawl dashboard, then try again.";
      throw new AppError("invalid_request", text, { fields: { key: text } });
    }
    message =
      check === "accepted"
        ? "Saved. Firecrawl accepted the key."
        : "Saved. Firecrawl couldn't be reached to check it; it is checked again on first use.";
  }
  await storeWorkspaceSecret(
    services.db,
    services,
    workspaceId,
    SECRET_KIND[kind],
    key,
    actor.personId,
  );
  await recordAudit(services.db, services.log, auditActor(actor), {
    action: kind === "model" ? "keys.model-saved" : "keys.research-saved",
    workspaceId,
    details: { masked: maskKey(key) },
  });
  const view = (await keyViews(services, workspaceId)).find((item) => item.kind === kind);
  if (!view) throw new Error("The saved key could not be read back.");
  return { key: view, message };
}

export async function removeKey(
  services: ControlServices,
  actor: WorkspaceActor,
  kind: KeyKind,
): Promise<void> {
  await actor.access.require("api-keys.manage");
  const removed = await services.db
    .deleteFrom("workspace_secret")
    .where("workspace_id", "=", actor.workspace.id)
    .where("kind", "=", SECRET_KIND[kind])
    .executeTakeFirst();
  if (Number(removed.numDeletedRows) > 0) {
    await recordAudit(services.db, services.log, auditActor(actor), {
      action: kind === "model" ? "keys.model-removed" : "keys.research-removed",
      workspaceId: actor.workspace.id,
    });
  }
}
