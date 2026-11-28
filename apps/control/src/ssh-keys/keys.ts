import {
  AppError,
  type createSshKeyRequestSchema,
  type generateSshKeyRequestSchema,
  type SshKeyType,
  sshKeyInUseMessage,
  type updateSshKeyRequestSchema,
} from "@nearzero/shared";
import { sql } from "kysely";
import type { z } from "zod";
import { recordAudit } from "../audit/audit.ts";
import { auditActor, type WorkspaceActor } from "../http/actor.ts";
import { isOurId, serviceTarget } from "../projects/objects.ts";
import type { ControlServices } from "../services.ts";
import { checkKeyPair, type GeneratedKeyPair, generateKeyPair } from "./format.ts";

/**
 * The workspace's SSH keys (spec 09 9.7): used to sign in to servers and to clone over SSH.
 * Private keys are sealed with the install key the moment they arrive and never leave the
 * platform again; every view of a key shows only its public half.
 */

export interface SshKeyView {
  id: string;
  name: string;
  description: string;
  type: SshKeyType;
  publicKey: string;
  fingerprint: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Servers that sign in with it, among those the person can see; while there are any (seen or
   * not), the key can't be deleted. `hiddenServers` counts the ones the person can't see (C1-13).
   */
  usedBy: { id: string; name: string }[];
  hiddenServers: number;
  /**
   * Apps and Compose services that clone their Git URL source with it (spec 9.7), among those
   * the person can see. Deleting the key stops them deploying from Git until another key is
   * chosen; `hiddenGitUsers` counts the ones the person can't see.
   */
  gitUsers: {
    id: string;
    name: string;
    kind: "application" | "compose";
    project: string;
    environment: string;
  }[];
  hiddenGitUsers: number;
}

function privateKeyContext(workspaceId: string, keyId: string): string {
  return `workspace:${workspaceId}:ssh-key:${keyId}`;
}

const NOT_FOUND = "This SSH key doesn't exist in this workspace, or you don't have access to it.";

async function views(
  services: ControlServices,
  workspaceId: string,
  ids?: string[],
  actor?: WorkspaceActor,
): Promise<SshKeyView[]> {
  let query = services.db
    .selectFrom("ssh_key")
    .select([
      "id",
      "name",
      "description",
      "key_type",
      "public_key",
      "fingerprint",
      "created_at",
      "updated_at",
    ])
    .where("workspace_id", "=", workspaceId)
    .orderBy("created_at", "desc");
  if (ids) query = query.where("id", "in", ids);
  const rows = await query.execute();
  if (rows.length === 0) return [];
  const users = await services.db
    .selectFrom("server")
    .select(["id", "name", "ssh_key_id"])
    .where("workspace_id", "=", workspaceId)
    .where(
      "ssh_key_id",
      "in",
      rows.map((row) => row.id),
    )
    .orderBy("name")
    .execute();
  const keyOfSource = sql<string>`s.settings -> 'source' ->> 'sshKeyId'`;
  const cloners = await services.db
    .selectFrom("service as s")
    .innerJoin("project as p", "p.id", "s.project_id")
    .innerJoin("environment as e", "e.id", "s.environment_id")
    .select([
      "s.id",
      "s.name",
      "s.kind",
      "s.project_id",
      "s.environment_id",
      "p.name as project",
      "e.name as environment",
      keyOfSource.as("key_id"),
    ])
    .where("s.workspace_id", "=", workspaceId)
    .where("s.kind", "in", ["application", "compose"])
    .where(sql<string>`s.settings -> 'source' ->> 'type'`, "=", "git")
    .where(
      keyOfSource,
      "in",
      rows.map((row) => row.id),
    )
    .orderBy("s.name")
    .execute();
  const seen = (service: (typeof cloners)[number]) =>
    !actor || actor.access.can("service.see", serviceTarget(service));
  const seenServer = (server: (typeof users)[number]) =>
    !actor || actor.access.can("server.see", { kind: "server", id: server.id });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    type: row.key_type,
    publicKey: row.public_key,
    fingerprint: row.fingerprint,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    usedBy: users
      .filter((server) => server.ssh_key_id === row.id && seenServer(server))
      .map((server) => ({ id: server.id, name: server.name })),
    hiddenServers: users.filter((server) => server.ssh_key_id === row.id && !seenServer(server))
      .length,
    gitUsers: cloners
      .filter((service) => service.key_id === row.id && seen(service))
      .map((service) => ({
        id: service.id,
        name: service.name,
        kind: service.kind as "application" | "compose",
        project: service.project,
        environment: service.environment,
      })),
    hiddenGitUsers: cloners.filter((service) => service.key_id === row.id && !seen(service)).length,
  }));
}

async function one(
  services: ControlServices,
  workspaceId: string,
  id: string,
  actor?: WorkspaceActor,
) {
  if (!isOurId(id)) throw new AppError("not_found", NOT_FOUND);
  const [view] = await views(services, workspaceId, [id], actor);
  if (!view) throw new AppError("not_found", NOT_FOUND);
  return view;
}

/**
 * The workspace's keys, for people who may use them, and for people who add servers, who pick
 * one in the Add server form (G3-06, spec 9.8).
 */
