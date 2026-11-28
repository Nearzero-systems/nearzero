import { createHash } from "node:crypto";
import { AppError } from "@nearzero/shared";
import type { ColumnType } from "kysely";
import { isSocketPath } from "../compose-runtime/privileged.ts";
import type { Db } from "../db/database.ts";
import type { SecretBox } from "../security/secret-box.ts";
import { secretsContext } from "../services/records.ts";
import { variablesForDeploy } from "../variables/deploy.ts";
import { isInstanceAdmin } from "../workspaces/workspaces.ts";
import {
  type AppMount,
  type AppSecrets,
  type AppSettings,
  type AppSource,
  readAppSettings,
} from "./app-settings.ts";

/**
 * The Nearzero host runs the control plane itself, so what reaches past a service's own
 * containers there is root on Nearzero (spec 24 G3, 22.2, 22.5). Two rules live here:
 *
 * - Only instance administrators and the workspaces they allow deploy to the host. Withdrawing a
 *   workspace's allowance stops its deploys there too, whoever or whatever starts them (B1-07):
 *   people, the Agent, pushes and webhooks.
 * - An application's bind mounts on the host (the Docker socket, `/`, any server path) are for
 *   instance administrators (30b R2-07, B1-02), as Compose's privileged options are. An
 *   administrator's deploy approves exactly those mounts in exactly that definition: everything
 *   that shapes what runs (spec 31's decision on host approvals, C1-04): the source, builder,
 *   commands, every mount, the variables (names and values after references are filled in), the
 *   published ports and the service port. Anyone else's deploy, and pushes and webhooks, may run
 *   the same again, and any change needs an administrator first. Routes change without a deploy,
 *   so hostnames of such an app are for administrators too (hostRouteRefusal). Elsewhere bind
 *   mounts are allowed, with the same warnings Compose gives.
 */

