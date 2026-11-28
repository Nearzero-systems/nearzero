import { z } from "zod";

/**
 * Runner commands for moving a 0.1.x install to 1.0 (spec 29.5): placing a server's certificate
 * authority state in its router's store before routes switch, and stopping, starting again or
 * removing the 0.1.x workload a service replaces, and restoring a volume archive into a service's
 * new volume on another machine. They are new command kinds, so an older runner answers them with
 * "unsupported".
 */

/** How a 0.1.x workload is found on its server (the export bundle names it). */
export const LEGACY_WORKLOAD_KINDS = [
  "swarm-service",
  "swarm-stack",
  "container",
  "compose-project",
] as const;
export type LegacyWorkloadKind = (typeof LEGACY_WORKLOAD_KINDS)[number];

const workloadName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/);
/** An absolute path of plain characters with no way back up. */
const absoluteFile = z
  .string()
  .regex(/^\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/)
  .max(500)
  .refine((value) => !value.split("/").includes(".."));
/** A file named inside a Compose project's folder. */
const stackFile = z
  .string()
  .regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/)
  .refine((value) => !value.split("/").includes(".."));

export const migrationCommandSchemas = {
  /**
   * Merges a router store (Traefik's acme.json for the "letsencrypt" resolver) into the router's
   * certificates volume and restarts the router so it reads it. Certificates the router already
   * holds for a name stay when they last longer; its own account stays when it has one.
   */
  "certificates.import": z.object({
    store: z
      .string()
      .min(2)
      .max(32 * 1024 * 1024),
  }),
  /**
   * Stops, starts again, removes or describes a 0.1.x workload: a Swarm service (scaled to zero
   * and back to its earlier replica count; stopping also lets go of its published ports, which
   * Swarm holds even at zero replicas, and starting publishes them again), every service of a
   * Swarm stack, a container, or a Compose project. Never touches Nearzero 1.0's own containers.
   * Volumes are never removed.
   */
  "legacy.workload": z.object({
    action: z.enum(["stop", "start", "remove", "status"]),
    kind: z.enum(LEGACY_WORKLOAD_KINDS),
    name: workloadName,
    /**
     * A Compose project's own files (29a.9 `legacy`): starting it then removes 1.0's labelled
     * containers in the project and runs `docker compose up -d` from these files, never relying
     * on 0.1.x's stopped containers, which 1.0's deploy may have replaced (spec 29.5).
     */
    folder: z
      .string()
      .regex(/^\/[A-Za-z0-9._/-]{0,499}$/)
      .refine((value) => !value.split("/").includes(".."))
      .optional(),
    composeFiles: z.array(stackFile).max(16).default([]),
    /**
     * A name in the folder, or an absolute path when 0.1.x keeps the env file elsewhere: then it
     * must be a regular file under `dataFolders` or a `dataVolumes` volume's folder (29a.9).
     */
    envFile: z.union([stackFile, absoluteFile]).optional(),
    dataFolders: z.array(absoluteFile).max(16).default([]),
    dataVolumes: z.array(workloadName).max(32).default([]),
  }),
  /**
   * Waits until no container or Swarm service on the server publishes any of these ports (a
   * moved service's 0.1.x workload has let go of them), up to `timeoutSeconds`. Answers with
   * what still holds each port that isn't free.
   */
  "ports.wait-free": z.object({
    ports: z
      .array(
        z.object({
          port: z.number().int().min(1).max(65535),
          protocol: z.enum(["tcp", "udp"]).default("tcp"),
        }),
      )
      .min(1)
      .max(64),
    timeoutSeconds: z.number().int().min(0).max(600).default(60),
  }),
  /**
   * Downloads a volume archive the import kept (export --volumes, a tar rooted at the volume) with
   * the runner's credential, checks its size and SHA-256, and unpacks it into the named volume,
   * creating the volume when it doesn't exist. Files keep the owners the archive gives them.
   */
  "volume.restore": z.object({
    volume: workloadName,
    archiveId: z.string().uuid(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    sizeBytes: z
      .number()
      .int()
      .min(0)
      .max(2 ** 42),
  }),
} as const;

export type MigrationCommandKind = keyof typeof migrationCommandSchemas;

/** What `ports.wait-free` answers: each port still held, with what holds it. */
export interface PortsWaitResult {
  free: boolean;
  held: { port: number; protocol: "tcp" | "udp"; holder: string }[];
}

/** What `legacy.workload` answers. */
export interface LegacyWorkloadResult {
  /** False when nothing by that name exists on the server (already removed, for instance). */
  found: boolean;
  running: boolean;
}
