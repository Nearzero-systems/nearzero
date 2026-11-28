import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { sql } from "kysely";
import {
  addMemberThroughInvitation,
  type Browser,
  CONSOLE_URL,
  createHarness,
  type Harness,
  INSTANCE_RESEND,
  PASSWORD,
  personIdOf,
  setUpNamedOwner,
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
  h.services.instanceEmail = INSTANCE_RESEND;
});

/** Turns email off for the rest of a test, so invitations are copy-link only. */
function emailOff() {
  h.services.instanceEmail = null;
}

function tokenOf(link: string): string {
  return new URL(link).searchParams.get("token") ?? "";
}

async function invite(by: Browser, email: string, role = "member", policyIds: string[] = []) {
  return by.post("/workspace/invitations", { email, role, policyIds });
}

describe("inviting (spec 04 4.5)", () => {
  test("emails the invitation with the instance's settings and lists it", async () => {
    const owner = await setUpNamedOwner(h);
    const reply = await invite(owner, "Dev@Example.com");
    expect(reply.status).toBe(201);
    expect(reply.body.delivery.emailed).toBe(true);
    expect(reply.body.delivery.link).toStartWith(`${CONSOLE_URL}/invitation?token=`);
    expect(reply.body.delivery.link).not.toContain("proof=");
    expect(reply.body.invitation).toMatchObject({
      email: "dev@example.com",
      role: "member",
      state: "pending",
    });
    expect(reply.body.invitation.lastEmailedAt).not.toBeNull();

    const email = h.outside.lastEmailTo("dev@example.com");
    expect(email?.subject).toBe("You've been invited to join Acme Inc. on Nearzero");
    expect(email?.from).toBe(INSTANCE_RESEND.from);
    expect(email?.apiKey).toBe(INSTANCE_RESEND.apiKey);
    expect(email?.text).toContain("Sent by Olivia Owner (owner@example.com)");
    const emailed = new URL(h.outside.linkIn(email));
    expect(emailed.searchParams.get("token")).toBe(tokenOf(reply.body.delivery.link));
    expect(emailed.searchParams.get("proof")).toMatch(/^[A-Za-z0-9_-]{32}$/);

    const list = await owner.get("/workspace/invitations");
    expect(list.body.invitations).toHaveLength(1);
    expect(list.body.invitations[0].invitedBy.name).toBe("Olivia Owner");
  });

  test("without email set up, the inviter gets the link to share", async () => {
    emailOff();
    const owner = await setUpNamedOwner(h);
    const reply = await invite(owner, "dev@example.com");
    expect(reply.body.delivery).toMatchObject({
      emailed: false,
      reason: "Not emailed: email isn't set up for this workspace or this server.",
    });
    expect(reply.body.invitation.lastEmailedAt).toBeNull();
    expect(h.outside.emails).toHaveLength(0);
  });

  test("a failed send says why and still gives the link", async () => {
    const owner = await setUpNamedOwner(h);
    h.outside.resendStatus = 422;
    h.outside.resendBody = { message: "The example.com domain is not verified." };
    const reply = await invite(owner, "dev@example.com");
    expect(reply.body.delivery.emailed).toBe(false);
    expect(reply.body.delivery.reason).toBe(
      "Not emailed. Resend refused the email: The example.com domain is not verified.",
    );
    expect(reply.body.delivery.link).toStartWith(CONSOLE_URL);
  });

  test("refusals: owner role, policies for admins, members, pending addresses", async () => {
    const owner = await setUpNamedOwner(h);
    const asOwner = await invite(owner, "x@example.com", "owner");
    expect(asOwner.status).toBe(400);
    expect(asOwner.body.error.message).toBe("Cannot invite a user with the owner role");

    const policy = await owner.post("/workspace/policies", { name: "Developers" });
    const adminPolicies = await invite(owner, "x@example.com", "admin", [policy.body.policy.id]);
    expect(adminPolicies.status).toBe(400);

    await invite(owner, "x@example.com");
    const again = await invite(owner, "x@example.com");
    expect(again.status).toBe(409);
    expect(again.body.error.message).toBe(
      "This email already has a pending invitation. Send it again or copy its link from the list.",
    );
    // The Add user dialog shows the field's message, so it carries the guidance too (B3-19).
    expect(again.body.error.fields.email).toBe(
      "This email already has a pending invitation. Send it again or copy its link from the list.",
    );

    const self = await invite(owner, "owner@example.com");
    expect(self.status).toBe(409);
    expect(self.body.error.message).toBe("User is already a member of this workspace");
  });

  test("an expired invitation is listed for 7 days, can be replaced, then disappears", async () => {
    const owner = await setUpNamedOwner(h);
    await invite(owner, "late@example.com");
    await h.test.db
      .updateTable("invitation")
      .set({ expires_at: sql<Date>`now() - interval '1 day'` })
      .execute();
    const listed = await owner.get("/workspace/invitations");
    expect(listed.body.invitations[0].state).toBe("expired");

    const replaced = await invite(owner, "late@example.com");
    expect(replaced.status).toBe(201);
    const after = await owner.get("/workspace/invitations");
    expect(after.body.invitations.map((i: { state: string }) => i.state)).toEqual(["pending"]);

    await h.test.db
      .updateTable("invitation")
      .set({ expires_at: sql<Date>`now() - interval '8 days'` })
      .where("status", "=", "pending")
      .execute();
    expect((await owner.get("/workspace/invitations")).body.invitations).toEqual([]);
  });

  test("without a console address, no invitation is created", async () => {
    const noConsole = await createHarness({ consoleUrl: null, instanceEmail: INSTANCE_RESEND });
    try {
      const owner = await setUpNamedOwner(noConsole);
      const reply = await owner.post("/workspace/invitations", {
        email: "a@example.com",
        role: "member",
      });
      expect(reply.status).toBe(409);
      expect(reply.body.error.message).toBe(
        "No link to copy: this server has no console address set.",
      );
      const count = await noConsole.test.db
        .selectFrom("invitation")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .executeTakeFirstOrThrow();
      expect(Number(count.n)).toBe(0);
    } finally {
      await noConsole.drop();
    }
  });
});

