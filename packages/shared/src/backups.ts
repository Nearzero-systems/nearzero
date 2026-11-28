import { z } from "zod";
import {
  ACCESS_KEY_MAX,
  BACKUP_MESSAGES,
  BACKUP_PROVIDERS,
  bucketProblem,
  DESTINATION_NAME_MAX,
  ENDPOINT_MAX,
  endpointProblem,
  KEEP_MAX,
  normalizeFolder,
  parseCron,
  REGION_MAX,
  regionProblem,
  SECRET_KEY_MAX,
} from "./backup-rules.ts";

/**
 * Request schemas for backup destinations, schedules, runs and restores (spec 08 8.3, 17). The
 * control plane validates with these; the words and pure rules live in backup-rules.ts,
 * re-exported here.
 */

export * from "./backup-rules.ts";

const uuid = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    "Pick one from the list.",
  );

const nameField = z
  .string()
  .trim()
  .min(1, "Enter a name for this destination.")
  .max(DESTINATION_NAME_MAX, `Use at most ${DESTINATION_NAME_MAX} characters.`);

const endpointField = z
  .string()
  .trim()
  .max(ENDPOINT_MAX, `Use at most ${ENDPOINT_MAX} characters.`)
  .superRefine((value, context) => {
    const problem = endpointProblem(value);
    if (problem) context.addIssue({ code: "custom", message: problem });
  })
  .transform((value) => value.replace(/\/+$/, ""));

const bucketField = z
  .string()
  .trim()
  .superRefine((value, context) => {
    const problem = bucketProblem(value);
    if (problem) context.addIssue({ code: "custom", message: problem });
  });

const regionField = z
  .string()
  .trim()
  .max(REGION_MAX, `Use at most ${REGION_MAX} characters.`)
  .superRefine((value, context) => {
    const problem = regionProblem(value);
    if (problem) context.addIssue({ code: "custom", message: problem });
  })
  .transform((value) => (value === "" ? "auto" : value));

const keyField = (max: number, message: string) =>
  z
    .string()
    .max(max, `Use at most ${max} characters.`)
    .refine((value) => !/[\s]/.test(value.trim()) && !/[\0\r\n]/.test(value), message)
    .transform((value) => value.trim());

const accessKeyField = keyField(ACCESS_KEY_MAX, "Paste the access key ID without spaces.");
const secretKeyField = keyField(SECRET_KEY_MAX, "Paste the secret access key without spaces.");

export const createDestinationRequestSchema = z.object({
  name: nameField,
  provider: z.enum(BACKUP_PROVIDERS, "Pick a provider."),
  endpoint: endpointField,
  bucket: bucketField,
  region: regionField.default("auto"),
  accessKeyId: accessKeyField.refine((value) => value !== "", "Paste the access key ID."),
  secretAccessKey: secretKeyField.refine((value) => value !== "", "Paste the secret access key."),
});

/** Blank keys keep the saved ones (spec 17.1). */
export const updateDestinationRequestSchema = z.object({
  name: nameField.optional(),
  provider: z.enum(BACKUP_PROVIDERS, "Pick a provider.").optional(),
  endpoint: endpointField.optional(),
  bucket: bucketField.optional(),
  region: regionField.optional(),
  accessKeyId: accessKeyField.optional(),
  secretAccessKey: secretKeyField.optional(),
});

export const testDestinationRequestSchema = z.object({
  /** The server to test from (a server id or "host"); the first reachable one when left out. */
  serverId: z.string().max(64).optional(),
});

/**
 * Test connection from the Add or Edit dialog, before saving (spec 17.1): the typed values. On
 * edit (`destinationId`), blank keys use the saved ones; for a new destination both are needed.
 */
export const testDestinationValuesRequestSchema = z.object({
  destinationId: z.string().max(64).optional(),
  provider: z.enum(BACKUP_PROVIDERS, "Pick a provider."),
  endpoint: endpointField,
  bucket: bucketField,
  region: regionField.default("auto"),
  accessKeyId: accessKeyField.default(""),
  secretAccessKey: secretKeyField.default(""),
  serverId: z.string().max(64).optional(),
});

const folderField = z
  .string()
  .max(400)
  .transform((value, context) => {
    const result = normalizeFolder(value);
    if ("folder" in result) return result.folder;
    context.addIssue({ code: "custom", message: result.problem });
    return z.NEVER;
  });

const cronField = z
  .string()
  .max(200)
  .transform((value, context) => {
    const parsed = parseCron(value);
    if (parsed.ok) return parsed.cron.expression;
    context.addIssue({ code: "custom", message: parsed.message });
    return z.NEVER;
  });

const keepField = z.union([z.number(), z.null(), z.literal("")]).transform((value, context) => {
  if (value === null || value === "") return null;
  if (!Number.isInteger(value) || value < 1 || value > KEEP_MAX) {
    context.addIssue({ code: "custom", message: BACKUP_MESSAGES.keepProblem });
    return z.NEVER;
  }
  return value;
});

const databaseField = z
  .string()
  .trim()
  .max(64, "Use at most 64 characters.")
  .refine(
    (value) => value === "" || /^[A-Za-z0-9_][A-Za-z0-9_$-]{0,63}$/.test(value),
    "Enter a database name: letters, numbers, _ and -.",
  );

const volumeField = z
  .string()
  .trim()
  .min(1, "Pick a volume.")
  .max(255)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/, "Pick a volume from the list.");

export const createScheduleRequestSchema = z.object({
  destinationId: uuid,
  /** Databases: which database to dump (spec 08 8.3); blank means the service's own. */
  database: databaseField.optional(),
  /** Volume backups (spec 17.3). */
  volume: volumeField.optional(),
  stopService: z.boolean().default(false),
  folder: folderField,
  cron: cronField,
  keep: keepField.default(null),
  enabled: z.boolean().default(true),
});

export const updateScheduleRequestSchema = z.object({
  destinationId: uuid.optional(),
  database: databaseField.optional(),
  volume: volumeField.optional(),
  stopService: z.boolean().optional(),
  folder: folderField.optional(),
  cron: cronField.optional(),
  keep: keepField.optional(),
  enabled: z.boolean().optional(),
});

export const listFilesQuerySchema = z.object({
  destinationId: uuid,
  /** Blank: straight under the app name, where a folderless schedule moved from 0.1.x wrote. */
  folder: z.union([z.literal(""), folderField]),
  volume: volumeField.optional(),
});

export const restoreRequestSchema = z.object({
  destinationId: uuid,
  key: z.string().min(1, "Pick a backup.").max(1024),
  /** The service's name as typed. */
  confirm: z.string().max(200),
  /** Volume restores: the volume to restore into. */
  volume: volumeField.optional(),
  /**
   * Database restores: the database to load the backup into (R3-45). Blank or left out: the
   * database the backup was dumped from.
   */
  database: databaseField.optional(),
});

export type CreateDestinationRequest = z.output<typeof createDestinationRequestSchema>;
export type UpdateDestinationRequest = z.output<typeof updateDestinationRequestSchema>;
export type TestDestinationValuesRequest = z.output<typeof testDestinationValuesRequestSchema>;
export type CreateScheduleRequest = z.output<typeof createScheduleRequestSchema>;
export type UpdateScheduleRequest = z.output<typeof updateScheduleRequestSchema>;
export type RestoreRequest = z.output<typeof restoreRequestSchema>;
