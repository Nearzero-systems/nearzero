import {
  AGENT_LIMITS,
  AGENT_MESSAGES,
  AGENT_POLICIES,
  AGENT_STARTERS,
  AppError,
  ATTACHMENT_KIND_MAX_BYTES,
  agentFormAnswerRequestSchema,
  allowAgentPolicyRequestSchema,
  formatBytes,
  GREETING_SECOND_LINES,
  renameAgentSessionRequestSchema,
  reorderAgentSessionsRequestSchema,
  sendAgentMessageRequestSchema,
  shareAgentSessionRequestSchema,
} from "@nearzero/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import { lastEventId, sseResponse } from "../deploys/streaming.ts";
import { type WorkspaceActor, workspaceActorFor } from "../http/actor.ts";
import type { AppEnv } from "../http/context.ts";
import { check } from "../http/validate.ts";
import { isRealName } from "../identity/names.ts";
import type { ControlServices } from "../services.ts";
import { agentPoliciesFor } from "../settings/agent-policies.ts";
import { keyViews, readWorkspaceKey } from "../settings/keys.ts";
import { pendingOf } from "./capability.ts";
import { capabilityCatalog } from "./catalog/index.ts";
import { followTurn, readEvents, type StoredEvent } from "./events.ts";
import { fileBytes, uploadFile, visibleFile } from "./files.ts";
import { resumeAfterConnect } from "./flows/connect-return.ts";
import { allowPolicy, answerForm, carriesSecret, sendMessage } from "./messages.ts";
import { TEXT_ONLY } from "./provider/provider.ts";
import {
  createSession,
  deleteSession,
  eventViewFor,
  hiddenStepsFor,
  listSessions,
  renameSession,
  reorderSessions,
  sessionDetail,
  shareSession,
  visibleSession,
} from "./sessions.ts";
import { agentSettings } from "./settings.ts";
import { providerFor, requestStop, runningHere } from "./turns.ts";
import "./tables.ts";

/** The Agent's endpoints under /api/v1 (docs/api/agent.md). */

/** Agent file uploads take their own, larger limit (spec 19.10). */
export const AGENT_UPLOAD_PATH = /^\/api\/v1\/agent\/files\/?$/;

async function jsonBody(c: Context<AppEnv>): Promise<unknown> {
  const type = c.req.header("content-type") ?? "";
  if (!/^application\/json\b/i.test(type)) {
    throw new AppError(
      "invalid_request",
      "Send the request body as JSON with Content-Type: application/json.",
    );
  }
  try {
    return await c.req.json();
  } catch {
    throw new AppError("invalid_request", "The request body is not valid JSON.");
  }
}

async function readUpload(c: Context<AppEnv>, max: number): Promise<Uint8Array> {
  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > max) {
    throw new AppError(
      "payload_too_large",
      `Attachments can be up to ${formatBytes(max, { largest: "MB" })}.`,
    );
  }
  const body = c.req.raw.body;
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new AppError(
        "payload_too_large",
        `Attachments can be up to ${formatBytes(max, { largest: "MB" })}.`,
      );
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function modelInputsFor(services: ControlServices, actor: WorkspaceActor) {
  const key = await readWorkspaceKey(services, actor.workspace.id, "model");
  if (key.status !== "ok") return TEXT_ONLY;
  const settings = agentSettings(services);
  return (
    (await providerFor(services)
      .modelInputs(key.value, settings.model, AbortSignal.timeout(8_000))
      .catch(() => null)) ?? TEXT_ONLY
  );
}

