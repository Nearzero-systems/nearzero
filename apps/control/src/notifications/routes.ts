import {
  createChannelRequestSchema,
  NOTIFICATION_MESSAGES,
  testChannelRequestSchema,
  updateChannelRequestSchema,
} from "@nearzero/shared";
import { Hono } from "hono";
import { z } from "zod";
import { workspaceActorFor } from "../http/actor.ts";
import type { AppEnv } from "../http/context.ts";
import { readBody } from "../http/validate.ts";
import type { ControlServices } from "../services.ts";
import {
  createChannel,
  deleteChannel,
  getChannel,
  listChannels,
  testChannel,
  updateChannel,
} from "./channels.ts";

/** Notification channels (spec 15); docs/api/notifications.md. */
export function notificationRoutes(services: ControlServices): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/notification-channels", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json(await listChannels(services, actor));
  });

  app.post("/notification-channels", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const body = await readBody(c, createChannelRequestSchema);
    return c.json(
      {
        channel: await createChannel(services, actor, body),
        message: NOTIFICATION_MESSAGES.created,
      },
      201,
    );
  });

  app.post("/notification-channels/test", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const body = await readBody(
      c,
      testChannelRequestSchema.extend({ name: z.string().max(100).optional() }),
    );
    return c.json(await testChannel(services, actor, body));
  });

  app.get("/notification-channels/:id", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json({ channel: await getChannel(services, actor, c.req.param("id")) });
  });

  app.patch("/notification-channels/:id", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const body = await readBody(c, updateChannelRequestSchema);
    return c.json({
      channel: await updateChannel(services, actor, c.req.param("id"), body),
      message: NOTIFICATION_MESSAGES.saved,
    });
  });

  app.delete("/notification-channels/:id", async (c) => {
    const actor = await workspaceActorFor(c, services);
    await deleteChannel(services, actor, c.req.param("id"));
    return c.json({ deleted: true, message: NOTIFICATION_MESSAGES.deleted });
  });

  return app;
}