export async function listSshKeys(services: ControlServices, actor: WorkspaceActor) {
  if (!actor.access.can("servers.add")) await actor.access.require("ssh-keys.use");
  return views(services, actor.workspace.id, undefined, actor);
}

export async function getSshKey(services: ControlServices, actor: WorkspaceActor, id: string) {
  await actor.access.require("ssh-keys.use");
  return one(services, actor.workspace.id, id, actor);
}

export async function addSshKey(
  services: ControlServices,
  actor: WorkspaceActor,
  input: z.output<typeof createSshKeyRequestSchema>,
): Promise<SshKeyView> {
  await actor.access.require("ssh-keys.manage");
  const info = checkKeyPair(input.publicKey, input.privateKey);
  const id = crypto.randomUUID();
  const sealed = services.secrets.seal(
    input.privateKey.trim(),
    privateKeyContext(actor.workspace.id, id),
  );
  await services.db.transaction().execute(async (trx) => {
    await trx
      .insertInto("ssh_key")
      .values({
        id,
        workspace_id: actor.workspace.id,
        name: input.name,
        description: input.description,
        key_type: info.type,
        public_key: info.line,
        fingerprint: info.fingerprint,
        private_key_sealed: sealed,
        created_by: actor.personId,
      })
      .execute();
    await recordAudit(trx, services.log, auditActor(actor), {
      action: "ssh-key.added",
      workspaceId: actor.workspace.id,
      target: { kind: "ssh_key", id },
      details: { name: input.name, type: info.type, fingerprint: info.fingerprint },
    });
  });
  return one(services, actor.workspace.id, id);
}

export async function updateSshKey(
  services: ControlServices,
  actor: WorkspaceActor,
  id: string,
  input: z.output<typeof updateSshKeyRequestSchema>,
): Promise<SshKeyView> {
  await actor.access.require("ssh-keys.manage");
  const current = await one(services, actor.workspace.id, id);
  const changes = {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.description === undefined ? {} : { description: input.description }),
  };
  if (Object.keys(changes).length === 0) return current;
  await services.db
    .updateTable("ssh_key")
    .set({ ...changes, updated_at: new Date() })
    .where("id", "=", id)
    .where("workspace_id", "=", actor.workspace.id)
    .execute();
  await recordAudit(services.db, services.log, auditActor(actor), {
    action: "ssh-key.updated",
    workspaceId: actor.workspace.id,
    target: { kind: "ssh_key", id },
    details: changes,
  });
  return one(services, actor.workspace.id, id);
}

export async function deleteSshKey(
  services: ControlServices,
  actor: WorkspaceActor,
  id: string,
): Promise<void> {
  await actor.access.require("ssh-keys.manage");
  const current = await one(services, actor.workspace.id, id, actor);
  if (current.usedBy.length + current.hiddenServers > 0) {
    throw new AppError(
      "conflict",
      sshKeyInUseMessage(
        current.usedBy.map((server) => server.name),
        current.hiddenServers,
      ),
    );
  }
  try {
    await services.db.transaction().execute(async (trx) => {
      await trx
        .deleteFrom("ssh_key")
        .where("id", "=", id)
        .where("workspace_id", "=", actor.workspace.id)
        .execute();
      await recordAudit(trx, services.log, auditActor(actor), {
        action: "ssh-key.deleted",
        workspaceId: actor.workspace.id,
        target: { kind: "ssh_key", id },
        details: {
          name: current.name,
          fingerprint: current.fingerprint,
          // These stop deploying from Git until another key is chosen (spec 9.7).
          gitUsers: current.gitUsers.map((service) => service.id),
        },
      });
    });
  } catch (error) {
    // A server picked the key meanwhile; the database refuses, and so do we.
    if ((error as { code?: string }).code === "23503") {
      const [again] = await views(services, actor.workspace.id, [id], actor);
      throw new AppError(
        "conflict",
        sshKeyInUseMessage(
          again?.usedBy.map((server) => server.name) ?? [],
          again?.hiddenServers ?? 0,
        ),
      );
    }
    throw error;
  }
}

/** Makes a new pair on the server for the Add dialog to fill in; nothing is saved yet. */
export async function generateSshKey(
  actor: WorkspaceActor,
  input: z.output<typeof generateSshKeyRequestSchema>,
): Promise<GeneratedKeyPair> {
  await actor.access.require("ssh-keys.manage");
  return generateKeyPair(input.type, input.name);
}

/** The private key for server setup and Git over SSH. Never sent to a browser or the model. */
export async function openPrivateKey(
  services: ControlServices,
  workspaceId: string,
  keyId: string,
): Promise<string> {
  const row = await services.db
    .selectFrom("ssh_key")
    .select("private_key_sealed")
    .where("id", "=", keyId)
    .where("workspace_id", "=", workspaceId)
    .executeTakeFirst();
  if (!row) throw new AppError("not_found", NOT_FOUND);
  const opened = services.secrets.open(
    row.private_key_sealed,
    privateKeyContext(workspaceId, keyId),
  );
  if (!opened.ok) {
    throw new AppError(
      "conflict",
      "This SSH key's private key can't be read any more (the install's secret changed). Add the key again.",
    );
  }
  return opened.value;
}
