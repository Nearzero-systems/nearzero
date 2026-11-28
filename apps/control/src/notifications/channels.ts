import {
  AppError,
  CHANNEL_TYPE_INFO,
  type ChannelType,
  type ChannelValue,
  type CreateChannelRequest,
  checkChannel,
  createChannelRequestSchema,
  eventsText,
  lastFailureText,
  maskedUrl,
  NOTIFICATION_EVENTS,
  NOTIFICATION_MESSAGES,
  type NotificationEvent,
  type TestChannelRequest,
  testChannelRequestSchema,
  testFailedText,
  testSentText,
  type UpdateChannelRequest,
  updateChannelRequestSchema,
} from "@nearzero/shared";
import { sql } from "kysely";
import { recordAudit } from "../audit/audit.ts";
import { auditActor, type WorkspaceActor } from "../http/actor.ts";
import { check } from "../http/validate.ts";
import { isOurId } from "../projects/objects.ts";
import type { ControlServices } from "../services.ts";
import { firstWorkspaceId } from "../workspaces/workspaces.ts";
import { testMessage } from "./messages.ts";
import { checkDestinations, DeliveryError, deliver } from "./senders.ts";
import type { ChannelRow } from "./tables.ts";
import { transportOf } from "./transport.ts";

/**
 * A workspace's notification channels (spec 15.1, 15.2): owners and admins, or people with
 * "Manage notification channels". Secrets are sealed and never sent back; blank fields on edit
 * keep them, and changing where a channel sends asks for them again.
 */

