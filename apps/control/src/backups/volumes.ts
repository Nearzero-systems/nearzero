import {
  AppError,
  BACKUP_HELPER_LABEL,
  BACKUP_MESSAGES,
  type BackupVolumesAnswer,
  isReservedVolume,
  NEARZERO_LABELS,
  type VolumeUserContainer,
} from "@nearzero/shared";
import { declaredVolumes } from "../compose-runtime/volumes.ts";
import type { Db } from "../db/database.ts";
import { targetOf } from "../runners/hub.ts";
import { mountVolume, readAppSettings } from "../service-runtime/app-settings.ts";
import type { ServiceRow } from "../services/records.ts";
import type { ControlServices } from "../services.ts";

/**
 * Which named volumes a service mounts (spec 17.3, 24 P4): its saved mounts, the mounts of its
 * containers, and for Compose the volumes its own file declares plus those carrying the stack's
 * labels. Never chosen by name prefix. The answer says where each volume was found, so the page
 * can say so, and which inner Compose services use it.
 *
 * A volume is only ever the service's own (spec 17.3, 22.4 rules 1 and 4, 24 G1 to G3): never
 * one of Nearzero's own, never one another service on the same server keeps (its mounts, its data
 * volume, a stack's volumes), and for Compose never one the file declares `external` or names
 * outside the stack. Those are left out of the list with the reason, and refused by name, so a
 * saved file can't point a backup or a restore at the control plane's database or at another
 * service's data.
 */

export type VolumeSource = "mount" | "container" | "compose-file" | "label";

export const VOLUME_SOURCE_LABELS: Record<VolumeSource, string> = {
  mount: "Saved mount",
  container: "Mounted by its container",
  "compose-file": "Declared in the Compose file",
  label: "Labelled for this stack",
};

export interface ServiceVolume {
  name: string;
  sources: VolumeSource[];
  sourceLabels: string[];
  /** Compose: the inner services that use it (from the file and from container labels). */
  innerServices: string[];
  /** Where it is mounted inside the service's containers. */
  paths: string[];
}

/** A volume the service touches but may not back up or restore over, and why. */
export interface ExcludedVolume {
  name: string;
  reason: string;
}

export interface VolumeDiscovery {
  volumes: ServiceVolume[];
  /** Volumes seen but left out: Nearzero's own, another service's, or outside the stack. */
  excluded: ExcludedVolume[];
  /** False when the server couldn't be asked; only saved mounts and the file are listed then. */
  checkedServer: boolean;
  note: string | null;
}

const COMPOSE_PROJECT = "com.docker.compose.project";
const COMPOSE_SERVICE = "com.docker.compose.service";
const COMPOSE_VOLUME = "com.docker.compose.volume";

/**
 * The named volumes a Compose stack declares, by the name Docker gives them, with the inner
 * services using each (spec 17.3): the Compose runtime's own list, so a pasted file and a
 * repository's file (as read at its last deploy or Preview) count alike. Labelled volumes on the
 * server are added by discoverVolumes.
 */
export function composeVolumes(
  row: Pick<ServiceRow, "settings" | "app_name">,
): { name: string; key: string; innerServices: string[] }[] {
  return declaredVolumes(row).map((volume) => ({
    name: volume.name,
    key: volume.key,
    innerServices: [...volume.innerServices].sort(),
  }));
}

/**
 * The stack's declared volumes that aren't its own (B1-03): `external` ones exist outside the
 * stack, and a `name:` outside `<app name>_…` / `<app name>-…` is a name any other stack (or the
 * server) can use. Both are refused for backups and restores.
 */
export function composeOutsiders(
  row: Pick<ServiceRow, "settings" | "app_name">,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const volume of declaredVolumes(row)) {
    if (volume.external) {
      out.set(volume.name, BACKUP_MESSAGES.externalVolume);
      continue;
    }
    const own = `${row.app_name}_${volume.key}`;
    if (
      volume.name !== own &&
      !volume.name.startsWith(`${row.app_name}_`) &&
      !volume.name.startsWith(`${row.app_name}-`)
    ) {
      out.set(volume.name, BACKUP_MESSAGES.foreignNamedVolume);
    }
  }
  return out;
}

/** The volumes the service's saved settings name (apps' volume mounts, a database's data). */
export function savedVolumes(row: Pick<ServiceRow, "kind" | "app_name" | "settings">): string[] {
  const settings = row.settings ?? {};
  if (row.kind === "application") {
    return readAppSettings(settings).mounts.flatMap((mount) =>
      mount.type === "volume" ? [mountVolume(row.app_name, mount)] : [],
    );
  }
  if (row.kind === "compose") return [];
  const data = typeof settings.dataVolume === "string" ? settings.dataVolume : null;
  return [data ?? `${row.app_name}-data`];
}

