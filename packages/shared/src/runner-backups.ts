import { z } from "zod";
import { BACKUP_PROVIDERS } from "./backup-rules.ts";

/**
 * Runner commands for backups and restores (spec 08 8.3, 17, 23.1, 25 D5: rclone called by the
 * runner). They are part of the runner protocol (runner-protocol.ts spreads them into its
 * command list) and are new command kinds, so older runners answer them with "unsupported".
 *
 * Every step the runner takes for these runs as its own short-lived helper container with its
 * standard input closed, and its exit status is checked before the next step starts (23.1).
 */

/**
 * The helper image: rclone (MIT) on Alpine, whose busybox also gives gzip, tar and wget. Pinned
 * to one release; a runner can be pointed at a mirror with NEARZERO_BACKUP_TOOLS_IMAGE.
 */
export const BACKUP_TOOLS_IMAGE = "rclone/rclone:1.71.2";

/**
 * The label on a backup or restore's own helper containers, naming its run. They mount the
 * volume they copy for a while: Nearzero's own work, never "another service" (C1-11).
 */
export const BACKUP_HELPER_LABEL = "dev.nearzero.backup-run";

/** A destination as the runner gets it. The keys are secrets: never logged, never returned. */
export const runnerDestinationSchema = z.object({
  provider: z.enum(BACKUP_PROVIDERS),
  endpoint: z.string().url().max(500),
  bucket: z.string().min(1).max(255),
  region: z.string().max(64).default("auto"),
  accessKeyId: z.string().min(1).max(256),
  secretAccessKey: z.string().min(1).max(512),
});
export type RunnerDestination = z.input<typeof runnerDestinationSchema>;

/**
 * Volumes that are Nearzero's own (spec 22.4 rule 4, 24 G3): the control plane's database, the
 * runner's state and hand-off, the runner link's certificate, the router's certificates, the
 * Railpack builder's cache and every backup run's scratch volume. No service backs them up or restores over them, whatever its
 * Compose file or saved settings say; the runner refuses them too.
 */
export const RESERVED_VOLUMES: readonly string[] = [
  "nearzero-postgres-data",
  "nearzero-runner-state",
  "nearzero-runner-handoff",
  "nearzero-router-certificates",
  "nearzero-buildkit-state",
  // The runner link's certificate and key (C4-10): a restore over it would cut off every
  // pinned server, and a backup would copy the key out.
  "nearzero-runner-link",
];

const SCRATCH_VOLUME = /^nearzero-backup-[0-9a-f-]{36}$/;

export function isReservedVolume(name: string): boolean {
  return RESERVED_VOLUMES.includes(name) || SCRATCH_VOLUME.test(name);
}

const runId = z.string().regex(/^[0-9a-f-]{36}$/);
const containerRef = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/);
const volumeName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/);
/** A key inside the bucket: relative, no dot segments. */
const objectKey = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "Not a safe key.",
  );
const prefix = z
  .string()
  .min(2)
  .max(1024)
  .refine(
    (value) =>
      value.endsWith("/") &&
      !value.startsWith("/") &&
      value
        .slice(0, -1)
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."),
    "Not a safe prefix.",
  );
const labelFilter = z.array(z.string().min(1).max(512)).max(8);

export const DATABASE_BACKUP_KINDS = ["postgres", "mysql", "mariadb", "mongodb", "libsql"] as const;
export type DatabaseBackupKind = (typeof DATABASE_BACKUP_KINDS)[number];

const databaseTarget = {
  runId,
  kind: z.enum(DATABASE_BACKUP_KINDS),
  /** The running database container (its id or name). */
  container: containerRef,
  /** The database to dump or restore into; null for "all" (MongoDB) or the default (libSQL). */
  database: z.string().max(64).nullable(),
  user: z.string().max(128).nullable(),
  /** Secrets. */
  password: z.string().max(512),
  rootPassword: z.string().max(512).nullable().default(null),
  port: z.number().int().min(1).max(65535),
  destination: runnerDestinationSchema,
  key: objectKey,
  toolsImage: z.string().min(1).max(512).default(BACKUP_TOOLS_IMAGE),
  /**
   * The database's data volume. libSQL with namespaces is backed up as an archive of it, with
   * the database stopped for the copy (R3-51), and an archive of it (0.1.x's libSQL backups and
   * 1.0's namespaced ones) is restored by unpacking it.
   */
  dataVolume: volumeName.nullable().default(null),
};

const databaseName = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_$-]{0,63}$/);