export interface ChannelView {
  id: string;
  name: string;
  type: ChannelType;
  typeLabel: string;
  events: NotificationEvent[];
  eventsText: string;
  /** Fields that may be shown again. */
  settings: Record<string, ChannelValue>;
  /** Which secrets are saved (never their values); provider webhooks show their host. */
  secrets: Record<string, { saved: boolean; hint: string | null }>;
  readable: boolean;
  lastDeliveryAt: string | null;
  lastFailure: string | null;
  lastFailureAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelList {
  channels: ChannelView[];
  total: number;
  can: { create: boolean; update: boolean; delete: boolean };
  /** The events this workspace can subscribe to ("Nearzero restart" only in the first). */
  events: NotificationEvent[];
}

function context(id: string): string {
  return `notification-channel:${id}`;
}

export function openSecrets(
  services: ControlServices,
  row: Pick<ChannelRow, "id" | "secrets_sealed">,
): { ok: true; secrets: Record<string, ChannelValue> } | { ok: false } {
  if (!row.secrets_sealed) return { ok: true, secrets: {} };
  const opened = services.secrets.open(row.secrets_sealed, context(row.id));
  if (!opened.ok) return { ok: false };
  try {
    return { ok: true, secrets: JSON.parse(opened.value) as Record<string, ChannelValue> };
  } catch {
    return { ok: false };
  }
}

function view(services: ControlServices, row: ChannelRow): ChannelView {
  const opened = openSecrets(services, row);
  const secrets: ChannelView["secrets"] = {};
  for (const field of CHANNEL_TYPE_INFO[row.type].fields) {
    if (!field.secret) continue;
    const value = opened.ok ? opened.secrets[field.key] : undefined;
    const saved =
      value !== undefined && !(Array.isArray(value) && value.length === 0) && value !== "";
    secrets[field.key] = {
      saved: opened.ok ? saved : Boolean(row.secrets_sealed),
      hint:
        saved && field.secretUrl && typeof value === "string"
          ? maskedUrl(value)
          : saved && field.kind === "headers" && Array.isArray(value)
            ? `${value.length} saved`
            : null,
    };
  }
  const events = (row.events ?? []).filter((event): event is NotificationEvent =>
    (NOTIFICATION_EVENTS as readonly string[]).includes(event),
  );
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    typeLabel: CHANNEL_TYPE_INFO[row.type].label,
    events,
    eventsText: eventsText(events),
    settings: (row.settings ?? {}) as Record<string, ChannelValue>,
    secrets,
    readable: opened.ok,
    lastDeliveryAt: row.last_delivery_at ? new Date(row.last_delivery_at).toISOString() : null,
    lastFailure: row.last_failure ? lastFailureText(row.last_failure) : null,
    lastFailureAt: row.last_failure_at ? new Date(row.last_failure_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function allowedEvents(
  services: ControlServices,
  actor: WorkspaceActor,
): Promise<NotificationEvent[]> {
  const first = await firstWorkspaceId(services.db);
  return NOTIFICATION_EVENTS.filter(
    (event) => event !== "nearzero.restart" || first === actor.workspace.id,
  );
}

async function requireChannels(actor: WorkspaceActor): Promise<void> {
  await actor.access.require("notifications.manage");
}

export async function listChannels(
  services: ControlServices,
  actor: WorkspaceActor,
): Promise<ChannelList> {
  await requireChannels(actor);
  const rows = await services.db
    .selectFrom("notification_channel")
    .selectAll()
    .where("workspace_id", "=", actor.workspace.id)
    .orderBy(sql`lower(name)`)
    .execute();
  return {
    channels: rows.map((row) => view(services, row)),
    total: rows.length,
    can: { create: true, update: true, delete: true },
    events: await allowedEvents(services, actor),
  };
}

async function channelFor(
  services: ControlServices,
  actor: WorkspaceActor,
  id: string,
): Promise<ChannelRow> {
  await requireChannels(actor);
  if (!isOurId(id)) throw new AppError("not_found", NOTIFICATION_MESSAGES.notFound);
  const row = await services.db
    .selectFrom("notification_channel")
    .selectAll()
    .where("id", "=", id)
    .where("workspace_id", "=", actor.workspace.id)
    .executeTakeFirst();
  if (!row) throw new AppError("not_found", NOTIFICATION_MESSAGES.notFound);
  return row;
}

export async function getChannel(
  services: ControlServices,
  actor: WorkspaceActor,
  id: string,
): Promise<ChannelView> {
  return view(services, await channelFor(services, actor, id));
}

function refuse(problems: Record<string, string>): void {
  const keys = Object.keys(problems);
  if (keys.length === 0) return;
  const fields: Record<string, string> = {};
  for (const key of keys) fields[`fields.${key}`] = problems[key] as string;
  throw new AppError("invalid_request", problems[keys[0] as string] as string, { fields });
}

async function checkEvents(
  services: ControlServices,
  actor: WorkspaceActor,
  events: NotificationEvent[],
) {
  const allowed = await allowedEvents(services, actor);
  if (events.some((event) => !allowed.includes(event))) {
    throw new AppError("invalid_request", NOTIFICATION_MESSAGES.restartOnlyFirst, {
      fields: { events: NOTIFICATION_MESSAGES.restartOnlyFirst },
    });
  }
  return [...new Set(events)];
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string })?.code === "23505";
}

/** A channel pointed at a private or internal address is for instance administrators (B1-20). */
async function refuseInternal(
  services: ControlServices,
  actor: WorkspaceActor,
  type: ChannelType,
  checked: { settings: Record<string, ChannelValue>; secrets: Record<string, ChannelValue> },
): Promise<void> {
  const problem = await checkDestinations(
    transportOf(services),
    type,
    checked.settings,
    checked.secrets,
    { allowInternal: actor.isInstanceAdmin },
  );
  if (!problem) return;
  const field = CHANNEL_TYPE_INFO[type].fields.find(
    (item) => item.kind === "url" || (type === "email" && item.key === "host"),
  );
  throw new AppError("invalid_request", problem, {
    fields: field ? { [`fields.${field.key}`]: problem } : {},
  });
}

export async function createChannel(
  services: ControlServices,
  actor: WorkspaceActor,
  input: CreateChannelRequest,
): Promise<ChannelView> {
  await requireChannels(actor);
  const request = check(createChannelRequestSchema, input);
  const checked = checkChannel(request.type, request.fields);
  refuse(checked.problems);
  await refuseInternal(services, actor, request.type, checked);
  const events = await checkEvents(services, actor, request.events);
  const id = crypto.randomUUID();
  try {
    await services.db
      .insertInto("notification_channel")
      .values({
        id,
        workspace_id: actor.workspace.id,
        name: request.name,
        type: request.type,
        settings: JSON.stringify(checked.settings),
        secrets_sealed:
          Object.keys(checked.secrets).length > 0
            ? services.secrets.seal(JSON.stringify(checked.secrets), context(id))
            : null,
        events,
        created_by: actor.personId,
        internal_allowed: actor.isInstanceAdmin,
      })
      .execute();
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AppError("conflict", NOTIFICATION_MESSAGES.nameTaken, {
        fields: { name: NOTIFICATION_MESSAGES.nameTaken },
      });
    }
    throw error;
  }
  await recordAudit(services.db, services.log, auditActor(actor), {
    action: "notification-channel.created",
    workspaceId: actor.workspace.id,
    target: { kind: "notification_channel", id },
    details: { name: request.name, type: request.type, events },
  });
  return getChannel(services, actor, id);
}