/** What other services on the same server keep as theirs: exact names, and stacks' prefixes. */
export interface VolumeClaims {
  names: Set<string>;
  /** `<app name>_` of every other Compose stack: Compose names its volumes that way. */
  prefixes: string[];
}

/**
 * The volumes every other service on this service's server keeps (any workspace: the Nearzero
 * host is shared). Only the names are used, to refuse them; nothing about those services is
 * shown.
 */
export async function otherServicesVolumes(
  db: Db,
  row: Pick<ServiceRow, "id" | "server_id">,
): Promise<VolumeClaims> {
  let query = db
    .selectFrom("service")
    .select(["id", "kind", "app_name", "settings"])
    .where("id", "!=", row.id);
  query =
    row.server_id === null
      ? query.where("server_id", "is", null)
      : query.where("server_id", "=", row.server_id);
  const others = await query.execute();
  const names = new Set<string>();
  const prefixes: string[] = [];
  for (const other of others) {
    for (const name of savedVolumes(other)) names.add(name);
    if (other.kind === "compose") {
      prefixes.push(`${other.app_name}_`);
      const outsiders = composeOutsiders(other);
      for (const volume of declaredVolumes(other)) {
        // Another stack's external volumes aren't its own either; only what it creates counts.
        if (!outsiders.has(volume.name)) names.add(volume.name);
      }
    }
  }
  return { names, prefixes };
}

/** Why the service may not use this volume, or null when it is the service's own. */
export function ownershipProblem(
  name: string,
  claims: VolumeClaims,
  outsiders: ReadonlyMap<string, string>,
): string | null {
  if (isReservedVolume(name)) return BACKUP_MESSAGES.reservedVolume;
  const outsider = outsiders.get(name);
  if (outsider) return outsider;
  if (claims.names.has(name) || claims.prefixes.some((prefix) => name.startsWith(prefix))) {
    return BACKUP_MESSAGES.foreignVolume;
  }
  return null;
}

/** Asks the service's server which volumes its containers mount and carry labels for. */
export async function askServer(
  services: ControlServices,
  row: Pick<ServiceRow, "id" | "kind" | "app_name" | "server_id">,
  volumes: string[],
  timeoutMs = 8_000,
): Promise<BackupVolumesAnswer> {
  const containerLabels = [[`${NEARZERO_LABELS.service}=${row.id}`]];
  const volumeLabels = [[`${NEARZERO_LABELS.service}=${row.id}`]];
  if (row.kind === "compose") {
    containerLabels.push([`${COMPOSE_PROJECT}=${row.app_name}`]);
    volumeLabels.push([`${COMPOSE_PROJECT}=${row.app_name}`]);
  }
  return (await services.runners.command(
    targetOf(row.server_id),
    "backup.volumes",
    { containerLabels, volumeLabels, volumes },
    { timeoutMs },
  )) as BackupVolumesAnswer;
}

export async function discoverVolumes(
  services: ControlServices,
  row: ServiceRow,
): Promise<VolumeDiscovery> {
  const found = new Map<string, ServiceVolume>();
  const note = (name: string, source: VolumeSource, inner: string[] = [], path?: string) => {
    const entry = found.get(name) ?? {
      name,
      sources: [],
      sourceLabels: [],
      innerServices: [],
      paths: [],
    };
    if (!entry.sources.includes(source)) {
      entry.sources.push(source);
      entry.sourceLabels.push(VOLUME_SOURCE_LABELS[source]);
    }
    for (const service of inner) {
      if (!entry.innerServices.includes(service)) entry.innerServices.push(service);
    }
    if (path && !entry.paths.includes(path)) entry.paths.push(path);
    found.set(name, entry);
  };
  for (const name of savedVolumes(row)) note(name, "mount");
  if (row.kind === "compose") {
    for (const volume of composeVolumes(row)) {
      note(volume.name, "compose-file", volume.innerServices);
    }
  }
  let checkedServer = false;
  let message: string | null = null;
  try {
    const answer = await askServer(services, row, []);
    checkedServer = true;
    for (const container of answer.containers) {
      const inner = container.labels[COMPOSE_SERVICE];
      for (const mount of container.mounts) {
        note(mount.name, "container", inner ? [inner] : [], mount.destination);
      }
    }
    // A labelled volume's users are found through the file or the containers' labels.
    for (const volume of answer.volumes) note(volume.name, "label");
  } catch (error) {
    message =
      error instanceof AppError
        ? `Only the saved mounts are listed. ${error.message}`
        : "Only the saved mounts are listed. The server didn't answer.";
  }
  const claims = await otherServicesVolumes(services.db, row);
  const outsiders = row.kind === "compose" ? composeOutsiders(row) : new Map<string, string>();
  const volumes: ServiceVolume[] = [];
  const excluded: ExcludedVolume[] = [];
  for (const volume of found.values()) {
    const problem = ownershipProblem(volume.name, claims, outsiders);
    if (problem) excluded.push({ name: volume.name, reason: problem });
    else volumes.push({ ...volume, innerServices: volume.innerServices.sort() });
  }
  volumes.sort((a, b) => a.name.localeCompare(b.name));
  excluded.sort((a, b) => a.name.localeCompare(b.name));
  if (volumes.length === 0 && !message) {
    message = row.kind === "compose" ? BACKUP_MESSAGES.noComposeVolumes : BACKUP_MESSAGES.noVolumes;
  }
  return { volumes, excluded, checkedServer, note: message };
}

