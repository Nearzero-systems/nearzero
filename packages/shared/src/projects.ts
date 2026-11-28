import { z } from "zod";
import {
  appNameProblem,
  DATABASE_PASSWORD_MAX,
  DEFAULT_PROJECT_SORT,
  DESCRIPTION_MAX,
  databasePasswordProblem,
  environmentNameProblem,
  normalizeEnvironmentName,
  PROJECT_NAME_MAX,
  PROJECT_SORTS,
  SERVICE_KINDS,
  SERVICE_NAME_MAX,
  type ServiceKind,
} from "./project-rules.ts";
import { VARIABLES_MAX_BYTES } from "./variables.ts";

/**
 * Request schemas for projects, environments, services and variables (spec 02, spec 05, spec 06
 * 6.1, spec 07 7.1, spec 08 8.1). The control plane validates with these, and the console uses
 * the same ones so its words match. The names, kinds, defaults and rules they are built on live
 * in project-rules.ts and are re-exported here.
 */

export * from "./project-rules.ts";

// ---- Request schemas

const descriptionField = z
  .string()
  .trim()
  .max(DESCRIPTION_MAX, `Use at most ${DESCRIPTION_MAX.toLocaleString("en-US")} characters.`);

const projectNameField = z
  .string({ error: "Project name is required" })
  .trim()
  .min(1, "Project name is required")
  .max(PROJECT_NAME_MAX, `Use at most ${PROJECT_NAME_MAX} characters.`);

export const createProjectRequestSchema = z.object({
  name: projectNameField,
  description: descriptionField.default(""),
});

export const updateProjectRequestSchema = z.object({
  name: projectNameField.optional(),
  description: descriptionField.optional(),
});

export const listProjectsQuerySchema = z.object({
  search: z.string().trim().max(200).default(""),
  sort: z
    .enum(PROJECT_SORTS, {
      error: `Sort by one of: ${PROJECT_SORTS.join(", ")}.`,
    })
    .default(DEFAULT_PROJECT_SORT),
});

const environmentNameField = z
  .string({ error: "Enter a name for the environment." })
  .transform(normalizeEnvironmentName)
  .superRefine((name, context) => {
    const problem = environmentNameProblem(name);
    if (problem) context.addIssue({ code: "custom", message: problem });
  });

export const createEnvironmentRequestSchema = z.object({
  name: environmentNameField,
  description: descriptionField.default(""),
  /**
   * "Start empty" (from: null) or "Copy names from <environment>"; with `values`, also copy the
   * values, secrets included.
   */
  variables: z
    .object({
      from: z.string().trim().min(1).max(64).nullable().default(null),
      values: z.boolean().default(false),
    })
    .default({ from: null, values: false }),
});

export const updateEnvironmentRequestSchema = z.object({
  name: environmentNameField.optional(),
  description: descriptionField.optional(),
});

// Services

const serviceNameField = z
  .string({ error: "Enter a name for the service." })
  .trim()
  .min(1, "Enter a name for the service.")
  .max(SERVICE_NAME_MAX, `Use at most ${SERVICE_NAME_MAX} characters.`);

const appNameField = z
  .string()
  .trim()
  .superRefine((base, context) => {
    const problem = appNameProblem(base);
    if (problem) context.addIssue({ code: "custom", message: problem });
  });

const imageField = z
  .string()
  .trim()
  .max(500, "Use at most 500 characters.")
  .refine(
    (value) => !/\s/.test(value),
    'Enter an image with no spaces, like "nginx:alpine" or "ghcr.io/acme/api:1.2.0".',
  );

const portField = z
  .number({ error: "Enter a valid service port (1–65535)." })
  .int("Enter a valid service port (1–65535).")
  .min(1, "Enter a valid service port (1–65535).")
  .max(65535, "Enter a valid service port (1–65535).");

