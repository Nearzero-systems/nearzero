import {
  AppError,
  CAPABILITY_KEYS,
  createWorkspaceRequestSchema,
  updateWorkspaceRequestSchema,
} from "@nearzero/shared";
import { Hono } from "hono";
import { hasCapability } from "../access/evaluate.ts";
import { recordAudit } from "../audit/audit.ts";
import { workspaceDomainsCleanup } from "../domains/background.ts";
import { auditActor, workspaceActorFor } from "../http/actor.ts";
import type { AppEnv } from "../http/context.ts";
import { readBody } from "../http/validate.ts";
import { requireSession } from "../identity/sessions.ts";
import type { ControlServices } from "../services.ts";
import { canUseTasks } from "../tasks/places.ts";
import {
  createWorkspace,
  findBySlug,
  firstWorkspaceId,
  isInstanceAdmin,
  listMemberships,
  renameWorkspace,
  resolveActiveWorkspace,
  switcherList,
  switchWorkspace,
} from "./workspaces.ts";

/** Workspaces: the switcher, the slug lookup, and add/rename/delete for administrators (spec 04 4.4). */
export function workspaceRoutes(services: ControlServices): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { db, log } = services;

  app.get("/workspaces", async (c) => {
    const session = requireSession(c);
    const active = await resolveActiveWorkspace(db, session);
    const all = await listMemberships(db, session.personId);
    return c.json({
      activeId: active?.id ?? null,
      workspaces: switcherList(all, active?.id ?? null),
      canAdd: await isInstanceAdmin(db, session.personId),
    });
  });

  app.post("/workspaces", async (c) => {
    const actor = await workspaceActorFor(c, services);
    await actor.access.require("workspaces.add");
    const input = await readBody(c, createWorkspaceRequestSchema);
    const created = await db.transaction().execute((trx) =>
      createWorkspace(trx, {
        name: input.name,
        logoUrl: input.logoUrl ?? null,
        ownerId: actor.personId,
      }),
    );
    await recordAudit(db, log, auditActor(actor), {
      action: "workspace.created",
      workspaceId: created.id,
      target: { kind: "workspace", id: created.id },
      details: { name: input.name, slug: created.slug },
    });
    const all = await listMemberships(db, actor.personId);
    return c.json({ workspace: all.find((workspace) => workspace.id === created.id) }, 201);
  });

  app.post("/workspaces/:workspaceId/switch", async (c) => {
    const session = requireSession(c);
    const workspace = await switchWorkspace(db, session, c.req.param("workspaceId"));
    return c.json({ workspace });
  });

  /**
   * For addresses like /<slug>/dashboard/…: the active workspace's slug to redirect to. A slug
   * that isn't the active workspace's redirects to the active one without switching; `renamed`
   * says the slug is an older name of a workspace the person belongs to.
   */
  app.get("/workspaces/by-slug/:slug", async (c) => {
    const session = requireSession(c);
    const slug = c.req.param("slug").toLowerCase();
    const active = await resolveActiveWorkspace(db, session);
    const found = await findBySlug(db, session.personId, slug);
    return c.json({
      activeSlug: active?.slug ?? null,
      isActive: found !== null && !found.renamed && found.workspace.id === active?.id,
      workspace: found?.workspace ?? null,
      renamed: found?.renamed ?? false,
    });
  });

  app.get("/workspace", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json({
      workspace: actor.workspace,
      role: actor.role,
      isInstanceAdmin: actor.isInstanceAdmin,
      // The signed-in person's own effective capabilities (every one for owners and admins),
      // so the console can show the entries a member's capabilities open (spec 18.1).
      capabilities: CAPABILITY_KEYS.filter((key) => hasCapability(actor.access.grants, key)),
      can: {
        rename: actor.access.can("workspace.rename"),
        manageMembers: actor.access.can("members.manage"),
        managePolicies: actor.access.can("policies.manage"),
        manageAgentPolicies: actor.access.can("agent-policies.manage"),
        manageApiKeys: actor.access.can("api-keys.manage"),
        manageEmail: actor.access.can("workspace-email.manage"),
        addWithPassword: actor.access.can("members.add-with-password") && !actor.workspace.personal,
        // Tasks shows only to people with somewhere to run one (spec 12.1, R3-31).
        tasks: await canUseTasks(services, actor),
      },
    });
  });

  app.patch("/workspace", async (c) => {
    const actor = await workspaceActorFor(c, services);
    await actor.access.require("workspace.rename");
    const input = await readBody(c, updateWorkspaceRequestSchema);
    const workspaceId = actor.workspace.id;
    const result = await db.transaction().execute(async (trx) => {
      let slug = actor.workspace.slug;
      if (input.name !== undefined && input.name !== actor.workspace.name) {
        slug = (await renameWorkspace(trx, workspaceId, input.name)).slug;
      }
      if (input.logoUrl !== undefined) {
        await trx
          .updateTable("workspace")
          .set({ logo_url: input.logoUrl, updated_at: new Date() })
          .where("id", "=", workspaceId)
          .execute();
      }
      return { slug };
    });
    await recordAudit(db, log, auditActor(actor), {
      action: "workspace.renamed",
      workspaceId,
      target: { kind: "workspace", id: workspaceId },
      details: {
        ...(input.name !== undefined ? { name: input.name, slug: result.slug } : {}),
        ...(input.logoUrl !== undefined ? { logoChanged: true } : {}),
      },
    });
    const all = await listMemberships(db, actor.personId);
    return c.json({ workspace: all.find((workspace) => workspace.id === workspaceId) });
  });

  /** API only in 1.0; refused with projects, for the first workspace, or an owner's last one. */
  app.delete("/workspace", async (c) => {
    const actor = await workspaceActorFor(c, services);
    await actor.access.require("workspace.delete");
    const workspaceId = actor.workspace.id;
    if (workspaceId === (await firstWorkspaceId(db))) {
      throw new AppError(
        "conflict",
        "This is the install's first workspace, whose owner and admins administer Nearzero, so it can't be deleted.",
      );
    }
    for (const check of services.workspaceDeletionChecks) {
      const refusal = await check(db, workspaceId);
      if (refusal) throw new AppError("conflict", refusal);
    }
    const owner = await db
      .selectFrom("membership")
      .select("person_id")
      .where("workspace_id", "=", workspaceId)
      .where("role", "=", "owner")
      .executeTakeFirstOrThrow();
    const ownedElsewhere = await db
      .selectFrom("membership")
      .select("workspace_id")
      .where("person_id", "=", owner.person_id)
      .where("role", "=", "owner")
      .where("workspace_id", "!=", workspaceId)
      .executeTakeFirst();
    if (!ownedElsewhere) {
      throw new AppError(
        "conflict",
        "This is its owner's last workspace, so it can't be deleted. Every account keeps one workspace it owns.",
      );
    }
    // Its zones and uploaded certificates leave the DNS server and routers too (B1-64).
    const domainsCleanup = await workspaceDomainsCleanup(services, workspaceId);
    await db.deleteFrom("workspace").where("id", "=", workspaceId).execute();
    await domainsCleanup();
    await recordAudit(db, log, auditActor(actor), {
      action: "workspace.deleted",
      workspaceId,
      target: { kind: "workspace", id: workspaceId },
      details: { name: actor.workspace.name, slug: actor.workspace.slug },
    });
    const session = requireSession(c);
    const next = await resolveActiveWorkspace(db, { ...session, activeWorkspaceId: null });
    return c.json({ deleted: true, activeWorkspace: next });
  });

  return app;
}