/** Whether a container belongs to this service (by its labels, spec 22.4 rule 4). */
export function belongsTo(
  container: Pick<VolumeUserContainer, "labels">,
  row: Pick<ServiceRow, "id" | "kind" | "app_name">,
): boolean {
  if (container.labels[NEARZERO_LABELS.service] === row.id) return true;
  return row.kind === "compose" && container.labels[COMPOSE_PROJECT] === row.app_name;
}

export interface VolumeCheck {
  volume: ServiceVolume;
  /** Every container using the volume, this service's and any other's. */
  users: VolumeUserContainer[];
  /** Containers using it that are not this service's. */
  others: VolumeUserContainer[];
  /** The volume isn't on the server yet (only when the check allows it). */
  missing: boolean;
  /**
   * The labels a volume made for a restore gets: the ones the deploy gives it, so the service's
   * next deploy uses it as its own.
   */
  createLabels: Record<string, string>;
}

/**
 * Checks, on the server, that this service mounts the volume (spec 17.3: "the service must
 * actually mount the volume"), that it is the service's own, and who else uses it. A volume that
 * isn't on the server yet is refused unless `allowMissing` (a restore, R3-52) and the service's
 * own settings or file name it.
 */
export async function checkVolume(
  services: ControlServices,
  row: ServiceRow,
  volume: string,
  options: { allowMissing?: boolean } = {},
): Promise<VolumeCheck> {
  const discovery = await discoverVolumes(services, row);
  const refused = discovery.excluded.find((item) => item.name === volume);
  if (refused)
    throw new AppError("forbidden", refused.reason, { fields: { volume: refused.reason } });
  const entry = discovery.volumes.find((item) => item.name === volume);
  if (!entry) throw new AppError("forbidden", BACKUP_MESSAGES.notMounted);
  const answer = await askServer(services, row, [volume], 15_000);
  const missing = answer.missing.includes(volume);
  const declared = entry.sources.includes("mount") || entry.sources.includes("compose-file");
  if (missing && !(options.allowMissing && declared)) {
    throw new AppError(
      "conflict",
      `The volume ${volume} doesn't exist on the server yet. Deploy the service first.`,
    );
  }
  const users = answer.users[volume] ?? [];
  // A helper of one of this service's own backups or restores is Nearzero's work for it, not
  // another service (C1-11): a resumed run, or a second schedule of the volume, meets it.
  const helperRuns = [
    ...new Set(
      users.flatMap((container) => {
        const run = container.labels[BACKUP_HELPER_LABEL];
        return run && /^[0-9a-f-]{36}$/.test(run) ? [run] : [];
      }),
    ),
  ];
  const ownRuns = new Set(
    helperRuns.length === 0
      ? []
      : (
          await services.db
            .selectFrom("backup_run")
            .select("id")
            .where("id", "in", helperRuns)
            .where("service_id", "=", row.id)
            .execute()
        ).map((run) => run.id),
  );
  const others = users.filter(
    (container) =>
      !belongsTo(container, row) && !ownRuns.has(container.labels[BACKUP_HELPER_LABEL] ?? ""),
  );
  const createLabels: Record<string, string> = {
    [NEARZERO_LABELS.service]: row.id,
    [NEARZERO_LABELS.edition]: "1",
  };
  if (row.kind === "compose") {
    const key = composeVolumes(row).find((item) => item.name === volume)?.key;
    if (key) {
      createLabels[COMPOSE_PROJECT] = row.app_name;
      createLabels[COMPOSE_VOLUME] = key;
    }
  }
  return { volume: entry, users, others, missing, createLabels };
}
