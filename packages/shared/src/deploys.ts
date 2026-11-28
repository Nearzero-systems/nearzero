import { z } from "zod";
import {
  absolutePathProblem,
  BUILDER_TYPES,
  branchProblem,
  DEFAULT_STABILITY_SECONDS,
  DEPLOYMENT_STATUSES,
  HEROKU_STACKS,
  MAX_STABILITY_SECONDS,
  normalizeBuildPath,
  PORT_MODES,
  PORT_PROTOCOLS,
  parseGitUrl,
  RAILPACK_VERSIONS,
  volumeNameProblem,
} from "./deploy-rules.ts";
import { composePathProblem } from "./git-provider-rules.ts";

/**
 * Request schemas for deploys, app sources, builders, ports, mounts, deploy settings and
 * webhooks (spec 06, 08, 11). The control plane validates with these and the console uses the
 * same ones. The words and pure helpers they are built on live in deploy-rules.ts, re-exported
 * here.
 */

export * from "./build-rules.ts";
export * from "./deploy-rules.ts";

const imageField = z
  .string()
  .trim()
  .min(1, 'Enter an image, like "nginx:alpine" or "ghcr.io/acme/api:1.2.0".')
  .max(500, "Use at most 500 characters.")
  .refine(
    (value) => !/\s/.test(value),
    'Enter an image with no spaces, like "nginx:alpine" or "ghcr.io/acme/api:1.2.0".',
  );

const buildPathField = z
  .string()
  .max(500)
  .default("")
  .transform((value, context) => {
    const result = normalizeBuildPath(value);
    if (typeof result === "string") return result;
    context.addIssue({ code: "custom", message: result.problem });
    return z.NEVER;
  });

const branchField = z
  .string()
  .trim()
  .default("main")
  .superRefine((value, context) => {
    const problem = branchProblem(value);
    if (problem) context.addIssue({ code: "custom", message: problem });
  });

const watchPathsField = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(200, "Use at most 200 characters for a watch path.")
      .refine((value) => !value.includes("\0"), "That isn't a valid path."),
  )
  .max(50, "Use at most 50 watch paths.")
  .default([]);

const gitUrlField = z
  .string({ error: "Enter a valid public Git URL (HTTPS or git@host:owner/repo)." })
  .transform((value, context) => {
    const parsed = parseGitUrl(value);
    if ("problem" in parsed) {
      context.addIssue({ code: "custom", message: parsed.problem });
      return z.NEVER;
    }
    return parsed.url;
  });

/**
 * Where an application's code comes from (spec 6.3: Git URL, Image, Upload); a Compose service
 * takes the Git URL one with its Compose file path (spec 07 7.2).
 */
export const appSourceRequestSchema = z.discriminatedUnion(
  "type",
  [
    z.object({
      type: z.literal("git"),
      url: gitUrlField,
      branch: branchField,
      buildPath: buildPathField,
      /** A saved SSH key for git@ / ssh:// URLs; null for public HTTPS repositories. */
      sshKeyId: z.string().trim().min(1).max(64).nullable().default(null),
      /** "On push" deploys pushes to the branch; "On tag" deploys new tags. */
      trigger: z.enum(["push", "tag"]).default("push"),
      watchPaths: watchPathsField,
      submodules: z.boolean().default(false),
      /**
       * Compose services (spec 07 7.2, 21.10, the Git tab): the Compose file inside the
       * repository. Ignored for applications; a Compose service uses ./docker-compose.yml without
       * it.
       */
      composePath: z
        .string()
        .trim()
        .max(500)
        .optional()
        .superRefine((value, context) => {
          const problem = value === undefined ? null : composePathProblem(value);
          if (problem) context.addIssue({ code: "custom", message: problem });
        }),
    }),
    z.object({
      type: z.literal("image"),
      image: imageField,
      registry: z
        .object({
          address: z.string().trim().max(255).default(""),
          username: z.string().trim().max(255).default(""),
          /** Blank keeps the saved password ("Stored — leave blank to keep"). */
          password: z.string().max(4096).default(""),
        })
        .default({ address: "", username: "", password: "" }),
    }),
    z.object({
      type: z.literal("upload"),
      buildPath: buildPathField,
    }),
  ],
  { error: "Choose a source: git, image or upload." },
);
export type AppSourceRequest = z.output<typeof appSourceRequestSchema>;