const identifierField = (what: string) =>
  z
    .string()
    .trim()
    .max(63, "Use at most 63 characters.")
    .refine(
      (value) => value === "" || /^[A-Za-z][A-Za-z0-9_-]*$/.test(value),
      `Use letters, numbers, _ and - for the ${what}, starting with a letter.`,
    );

/** Empty means "generate one". */
const passwordField = z
  .string()
  .max(DATABASE_PASSWORD_MAX)
  .superRefine((value, context) => {
    if (value === "") return;
    const problem = databasePasswordProblem(value);
    if (problem) context.addIssue({ code: "custom", message: problem });
  });

const COMPOSE_FILE_MAX = VARIABLES_MAX_BYTES;

export const applicationSettingsInputSchema = z.object({
  /** "Create without Git": a container image, optional. Git sources arrive with M3/M8. */
  image: imageField.default(""),
  /** Left out, each deploy uses the port the image declares (30b R2-01). */
  servicePort: portField.optional(),
});

export const composeSettingsInputSchema = z.object({
  format: z.enum(["compose", "stack"]).default("compose"),
  /** Pasted YAML. Values for ${VAR} placeholders belong in the service's variables. */
  composeFile: z
    .string()
    .max(COMPOSE_FILE_MAX, `A Compose file can be up to ${COMPOSE_FILE_MAX / 1024} KB.`)
    .default(""),
});

const sqlSettingsInput = {
  databaseName: identifierField("database name").default(""),
  user: identifierField("user").default(""),
  password: passwordField.default(""),
  image: imageField.default(""),
};

export const postgresSettingsInputSchema = z.object(sqlSettingsInput);
export const mysqlSettingsInputSchema = z.object({
  ...sqlSettingsInput,
  rootPassword: passwordField.default(""),
});
export const mariadbSettingsInputSchema = mysqlSettingsInputSchema;
export const mongodbSettingsInputSchema = z.object({
  user: identifierField("user").default(""),
  password: passwordField.default(""),
  image: imageField.default(""),
  /** Only at creation. */
  replicaSet: z.boolean().default(false),
});
export const redisSettingsInputSchema = z.object({
  password: passwordField.default(""),
  image: imageField.default(""),
});
export const libsqlSettingsInputSchema = z
  .object({
    user: identifierField("user").default(""),
    password: passwordField.default(""),
    image: imageField.default(""),
    /** Only at creation. */
    nodeRole: z.enum(["primary", "replica"]).default("primary"),
    primaryUrl: z.string().trim().max(500).default(""),
    namespaces: z.boolean().default(false),
  })
  .superRefine((value, context) => {
    if (value.nodeRole !== "replica") return;
    if (!/^https?:\/\/[^\s/]+/.test(value.primaryUrl)) {
      context.addIssue({
        code: "custom",
        path: ["primaryUrl"],
        message: "A replica needs its primary's URL, like http://primary-host:8080.",
      });
    }
  });

export const serviceSettingsInputSchemas = {
  application: applicationSettingsInputSchema,
  compose: composeSettingsInputSchema,
  postgres: postgresSettingsInputSchema,
  mysql: mysqlSettingsInputSchema,
  mariadb: mariadbSettingsInputSchema,
  mongodb: mongodbSettingsInputSchema,
  redis: redisSettingsInputSchema,
  libsql: libsqlSettingsInputSchema,
} as const satisfies Record<ServiceKind, z.ZodType>;

export type ServiceSettingsInput<Kind extends ServiceKind> = z.output<
  (typeof serviceSettingsInputSchemas)[Kind]
>;

const variableRowField = z.object({
  name: z.string().max(1024),
  value: z.string().max(VARIABLES_MAX_BYTES),
});

const commonServiceFields = {
  name: serviceNameField,
  /** "host" for the Nearzero host, otherwise a server's id. */
  serverId: z
    .string({ error: "Pick a server." })
    .trim()
    .min(1, "Pick a server.")
    .max(64, "Pick a server."),
  /** Without it, one is made from the project's name and the service's. */
  appName: appNameField.optional(),
  description: descriptionField.default(""),
  /** Variables to start with; the copies in other environments get the names only. */
  variables: z.array(variableRowField).max(2000).default([]),
};