export function agentRoutes(services: ControlServices): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { db } = services;

  // ---- Home (spec 19.2, 19.10)

  app.get("/agent", async (c) => {
    const actor = await workspaceActorFor(c, services);
    await actor.access.require("agent.use");
    const settings = agentSettings(services);
    const person = await db
      .selectFrom("person")
      .select(["first_name"])
      .where("id", "=", actor.personId)
      .executeTakeFirst();
    const real = isRealName(person?.first_name);
    const name = real ? (person?.first_name?.trim() as string) : "there";
    const keys = await keyViews(services, actor.workspace.id);
    const model = keys.find((key) => key.kind === "model");
    const research = keys.find((key) => key.kind === "research");
    const admin = actor.role === "owner" || actor.role === "admin";
    return c.json({
      enabled: !settings.disabled,
      greeting: {
        name,
        askName: !real,
        secondLine: GREETING_SECOND_LINES[Math.floor(Math.random() * GREETING_SECOND_LINES.length)],
        fixed: settings.greeting ? settings.greeting.replaceAll("{first name}", name) : null,
      },
      starters: AGENT_STARTERS,
      research: {
        keySaved: research?.status === "added",
        canAddKey: admin,
        whoCanAdd: AGENT_MESSAGES.researchNoKey,
      },
      model: { keySaved: model?.status !== "not_added", keyUsable: model?.status === "added" },
      limits: {
        filesPerMessage: AGENT_LIMITS.filesPerMessage,
        totalBytes: settings.attachmentsMaxBytes,
        perKind: ATTACHMENT_KIND_MAX_BYTES,
        quoteChars: AGENT_LIMITS.quoteMax,
        messageChars: AGENT_LIMITS.messageMax,
        concurrentUploads: AGENT_LIMITS.concurrentUploads,
      },
      can: { allowPolicies: admin },
    });
  });

  app.get("/agent/capabilities", async (c) => {
    const actor = await workspaceActorFor(c, services);
    await actor.access.require("agent-policies.manage");
    const switches = (await agentPoliciesFor(db, actor.workspace.id)).switches;
    return c.json({
      capabilities: capabilityCatalog().map((capability) => {
        const policy = capability.policies.at(-1) ?? null;
        return {
          name: capability.name,
          area: capability.area,
          policy,
          policyLabel: policy ? AGENT_POLICIES[policy].label : null,
          changes: capability.changes,
          available: capability.policies.every((key) => switches[key]),
          pending: pendingOf(capability, services),
        };
      }),
    });
  });

  // ---- Sessions (spec 19.5)

  app.get("/agent/sessions", async (c) => {
    const actor = await workspaceActorFor(c, services);
    await actor.access.require("agent.use");
    return c.json(await listSessions(services, actor));
  });

  app.post("/agent/sessions", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json({ session: await createSession(services, actor) }, 201);
  });

  app.put("/agent/sessions/order", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = check(reorderAgentSessionsRequestSchema, await jsonBody(c));
    return c.json(await reorderSessions(services, actor, input));
  });

  app.get("/agent/sessions/:id", async (c) => {
    const actor = await workspaceActorFor(c, services);
    // Back from connecting a Git account: a waiting import carries on (spec 19.7 step 1).
    await resumeAfterConnect(services, actor, c.req.param("id")).catch((error) =>
      services.log.warn("couldn't resume an import after connecting", { error }),
    );
    const inputs = await modelInputsFor(services, actor);
    return c.json(
      await sessionDetail(
        services,
        actor,
        c.req.param("id"),
        c.req.query("before") ?? null,
        inputs,
      ),
    );
  });

  app.patch("/agent/sessions/:id", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = check(renameAgentSessionRequestSchema, await jsonBody(c));
    return c.json({
      session: await renameSession(services, actor, c.req.param("id"), input.title),
    });
  });

  app.post("/agent/sessions/:id/share", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = check(shareAgentSessionRequestSchema, await jsonBody(c));
    return c.json(await shareSession(services, actor, c.req.param("id"), input.shared));
  });

  app.delete("/agent/sessions/:id", async (c) => {
    const actor = await workspaceActorFor(c, services);
    await deleteSession(services, actor, c.req.param("id"));
    return c.json({ deleted: true });
  });

  // ---- Messages and turns (spec 19.6)

  const send = async (c: Context<AppEnv>, sessionId: string | null) => {
    const actor = await workspaceActorFor(c, services);
    const body = await jsonBody(c);
    if (carriesSecret(body, false))
      throw new AppError("invalid_request", AGENT_MESSAGES.secretInput);
    const input = check(sendAgentMessageRequestSchema, body);
    return c.json(await sendMessage(services, actor, sessionId, input), 202);
  };
  app.post("/agent/messages", (c) => send(c, null));
  app.post("/agent/sessions/:id/messages", (c) => send(c, c.req.param("id")));

  app.get("/agent/turns/:id/events", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const turnId = c.req.param("id");
    if (!/^[0-9a-f-]{36}$/.test(turnId))
      throw new AppError("not_found", "This turn doesn't exist.");
    const turn = await db
      .selectFrom("agent_turn")
      .select(["id", "session_id", "hidden"])
      .where("id", "=", turnId)
      .where("workspace_id", "=", actor.workspace.id)
      .executeTakeFirst();
    if (!turn) throw new AppError("not_found", "This turn doesn't exist.");
    // Access first: nothing is sent before it is checked (spec 22.4 rule 2).
    const session = await visibleSession(services, actor, turn.session_id);
    const resume = lastEventId(c);
    const after = resume && resume.id === turnId ? resume.position : 0;
    const settings = agentSettings(services);
    const hidden = hiddenStepsFor(actor, session.author_id, await readEvents(db, turnId));
    const base = eventViewFor(actor, session.author_id, hidden);
    const view = (event: StoredEvent) => {
      const data = base(event);
      if (event.type === "step.started" && session.author_id !== actor.personId)
        return { ...data, target: "" };
      return data;
    };
    return sseResponse(c, (writer, aborted) =>
      // A turn carried out here reaches the stream through the bus; others are read from the table.
      followTurn(db, turnId, after, writer, aborted, view, () =>
        runningHere(turnId) ? Math.max(2_000, settings.followPollMs) : settings.followPollMs,
      ),
    );
  });

  app.post("/agent/turns/:id/stop", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const turnId = c.req.param("id");
    const turn = /^[0-9a-f-]{36}$/.test(turnId)
      ? await db
          .selectFrom("agent_turn as t")
          .innerJoin("agent_session as s", "s.id", "t.session_id")
          .select(["t.id", "s.author_id", "s.shared"])
          .where("t.id", "=", turnId)
          .where("t.workspace_id", "=", actor.workspace.id)
          .executeTakeFirst()
      : undefined;
    if (!turn || (turn.author_id !== actor.personId && !turn.shared))
      throw new AppError("not_found", "This turn doesn't exist.");
    if (turn.author_id !== actor.personId)
      throw new AppError("forbidden", "Only the person who started this session can stop it.");
    return c.json({ stopping: await requestStop(services, turnId) });
  });

  app.post("/agent/turns/:id/forms/:formId", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const body = await jsonBody(c);
    if (carriesSecret(body, true))
      throw new AppError("invalid_request", AGENT_MESSAGES.secretInput);
    const answer = check(agentFormAnswerRequestSchema, body);
    return c.json(
      await answerForm(services, actor, c.req.param("id"), c.req.param("formId"), answer),
      202,
    );
  });

  app.post("/agent/turns/:id/permission", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = check(allowAgentPolicyRequestSchema, await jsonBody(c));
    return c.json(await allowPolicy(services, actor, c.req.param("id"), input.policy), 202);
  });

  // ---- Attachments (spec 19.10)

  app.post("/agent/files", async (c) => {
    const actor = await workspaceActorFor(c, services);
    await actor.access.require("agent.use");
    const settings = agentSettings(services);
    const sessionId = c.req.query("sessionId") || null;
    if (sessionId) await visibleSession(services, actor, sessionId, { own: true });
    const max = Math.max(settings.attachmentsMaxBytes, ...Object.values(ATTACHMENT_KIND_MAX_BYTES));
    const bytes = await readUpload(c, max);
    const inputs = await modelInputsFor(services, actor);
    const file = await uploadFile(
      services,
      actor,
      {
        name: c.req.query("name") ?? "",
        contentType: c.req.header("content-type") ?? "",
        bytes,
        sessionId,
      },
      inputs,
    );
    return c.json({ file }, 201);
  });

  app.get("/agent/files/:id", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const row = await visibleFile(db, actor, c.req.param("id"), async (sessionId) => {
      try {
        await visibleSession(services, actor, sessionId);
        return true;
      } catch {
        return false;
      }
    });
    const bytes = await fileBytes(db, row.id);
    const inline = row.kind === "image";
    const safeName = row.name.replace(/["\\\r\n]/g, "_");
    return new Response(bytes, {
      headers: {
        "content-type": inline ? row.content_type : "application/octet-stream",
        "content-disposition": `${inline ? "inline" : "attachment"}; filename="${safeName}"`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; img-src 'self' data:; sandbox",
        "cache-control": "private, no-store",
      },
    });
  });

  app.delete("/agent/files/:id", async (c) => {
    const actor = await workspaceActorFor(c, services);
    // Only the uploader's own files; a sent one stays with its message.
    const row = await visibleFile(db, actor, c.req.param("id"), async (sessionId) => {
      const owner = await db
        .selectFrom("agent_session")
        .select("author_id")
        .where("id", "=", sessionId)
        .executeTakeFirst();
      return owner?.author_id === actor.personId;
    });
    if (row.uploader_id !== actor.personId) {
      throw new AppError("not_found", "This file doesn't exist, or you can't open it.");
    }
    if (row.sent_at !== null) throw new AppError("conflict", "A sent file stays with its message.");
    await db.deleteFrom("agent_file").where("id", "=", row.id).execute();
    return c.json({ deleted: true });
  });

  return app;
}