/**
 * Install, build and start commands are one line each (spec 6.4): line breaks and other
 * control characters are refused, so a command can't add lines to a Procfile, a Dockerfile or
 * anything else it is written into.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: these are the characters refused.
export const COMMAND_CONTROL_CHARACTERS = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029]/;

const commandField = z
  .string()
  .max(2000, "Use at most 2,000 characters.")
  .refine(
    (value) => !COMMAND_CONTROL_CHARACTERS.test(value),
    "Keep the command on one line, without line breaks or other control characters.",
  )
  .default("");

export const builderSchema = z.discriminatedUnion(
  "type",
  [
    z.object({ type: z.literal("automatic") }),
    z.object({
      type: z.literal("dockerfile"),
      dockerfilePath: z.string().trim().max(500).default("Dockerfile"),
      contextPath: z.string().trim().max(500).default(""),
      stage: z
        .string()
        .trim()
        .max(128)
        .regex(/^([A-Za-z0-9][A-Za-z0-9_.-]*)?$/, "Use letters, numbers, ., _ and - for the stage.")
        .default(""),
    }),
    z.object({ type: z.literal("railpack"), version: z.enum(RAILPACK_VERSIONS).default("0.43.0") }),
    z.object({
      type: z.literal("nixpacks"),
      publishDirectory: z.string().trim().max(500).default(""),
    }),
    z.object({ type: z.literal("heroku"), stack: z.enum(HEROKU_STACKS).default("24") }),
    z.object({ type: z.literal("paketo") }),
    z.object({ type: z.literal("static"), spa: z.boolean().default(false) }),
  ],
  { error: `Choose a builder: ${BUILDER_TYPES.join(", ")}.` },
);
export type BuilderSettings = z.output<typeof builderSchema>;

export const buildSettingsRequestSchema = z.object({
  builder: builderSchema,
  commands: z
    .object({ install: commandField, build: commandField, start: commandField })
    .default({ install: "", build: "", start: "" }),
});
export type BuildSettingsRequest = z.output<typeof buildSettingsRequestSchema>;

/** A TCP or UDP port, 1 to 65535: the one port rule for mappings and the Agent's inputs. */
export const portNumberSchema = z
  .number({ error: "Enter a port from 1 to 65535." })
  .int("Enter a port from 1 to 65535.")
  .min(1, "Enter a port from 1 to 65535.")
  .max(65535, "Enter a port from 1 to 65535.");

export const portMappingSchema = z.object({
  containerPort: portNumberSchema,
  publishedPort: portNumberSchema,
  protocol: z.enum(PORT_PROTOCOLS).default("tcp"),
  mode: z.enum(PORT_MODES).default("routed"),
});
export type PortMapping = z.output<typeof portMappingSchema>;

export const portsRequestSchema = z.object({
  ports: z
    .array(portMappingSchema)
    .max(50, "Use at most 50 port mappings.")
    .superRefine((ports, context) => {
      const seen = new Map<string, number>();
      ports.forEach((port, index) => {
        const key = `${port.publishedPort}/${port.protocol}`;
        const first = seen.get(key);
        if (first !== undefined) {
          context.addIssue({
            code: "custom",
            path: [index, "publishedPort"],
            message: `Port ${port.publishedPort}/${port.protocol.toUpperCase()} is published twice. Keep one.`,
          });
        } else seen.set(key, index);
      });
    }),
});

const containerPathField = z.string().superRefine((value, context) => {
  const problem = absolutePathProblem(value, "container path");
  if (problem) context.addIssue({ code: "custom", message: problem });
});

const mountIdField = z
  .string()
  .regex(/^[a-z0-9]{1,16}$/)
  .optional();

/** How much a file mount holds (spec 6.8, 31d G4-16): what one container start carries. */
export const FILE_MOUNT_MAX_CHARS = 1024 * 1024;
export const FILE_MOUNT_TOO_LARGE = "A file mount can hold up to 1 MB.";