export interface HostApprovalTable {
  service_id: string;
  approved_keys: ColumnType<string[], string[] | undefined, string[]>;
  approved_by: string | null;
  approved_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

declare module "../db/schema.ts" {
  interface Database {
    host_approval: HostApprovalTable;
  }
}

export const HOST_WITHDRAWN =
  "This workspace isn't allowed on the Nearzero host any more, so nothing of it deploys there. Ask a Nearzero administrator to allow it again, or create the service on another server.";

/** The install's first workspace, or one an instance administrator allowed onto the host. */
export async function workspaceMayUseHost(db: Db, workspaceId: string): Promise<boolean> {
  const [first, allowed] = await Promise.all([
    db.selectFrom("install_state").select("first_workspace_id").executeTakeFirst(),
    db
      .selectFrom("host_allowed_workspace")
      .select("workspace_id")
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirst(),
  ]);
  return first?.first_workspace_id === workspaceId || allowed !== undefined;
}

export interface MountFinding {
  kind: "docker-socket" | "host-path";
  message: string;
  /** The mount and the definition it is in (see appDefinitionFingerprint). */
  key: string;
}

type BindMount = Extract<AppMount, { type: "bind" }>;

function bindMounts(settings: AppSettings): BindMount[] {
  return settings.mounts.filter((mount): mount is BindMount => mount.type === "bind");
}

/** Where the code comes from, without anything secret. */
function sourceIdentity(source: AppSource | null): unknown {
  if (!source) return null;
  switch (source.type) {
    case "git":
      return ["git", source.url, source.branch, source.buildPath, source.submodules];
    case "provider":
      return [
        "provider",
        source.providerId,
        source.repository,
        source.branch,
        source.buildPath,
        source.submodules,
      ];
    case "image":
      return ["image", source.image, source.registry?.address ?? null];
    case "upload":
      return ["upload", source.buildPath, source.upload?.sha256 ?? null];
  }
}

/**
 * What an application on the host runs, as its deploy runs it: the saved settings, the file mount
 * contents, and its variables resolved (or why they couldn't be).
 */
export interface AppDefinition {
  settings: AppSettings;
  /** File mount contents, by mount id. */
  files: Readonly<Record<string, string>>;
  runtime: ResolvedValues;
  /** Build variables; not used for image sources, which build nothing. */
  build: ResolvedValues;
}

/** Variables with their references filled in, or the names that couldn't be. */
export type ResolvedValues =
  | { ok: true; values: Readonly<Record<string, string>> }
  | { ok: false; unresolved: string };

function digestOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function sortedEntries(values: ResolvedValues): unknown {
  if (!values.ok) return ["unresolved", values.unresolved];
  return Object.entries(values.values).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function mountIdentity(mount: AppMount, files: AppDefinition["files"]): unknown {
  switch (mount.type) {
    case "bind":
      return ["bind", mount.hostPath, mount.containerPath, mount.readOnly];
    case "volume":
      return ["volume", mount.volume ?? mount.name, mount.containerPath];
    case "file":
      return ["file", mount.containerPath, digestOf(files[mount.id] ?? "")];
  }
}

/**
 * A fingerprint of everything that shapes what an application runs (C1-04): its source, builder,
 * commands, mounts (file contents by digest), published ports, service port and variables. Values
 * only ever enter it through the digest.
 */
export function appDefinitionFingerprint(definition: AppDefinition): string {
  const { settings } = definition;
  const byJson = (items: unknown[]) =>
    items.map((item) => JSON.stringify(item)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const text = JSON.stringify([
    sourceIdentity(settings.source),
    settings.builder,
    settings.commands,
    byJson(settings.mounts.map((mount) => mountIdentity(mount, definition.files))),
    byJson(
      settings.ports.map((port) => [
        port.containerPort,
        port.publishedPort,
        port.protocol,
        port.mode,
      ]),
    ),
    settings.servicePortAuto ? "auto" : settings.servicePort,
    sortedEntries(definition.runtime),
    settings.source?.type === "image" ? null : sortedEntries(definition.build),
  ]);
  return digestOf(text).slice(0, 24);
}

function resolved(result: Awaited<ReturnType<typeof variablesForDeploy>>): ResolvedValues {
  if (!result.ok) {
    return {
      ok: false,
      unresolved: result.errors.map((error) => error.reference ?? error.name).join(",") || "?",
    };
  }
  return {
    ok: true,
    values: Object.fromEntries(result.variables.map((variable) => [variable.name, variable.value])),
  };
}

/**
 * An application's definition as it is saved now, for the check before a deploy is queued and
 * for the move's approval. `settings` replaces the saved settings when given.
 */
export async function savedAppDefinition(
  db: Db,
  box: SecretBox,
  serviceId: string,
  settings?: Record<string, unknown> | null,
): Promise<AppDefinition> {
  const row = await db
    .selectFrom("service")
    .select(["settings", "secrets_sealed"])
    .where("id", "=", serviceId)
    .executeTakeFirstOrThrow();
  const app = readAppSettings(settings === undefined ? row.settings : settings);
  let secrets: AppSecrets | null = null;
  if (row.secrets_sealed) {
    const opened = box.open(row.secrets_sealed, secretsContext(serviceId));
    secrets = opened.ok ? (JSON.parse(opened.value) as AppSecrets) : null;
  }
  const [runtime, build] = await Promise.all([
    variablesForDeploy(db, box, serviceId, "runtime"),
    app.source?.type === "image"
      ? Promise.resolve(null)
      : variablesForDeploy(db, box, serviceId, "build"),
  ]);
  return {
    settings: app,
    files: secrets?.files ?? {},
    runtime: resolved(runtime),
    build: build ? resolved(build) : { ok: true, values: {} },
  };
}

/** The warnings an application's bind mounts get where they are allowed. */
export function appMountWarnings(settings: AppSettings): string[] {
  return bindMounts(settings).map((mount) => mountMessage(mount).message);
}

function mountMessage(mount: BindMount): { kind: MountFinding["kind"]; message: string } {
  if (isSocketPath(mount.hostPath)) {
    return {
      kind: "docker-socket",
      message: `The mount at ${mount.containerPath} is ${mount.hostPath}, which holds the Docker socket: control of every container on the server.`,
    };
  }
  return {
    kind: "host-path",
    message: `The mount at ${mount.containerPath} is the server's folder ${mount.hostPath}, outside the service's own volumes.`,
  };
}

/** An application's bind mounts, each with its approval key. */
export function appMountFindings(definition: AppDefinition): MountFinding[] {
  const fingerprint = appDefinitionFingerprint(definition);
  return bindMounts(definition.settings).map((mount) => ({
    ...mountMessage(mount),
    key: `bind:${mount.hostPath}:${mount.containerPath}:${mount.readOnly ? "ro" : "rw"}@${fingerprint}`,
  }));
}

export function hostMountRefusal(findings: readonly MountFinding[]): string {
  const kinds = [
    ...new Set(
      findings.map((finding) =>
        finding.kind === "docker-socket" ? "the Docker socket" : "server folders",
      ),
    ),
  ].join(" and ");
  return `This application mounts ${kinds} of the Nearzero host itself. On the Nearzero host only Nearzero administrators can deploy bind mounts. Use a volume instead, or deploy the application to another server.`;
}

async function approvedKeys(db: Db, serviceId: string): Promise<Set<string>> {
  const row = await db
    .selectFrom("host_approval")
    .select("approved_keys")
    .where("service_id", "=", serviceId)
    .executeTakeFirst();
  return new Set(row?.approved_keys ?? []);
}

export type MountDecision =
  | { allowed: true; approve: boolean; findings: MountFinding[] }
  | { allowed: false; message: string; unapproved: MountFinding[]; findings: MountFinding[] };

/** Whether this application's bind mounts may run on the host for this person (null: no person). */
export async function hostMountDecision(
  db: Db,
  input: {
    serviceId: string;
    definition: AppDefinition;
    personId: string | null;
    isAdmin?: boolean;
  },
): Promise<MountDecision> {
  const findings = appMountFindings(input.definition);
  if (findings.length === 0) return { allowed: true, approve: false, findings };
  const admin =
    input.isAdmin ?? (input.personId ? await isInstanceAdmin(db, input.personId) : false);
  if (admin) return { allowed: true, approve: true, findings };
  const approved = await approvedKeys(db, input.serviceId);
  const unapproved = findings.filter((finding) => !approved.has(finding.key));
  if (unapproved.length === 0) return { allowed: true, approve: false, findings };
  return { allowed: false, message: hostMountRefusal(unapproved), unapproved, findings };
}

/** Records the bind mounts an instance administrator deployed on the host. */
export async function recordMountApproval(
  db: Db,
  serviceId: string,
  findings: readonly MountFinding[],
  personId: string | null,
): Promise<void> {
  const keys = [...new Set(findings.map((finding) => finding.key))].sort();
  await db
    .insertInto("host_approval")
    .values({ service_id: serviceId, approved_keys: keys, approved_by: personId })
    .onConflict((conflict) =>
      conflict.column("service_id").doUpdateSet({
        approved_keys: keys,
        approved_by: personId,
        approved_at: new Date(),
      }),
    )
    .execute();
}

/**
 * Saving mounts (spec 06 6.8): on the host, a bind mount that is new or changed is refused for
 * anyone but instance administrators; mounts already saved may stay as they are. Elsewhere it
 * is allowed and the answer warns about it.
 */
export function checkMountsOnSave(input: {
  onHost: boolean;
  isAdmin: boolean;
  before: readonly AppMount[];
  after: readonly AppMount[];
}): string[] {
  const kept = new Set(
    input.before
      .filter((mount): mount is BindMount => mount.type === "bind")
      .map((mount) => `${mount.hostPath}\u0000${mount.containerPath}\u0000${mount.readOnly}`),
  );
  const binds = input.after.filter((mount): mount is BindMount => mount.type === "bind");
  if (input.onHost && !input.isAdmin) {
    const added = binds.filter(
      (mount) => !kept.has(`${mount.hostPath}\u0000${mount.containerPath}\u0000${mount.readOnly}`),
    );
    if (added.length > 0) {
      const findings = added.map((mount) => ({ ...mountMessage(mount), key: "" }));
      throw new AppError(
        "forbidden",
        `${findings.map((finding) => finding.message).join(" ")} ${hostMountRefusal(findings)}`,
      );
    }
    return [];
  }
  if (input.onHost) return [];
  return binds.map((mount) => `Warning: ${mountMessage(mount).message}`);
}

/**
 * Before a deploy or Reload of a service on the host is queued: the workspace must still be
 * allowed there (B1-07), and an application's bind mounts must be approved for this person. The
 * pipeline checks the same again for every deploy, pushes and webhooks included.
 */
export async function hostDeployPrecheck(
  services: { db: Db; secrets: SecretBox },
  actor: { isInstanceAdmin: boolean; personId: string; workspace: { id: string } },
  row: {
    id: string;
    kind: string;
    server_id: string | null;
    settings: Record<string, unknown> | null;
  },
): Promise<void> {
  const { db } = services;
  if (row.server_id !== null) return;
  if (!actor.isInstanceAdmin && !(await workspaceMayUseHost(db, actor.workspace.id))) {
    throw new AppError("forbidden", HOST_WITHDRAWN);
  }
  if (row.kind !== "application" || actor.isInstanceAdmin) return;
  if (bindMounts(readAppSettings(row.settings)).length === 0) return;
  const definition = await savedAppDefinition(db, services.secrets, row.id, row.settings);
  // Variables that can't be resolved fail the deploy itself, with their names.
  if (!definition.runtime.ok || !definition.build.ok) return;
  const decision = await hostMountDecision(db, {
    serviceId: row.id,
    definition,
    personId: actor.personId,
    isAdmin: actor.isInstanceAdmin,
  });
  if (!decision.allowed) throw new AppError("forbidden", decision.message);
}

export const HOST_ROUTE_REFUSAL =
  "On the Nearzero host only Nearzero administrators can change the hostnames of a service that reaches the host itself (bind mounts, or Compose options a Nearzero administrator approved). Ask one to add it.";

/**
 * Hostnames of a host service that needs an administrator's approval (C1-04): routes are part of
 * what was approved and change without a deploy, so only instance administrators add, connect or
 * generate them. For apps that is any app with bind mounts on the host; for Compose, an inner
 * service with an approved privileged option (or a stack-wide one). Returns the refusal, or null.
 */
export async function hostRouteRefusal(
  db: Db,
  actor: { isInstanceAdmin: boolean },
  service: {
    id: string;
    kind: string;
    serverId: string | null;
    settings: Record<string, unknown> | null;
  },
  composeService: string | null,
): Promise<string | null> {
  if (actor.isInstanceAdmin || service.serverId !== null) return null;
  if (service.kind === "application") {
    return bindMounts(readAppSettings(service.settings)).length > 0 ? HOST_ROUTE_REFUSAL : null;
  }
  if (service.kind !== "compose") return null;
  const stack = await db
    .selectFrom("compose_stack")
    .select("approved_keys")
    .where("service_id", "=", service.id)
    .executeTakeFirst();
  const owners = new Set((stack?.approved_keys ?? []).map((key) => key.split("|")[0] ?? ""));
  return owners.has("*") || (composeService !== null && owners.has(composeService))
    ? HOST_ROUTE_REFUSAL
    : null;
}