describe("resend, copy link and cancel", () => {
  test("resend keeps the link, restarts 7 days, and waits 30 seconds after an email went out", async () => {
    const owner = await setUpNamedOwner(h);
    const created = await invite(owner, "dev@example.com");
    const id = created.body.invitation.id;
    const tooSoon = await owner.post(`/workspace/invitations/${id}/resend`);
    expect(tooSoon.status).toBe(429);
    expect(tooSoon.body.error.message).toMatch(
      /^This invitation was just sent\. Try again in (30|29) seconds\.$/,
    );

    await h.test.db
      .updateTable("invitation")
      .set({
        last_emailed_at: sql<Date>`now() - interval '31 seconds'`,
        expires_at: sql<Date>`now() + interval '1 day'`,
      })
      .execute();
    const resent = await owner.post(`/workspace/invitations/${id}/resend`);
    expect(resent.status).toBe(200);
    expect(resent.body.delivery.emailed).toBe(true);
    expect(tokenOf(resent.body.delivery.link)).toBe(tokenOf(created.body.delivery.link));
    const days = (Date.parse(resent.body.invitation.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(h.outside.emails.filter((e) => e.to === "dev@example.com")).toHaveLength(2);
  });

  test("the wait starts only when an email actually went out", async () => {
    emailOff();
    const owner = await setUpNamedOwner(h);
    const created = await invite(owner, "dev@example.com");
    const id = created.body.invitation.id;
    const first = await owner.post(`/workspace/invitations/${id}/resend`);
    expect(first.status).toBe(200);
    expect(first.body.delivery.emailed).toBe(false);
    expect((await owner.post(`/workspace/invitations/${id}/resend`)).status).toBe(200);
  });

  test("copy link gives the shareable link; cancel stops it working", async () => {
    const owner = await setUpNamedOwner(h);
    const created = await invite(owner, "dev@example.com");
    const id = created.body.invitation.id;
    const link = await owner.get(`/workspace/invitations/${id}/link`);
    expect(link.body.link).toBe(created.body.delivery.link);

    expect((await owner.delete(`/workspace/invitations/${id}`)).body).toEqual({ cancelled: true });
    expect((await owner.get("/workspace/invitations")).body.invitations).toEqual([]);
    const inspected = await h
      .browser()
      .post("/invitations/inspect", { token: tokenOf(link.body.link) });
    expect(inspected.body.state).toBe("cancelled");
    const register = await h.browser().post("/auth/register", {
      token: tokenOf(link.body.link),
      password: PASSWORD,
    });
    expect(register.body.error.message).toBe("This invitation was cancelled");
    expect((await owner.post(`/workspace/invitations/${id}/resend`)).status).toBe(404);
  });
});

describe("the invitee's page and sign-up (spec 04 4.2, 4.5, spec 24 G5)", () => {
  test("inspecting a link shows its state and whether to sign in or sign up", async () => {
    const owner = await setUpNamedOwner(h);
    const created = await invite(owner, "dev@example.com", "admin");
    const token = tokenOf(created.body.delivery.link);
    const visitor = h.browser();
    expect((await visitor.post("/invitations/inspect", { token })).body).toEqual({
      state: "pending",
      workspaceName: "Acme Inc.",
      role: "admin",
      email: "dev@example.com",
      // Who sent it, so the page can name them (30a R1-09).
      inviterName: "Olivia Owner",
      accountExists: false,
      signedInEmail: null,
      forAnotherEmail: false,
    });
    expect((await visitor.post("/invitations/inspect", { token: "y".repeat(43) })).body).toEqual({
      state: "not_found",
    });
    // Signed in as someone else.
    const other = await owner.post("/invitations/inspect", { token });
    expect(other.body).toMatchObject({ forAnotherEmail: true, signedInEmail: "owner@example.com" });
  });

  test("sign-up through the emailed link proves the address and joins with the role", async () => {
    const owner = await setUpNamedOwner(h);
    const policy = await owner.post("/workspace/policies", { name: "Developers" });
    await invite(owner, "dev@example.com", "member", [policy.body.policy.id]);
    const link = new URL(h.outside.linkIn(h.outside.lastEmailTo("dev@example.com")));
    const dev = h.browser();
    const mismatch = await dev.post("/auth/register", {
      token: link.searchParams.get("token"),
      proof: link.searchParams.get("proof"),
      email: "someone@example.com",
      password: PASSWORD,
    });
    expect(mismatch.body.error.message).toBe("Email does not match invitation");

    const registered = await dev.post("/auth/register", {
      token: link.searchParams.get("token"),
      proof: link.searchParams.get("proof"),
      email: "dev@example.com",
      password: PASSWORD,
    });
    expect(registered.status).toBe(201);
    const session = await dev.get("/auth/session");
    expect(session.body.person).toMatchObject({ email: "dev@example.com", emailVerified: true });
    expect(session.body.workspace).toMatchObject({ name: "Acme Inc.", role: "member" });
    const members = await owner.get("/workspace/members");
    const devRow = members.body.members.find(
      (m: { person: { email: string } }) => m.person.email === "dev@example.com",
    );
    expect(devRow.access.policies.map((p: { name: string }) => p.name)).toEqual(["Developers"]);

    const reused = await h.browser().post("/auth/register", {
      token: link.searchParams.get("token"),
      proof: link.searchParams.get("proof"),
      password: PASSWORD,
    });
    expect(reused.body.error.message).toBe("This invitation was already accepted");
  });

  test("an emailed invitation can't create an account without the emailed link (G5)", async () => {
    const owner = await setUpNamedOwner(h);
    const created = await invite(owner, "victim@example.com");
    const copied = tokenOf(created.body.delivery.link);
    const attempt = await h.browser().post("/auth/register", { token: copied, password: PASSWORD });
    expect(attempt.status).toBe(403);
    expect(attempt.body.error.message).toBe(
      "To create your account, open the link in the invitation email sent to victim@example.com.",
    );
    const forged = await h.browser().post("/auth/register", {
      token: copied,
      proof: "A".repeat(32),
      password: PASSWORD,
    });
    expect(forged.status).toBe(403);
    expect(
      await h.test.db
        .selectFrom("person")
        .select("id")
        .where("email", "=", "victim@example.com")
        .execute(),
    ).toEqual([]);
  });

  test("a never-emailed link creates an account only when an instance administrator made it", async () => {
    emailOff();
    const owner = await setUpNamedOwner(h);
    const byAdmin = await invite(owner, "copy@example.com");
    const fromAdmin = await h.browser().post("/auth/register", {
      token: tokenOf(byAdmin.body.delivery.link),
      password: PASSWORD,
    });
    expect(fromAdmin.status).toBe(201);
    const me = await h.test.db
      .selectFrom("person")
      .select("email_verified_at")
      .where("email", "=", "copy@example.com")
      .executeTakeFirstOrThrow();
    // The administrator vouched for the address, as with Add user with a password (30a R1-02).
    expect(me.email_verified_at).not.toBeNull();

    // A non-administrator owns a personal workspace and invites from it: the G5 hole.
    h.services.instanceEmail = INSTANCE_RESEND;
    const mia = await addMemberThroughInvitation(h, owner, "mia@example.com");
    emailOff();
    const personal = await h.test.db
      .selectFrom("workspace")
      .select("id")
      .where("created_by", "=", await personIdOf(h, "mia@example.com"))
      .where("is_personal", "=", true)
      .executeTakeFirstOrThrow();
    await mia.post(`/workspaces/${personal.id}/switch`);
    const byMia = await invite(mia, "victim@example.com");
    expect(byMia.status).toBe(201);
    const hole = await h.browser().post("/auth/register", {
      token: tokenOf(byMia.body.delivery.link),
      password: PASSWORD,
    });
    expect(hole.status).toBe(403);
    expect(hole.body.error.message).toContain("was never emailed to victim@example.com");
  });

  test("an existing account signs in, is sent to the invitation, and accepts it", async () => {
    const owner = await setUpNamedOwner(h);
    const dev = await addMemberThroughInvitation(h, owner, "dev@example.com");
    const other = await owner.post("/workspaces", { name: "Other Team" });
    await owner.post(`/workspaces/${other.body.workspace.id}/switch`);
    const created = await invite(owner, "dev@example.com", "admin");
    const token = tokenOf(created.body.delivery.link);

    const inspect = await h.browser().post("/invitations/inspect", { token });
    expect(inspect.body.accountExists).toBe(true);
    const register = await h.browser().post("/auth/register", {
      token,
      proof: new URL(h.outside.linkIn(h.outside.lastEmailTo("dev@example.com"))).searchParams.get(
        "proof",
      ),
      password: PASSWORD,
    });
    expect(register.body.error.message).toBe(
      "An account already exists with this email. Log in instead.",
    );

    const signIn = await dev.signIn("dev@example.com");
    expect(signIn.body.next).toMatchObject({ kind: "invitation", workspaceName: "Other Team" });
    expect((await dev.get("/me/invitations")).body.invitations).toHaveLength(1);

    const wrong = await owner.post("/invitations/accept", { token });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.message).toBe("This invitation is for another email");

    const accepted = await dev.post(`/me/invitations/${signIn.body.next.invitationId}/accept`);
    expect(accepted.status).toBe(200);
    expect(accepted.body.message).toBe("You've joined Other Team");
    expect(accepted.body.next).toEqual({ kind: "home" });
    expect((await dev.get("/workspace")).body).toMatchObject({ role: "admin" });
    expect((await dev.post("/invitations/accept", { token })).body.error.message).toBe(
      "This invitation was already accepted",
    );
  });

  test("declining cancels the invitation, and signs out a person still onboarding", async () => {
    emailOff();
    const owner = await setUpNamedOwner(h);
    const first = await invite(owner, "newbie@example.com");
    const newbie = h.browser();
    await newbie.post("/auth/register", {
      token: tokenOf(first.body.delivery.link),
      password: PASSWORD,
    });
    const other = await owner.post("/workspaces", { name: "Other Team" });
    await owner.post(`/workspaces/${other.body.workspace.id}/switch`);
    const second = await invite(owner, "newbie@example.com");
    const declined = await newbie.post("/invitations/decline", {
      token: tokenOf(second.body.delivery.link),
    });
    expect(declined.body).toEqual({ declined: true, signedOut: true });
    expect((await newbie.get("/me")).status).toBe(401);
    const inspect = await h
      .browser()
      .post("/invitations/inspect", { token: tokenOf(second.body.delivery.link) });
    expect(inspect.body.state).toBe("cancelled");
  });

  test("an expired invitation can't be used", async () => {
    const owner = await setUpNamedOwner(h);
    await invite(owner, "late@example.com");
    const link = new URL(h.outside.linkIn(h.outside.lastEmailTo("late@example.com")));
    await h.test.db
      .updateTable("invitation")
      .set({ expires_at: sql<Date>`now() - interval '1 minute'` })
      .execute();
    const reply = await h.browser().post("/auth/register", {
      token: link.searchParams.get("token"),
      proof: link.searchParams.get("proof"),
      password: PASSWORD,
    });
    expect(reply.body.error.message).toBe("This invitation has expired");
  });

  test("accepting is refused when the workspace has 100 members", async () => {
    const owner = await setUpNamedOwner(h);
    await invite(owner, "late@example.com");
    const link = new URL(h.outside.linkIn(h.outside.lastEmailTo("late@example.com")));
    const workspace = await owner.get("/workspace");
    await sql`
      with people as (
        insert into person (email, password_hash)
        select 'filler' || n || '@example.com', null from generate_series(1, 99) n
        returning id
      )
      insert into membership (workspace_id, person_id, role)
      select ${workspace.body.workspace.id}::uuid, id, 'member' from people
    `.execute(h.test.db);
    const reply = await h.browser().post("/auth/register", {
      token: link.searchParams.get("token"),
      proof: link.searchParams.get("proof"),
      password: PASSWORD,
    });
    expect(reply.status).toBe(409);
    expect(reply.body.error.message).toBe(
      "This workspace has reached its limit of 100 members. Ask an owner or admin to remove someone first.",
    );
    expect(
      await h.test.db
        .selectFrom("person")
        .select("id")
        .where("email", "=", "late@example.com")
        .execute(),
    ).toEqual([]);
    expect((await invite(owner, "more@example.com")).status).toBe(409);
  });
});

describe("members: roles and removal (spec 04 4.7)", () => {
  test("lists members with roles and access notes", async () => {
    const owner = await setUpNamedOwner(h);
    await addMemberThroughInvitation(h, owner, "ada@example.com", {
      role: "admin",
      name: "Ada Admin",
    });
    await addMemberThroughInvitation(h, owner, "mia@example.com");
    const reply = await owner.get("/workspace/members");
    expect(reply.body.count).toBe(3);
    expect(
      reply.body.members.map(
        (m: {
          person: { name: string };
          role: string;
          isYou: boolean;
          access: { everything: boolean };
        }) => [m.person.name, m.role, m.isYou, m.access.everything],
      ),
    ).toEqual([
      ["Olivia Owner", "owner", true, true],
      ["Ada Admin", "admin", false, true],
      ["Mia Member", "member", false, false],
    ]);
  });

  test("role changes follow the rules and their words", async () => {
    const owner = await setUpNamedOwner(h);
    const ada = await addMemberThroughInvitation(h, owner, "ada@example.com", { role: "admin" });
    await addMemberThroughInvitation(h, owner, "ben@example.com", { role: "admin" });
    await addMemberThroughInvitation(h, owner, "mia@example.com");
    const ownerId = await personIdOf(h, "owner@example.com");
    const adaId = await personIdOf(h, "ada@example.com");
    const benId = await personIdOf(h, "ben@example.com");
    const miaId = await personIdOf(h, "mia@example.com");

    expect(
      (await owner.patch(`/workspace/members/${ownerId}`, { role: "member" })).body.error.message,
    ).toBe("You cannot change your own role");
    expect(
      (await ada.patch(`/workspace/members/${ownerId}`, { role: "member" })).body.error.message,
    ).toBe("The owner role is nontransferable");
    expect(
      (await owner.patch(`/workspace/members/${miaId}`, { role: "owner" })).body.error.message,
    ).toBe("The owner role is nontransferable");
    const adminOnAdmin = await ada.patch(`/workspace/members/${benId}`, { role: "member" });
    expect(adminOnAdmin.status).toBe(403);
    expect(adminOnAdmin.body.error.message).toStartWith(
      "Only the workspace owner can change admin roles",
    );
    expect(
      (await ada.patch(`/workspace/members/${adaId}`, { role: "member" })).body.error.message,
    ).toBe("You cannot change your own role");

    // Admins may promote a member; the owner may demote an admin.
    expect((await ada.patch(`/workspace/members/${miaId}`, { role: "admin" })).status).toBe(200);
    expect((await owner.patch(`/workspace/members/${benId}`, { role: "member" })).status).toBe(200);
    const roles = await owner.get("/workspace/members");
    expect(
      Object.fromEntries(
        roles.body.members.map((m: { person: { email: string }; role: string }) => [
          m.person.email,
          m.role,
        ]),
      ),
    ).toMatchObject({ "mia@example.com": "admin", "ben@example.com": "member" });
  });

  test("removal follows the rules; the account stays", async () => {
    const owner = await setUpNamedOwner(h);
    const ada = await addMemberThroughInvitation(h, owner, "ada@example.com", { role: "admin" });
    await addMemberThroughInvitation(h, owner, "ben@example.com", { role: "admin" });
    const mia = await addMemberThroughInvitation(h, owner, "mia@example.com");
    const ownerId = await personIdOf(h, "owner@example.com");
    const adaId = await personIdOf(h, "ada@example.com");
    const benId = await personIdOf(h, "ben@example.com");
    const miaId = await personIdOf(h, "mia@example.com");

    expect((await ada.delete(`/workspace/members/${ownerId}`)).body.error.message).toBe(
      "The workspace owner can't be removed.",
    );
    expect((await ada.delete(`/workspace/members/${adaId}`)).status).toBe(403);
    expect((await ada.delete(`/workspace/members/${benId}`)).body.error.message).toBe(
      "Admins can't remove other admins. Ask the workspace owner to do it.",
    );
    expect((await mia.delete(`/workspace/members/${benId}`)).status).toBe(403);

    expect((await ada.delete(`/workspace/members/${miaId}`)).body).toEqual({ removed: true });
    // Mia's account remains, and she lands in her own workspace.
    expect((await mia.get("/workspace")).body.workspace.name).toBe("My Workspace");
    expect((await owner.delete(`/workspace/members/${benId}`)).status).toBe(200);
    const audit = await h.test.db
      .selectFrom("audit_event")
      .select("action")
      .where("action", "=", "member.removed")
      .execute();
    expect(audit).toHaveLength(2);
  });

  test("members can't see or manage people, invitations or policies", async () => {
    const owner = await setUpNamedOwner(h);
    const mia = await addMemberThroughInvitation(h, owner, "mia@example.com");
    for (const [method, path] of [
      ["GET", "/workspace/members"],
      ["GET", "/workspace/invitations"],
      ["POST", "/workspace/invitations"],
      ["GET", "/workspace/policies"],
      ["POST", "/workspace/policies"],
    ] as const) {
      const body =
        method === "POST" ? { email: "z@example.com", role: "member", name: "P" } : undefined;
      const reply = await mia.request(method, path, body);
      expect(reply.status).toBe(403);
      expect(reply.body.error.message).toStartWith("Only owners and admins can");
    }
  });
});

describe("the workspace boundary (spec 22.4, rule 1)", () => {
  test("ids from another workspace are not found, for owners too", async () => {
    const owner = await setUpNamedOwner(h);
    const mia = await addMemberThroughInvitation(h, owner, "mia@example.com");
    const elsewhere = await owner.post("/workspaces", { name: "Elsewhere" });
    await owner.post(`/workspaces/${elsewhere.body.workspace.id}/switch`);
    const foreignInvitation = await invite(owner, "far@example.com");
    const foreignPolicy = await owner.post("/workspace/policies", { name: "Far" });
    const acme = (await owner.get("/workspaces")).body.workspaces.find(
      (w: { name: string }) => w.name === "Acme Inc.",
    );
    await owner.post(`/workspaces/${acme.id}/switch`);

    const id = foreignInvitation.body.invitation.id;
    expect((await owner.post(`/workspace/invitations/${id}/resend`)).status).toBe(404);
    expect((await owner.get(`/workspace/invitations/${id}/link`)).status).toBe(404);
    expect((await owner.delete(`/workspace/invitations/${id}`)).status).toBe(404);
    const policyId = foreignPolicy.body.policy.id;
    expect((await owner.put(`/workspace/policies/${policyId}`, { name: "X" })).status).toBe(404);
    expect((await owner.delete(`/workspace/policies/${policyId}`)).status).toBe(404);
    const withForeign = await invite(owner, "q@example.com", "member", [policyId]);
    expect(withForeign.status).toBe(409);

    // A person who isn't a member here is not found, and their avatar stays hidden.
    const stranger = await h.test.db
      .selectFrom("person")
      .select("id")
      .where("email", "=", "owner@example.com")
      .executeTakeFirstOrThrow();
    await owner.post(`/workspaces/${elsewhere.body.workspace.id}/switch`);
    const miaId = await personIdOf(h, "mia@example.com");
    expect((await owner.patch(`/workspace/members/${miaId}`, { role: "admin" })).status).toBe(404);
    expect((await owner.delete(`/workspace/members/${miaId}`)).status).toBe(404);
    expect((await owner.get(`/workspace/members/${miaId}/access`)).status).toBe(404);
    expect((await owner.get(`/workspace/members/not-a-uuid/access`)).status).toBe(404);
    expect(stranger.id).toBeTruthy();
    void mia;
  });
});

describe("adding people with a password (spec 04 4.7, spec 22.2)", () => {
  test("an instance administrator adds someone who then signs in and names themselves", async () => {
    const owner = await setUpNamedOwner(h);
    const added = await owner.post("/workspace/members", {
      email: "pat@example.com",
      role: "member",
      password: "Generated-Pass-123",
    });
    expect(added.status).toBe(201);
    expect(added.body.signIn).toEqual({ address: CONSOLE_URL, email: "pat@example.com" });
    expect(JSON.stringify(added.body)).not.toContain("Generated-Pass-123");
    const pat = h.browser();
    const signIn = await pat.signIn("pat@example.com", "Generated-Pass-123");
    expect(signIn.body.next).toEqual({ kind: "onboarding", step: "name" });
    expect((await pat.get("/workspace")).body.workspace.name).toBe("Acme Inc.");
  });

  test("refusals use the spec's words", async () => {
    const owner = await setUpNamedOwner(h);
    const spaced = await owner.post("/workspace/members", {
      email: "pat@example.com",
      role: "member",
      password: " leading space",
    });
    expect(spaced.status).toBe(400);
    const existing = await owner.post("/workspace/members", {
      email: "owner@example.com",
      role: "member",
      password: "whatever-123",
    });
    expect(existing.body.error.message).toStartWith(
      "owner@example.com already has an account on this server. Send an invitation instead",
    );

    const mia = await addMemberThroughInvitation(h, owner, "mia@example.com");
    const asMember = await mia.post("/workspace/members", {
      email: "x@example.com",
      role: "member",
      password: "whatever-123",
    });
    expect(asMember.body.error.message).toBe(
      "Only owners and admins can add people with a password.",
    );

    // Mia owns her personal workspace but isn't an instance administrator.
    const personal = await h.test.db
      .selectFrom("workspace")
      .select("id")
      .where("created_by", "=", await personIdOf(h, "mia@example.com"))
      .executeTakeFirstOrThrow();
    await mia.post(`/workspaces/${personal.id}/switch`);
    const notAdmin = await mia.post("/workspace/members", {
      email: "x@example.com",
      role: "member",
      password: "whatever-123",
    });
    expect(notAdmin.body.error.message).toBe(
      "Only this server's administrators can add people with a password. Send an invitation instead.",
    );

    // The owner's own personal workspace still has its placeholder name.
    const spare = await owner.post("/workspaces", { name: "Spare" });
    await h.test.db
      .updateTable("workspace")
      .set({ is_personal: true })
      .where("id", "=", spare.body.workspace.id)
      .execute();
    await owner.post(`/workspaces/${spare.body.workspace.id}/switch`);
    const placeholder = await owner.post("/workspace/members", {
      email: "x@example.com",
      role: "member",
      password: "whatever-123",
    });
    expect(placeholder.body.error.message).toBe(
      "Give this workspace its own name before adding people with a password.",
    );
  });
});