export async function updateChannel(
  services: ControlServices,
  actor: WorkspaceActor,
  id: string,
  input: UpdateChannelRequest,
): Promise<ChannelView> {
  const row = await channelFor(services, actor, id);
  const request = check(updateChannelRequestSchema, input);
  const patch: Record<string, unknown> = {};
  if (request.fields !== undefined) {
    const opened = openSecrets(services, row);
    const saved = {
      settings: (row.settings ?? {}) as Record<string, ChannelValue>,
      secrets: opened.ok ? opened.secrets : {},
    };
    const checked = checkChannel(row.type, request.fields, saved);
    refuse(checked.problems);
    await refuseInternal(services, actor, row.type, checked);
    patch.settings = JSON.stringify(checked.settings);
    patch.secrets_sealed =
      Object.keys(checked.secrets).length > 0
        ? services.secrets.seal(JSON.stringify(checked.secrets), context(row.id))
        : null;
    // A changed destination starts with a clean slate, and may reach private and internal
    // addresses only when an instance administrator saved it (B1-20).
    patch.last_failure = null;
    patch.last_failure_at = null;
    patch.internal_allowed = actor.isInstanceAdmin;
  }
  if (request.events !== undefined)
    patch.events = await checkEvents(services, actor, request.events);
  if (request.name !== undefined) patch.name = request.name;
  try {
    await services.db
      .updateTable("notification_channel")
      .set({ ...patch, updated_at: sql<Date>`now()` })
      .where("id", "=", row.id)
      .execute();
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AppError("conflict", NOTIFICATION_MESSAGES.nameTaken, {
        fields: { name: NOTIFICATION_MESSAGES.nameTaken },
      });
    }
    throw error;
  }
  await recordAudit(services.db, services.log, auditActor(actor), {
    action: "notification-channel.updated",
    workspaceId: actor.workspace.id,
    target: { kind: "notification_channel", id: row.id },
    details: { name: request.name ?? row.name, changed: Object.keys(request) },
  });
  return getChannel(services, actor, row.id);
}

export async function deleteChannel(
  services: ControlServices,
  actor: WorkspaceActor,
  id: string,
): Promise<void> {
  const row = await channelFor(services, actor, id);
  await services.db.deleteFrom("notification_channel").where("id", "=", row.id).execute();
  await recordAudit(services.db, services.log, auditActor(actor), {
    action: "notification-channel.deleted",
    workspaceId: actor.workspace.id,
    target: { kind: "notification_channel", id: row.id },
    details: { name: row.name, type: row.type },
  });
}

/** "Test notification": checks the fields and sends a test (spec 15.2). */
export async function testChannel(
  services: ControlServices,
  actor: WorkspaceActor,
  input: TestChannelRequest & { name?: string },
): Promise<{ ok: boolean; message: string }> {
  await requireChannels(actor);
  const request = check(testChannelRequestSchema, input);
  let saved: Parameters<typeof checkChannel>[2] = null;
  let name = typeof input.name === "string" ? input.name : "";
  if (request.channelId) {
    const row = await channelFor(services, actor, request.channelId);
    if (row.type !== request.type) {
      throw new AppError(
        "invalid_request",
        "A channel's type can't change. Add a new channel instead.",
      );
    }
    const opened = openSecrets(services, row);
    saved = {
      settings: (row.settings ?? {}) as Record<string, ChannelValue>,
      secrets: opened.ok ? opened.secrets : {},
    };
    name ||= row.name;
  }
  const checked = checkChannel(request.type, request.fields, saved);
  refuse(checked.problems);
  try {
    await deliver(
      transportOf(services),
      request.type,
      checked.settings,
      checked.secrets,
      testMessage(name),
      // Only instance administrators reach private and internal addresses (B1-20).
      { allowInternal: actor.isInstanceAdmin },
    );
    return { ok: true, message: testSentText(request.type) };
  } catch (error) {
    const reason = error instanceof DeliveryError ? error.message : "the message couldn't be sent";
    return { ok: false, message: testFailedText(reason) };
  }
}
