import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  addMemberThroughInvitation,
  createHarness,
  type Harness,
  INSTANCE_RESEND,
  personIdOf,
  setUpNamedOwner,
  setUpOwner,
} from "./support/harness.ts";

// Throwaway databases can take seconds to create and migrate on a busy machine.
setDefaultTimeout(120_000);

let h: Harness;

beforeAll(async () => {
  h = await createHarness({ instanceEmail: INSTANCE_RESEND });
});

afterAll(async () => {
  await h.drop();
});

beforeEach(async () => {
  await h.reset();
});

describe("onboarding (spec 04 4.3)", () => {
  test("a fresh owner completes both steps and has a real first name", async () => {
    const owner = await setUpOwner(h);
    expect((await owner.get("/onboarding")).body).toEqual({
      step: "workspace",
      suggestedWorkspaceName: null,
    });
    const missing = await owner.post("/onboarding/workspace", { name: " ", workspaceName: "" });
    expect(missing.body.error.fields).toEqual({
      name: "Enter your name.",
      workspaceName: "Enter a workspace name.",
    });

    const named = await owner.post("/onboarding/workspace", {
      name: "Olivia Owner",
      workspaceName: "Acme Inc.",
    });
    expect(named.status).toBe(200);
    expect(named.body.workspace).toMatchObject({ name: "Acme Inc.", slug: "acme-inc" });
    expect(named.body.onboarding).toEqual({
      step: "invite",
      suggestedWorkspaceName: "Olivia's workspace",
    });

    const invalid = await owner.post("/onboarding/invitations", {
      emails: "dev@example.com, broken@, ops@example.com",
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.message).toContain('"broken@" is not a valid email address');
    expect((await owner.get("/onboarding")).body.step).toBe("invite");

    const sent = await owner.post("/onboarding/invitations", {
      emails: "dev@example.com;\nops@example.com",
    });
    expect(sent.status).toBe(200);
    expect(sent.body.results).toEqual([
      { email: "dev@example.com", emailed: true },
      { email: "ops@example.com", emailed: true },
    ]);
    expect(sent.body.onboarding.step).toBeNull();

    const session = await owner.get("/auth/session");
    expect(session.body.person).toMatchObject({ firstName: "Olivia", hasRealName: true });
    expect(session.body.workspace).toMatchObject({
      name: "Acme Inc.",
      personal: false,
      first: true,
    });
    expect(session.body.next).toEqual({ kind: "home" });
  });

  test("invites are capped at 10 and the step can be skipped", async () => {
    const owner = await setUpOwner(h);
    await owner.post("/onboarding/workspace", { name: "Olivia", workspaceName: "Acme" });
    const many = Array.from({ length: 11 }, (_, i) => `p${i}@example.com`);
    const tooMany = await owner.post("/onboarding/invitations", { emails: many });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error.message).toStartWith("Invite up to 10 people here.");
    expect((await owner.post("/onboarding/skip-invitations")).body.onboarding.step).toBeNull();
    expect((await owner.post("/onboarding/skip-invitations")).status).toBe(409);
  });

  test("an invited member gives their name; an existing real name skips the step", async () => {
    const owner = await setUpNamedOwner(h);
    const invited = await owner.post("/workspace/invitations", {
      email: "mia@example.com",
      role: "member",
    });
    expect(invited.status).toBe(201);
    const link = new URL(h.outside.linkIn(h.outside.lastEmailTo("mia@example.com")));
    const mia = h.browser();
    const registered = await mia.post("/auth/register", {
      token: link.searchParams.get("token"),
      proof: link.searchParams.get("proof"),
      password: "mia's password",
    });
    expect(registered.status).toBe(201);
    expect(registered.body.next).toEqual({ kind: "onboarding", step: "name" });
    expect((await mia.post("/onboarding/name", { name: "" })).body.error.message).toBe(
      "Enter your name.",
    );
    expect(
      (await mia.post("/onboarding/name", { name: "Mia Member" })).body.onboarding.step,
    ).toBeNull();
    // A welcome email goes out after the name step, greeting her by name (30a R1-05).
    for (let i = 0; i < 100; i++) {
      if (h.outside.lastEmailTo("mia@example.com")?.subject.startsWith("Welcome")) break;
      await Bun.sleep(20);
    }
    expect(h.outside.lastEmailTo("mia@example.com")?.subject).toBe("Welcome to Nearzero, Mia");
  });
});