function serviceBranch<Kind extends ServiceKind, Settings extends z.ZodType>(
  kind: Kind,
  settings: Settings,
) {
  return z.object({
    kind: z.literal(kind),
    ...commonServiceFields,
    settings: settings.prefault({} as z.input<Settings>),
  });
}

export const createServiceRequestSchema = z.discriminatedUnion(
  "kind",
  [
    serviceBranch("application", applicationSettingsInputSchema),
    serviceBranch("compose", composeSettingsInputSchema),
    serviceBranch("postgres", postgresSettingsInputSchema),
    serviceBranch("mysql", mysqlSettingsInputSchema),
    serviceBranch("mariadb", mariadbSettingsInputSchema),
    serviceBranch("mongodb", mongodbSettingsInputSchema),
    serviceBranch("redis", redisSettingsInputSchema),
    serviceBranch("libsql", libsqlSettingsInputSchema),
  ],
  { error: `Choose a kind of service: ${SERVICE_KINDS.join(", ")}.` },
);

export type CreateServiceRequest = z.output<typeof createServiceRequestSchema>;

/** What can change on a service after creation, per kind. Fixed choices are left out. */
export const serviceSettingsUpdateSchemas = {
  application: z.object({ image: imageField.optional(), servicePort: portField.optional() }),
  compose: z.object({ composeFile: composeSettingsInputSchema.shape.composeFile.optional() }),
  postgres: z.object({ image: imageField.optional() }),
  mysql: z.object({ image: imageField.optional() }),
  mariadb: z.object({ image: imageField.optional() }),
  mongodb: z.object({ image: imageField.optional() }),
  redis: z.object({ image: imageField.optional() }),
  libsql: z.object({ image: imageField.optional() }),
} as const satisfies Record<ServiceKind, z.ZodType>;

export const updateServiceRequestSchema = z.object({
  description: descriptionField.optional(),
  /** Checked against the service's kind. */
  settings: z.record(z.string(), z.unknown()).optional(),
});

// Deleting

const idsField = z
  .array(z.string().trim().min(1).max(64))
  .min(1, "Choose at least one service.")
  .max(500, "Delete at most 500 services at once.");

const confirmField = z.string({ error: "Type the name to confirm." }).max(200);

export const deleteProjectRequestSchema = z.object({
  /** From the plan the person saw; a changed project refuses the delete. */
  fingerprint: z.string().min(1).max(128),
  /** The project's name, as typed. */
  confirm: confirmField,
});

export const servicesDeletePlanRequestSchema = z.object({ serviceIds: idsField });

export const deleteServicesRequestSchema = z.object({
  serviceIds: idsField,
  fingerprint: z.string().min(1).max(128),
  /** The project's name, as typed. */
  confirm: confirmField,
});

export const deleteServiceRequestSchema = z.object({
  /** The service's name, as typed. */
  confirm: confirmField,
  /** Copies in other environments to delete too; none unless ticked. */
  alsoDeleteCopyIds: z.array(z.string().trim().min(1).max(64)).max(100).default([]),
});

// Variables

export const saveVariablesRequestSchema = z
  .object({
    /** Text mode: the whole text, stored exactly as sent. */
    text: z.string().optional(),
    /**
     * Form mode: the rows in order. `keep: true` keeps the saved value of that name without
     * sending it (values stay hidden in the form until shown).
     */
    rows: z
      .array(
        z.object({
          name: z.string().max(1024),
          value: z.string().max(VARIABLES_MAX_BYTES).optional(),
          keep: z.boolean().optional(),
        }),
      )
      .max(5000)
      .optional(),
    /** The version the editor opened; a newer saved version refuses the save. */
    baseVersion: z.number().int().min(0).optional(),
  })
  .refine((value) => (value.text === undefined) !== (value.rows === undefined), {
    message: "Send the variables either as text or as rows.",
  });
