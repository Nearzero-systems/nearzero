import { z } from "zod";
import {
  TASK_DESCRIPTION_MAX,
  TASK_NAME_MAX,
  TASK_PAGE_SIZES,
  TASK_PLACES,
  TASK_SHELLS,
} from "./task-rules.ts";

/**
 * Request schemas of the tasks API (spec 12, 20.12; docs/api/tasks.md). The checks that need a
 * shell or the database (syntax, the place, the person's rights) happen in the control plane.
 */

const uuid = z.string().regex(/^[0-9a-f-]{36}$/, "That isn't an id Nearzero gave out.");
/** Scripts are checked for size after line endings are converted; this is a hard cap. */
const script = z.string().max(96 * 1024, "The script is larger than 64 KB. Shorten it.");
const innerService = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/, "Pick one of the Compose file's services.");

const name = z
  .string()
  .trim()
  .min(1, "Enter a name.")
  .max(TASK_NAME_MAX, `Use at most ${TASK_NAME_MAX} characters for the name.`);
const description = z
  .string()
  .trim()
  .max(TASK_DESCRIPTION_MAX, `Use at most ${TASK_DESCRIPTION_MAX} characters for the description.`);
const cron = z.string().trim().min(1, "Enter a schedule.").max(200);
const timeZone = z.string().trim().max(64);

export const taskPlaceSchema = z.object({
  place: z.enum(TASK_PLACES, "Choose where the task runs."),
  serviceId: uuid.nullish(),
  innerService: innerService.nullish(),
  serverId: uuid.nullish(),
});

export const checkTaskRequestSchema = taskPlaceSchema.extend({
  /** When editing: the task being changed (its place is used, and its name may stay). */
  taskId: uuid.nullish(),
  shell: z.enum(TASK_SHELLS).default("bash"),
  cron,
  timeZone: timeZone.default(""),
  script,
});
export type CheckTaskRequest = z.input<typeof checkTaskRequestSchema>;

export const createTaskRequestSchema = taskPlaceSchema.extend({
  name,
  description: description.default(""),
  shell: z.enum(TASK_SHELLS).default("bash"),
  cron,
  timeZone: timeZone.default(""),
  script,
  enabled: z.boolean().default(true),
  /** "Save anyway": save although the checks gave warnings (errors always block). */
  force: z.boolean().default(false),
});
export type CreateTaskRequest = z.input<typeof createTaskRequestSchema>;

export const updateTaskRequestSchema = z.object({
  name: name.optional(),
  description: description.optional(),
  shell: z.enum(TASK_SHELLS).optional(),
  cron: cron.optional(),
  timeZone: timeZone.optional(),
  script: script.optional(),
  enabled: z.boolean().optional(),
  force: z.boolean().default(false),
});
export type UpdateTaskRequest = z.input<typeof updateTaskRequestSchema>;

export const TASK_SORTS = ["name", "schedule", "timezone", "status", "created"] as const;
export type TaskSort = (typeof TASK_SORTS)[number];

export const listTasksQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  status: z.enum(["all", "enabled", "disabled"]).default("all"),
  place: z.enum(["all", "services", "servers", "host"]).default("all"),
  sort: z.enum(TASK_SORTS).default("created"),
  order: z.enum(["asc", "desc"]).default("desc"),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .refine((value) => (TASK_PAGE_SIZES as readonly number[]).includes(value))
    .default(25),
  serviceId: uuid.optional(),
  serverId: z.union([uuid, z.literal("host")]).optional(),
});
export type ListTasksQuery = z.input<typeof listTasksQuerySchema>;
