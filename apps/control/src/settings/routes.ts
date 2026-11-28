import {
  AppError,
  emailSettingsRequestSchema,
  KEY_KINDS,
  type KeyKind,
  saveKeyRequestSchema,
} from "@nearzero/shared";
import { Hono } from "hono";
import { workspaceActorFor } from "../http/actor.ts";
import type { AppEnv } from "../http/context.ts";
import { readBody } from "../http/validate.ts";
import type { ControlServices } from "../services.ts";
import {
  agentPoliciesFor,
  saveAgentPolicies,
  saveAgentPoliciesRequestSchema,
} from "./agent-policies.ts";
import { emailSettingsView, removeEmailSettings, saveEmailSettings } from "./email-settings.ts";
import { keyViews, removeKey, saveKey } from "./keys.ts";

/** Workspace settings: Agent policies, API keys and invitation email (spec 04 4.7, 4.8; spec 19.9). */
export function settingsRoutes(services: ControlServices): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  function keyKind(value: string): KeyKind {
    if ((KEY_KINDS as readonly string[]).includes(value)) return value as KeyKind;
    throw new AppError("not_found", "There is no such key. Use model or research.");
  }

  app.get("/workspace/agent-policies", async (c) => {
    const actor = await workspaceActorFor(c, services);
    await actor.access.require("agent-policies.manage");
    return c.json(await agentPoliciesFor(services.db, actor.workspace.id));
  });

  app.put("/workspace/agent-policies", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, saveAgentPoliciesRequestSchema);
    return c.json(await saveAgentPolicies(services, actor, input));
  });

  app.get("/workspace/keys", async (c) => {
    const actor = await workspaceActorFor(c, services);
    await actor.access.require("api-keys.manage");
    c.header("cache-control", "no-store");
    return c.json({ keys: await keyViews(services, actor.workspace.id) });
  });

  app.put("/workspace/keys/:kind", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const kind = keyKind(c.req.param("kind"));
    const input = await readBody(c, saveKeyRequestSchema);
    return c.json(await saveKey(services, actor, kind, input.key));
  });

  app.delete("/workspace/keys/:kind", async (c) => {
    const actor = await workspaceActorFor(c, services);
    await removeKey(services, actor, keyKind(c.req.param("kind")));
    return c.json({ removed: true });
  });

  app.get("/workspace/email", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json(await emailSettingsView(services, actor));
  });

  app.put("/workspace/email", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, emailSettingsRequestSchema);
    return c.json(await saveEmailSettings(services, actor, input));
  });

  app.delete("/workspace/email", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json({ settings: await removeEmailSettings(services, actor) });
  });

  return app;
}
