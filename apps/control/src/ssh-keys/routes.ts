import {
  createSshKeyRequestSchema,
  generateSshKeyRequestSchema,
  SSH_KEY_MESSAGES,
  updateSshKeyRequestSchema,
} from "@nearzero/shared";
import { Hono } from "hono";
import { workspaceActorFor } from "../http/actor.ts";
import type { AppEnv } from "../http/context.ts";
import { readBody } from "../http/validate.ts";
import type { ControlServices } from "../services.ts";
import {
  addSshKey,
  deleteSshKey,
  generateSshKey,
  getSshKey,
  listSshKeys,
  updateSshKey,
} from "./keys.ts";

/** The workspace's SSH keys (spec 09 9.7). docs/api/servers.md documents each endpoint. */
export function sshKeyRoutes(services: ControlServices): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/ssh-keys", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json({ keys: await listSshKeys(services, actor) });
  });

  app.post("/ssh-keys", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, createSshKeyRequestSchema);
    return c.json({ key: await addSshKey(services, actor, input) }, 201);
  });

  // Fills the Add dialog; nothing is stored until the person saves the key.
  app.post("/ssh-keys/generate", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, generateSshKeyRequestSchema);
    const pair = await generateSshKey(actor, input);
    c.header("cache-control", "no-store");
    return c.json({ ...pair, message: SSH_KEY_MESSAGES.generated });
  });

  app.get("/ssh-keys/:id", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json({ key: await getSshKey(services, actor, c.req.param("id")) });
  });

  app.patch("/ssh-keys/:id", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, updateSshKeyRequestSchema);
    return c.json({ key: await updateSshKey(services, actor, c.req.param("id"), input) });
  });

  app.delete("/ssh-keys/:id", async (c) => {
    const actor = await workspaceActorFor(c, services);
    await deleteSshKey(services, actor, c.req.param("id"));
    return c.json({ deleted: true });
  });

  return app;
}
