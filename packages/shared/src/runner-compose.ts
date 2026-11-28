import { z } from "zod";

/**
 * Runner commands for Compose stacks (spec 07, M7). They are part of the runner protocol
 * (runner-protocol.ts spreads them into its command list) and are new command kinds, so an older
 * runner answers them with "unsupported".
 *
 * A stack lives in its service's folder on the server, `<work>/compose/<project>` (the project is
 * the service's app name). A pasted file runs with that folder as its project directory; a
 * repository is copied into `repo/` inside it and runs from the Compose file's folder there.
 * Nearzero's own files (its additions, the env file) are kept in `.nearzero/` inside it.
 */

/** A Compose project name: the service's app name. */
const project = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/);
/** A service's folder in the runner's work folder (where `source.git` fetched it). */
const appKey = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
/** A path inside a folder: relative, no `..`, no leading slash. */
const insidePath = z
  .string()
  .max(1000)
  .refine(
    (value) =>
      value === "" ||
      (!value.startsWith("/") &&
        !value.includes("\0") &&
        !value.split("/").some((part) => part === "..")),
    "Use a path inside the folder.",
  );
const id = z.string().min(1).max(128);

export const COMPOSE_STAGES = ["validate", "pull", "build", "up", "connect"] as const;
export type ComposeStage = (typeof COMPOSE_STAGES)[number];

/** The oldest Docker Compose that runs Nearzero's additions (it uses `!reset` and `!override`). */
export const COMPOSE_MIN_VERSION = "2.24.4";

/**
 * The variable the runner sets for every Compose command: the service's folder as the Docker
 * Engine sees it. Nearzero's additions write bind mounts inside the folder with it, so they work
 * on the Nearzero host too, where the runner runs in a container and sees the folder elsewhere.
 */
export const SERVICE_FOLDER_VARIABLE = "NEARZERO_SERVICE_FOLDER";

export const composeCommandSchemas = {
  /**
   * Makes the stack's folder. With `repository`, copies the fetched repository (the service's
   * source folder) into `repo/` (files removed from the repository since the last copy are
   * removed; symbolic links that point outside the repository are skipped) and reads the Compose
   * file at `composePath`. Answers the Compose version on the server.
   */
  "compose.prepare": z.object({
    project,
    repository: z
      .object({
        appKey,
        composePath: insidePath.refine((value) => value !== "", "Name the Compose file."),
        /** Env files next to the Compose file that Compose reads before Nearzero's (a repository's .env). */
        envFiles: z.array(insidePath).max(8).default([".env"]),
      })
      .optional(),
  }),
  /**
   * Validates, pulls, builds and starts a stack, streaming Docker Compose's output. Nothing
   * running is touched until the file validated, every image pulled and every build finished.
   * After `up`, every container joins `network` with the alias `<aliasPrefix>-<service>`.
   * The answer says how it went (it doesn't throw for a stack that failed): `stage` names the
   * step that failed, and `touched` whether running containers were replaced.
   */
  "compose.deploy": z.object({
    project,
    /** The project directory inside the stack's folder: "" for a pasted file, "repo/<folder>". */
    directory: insidePath.default(""),
    /** Compose files, merged in order (the person's file, then Nearzero's additions). */
    files: z
      .array(
        z.object({
          name: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
          content: z.string().max(2 * 1024 * 1024),
        }),
      )
      .min(1)
      .max(4),
    /** The service's variables as an env file (secret: written 0600, never printed). */
    envFile: z.string().max(1024 * 1024),
    /** Also written as `.env` in the project directory (pasted files, for `env_file: .env`). */
    writeDotEnv: z.boolean().default(false),
    /** Env files in the project directory read before Nearzero's (a repository's .env). */
    extraEnvFiles: z.array(insidePath).max(8).default([]),
    /** Values cut out of everything printed. */
    secrets: z.array(z.string()).max(2000).default([]),
    /**
     * Bind-mount sources inside the stack's folder (relative to it). Each is made as a folder
     * when missing, and refused when any part of its path is a symbolic link.
     */
    bindPaths: z.array(insidePath).max(500).default([]),
    pull: z.boolean().default(true),
    build: z.boolean().default(true),
    noCache: z.boolean().default(false),
    /**
     * False while the stack is moved from 0.1.x and not finalized: it shares its project name with
     * 0.1.x's copy, whose containers aren't 1.0's to remove (spec 29.5).
     */
    removeOrphans: z.boolean().default(true),
    network: z
      .object({
        name: z.string().min(1).max(128),
        aliasPrefix: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
        /**
         * The inner services that join it: the ones hostnames route to (30b R2-11). The others
         * stay on the stack's own network, reachable only inside the stack. Left out: all
         * (older control planes).
         */
        services: z.array(z.string().min(1).max(128)).max(256).optional(),
      })
      .optional(),
  }),
  /** Restarts one container (the Containers section's row menu). */
  "container.restart": z.object({
    id,
    timeoutSeconds: z.number().int().min(0).max(600).default(10),
  }),
  /** Sends a signal to one container (Kill sends KILL). */
  "container.kill": z.object({
    id,
    signal: z.enum(["KILL", "TERM", "INT", "HUP", "QUIT"]).default("KILL"),
  }),
} as const;

export type ComposeCommandKind = keyof typeof composeCommandSchemas;

/** Commands of this file whose output arrives as a stream. */
export const COMPOSE_STREAMING_COMMANDS = ["compose.deploy"] as const;

/** What `compose.prepare` answers. */
export interface ComposePrepared {
  /** The stack's folder as the runner sees it, and as the Docker Engine sees it. */
  folder: string;
  hostFolder: string;
  /** The Docker Compose version on the server, like 2.39.4, or null when it isn't installed. */
  composeVersion: string | null;
  /** With a repository: the Compose file's text. */
  composeFile: string | null;
  /** With a repository: which of the asked env files exist next to the Compose file. */
  envFiles: string[];
  /**
   * The variables those env files set (later files win), for the control plane's checks of
   * where paths point and which variables are missing. Never shown or logged.
   */
  envValues: Record<string, string>;
  /** Symbolic links left out of the copy because they point outside the repository. */
  skippedLinks: string[];
  /**
   * Files (and folders, ending in /) left out because a container owns the folder they go in
   * (B2-06). Older runners don't send it.
   */
  skippedFiles?: string[];
}

/** One container of a stack after `compose.deploy`. */
export interface ComposeContainer {
  id: string;
  name: string;
  service: string;
  state: string;
}

/** What `compose.deploy` answers. */
export interface ComposeDeployed {
  ok: boolean;
  /** The step that failed. */
  stage: ComposeStage | null;
  message: string | null;
  /** True once `up` started: running containers may have been replaced. */
  touched: boolean;
  containers: ComposeContainer[];
  /** Containers that couldn't join the private network (network_mode set, for example). */
  notConnected: string[];
}