export const backupCommandSchemas = {
  /** Lists the bucket (spec 17.1 Test). */
  "backup.test": z.object({
    destination: runnerDestinationSchema,
    toolsImage: z.string().min(1).max(512).default(BACKUP_TOOLS_IMAGE),
    timeoutSeconds: z.number().int().min(1).max(60).default(10),
    /**
     * Names the helper must reach at these addresses only (the control plane checked them), so
     * a test from the Nearzero host can't be pointed somewhere else between the check and the
     * connection (R3-49).
     */
    pinnedHosts: z
      .array(
        z.object({
          host: z.string().regex(/^[A-Za-z0-9.-]{1,253}$/),
          address: z.string().regex(/^[0-9A-Fa-f.:]{2,45}$/),
        }),
      )
      .max(16)
      .default([]),
  }),
  /** The files under one prefix (spec 24 G1: the control plane only asks for a service's own). */
  "backup.files": z.object({
    destination: runnerDestinationSchema,
    prefix,
    toolsImage: z.string().min(1).max(512).default(BACKUP_TOOLS_IMAGE),
  }),
  /** Deletes files (keep N). */
  "backup.prune": z.object({
    destination: runnerDestinationSchema,
    keys: z.array(objectKey).min(1).max(1000),
    toolsImage: z.string().min(1).max(512).default(BACKUP_TOOLS_IMAGE),
  }),
  /**
   * Dumps a database and streams it, compressed, straight to the bucket (streams its log; R3-50:
   * no copy of the dump on the server's disk). `archive`: back up the data volume instead (libSQL
   * with namespaces).
   */
  "backup.database": z.object({ ...databaseTarget, archive: z.boolean().default(false) }),
  /**
   * Streams a backup from the bucket into the database (streams its log): checked whole first,
   * then loaded into `database`. The file's format is read from its content: a plain SQL dump, a
   * Postgres archive (pg_restore), a MongoDB archive, or an archive of a libSQL data folder.
   * `sourceDatabase` is the database the file was dumped from, when known (MongoDB renames it).
   */
  "restore.database": z.object({
    ...databaseTarget,
    database: databaseName.nullable(),
    sourceDatabase: databaseName.nullable().default(null),
  }),
  /** Archives a volume (optionally with the service stopped) and uploads it (streams). */
  "backup.volume": z.object({
    runId,
    volume: volumeName,
    /** This service's containers to stop while copying; started again afterwards. */
    stop: z.array(containerRef).max(64).default([]),
    destination: runnerDestinationSchema,
    key: objectKey,
    toolsImage: z.string().min(1).max(512).default(BACKUP_TOOLS_IMAGE),
  }),
  /**
   * Restores a volume in place (streams): stops the containers that use it, empties it, unpacks
   * the archive and starts them again, even after a failure. Refused when a container outside
   * `allowedContainers` uses the volume.
   */
  "restore.volume": z.object({
    runId,
    volume: volumeName,
    allowedContainers: z.array(containerRef).max(256).default([]),
    destination: runnerDestinationSchema,
    key: objectKey,
    toolsImage: z.string().min(1).max(512).default(BACKUP_TOOLS_IMAGE),
    /**
     * A volume the service mounts that isn't on the server yet is created with these labels
     * (R3-52); without it a missing volume is refused.
     */
    create: z
      .object({ labels: z.record(z.string().max(128), z.string().max(256)) })
      .nullable()
      .default(null),
  }),
  /**
   * What volumes a service's containers mount, which volumes carry its labels, and who uses the
   * named volumes (spec 17.3: never chosen by name prefix).
   */
  "backup.volumes": z.object({
    /** Each set of label filters finds containers (filters in one set must all match). */
    containerLabels: z.array(labelFilter).max(8).default([]),
    volumeLabels: z.array(labelFilter).max(8).default([]),
    /** Named volumes to report on: whether they exist, and every container using them. */
    volumes: z.array(volumeName).max(64).default([]),
  }),
} as const;

export type BackupCommandKind = keyof typeof backupCommandSchemas;

export const BACKUP_STREAMING_COMMANDS = [
  "backup.database",
  "restore.database",
  "backup.volume",
  "restore.volume",
] as const;

/** A file in the bucket, as `backup.files` answers. */
export interface BackupFileEntry {
  key: string;
  size: number;
  modifiedAt: string;
}

/** A container as `backup.volumes` answers. */
export interface VolumeUserContainer {
  id: string;
  name: string;
  state: string;
  labels: Record<string, string>;
  mounts: { name: string; destination: string }[];
}

export interface BackupVolumesAnswer {
  containers: VolumeUserContainer[];
  volumes: { name: string; labels: Record<string, string> }[];
  users: Record<string, VolumeUserContainer[]>;
  missing: string[];
}
