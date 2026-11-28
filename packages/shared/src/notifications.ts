import { z } from "zod";
import { CHANNEL_TYPES, NOTIFICATION_EVENTS } from "./notification-rules.ts";

/**
 * Request schemas of the notification channels API (spec 15; docs/api/notifications.md). Each
 * type's fields are checked by `checkChannel` in notification-rules.ts, which names every
 * problem in the spec's words.
 */

const name = z.string().trim().min(1, "Name is required.").max(100, "Use at most 100 characters.");
const fields = z.record(z.string().max(64), z.unknown()).default({});
const events = z.array(z.enum(NOTIFICATION_EVENTS)).max(NOTIFICATION_EVENTS.length).default([]);

export const createChannelRequestSchema = z.object({
  name,
  type: z.enum(CHANNEL_TYPES, "Choose a channel type."),
  fields,
  events,
});
export type CreateChannelRequest = z.input<typeof createChannelRequestSchema>;

export const updateChannelRequestSchema = z.object({
  name: name.optional(),
  fields: fields.optional(),
  events: events.optional(),
});
export type UpdateChannelRequest = z.input<typeof updateChannelRequestSchema>;

export const testChannelRequestSchema = z.object({
  type: z.enum(CHANNEL_TYPES, "Choose a channel type."),
  fields,
  /** When editing: blank secrets come from this saved channel. */
  channelId: z
    .string()
    .regex(/^[0-9a-f-]{36}$/)
    .nullish(),
});
export type TestChannelRequest = z.input<typeof testChannelRequestSchema>;

export const alertSettingsRequestSchema = z.object({
  cpuThreshold: z.number().int().nullable(),
  memoryThreshold: z.number().int().nullable(),
});
export type AlertSettingsRequest = z.input<typeof alertSettingsRequestSchema>;

export const analyticsSettingsRequestSchema = z.object({
  enabled: z.boolean().optional(),
  cleanupCron: z.string().trim().min(1).max(200).optional(),
});
export type AnalyticsSettingsRequest = z.input<typeof analyticsSettingsRequestSchema>;
