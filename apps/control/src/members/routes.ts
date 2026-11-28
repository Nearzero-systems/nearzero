import {
  accessPolicyRequestSchema,
  addMemberWithPasswordRequestSchema,
  changeRoleRequestSchema,
  createInvitationRequestSchema,
  memberAccessRequestSchema,
  setMemberEmailRequestSchema,
} from "@nearzero/shared";
import { Hono } from "hono";
import {
  createPolicy,
  deletePolicy,
  listPolicies,
  memberAccessView,
  setMemberAccess,
  updatePolicy,
} from "../access/policies.ts";
import { workspaceActorFor } from "../http/actor.ts";
import type { AppEnv } from "../http/context.ts";
import { readBody } from "../http/validate.ts";
import type { ControlServices } from "../services.ts";
import {
  cancelInvitation,
  copyInvitationLink,
  createInvitation,
  listInvitations,
  resendInvitation,
} from "./invitations.ts";
import {
  addWithPassword,
  canSetMemberEmail,
  changeRole,
  listMembers,
  removeMember,
  setMemberEmail,
} from "./members.ts";

/**
 * Settings → Members & access for the active workspace (spec 04 4.5, 4.7): people, invitations,
 * access policies and each member's access. Owners and admins only.
 */
export function memberRoutes(services: ControlServices): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { db } = services;

  app.get("/workspace/members", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const members = await listMembers(services, actor);
    return c.json({
      members,
      count: members.length,
      canSetEmail: canSetMemberEmail(services, actor),
    });
  });

  app.post("/workspace/members", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, addMemberWithPasswordRequestSchema);
    return c.json(await addWithPassword(services, actor, input), 201);
  });

  app.patch("/workspace/members/:personId", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, changeRoleRequestSchema);
    await changeRole(services, actor, c.req.param("personId"), input.role);
    return c.json({ updated: true });
  });

  app.put("/workspace/members/:personId/email", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, setMemberEmailRequestSchema);
    const result = await setMemberEmail(services, actor, c.req.param("personId"), input.email);
    return c.json({
      ...result,
      message: result.changed
        ? `Email changed to ${result.member.person.email}. Their sessions were signed out.`
        : `${result.member.person.email} is confirmed.`,
    });
  });

  app.delete("/workspace/members/:personId", async (c) => {
    const actor = await workspaceActorFor(c, services);
    await removeMember(services, actor, c.req.param("personId"));
    return c.json({ removed: true });
  });

  app.get("/workspace/members/:personId/access", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json(await memberAccessView(services, actor, c.req.param("personId")));
  });

  app.put("/workspace/members/:personId/access", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, memberAccessRequestSchema);
    return c.json(await setMemberAccess(services, actor, c.req.param("personId"), input));
  });

  app.get("/workspace/invitations", async (c) => {
    const actor = await workspaceActorFor(c, services);
    await actor.access.require("invitations.manage");
    return c.json({ invitations: await listInvitations(db, actor.workspace.id) });
  });

  app.post("/workspace/invitations", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, createInvitationRequestSchema);
    return c.json(await createInvitation(services, actor, input), 201);
  });

  app.post("/workspace/invitations/:invitationId/resend", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json(await resendInvitation(services, actor, c.req.param("invitationId")));
  });

  app.get("/workspace/invitations/:invitationId/link", async (c) => {
    const actor = await workspaceActorFor(c, services);
    c.header("cache-control", "no-store");
    return c.json({ link: await copyInvitationLink(services, actor, c.req.param("invitationId")) });
  });

  app.delete("/workspace/invitations/:invitationId", async (c) => {
    const actor = await workspaceActorFor(c, services);
    await cancelInvitation(services, actor, c.req.param("invitationId"));
    return c.json({ cancelled: true });
  });

  app.get("/workspace/policies", async (c) => {
    const actor = await workspaceActorFor(c, services);
    await actor.access.require("policies.manage");
    const policies = await listPolicies(db, actor.workspace.id);
    return c.json({ policies, count: policies.length });
  });

  app.post("/workspace/policies", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, accessPolicyRequestSchema);
    return c.json({ policy: await createPolicy(services, actor, input) }, 201);
  });

  app.put("/workspace/policies/:policyId", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, accessPolicyRequestSchema);
    return c.json({ policy: await updatePolicy(services, actor, c.req.param("policyId"), input) });
  });

  app.delete("/workspace/policies/:policyId", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json({
      deleted: true,
      ...(await deletePolicy(services, actor, c.req.param("policyId"))),
    });
  });

  return app;
}