export const mountRequestSchema = z.discriminatedUnion(
  "type",
  [
    z.object({
      type: z.literal("volume"),
      id: mountIdField,
      name: z.string().superRefine((value, context) => {
        const problem = volumeNameProblem(value);
        if (problem) context.addIssue({ code: "custom", message: problem });
      }),
      containerPath: containerPathField,
      /**
       * Another app in the same environment and server whose volume `name` this mounts, so both
       * see the same files (31b G2-08).
       */
      of: z
        .string()
        .regex(/^[0-9a-f-]{36}$/, "Pick a volume of an app in this environment.")
        .optional(),
    }),
    z.object({
      type: z.literal("bind"),
      id: mountIdField,
      hostPath: z.string().superRefine((value, context) => {
        const problem = absolutePathProblem(value, "host path");
        if (problem) context.addIssue({ code: "custom", message: problem });
      }),
      containerPath: containerPathField,
      readOnly: z.boolean().default(false),
    }),
    z.object({
      type: z.literal("file"),
      id: mountIdField,
      containerPath: containerPathField,
      /** A secret, never shown again; leave it out to keep the saved content of this mount. */
      content: z.string().max(FILE_MOUNT_MAX_CHARS, FILE_MOUNT_TOO_LARGE).optional(),
    }),
  ],
  { error: "Choose a mount type: volume, bind or file." },
);
export type MountRequest = z.output<typeof mountRequestSchema>;

export const mountsRequestSchema = z.object({
  mounts: z
    .array(mountRequestSchema)
    .max(50, "Use at most 50 mounts.")
    .superRefine((mounts, context) => {
      const paths = new Map<string, number>();
      mounts.forEach((mount, index) => {
        const first = paths.get(mount.containerPath);
        if (first !== undefined) {
          context.addIssue({
            code: "custom",
            path: [index, "containerPath"],
            message: `${mount.containerPath} is mounted twice. Keep one.`,
          });
        } else paths.set(mount.containerPath, index);
      });
    }),
  /** Volumes of removed mounts whose data should be deleted ("keep the volume's data?" → no). */
  deleteVolumeData: z.array(z.string().max(63)).max(50).default([]),
});

export const deploySettingsRequestSchema = z.object({
  autodeploy: z.boolean().optional(),
  cleanCache: z.boolean().optional(),
  /** How long a new container must keep running before it replaces the old one. */
  stabilitySeconds: z
    .number()
    .int()
    .min(0)
    .max(MAX_STABILITY_SECONDS, `Use at most ${MAX_STABILITY_SECONDS} seconds.`)
    .optional(),
});

export const DEFAULT_DEPLOY_SETTINGS = {
  autodeploy: true,
  cleanCache: false,
  stabilitySeconds: DEFAULT_STABILITY_SECONDS,
} as const;

export const startDeployRequestSchema = z.object({
  /** Build this one without cached layers (the "Clean cache" switch does it for every build). */
  cleanCache: z.boolean().default(false),
  /** The header's Redeploy: recorded as "Redeploy" (spec 6.3); otherwise "Manual". */
  redeploy: z.boolean().default(false),
});

export const listDeploymentsQuerySchema = z.object({
  search: z.string().trim().max(200).default(""),
  status: z.enum([...DEPLOYMENT_STATUSES, "all"]).default("all"),
  type: z.enum(["all", "application", "compose", "database"]).default("all"),
  pageSize: z.coerce
    .number()
    .int()
    .refine((value) => [10, 25, 50, 100].includes(value), "Show 10, 25, 50 or 100 at once.")
    .default(50),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  serviceId: z.string().trim().max(64).optional(),
});

export const makePublicRequestSchema = z.object({ public: z.boolean() });

export const runtimeLogsQuerySchema = z.object({
  tail: z.enum(["100", "500", "1000", "all"]).default("100"),
  /** An ISO time: only output after it. */
  since: z
    .string()
    .trim()
    .max(64)
    .optional()
    .refine((value) => value === undefined || !Number.isNaN(Date.parse(value)), "Enter a time."),
  search: z.string().max(200).default(""),
  follow: z.enum(["0", "1"]).default("1"),
  container: z.string().max(128).optional(),
});