describe("workspaces (spec 04 4.4)", () => {
  test("every account has a personal My Workspace, hidden once it belongs to another", async () => {
    const owner = await setUpNamedOwner(h);
    const mia = await addMemberThroughInvitation(h, owner, "mia@example.com");
    const list = await mia.get("/workspaces");
    expect(list.body.workspaces.map((w: { name: string }) => w.name)).toEqual(["Acme Inc."]);
    expect(list.body.canAdd).toBe(false);
    const all = await h.test.db
      .selectFrom("membership as m")
      .innerJoin("person as p", "p.id", "m.person_id")
      .innerJoin("workspace as w", "w.id", "m.workspace_id")
      .select(["w.name", "m.role", "w.is_personal"])
      .where("p.email", "=", "mia@example.com")
      .orderBy("w.name")
      .execute();
    expect(all).toEqual([
      { name: "Acme Inc.", role: "member", is_personal: false },
      { name: "My Workspace", role: "owner", is_personal: true },
    ]);
  });

  test("switching changes the active workspace and is remembered for new sessions", async () => {
    const owner = await setUpNamedOwner(h);
    const added = await owner.post("/workspaces", { name: "Side Project" });
    expect(added.status).toBe(201);
    expect(added.body.workspace).toMatchObject({
      name: "Side Project",
      slug: "side-project",
      role: "owner",
    });
    const switched = await owner.post(`/workspaces/${added.body.workspace.id}/switch`);
    expect(switched.body.workspace.slug).toBe("side-project");
    expect((await owner.get("/workspace")).body.workspace.name).toBe("Side Project");
    const laptop = h.browser();
    await laptop.signIn("owner@example.com");
    expect((await laptop.get("/workspace")).body.workspace.name).toBe("Side Project");

    const stranger = await owner.post("/workspaces/00000000-0000-0000-0000-000000000000/switch");
    expect(stranger.status).toBe(404);
  });

  test("slugs: numeric suffix on collision, random id when reserved or empty", async () => {
    const owner = await setUpNamedOwner(h, "Acme Inc.");
    const second = await owner.post("/workspaces", { name: "ACME inc" });
    expect(second.body.workspace.slug).toBe("acme-inc-2");
    const reserved = await owner.post("/workspaces", { name: "Dashboard" });
    expect(reserved.body.workspace.slug).toMatch(/^ws-[a-z0-9]{10}$/);
    const symbols = await owner.post("/workspaces", { name: "!!!" });
    expect(symbols.body.workspace.slug).toMatch(/^ws-[a-z0-9]{10}$/);
  });

  test("a rename moves the slug and old slugs keep redirecting", async () => {
    const owner = await setUpNamedOwner(h, "Acme Inc.");
    const renamed = await owner.patch("/workspace", { name: "Acme Labs" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.workspace.slug).toBe("acme-labs");
    const old = await owner.get("/workspaces/by-slug/acme-inc");
    expect(old.body).toMatchObject({ activeSlug: "acme-labs", renamed: true, isActive: false });
    expect(old.body.workspace.slug).toBe("acme-labs");
    const current = await owner.get("/workspaces/by-slug/acme-labs");
    expect(current.body).toMatchObject({ isActive: true, renamed: false });
    const unknown = await owner.get("/workspaces/by-slug/somewhere-else");
    expect(unknown.body).toMatchObject({ activeSlug: "acme-labs", workspace: null });

    // An old slug is never given to another workspace.
    const reuse = await owner.post("/workspaces", { name: "Acme Inc" });
    expect(reuse.body.workspace.slug).toBe("acme-inc-2");
    // Renaming back takes the old slug back.
    expect((await owner.patch("/workspace", { name: "Acme Inc." })).body.workspace.slug).toBe(
      "acme-inc",
    );

    const logo = await owner.patch("/workspace", { logoUrl: "https://example.com/logo.png" });
    expect(logo.body.workspace.logoUrl).toBe("https://example.com/logo.png");
    const removed = await owner.patch("/workspace", { logoUrl: null });
    expect(removed.body.workspace.logoUrl).toBeNull();
    expect((await owner.patch("/workspace", { logoUrl: "javascript:alert(1)" })).status).toBe(400);
  });

  test("GET /workspace lists the person's own effective capabilities (spec 18.1)", async () => {
    const owner = await setUpNamedOwner(h);
    const all = (await owner.get("/workspace")).body.capabilities as string[];
    expect(all).toContain("git.connect-own");
    expect(all).toContain("router-files.read");
    expect(all).toHaveLength(16);

    const policy = await owner.post("/workspace/policies", {
      name: "Integrations",
      capabilities: ["git.connect-own", "notifications.manage"],
    });
    const mia = await addMemberThroughInvitation(h, owner, "mia@example.com");
    expect((await mia.get("/workspace")).body.capabilities).toEqual([]);

    const miaId = await personIdOf(h, "mia@example.com");
    const granted = await owner.put(`/workspace/members/${miaId}/access`, {
      policyIds: [policy.body.policy.id],
      capabilities: ["backups.use-destinations"],
      scope: {},
    });
    expect(granted.status).toBe(200);
    const mine = await mia.get("/workspace");
    expect(mine.body.role).toBe("member");
    expect([...mine.body.capabilities].sort()).toEqual([
      "backups.use-destinations",
      "git.connect-own",
      "notifications.manage",
    ]);
  });

  test("only instance administrators add, rename or delete workspaces (spec 22.2)", async () => {
    const owner = await setUpNamedOwner(h);
    const mia = await addMemberThroughInvitation(h, owner, "mia@example.com");
    const message = "Only Nearzero administrators can add, rename or delete workspaces.";

    const add = await mia.post("/workspaces", { name: "Mine" });
    expect(add.status).toBe(403);
    expect(add.body.error.message).toBe(message);

    // Even the owner of their own personal workspace can't rename or delete it.
    const workspaces = await h.test.db
      .selectFrom("workspace as w")
      .innerJoin("membership as m", "m.workspace_id", "w.id")
      .innerJoin("person as p", "p.id", "m.person_id")
      .select("w.id")
      .where("p.email", "=", "mia@example.com")
      .where("w.is_personal", "=", true)
      .executeTakeFirstOrThrow();
    await mia.post(`/workspaces/${workspaces.id}/switch`);
    const rename = await mia.patch("/workspace", { name: "Mia Inc" });
    expect(rename.status).toBe(403);
    expect(rename.body.error.message).toBe(message);
    const del = await mia.delete("/workspace");
    expect(del.status).toBe(403);
    expect(del.body.error.message).toBe(message);
  });

  test("delete refuses the first workspace, workspaces with projects, and an owner's last one", async () => {
    h.services.workspaceDeletionChecks.push(async (db, workspaceId) => {
      const row = await db
        .selectFrom("workspace")
        .select("name")
        .where("id", "=", workspaceId)
        .executeTakeFirst();
      return row?.name === "Busy"
        ? "Delete this workspace's 2 projects first, then try again."
        : null;
    });
    try {
      const owner = await setUpNamedOwner(h);
      const first = await owner.delete("/workspace");
      expect(first.status).toBe(409);
      expect(first.body.error.message).toContain("first workspace");

      const busy = await owner.post("/workspaces", { name: "Busy" });
      await owner.post(`/workspaces/${busy.body.workspace.id}/switch`);
      const refused = await owner.delete("/workspace");
      expect(refused.status).toBe(409);
      expect(refused.body.error.message).toBe(
        "Delete this workspace's 2 projects first, then try again.",
      );

      const spare = await owner.post("/workspaces", { name: "Spare" });
      await owner.post(`/workspaces/${spare.body.workspace.id}/switch`);
      const deleted = await owner.delete("/workspace");
      expect(deleted.status).toBe(200);
      expect(deleted.body.activeWorkspace.name).toBe("Acme Inc.");
      expect((await owner.get("/workspace")).body.workspace.name).toBe("Acme Inc.");
      const audit = await h.test.db
        .selectFrom("audit_event")
        .select("action")
        .where("action", "=", "workspace.deleted")
        .execute();
      expect(audit).toHaveLength(1);
    } finally {
      h.services.workspaceDeletionChecks.length = 0;
    }
  });

  test("an owner's last owned workspace can't be deleted", async () => {
    const owner = await setUpNamedOwner(h);
    const mia = await addMemberThroughInvitation(h, owner, "mia@example.com", { role: "admin" });
    // Promote Mia to instance administrator, then give her ownership of nothing but one team workspace.
    const extra = await owner.post("/workspaces", { name: "Team Two" });
    const miaId = (
      await h.test.db
        .selectFrom("person")
        .select("id")
        .where("email", "=", "mia@example.com")
        .executeTakeFirstOrThrow()
    ).id;
    // Hand Team Two to Mia and remove her personal workspace, so Team Two is her last.
    await h.test.db
      .updateTable("membership")
      .set({ person_id: miaId })
      .where("workspace_id", "=", extra.body.workspace.id)
      .execute();
    await h.test.db
      .deleteFrom("workspace")
      .where("is_personal", "=", true)
      .where("created_by", "=", miaId)
      .execute();
    await mia.post(`/workspaces/${extra.body.workspace.id}/switch`);
    const refused = await mia.delete("/workspace");
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toContain("last workspace");
  });
});
