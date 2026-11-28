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
  Browser,
  CONSOLE_URL,
  createHarness,
  type Harness,
  INSTANCE_RESEND,
  nextPeer,
  PASSWORD,
  personIdOf,
  setUpNamedOwner,
  setUpOwner,
} from "./support/harness.ts";

/**
 * Proving email addresses (30a R1-02, B1-63), the welcome email (R1-05), the inviter's name on
 * the invitee's page (R1-09) and sign-ups that race for one invitation (B1-65).
 */

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

/** Emails are sent in the background after some requests; wait until one arrives. */
async function emailTo(address: string, subject: string) {
  for (let i = 0; i < 100; i++) {
    const found = h.outside.emails.find((mail) => mail.to === address && mail.subject === subject);
    if (found) return found;
    await Bun.sleep(20);
  }
  throw new Error(`no "${subject}" email reached ${address}`);
}

function tokenIn(mail: { text: string }): string {
  const link = new URL(h.outside.linkIn(mail as Parameters<typeof h.outside.linkIn>[0]));
  expect(link.origin + link.pathname).toBe(`${CONSOLE_URL}/confirm-email`);
  return link.searchParams.get("token") ?? "";
}

/** The instance owner adds a second workspace, switches to it, and comes back afterwards. */
async function inOtherWorkspace(owner: Browser, act: () => Promise<void>) {
  const before = (await owner.get("/auth/session")).body.workspace.id;
  const added = await owner.post("/workspaces", { name: "Other Co" });
  expect(added.status).toBe(201);
  await owner.post(`/workspaces/${added.body.workspace.id}/switch`);
  await act();
  await owner.post(`/workspaces/${before}/switch`);
}

async function invite(from: Browser, email: string) {
  const reply = await from.post("/workspace/invitations", { email, role: "member", policyIds: [] });
  expect(reply.status).toBe(201);
  return reply;
}

describe("a changed email counts once its link is opened (R1-02, B1-63)", () => {
  test("the link goes to the new address; until it's opened the old one stays in use", async () => {
    const owner = await setUpOwner(h);
    const asked = await owner.post("/me/email", {
      email: "olivia@new.example",
      currentPassword: PASSWORD,
    });
    expect(asked.status).toBe(200);
    expect(asked.body.message).toBe(
      "We sent a link to olivia@new.example. Open it to finish the change; until then owner@example.com stays in use.",
    );
    const mail = await emailTo("olivia@new.example", "Confirm your new Nearzero email address");
    expect(mail.text).toContain("Until you do, owner@example.com stays in use.");
    expect(mail.text).toContain("24 hours");
    // No notice to the old address yet: nothing has changed.
    expect(h.outside.lastEmailTo("owner@example.com")).toBeUndefined();

    const me = (await owner.get("/me")).body;
    expect(me.email).toBe("owner@example.com");
    expect(me.emailVerified).toBe(true);
    expect(me.pendingEmail).toBe("olivia@new.example");
    // Sign-in still uses the old address.
    expect((await h.browser().signIn("olivia@new.example")).status).toBe(401);
    expect((await h.browser().signIn("owner@example.com")).status).toBe(200);

    const confirmed = await owner.post("/me/email/confirm", { token: tokenIn(mail) });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.message).toBe("Your email address is now olivia@new.example.");
    expect(confirmed.body.person).toMatchObject({
      email: "olivia@new.example",
      emailVerified: true,
      pendingEmail: null,
    });
    expect((await h.browser().signIn("olivia@new.example")).status).toBe(200);
    expect(
      (await emailTo("owner@example.com", "Your Nearzero email address was changed")).text,
    ).toContain("olivia@new.example");
    // A link works once.
    const again = await owner.post("/me/email/confirm", { token: tokenIn(mail) });
    expect(again.status).toBe(404);
  });

  test("nobody can take an address they don't receive mail at", async () => {
    const owner = await setUpNamedOwner(h);
    const squatter = await addMemberThroughInvitation(h, owner, "sam@example.com");
    // Sam asks for alice@corp.example, which Sam can't read.
    expect(
      (
        await squatter.post("/me/email", {
          email: "alice@corp.example",
          currentPassword: PASSWORD,
        })
      ).status,
    ).toBe(200);
    expect((await squatter.get("/me")).body.email).toBe("sam@example.com");
    // The real Alice is invited later and signs up from her emailed link.
    const alice = await addMemberThroughInvitation(h, owner, "alice@corp.example", {
      name: "Alice Real",
    });
    expect((await alice.get("/me")).body.email).toBe("alice@corp.example");
    // Sam's link, opened anyway, can't take the address any more.
    const mail = await emailTo("alice@corp.example", "Confirm your new Nearzero email address");
    const taken = await squatter.post("/me/email/confirm", { token: tokenIn(mail) });
    expect(taken.status).toBe(409);
    expect((await squatter.get("/me")).body).toMatchObject({
      email: "sam@example.com",
      pendingEmail: null,
    });
  });

  test("a link opened by another account changes nothing", async () => {
    const owner = await setUpNamedOwner(h);
    const mia = await addMemberThroughInvitation(h, owner, "mia@example.com");
    await owner.post("/me/email", { email: "olivia@new.example", currentPassword: PASSWORD });
    const mail = await emailTo("olivia@new.example", "Confirm your new Nearzero email address");
    const other = await mia.post("/me/email/confirm", { token: tokenIn(mail) });
    expect(other.status).toBe(403);
    expect(other.body.error.message).toBe(
      "This link was sent for another Nearzero account. Sign in as that account, then open it again.",
    );
    expect((await mia.get("/me")).body.email).toBe("mia@example.com");
    // Signed out, nothing either.
    expect((await h.browser().post("/me/email/confirm", { token: tokenIn(mail) })).status).toBe(
      401,
    );
    // An expired link is refused.
    await h.test.db
      .updateTable("email_confirmation")
      .set({ expires_at: sql<Date>`now() - interval '1 second'` })
      .execute();
    expect((await owner.post("/me/email/confirm", { token: tokenIn(mail) })).status).toBe(404);
    expect((await owner.get("/me")).body.pendingEmail).toBeNull();
  });

  test("a change can be taken back, and the link sent again", async () => {
    const owner = await setUpOwner(h);
    await owner.post("/me/email", { email: "olivia@new.example", currentPassword: PASSWORD });
    const first = await emailTo("olivia@new.example", "Confirm your new Nearzero email address");
    const resent = await owner.post("/me/email/confirmation");
    expect(resent.body.sentTo).toBe("olivia@new.example");
    // The newest link replaces the earlier one.
    expect((await owner.post("/me/email/confirm", { token: tokenIn(first) })).status).toBe(404);
    const cancelled = await owner.delete("/me/email/change");
    expect(cancelled.body.person.pendingEmail).toBeNull();
    const latest = h.outside.emails.filter((mail) => mail.to === "olivia@new.example").at(-1);
    expect(
      (await owner.post("/me/email/confirm", { token: tokenIn(latest ?? first) })).status,
    ).toBe(404);
    expect((await owner.get("/me")).body.email).toBe("owner@example.com");
    // Already confirmed, with nothing waiting: nothing to send.
    expect((await owner.post("/me/email/confirmation")).status).toBe(409);
  });

  test("without email, a new address can't be confirmed, so nothing is promised", async () => {
    const owner = await setUpOwner(h);
    h.services.instanceEmail = null;
    const refused = await owner.post("/me/email", {
      email: "olivia@new.example",
      currentPassword: PASSWORD,
    });
    expect(refused.status).toBe(409);
    // It says who can make the change instead (31a G1-02).
    expect(refused.body.error.message).toBe(
      "This server can't send email, so a new address can't be confirmed. Ask a Nearzero administrator to change it in Members, or run sudo nearzero set-email on the server.",
    );
    expect((await owner.get("/me")).body.pendingEmail).toBeNull();
  });

  test("an unconfirmed account confirms its own address from Profile, then sees its invitations", async () => {
    const owner = await setUpNamedOwner(h);
    const mia = await addMemberThroughInvitation(h, owner, "mia@example.com");
    const miaId = await personIdOf(h, "mia@example.com");
    // An account whose address was never proven (a copied invitation link, for example).
    await h.test.db
      .updateTable("person")
      .set({ email_verified_at: null })
      .where("id", "=", miaId)
      .execute();
    // Another workspace invites her: the bell can't offer it while her address is unproven.
    await inOtherWorkspace(owner, async () => {
      await invite(owner, "mia@example.com");
    });
    expect((await mia.get("/me/invitations")).body.invitations).toEqual([]);

    const sent = await mia.post("/me/email/confirmation");
    expect(sent.status).toBe(200);
    expect(sent.body.sentTo).toBe("mia@example.com");
    const mail = await emailTo("mia@example.com", "Confirm your Nearzero email address");
    const confirmed = await mia.post("/me/email/confirm", { token: tokenIn(mail) });
    expect(confirmed.body.message).toBe("mia@example.com is confirmed.");
    expect(confirmed.body.person.emailVerified).toBe(true);
    const bell = (await mia.get("/me/invitations")).body.invitations;
    expect(bell.map((item: { workspaceName: string }) => item.workspaceName)).toEqual(["Other Co"]);
    // And sign-in sends her to it.
    const signedIn = await h.browser().signIn("mia@example.com");
    expect(signedIn.body.next.kind).toBe("invitation");
  });
});

describe("the welcome email (R1-05)", () => {
  test("the owner gets one when they finish onboarding, greeted by name, opening the Agent", async () => {
    const owner = await setUpOwner(h);
    await owner.post("/onboarding/workspace", { name: "Olivia Owner", workspaceName: "Acme Inc." });
    expect(h.outside.lastEmailTo("owner@example.com")).toBeUndefined();
    await owner.post("/onboarding/skip-invitations");
    const mail = await emailTo("owner@example.com", "Welcome to Nearzero, Olivia");
    expect(mail.text).toContain(
      "Your workspace Acme Inc. is ready. Nearzero helps your team deploy apps, manage services, and run infrastructure from one place.",
    );
    expect(mail.text).toContain(`Open your dashboard: ${CONSOLE_URL}/acme-inc/dashboard/agent`);
    expect(mail.text).toContain("This message was sent to owner@example.com.");
    expect(h.outside.emails.filter((item) => item.subject.startsWith("Welcome")).length).toBe(1);
  });

  test("an invited member gets one after their name step, greeted by first name", async () => {
    const owner = await setUpNamedOwner(h);
    await addMemberThroughInvitation(h, owner, "mia@example.com", { name: "Mia Member" });
    const mail = await emailTo("mia@example.com", "Welcome to Nearzero, Mia");
    expect(mail.text).toContain(`${CONSOLE_URL}/acme-inc/dashboard/agent`);
    expect(
      h.outside.emails.filter(
        (item) => item.to === "mia@example.com" && item.subject.startsWith("Welcome"),
      ).length,
    ).toBe(1);
  });

  test("someone who already has a name gets it when they join", async () => {
    const owner = await setUpNamedOwner(h);
    const mia = await addMemberThroughInvitation(h, owner, "mia@example.com", {
      name: "Mia Member",
    });
    await emailTo("mia@example.com", "Welcome to Nearzero, Mia");
    await inOtherWorkspace(owner, async () => {
      await invite(owner, "mia@example.com");
    });
    const [pending] = (await mia.get("/me/invitations")).body.invitations;
    expect((await mia.post(`/me/invitations/${pending.id}/accept`)).status).toBe(200);
    // No name step this time, so the welcome goes out on joining.
    expect((await mia.get("/onboarding")).body.step).toBeNull();
    const welcomes = async () =>
      h.outside.emails.filter(
        (item) =>
          item.to === "mia@example.com" && item.text.includes("Your workspace Other Co is ready."),
      );
    for (let i = 0; i < 100 && (await welcomes()).length === 0; i++) await Bun.sleep(20);
    expect((await welcomes()).length).toBe(1);
    expect((await welcomes())[0]?.subject).toBe("Welcome to Nearzero, Mia");
  });
});

describe("the invitee's page names the inviter (R1-09)", () => {
  test("by their real name, in the inspect answer and the bell; never by an email", async () => {
    const owner = await setUpNamedOwner(h);
    await invite(owner, "dev@example.com");
    const link = new URL(h.outside.linkIn(h.outside.lastEmailTo("dev@example.com")));
    const inspected = await h
      .browser()
      .post("/invitations/inspect", { token: link.searchParams.get("token") });
    expect(inspected.body.inviterName).toBe("Olivia Owner");

    // An admin whose account has no real name isn't named.
    const ann = await addMemberThroughInvitation(h, owner, "ann@example.com", { role: "admin" });
    await h.test.db
      .updateTable("person")
      .set({ first_name: null, last_name: null })
      .where("email", "=", "ann@example.com")
      .execute();
    await invite(ann, "x@example.com");
    const plain = new URL(h.outside.linkIn(h.outside.lastEmailTo("x@example.com")));
    const unnamed = await h
      .browser()
      .post("/invitations/inspect", { token: plain.searchParams.get("token") });
    expect(unnamed.body.inviterName).toBeNull();

    // The bell's list carries the name too.
    const mia = await addMemberThroughInvitation(h, owner, "mia@example.com");
    await inOtherWorkspace(owner, async () => {
      await invite(owner, "mia@example.com");
    });
    const bell = (await mia.get("/me/invitations")).body.invitations;
    expect(bell[0].inviterName).toBe("Olivia Owner");
  });
});

describe("sign-ups racing for one invitation (B1-65)", () => {
  test("one account is made; the others are told the invitation was used", async () => {
    const owner = await setUpNamedOwner(h);
    await invite(owner, "dev@example.com");
    const link = new URL(h.outside.linkIn(h.outside.lastEmailTo("dev@example.com")));
    const body = {
      token: link.searchParams.get("token"),
      proof: link.searchParams.get("proof"),
      password: PASSWORD,
    };
    // From four machines: sign-ups are also limited per client address (G4-14).
    const replies = await Promise.all(
      [1, 2, 3, 4].map(() => h.browser({ peer: nextPeer() }).post("/auth/register", body)),
    );
    expect(replies.filter((reply) => reply.status === 201).length).toBe(1);
    for (const reply of replies.filter((item) => item.status !== 201)) {
      expect(reply.status).toBe(409);
      expect([
        "This invitation was already accepted",
        "An account already exists with this email. Log in instead.",
      ]).toContain(reply.body.error.message);
    }
  });

  test("two adds of one address with a password at once: one account, one clear refusal", async () => {
    const owner = await setUpNamedOwner(h);
    const add = () =>
      owner.post("/workspace/members", {
        email: "pat@example.com",
        role: "member",
        policyIds: [],
        password: "a-long-password-1",
      });
    const replies = await Promise.all([add(), add(), add()]);
    expect(replies.filter((reply) => reply.status === 201).length).toBe(1);
    for (const reply of replies.filter((item) => item.status !== 201)) {
      expect(reply.status).toBe(409);
      expect(reply.body.error.message).toContain("already has an account on this server");
    }
  });
});

/** Mallory's own personal workspace, hidden from her switcher but found through its slug. */
async function personalWorkspaceOf(browser: Browser, email: string): Promise<string> {
  const row = await h.test.db
    .selectFrom("workspace")
    .select("id")
    .where("created_by", "=", await personIdOf(h, email))
    .where("is_personal", "=", true)
    .executeTakeFirstOrThrow();
  expect((await browser.post(`/workspaces/${row.id}/switch`)).status).toBe(200);
  return row.id;
}

/** Points the browser's active workspace at a mail server its owner runs. */
async function ownSmtp(browser: Browser) {
  const saved = await browser.put("/workspace/email", {
    provider: "smtp",
    host: "smtp.evil.example",
    port: 25,
    security: "none",
    username: "",
    from: "m@evil.example",
  });
  expect(saved.status).toBe(200);
}

const throughOwnSmtp = (mail: { via: string; smtp?: { host: string } } | undefined) =>
  mail?.via === "smtp" && mail.smtp?.host === "smtp.evil.example";

describe("mail that proves an address uses only the install's settings (C1-01)", () => {
  test("a confirmation link never travels through a workspace's own mail server", async () => {
    const owner = await setUpNamedOwner(h, "Corp");
    const mallory = await addMemberThroughInvitation(h, owner, "mallory@evil.example");
    await personalWorkspaceOf(mallory, "mallory@evil.example");
    await ownSmtp(mallory);
    h.outside.emails.length = 0;
    const asked = await mallory.post("/me/email", {
      email: "alice@corp.example",
      currentPassword: PASSWORD,
    });
    expect(asked.status).toBe(200);
    const mail = await emailTo("alice@corp.example", "Confirm your new Nearzero email address");
    // It went out with the install's Resend key, to the real Alice, not to Mallory's server.
    expect(mail.via).toBe("resend");
    expect(mail.apiKey).toBe(INSTANCE_RESEND.apiKey);
    expect(h.outside.emails.some(throughOwnSmtp)).toBe(false);
    expect((await mallory.get("/me")).body).toMatchObject({
      email: "mallory@evil.example",
      pendingEmail: "alice@corp.example",
    });

    // Without install email nothing is sent at all, even though her workspace could send.
    h.services.instanceEmail = null;
    h.outside.emails.length = 0;
    await mallory.delete("/me/email/change");
    const refused = await mallory.post("/me/email", {
      email: "alice@corp.example",
      currentPassword: PASSWORD,
    });
    expect(refused.status).toBe(409);
    expect(h.outside.emails).toEqual([]);
    expect((await mallory.get("/me")).body.email).toBe("mallory@evil.example");
  });

  test("the notice of a change goes to the old address through the install, whatever the workspace sends with", async () => {
    const owner = await setUpNamedOwner(h, "Corp");
    const mia = await addMemberThroughInvitation(h, owner, "mia@example.com");
    await personalWorkspaceOf(mia, "mia@example.com");
    await ownSmtp(mia);
    h.outside.emails.length = 0;
    await mia.post("/me/email", { email: "mia@new.example", currentPassword: PASSWORD });
    const link = await emailTo("mia@new.example", "Confirm your new Nearzero email address");
    expect((await mia.post("/me/email/confirm", { token: tokenIn(link) })).status).toBe(200);
    const notice = await emailTo("mia@example.com", "Your Nearzero email address was changed");
    expect(notice.via).toBe("resend");
    expect(notice.apiKey).toBe(INSTANCE_RESEND.apiKey);
    expect(h.outside.emails.some(throughOwnSmtp)).toBe(false);
  });

  test("G5: an invitation through a workspace's own mail works, but doesn't prove the address", async () => {
    const owner = await setUpNamedOwner(h, "Corp");
    const mallory = await addMemberThroughInvitation(h, owner, "mallory@evil.example");
    await personalWorkspaceOf(mallory, "mallory@evil.example");
    await ownSmtp(mallory);
    expect(
      (
        await mallory.post("/workspace/invitations", {
          email: "bob@corp.example",
          role: "member",
          policyIds: [],
        })
      ).status,
    ).toBe(201);
    const mail = h.outside.lastEmailTo("bob@corp.example");
    expect(throughOwnSmtp(mail)).toBe(true);
    const link = new URL(h.outside.linkIn(mail));
    const fresh = h.browser();
    const registered = await fresh.post("/auth/register", {
      token: link.searchParams.get("token"),
      proof: link.searchParams.get("proof"),
      password: PASSWORD,
    });
    // Still an invitation: the account is made and joins the workspace...
    expect(registered.status).toBe(201);
    // ...but it starts unconfirmed, so nothing addressed to bob@corp.example reaches it.
    expect((await fresh.get("/me")).body).toMatchObject({
      email: "bob@corp.example",
      emailVerified: false,
    });
    await fresh.post("/onboarding/name", { name: "Not Bob" });
    await inOtherWorkspace(owner, async () => {
      await owner.post("/workspace/invitations", {
        email: "bob@corp.example",
        role: "admin",
        policyIds: [],
      });
    });
    expect((await fresh.get("/me/invitations")).body.invitations).toEqual([]);
    const pending = await h.test.db
      .selectFrom("invitation")
      .select("id")
      .where("email", "=", "bob@corp.example")
      .where("status", "=", "pending")
      .executeTakeFirstOrThrow();
    expect((await fresh.post(`/me/invitations/${pending.id}/accept`)).status).toBe(403);
    expect((await h.browser().signIn("bob@corp.example")).body.next.kind).not.toBe("invitation");
    // The real invitation email, through the install, carries a proof Mallory's link didn't.
    const real = new URL(h.outside.linkIn(h.outside.lastEmailTo("bob@corp.example")));
    expect(real.searchParams.get("proof")).not.toBe(link.searchParams.get("proof"));
  });

  test("an instance administrator's invitation through a workspace's own mail starts confirmed", async () => {
    const owner = await setUpNamedOwner(h, "Corp");
    await ownSmtp(owner);
    await invite(owner, "dev@corp.example");
    const mail = h.outside.lastEmailTo("dev@corp.example");
    expect(throughOwnSmtp(mail)).toBe(true);
    const link = new URL(h.outside.linkIn(mail));
    const dev = h.browser();
    expect(
      (
        await dev.post("/auth/register", {
          token: link.searchParams.get("token"),
          proof: link.searchParams.get("proof"),
          password: PASSWORD,
        })
      ).status,
    ).toBe(201);
    expect((await dev.get("/me")).body.emailVerified).toBe(true);
  });

  test("a made-up proof, or none for an emailed invitation, creates nothing", async () => {
    const owner = await setUpNamedOwner(h, "Corp");
    await invite(owner, "dev@corp.example");
    const link = new URL(h.outside.linkIn(h.outside.lastEmailTo("dev@corp.example")));
    const token = link.searchParams.get("token");
    for (const proof of ["x".repeat(32), undefined]) {
      const reply = await h.browser().post("/auth/register", { token, proof, password: PASSWORD });
      expect(reply.status).toBe(403);
      expect(reply.body.error.message).toBe(
        "To create your account, open the link in the invitation email sent to dev@corp.example.",
      );
    }
  });
});

describe("a server that can't send email (30a R1-02, 31a G1-02)", () => {
  async function copiedLink(from: Browser, email: string): Promise<string> {
    const reply = await from.post("/workspace/invitations", {
      email,
      role: "member",
      policyIds: [],
    });
    expect(reply.status).toBe(201);
    expect(reply.body.delivery.emailed).toBe(false);
    return new URL(reply.body.delivery.link).searchParams.get("token") ?? "";
  }

  test("an account from an administrator's copied link counts as confirmed and sees its invitations", async () => {
    h.services.instanceEmail = null;
    const owner = await setUpNamedOwner(h, "Corp");
    const token = await copiedLink(owner, "mia@example.com");
    const mia = h.browser();
    expect((await mia.post("/auth/register", { token, password: PASSWORD })).status).toBe(201);
    expect((await mia.get("/me")).body).toMatchObject({
      emailVerified: true,
      canEmailLinks: false,
    });
    await mia.post("/onboarding/name", { name: "Mia Member" });
    await inOtherWorkspace(owner, async () => {
      await copiedLink(owner, "mia@example.com");
    });
    const bell = (await mia.get("/me/invitations")).body.invitations;
    expect(bell.map((item: { workspaceName: string }) => item.workspaceName)).toEqual(["Other Co"]);
    expect((await h.browser().signIn("mia@example.com")).body.next.kind).toBe("invitation");
  });

  test("Profile can't offer a confirmation link, and the refusal speaks of the account's own address", async () => {
    const owner = await setUpNamedOwner(h, "Corp");
    const mia = await addMemberThroughInvitation(h, owner, "mia@example.com");
    expect((await mia.get("/me")).body.canEmailLinks).toBe(true);
    await h.test.db
      .updateTable("person")
      .set({ email_verified_at: null })
      .where("email", "=", "mia@example.com")
      .execute();
    h.services.instanceEmail = null;
    expect((await mia.get("/me")).body.canEmailLinks).toBe(false);
    expect((await mia.get("/auth/session")).body.person.canEmailLinks).toBe(false);
    const refused = await mia.post("/me/email/confirmation");
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toBe(
      "This server can't send email, so your address can't be confirmed by email. Ask a Nearzero administrator to confirm it in Members, or run sudo nearzero set-email on the server.",
    );
    expect(refused.body.error.message).not.toContain("a new address");
  });

  test("an instance administrator changes a member's address in Members: confirmed, audited, signed out", async () => {
    h.services.instanceEmail = null;
    const owner = await setUpNamedOwner(h, "Corp");
    const mia = h.browser();
    await mia.post("/auth/register", {
      token: await copiedLink(owner, "mia@exmaple.com"),
      password: PASSWORD,
    });
    await mia.post("/onboarding/name", { name: "Mia Member" });
    const miaId = await personIdOf(h, "mia@exmaple.com");
    const listed = await owner.get("/workspace/members");
    expect(listed.body.canSetEmail).toBe(true);
    const changed = await owner.put(`/workspace/members/${miaId}/email`, {
      email: "Mia@Example.com",
    });
    expect(changed.status).toBe(200);
    expect(changed.body.message).toBe(
      "Email changed to mia@example.com. Their sessions were signed out.",
    );
    expect(changed.body.member).toMatchObject({
      person: { email: "mia@example.com" },
      emailConfirmed: true,
    });
    expect((await mia.get("/me")).status).toBe(401);
    const again = h.browser();
    expect((await again.signIn("mia@example.com")).status).toBe(200);
    expect((await again.get("/me")).body.emailVerified).toBe(true);
    const audit = await h.test.db
      .selectFrom("audit_event")
      .select(["actor_person_id", "details"])
      .where("action", "=", "person.email-set")
      .executeTakeFirstOrThrow();
    expect(audit.actor_person_id).toBe(await personIdOf(h, "owner@example.com"));
    expect(audit.details).toMatchObject({ from: "mia@exmaple.com", to: "mia@example.com" });
    // The owner stays signed in.
    expect((await owner.get("/me")).status).toBe(200);
  });

  test("who may set an address, and only while the server can't send email", async () => {
    h.services.instanceEmail = INSTANCE_RESEND;
    const owner = await setUpNamedOwner(h, "Corp");
    // Admins of the install's first workspace are instance administrators (spec 22.1).
    const ann = await addMemberThroughInvitation(h, owner, "ann@example.com", { role: "admin" });
    await addMemberThroughInvitation(h, owner, "al@example.com", { role: "admin" });
    const member = await addMemberThroughInvitation(h, owner, "mia@example.com");
    const miaId = await personIdOf(h, "mia@example.com");
    // An admin of another workspace only, who isn't an instance administrator.
    let zed: Browser | null = null;
    await inOtherWorkspace(owner, async () => {
      zed = await addMemberThroughInvitation(h, owner, "zed@example.com", { role: "admin" });
      await addMemberThroughInvitation(h, owner, "kim@example.com");
    });
    // With email set up, people change their own address and confirm it from the link.
    expect((await owner.get("/workspace/members")).body.canSetEmail).toBe(false);
    const withEmail = await owner.put(`/workspace/members/${miaId}/email`, {
      email: "mia@new.example",
    });
    expect(withEmail.status).toBe(409);
    expect(withEmail.body.error.message).toBe(
      "This server can send email, so people change their address from Profile and confirm it from the link sent to it.",
    );
    h.services.instanceEmail = null;
    const byMember = await member.put(`/workspace/members/${miaId}/email`, {
      email: "x@y.example",
    });
    expect(byMember.status).toBe(403);
    expect(byMember.body.error.message).toBe(
      "Only owners and admins can change a member's email address.",
    );
    const kimId = await personIdOf(h, "kim@example.com");
    const byZed = await (zed as unknown as Browser).put(`/workspace/members/${kimId}/email`, {
      email: "x@y.example",
    });
    expect(byZed.status).toBe(403);
    expect(byZed.body.error.message).toBe(
      "Only this server's administrators can change someone's email address. Ask a Nearzero administrator.",
    );
    expect((await (zed as unknown as Browser).get("/workspace/members")).body.canSetEmail).toBe(
      false,
    );
    // An instance administrator who is an admin changes members only.
    const alId = await personIdOf(h, "al@example.com");
    const adminToAdmin = await ann.put(`/workspace/members/${alId}/email`, {
      email: "x@y.example",
    });
    expect(adminToAdmin.status).toBe(403);
    expect(adminToAdmin.body.error.message).toBe(
      "Only the workspace owner can change an admin's email address. Ask the owner to make this change.",
    );
    // Not one's own, not the owner's, and not an address in use.
    const ownerId = await personIdOf(h, "owner@example.com");
    expect(
      (await owner.put(`/workspace/members/${ownerId}/email`, { email: "o@new.example" })).status,
    ).toBe(403);
    expect(
      (await ann.put(`/workspace/members/${ownerId}/email`, { email: "o@new.example" })).status,
    ).toBe(403);
    const taken = await owner.put(`/workspace/members/${miaId}/email`, {
      email: "ann@example.com",
    });
    expect(taken.status).toBe(409);
    expect(taken.body.error.message).toBe(
      "Another account already uses this email address. Use a different one.",
    );
    const same = await owner.put(`/workspace/members/${miaId}/email`, { email: "mia@example.com" });
    expect(same.status).toBe(400);
    // Someone who isn't in the active workspace isn't found.
    expect(
      (await owner.put(`/workspace/members/${kimId}/email`, { email: "z@y.example" })).status,
    ).toBe(404);
    expect((await member.get("/me")).body.email).toBe("mia@example.com");
    // An instance administrator who is an admin may change a member's.
    expect(
      (await ann.put(`/workspace/members/${miaId}/email`, { email: "mia@new.example" })).status,
    ).toBe(200);
  });
});

describe("sign-ups are limited per client address (31d G4-14)", () => {
  test("more than 3 in 10 seconds, or 10 in 15 minutes, get 429 with how long to wait", async () => {
    const owner = await setUpNamedOwner(h);
    await invite(owner, "dev@example.com");
    const link = new URL(h.outside.linkIn(h.outside.lastEmailTo("dev@example.com")));
    const token = link.searchParams.get("token");
    const prober = h.browser({ peer: "198.51.100.77" });
    // Probing which addresses have accounts: each attempt counts, whatever it answers.
    for (let i = 0; i < 3; i++) {
      const reply = await prober.post("/auth/register", { token, proof: "x", password: PASSWORD });
      expect(reply.status).toBe(403);
    }
    const limited = await prober.post("/auth/register", { token, proof: "x", password: PASSWORD });
    expect(limited.status).toBe(429);
    expect(limited.body.error.message).toMatch(
      /^Too many sign-up attempts\. Please try again in \d+ seconds?\.$/,
    );
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(Number(limited.headers.get("retry-after"))).toBeLessThanOrEqual(10);
    // Another address isn't held back, and the limit survives a restart.
    expect(
      (
        await h
          .browser({ peer: "198.51.100.78" })
          .post("/auth/register", { token, proof: "x", password: PASSWORD })
      ).status,
    ).toBe(403);
    const again = new Browser(h.restart(), { peer: "198.51.100.77" });
    expect((await again.post("/auth/register", { token, password: PASSWORD })).status).toBe(429);
    // 10 in 15 minutes: the burst window passed, the longer one still holds.
    await h.test.db
      .updateTable("attempt_record")
      .set({ attempted_at: sql<Date>`now() - interval '1 minute'` })
      .execute();
    // Three were counted above; seven more fill the 15-minute window.
    for (let i = 0; i < 7; i++) {
      await h.test.db
        .insertInto("attempt_record")
        .values({ bucket: "register", subject: "198.51.100.77" })
        .execute();
    }
    const hourly = await prober.post("/auth/register", { token, password: PASSWORD });
    expect(hourly.status).toBe(429);
    expect(Number(hourly.headers.get("retry-after"))).toBeGreaterThan(10);
  });
});

describe("invitation emails (31a G1-07, C1-21, C1-22)", () => {
  test("fixed opening words, who sent it on its own line, the role, the expiry and the closing note", async () => {
    const owner = await setUpNamedOwner(h);
    await invite(owner, "dev@example.com");
    const mail = h.outside.lastEmailTo("dev@example.com");
    expect(mail?.subject).toBe("You've been invited to join Acme Inc. on Nearzero");
    const lines = (mail?.text ?? "").split("\n\n");
    expect(lines.slice(0, 4)).toEqual([
      "You've been invited to join Acme Inc.",
      "You've been invited to join Acme Inc. on Nearzero.",
      "Sent by Olivia Owner (owner@example.com)",
      "You'll join as a member. The link works only for dev@example.com and expires in 7 days.",
    ]);
    expect(lines.at(-1)).toBe(
      "This invitation was intended for dev@example.com. If you were not expecting this invitation, you can safely ignore this email.",
    );
    expect(mail?.html).toContain("<h1");
  });

  test("an inviter's name never opens the email, and is cut at 60 characters", async () => {
    const owner = await setUpNamedOwner(h, "Corp");
    const mallory = await addMemberThroughInvitation(h, owner, "mallory@evil.example", {
      name: `Your account is locked: visit evil.example ${"x".repeat(40)}`,
    });
    await personalWorkspaceOf(mallory, "mallory@evil.example");
    await invite(mallory, "victim@target.example");
    const mail = h.outside.lastEmailTo("victim@target.example");
    const lines = (mail?.text ?? "").split("\n\n");
    expect(lines[1]).toBe("You've been invited to join My Workspace on Nearzero.");
    const sentBy = lines[2] ?? "";
    expect(sentBy).toStartWith("Sent by Your account is locked");
    expect(sentBy).toEndWith("… (mallory@evil.example)");
    expect(sentBy.length).toBeLessThanOrEqual("Sent by  (mallory@evil.example)".length + 60);
  });

  test("one person sends at most 20 invitation emails an hour; past that the link is given", async () => {
    const owner = await setUpNamedOwner(h, "Corp");
    const mallory = await addMemberThroughInvitation(h, owner, "mallory@evil.example");
    await personalWorkspaceOf(mallory, "mallory@evil.example");
    const before = h.outside.emails.length;
    const deliveries: { emailed: boolean; reason?: string }[] = [];
    for (let i = 0; i < 25; i++) {
      const reply = await mallory.post("/workspace/invitations", {
        email: `victim${i}@target.example`,
        role: "member",
        policyIds: [],
      });
      expect(reply.status).toBe(201);
      deliveries.push(reply.body.delivery);
    }
    expect(h.outside.emails.length - before).toBe(20);
    expect(deliveries.filter((item) => item.emailed)).toHaveLength(20);
    expect(deliveries.at(-1)?.reason).toBe(
      "Not emailed: you've sent 20 invitation emails in the last hour, the most one person may. Share the link, or send it again later.",
    );
    // A resend counts too.
    const listed = (await mallory.get("/workspace/invitations")).body.invitations;
    const unsent = listed.find((item: { lastEmailedAt: string | null }) => !item.lastEmailedAt);
    const resent = await mallory.post(`/workspace/invitations/${unsent.id}/resend`);
    expect(resent.status).toBe(200);
    expect(resent.body.delivery.emailed).toBe(false);
    expect(h.outside.emails.length - before).toBe(20);
    // 100 a day: an hour later, the daily count still holds.
    await h.test.db
      .updateTable("attempt_record")
      .set({ attempted_at: sql<Date>`now() - interval '2 hours'` })
      .where("bucket", "=", "invitation-email-hour")
      .execute();
    for (let i = 0; i < 80; i++) {
      await h.test.db
        .insertInto("attempt_record")
        .values({
          bucket: "invitation-email-day",
          subject: await personIdOf(h, "mallory@evil.example"),
        })
        .execute();
    }
    const daily = await mallory.post("/workspace/invitations", {
      email: "late@target.example",
      role: "member",
      policyIds: [],
    });
    expect(daily.body.delivery.reason).toBe(
      "Not emailed: you've sent 100 invitation emails today, the most one person may. Share the link, or send it again tomorrow.",
    );
  });

  test("a workspace holds at most 100 pending invitations", async () => {
    const owner = await setUpNamedOwner(h, "Corp");
    const workspaceId = (await owner.get("/auth/session")).body.workspace.id;
    const ownerId = await personIdOf(h, "owner@example.com");
    await sql`
      insert into invitation (id, workspace_id, email, role, token_hash, token_sealed, invited_by, expires_at)
      select gen_random_uuid(), ${workspaceId}::uuid, 'p' || n || '@x.example', 'member',
        decode(md5(n::text), 'hex'), 'x', ${ownerId}::uuid, now() + interval '1 day'
      from generate_series(1, 100) as n
    `.execute(h.test.db);
    const refused = await owner.post("/workspace/invitations", {
      email: "one-more@x.example",
      role: "member",
      policyIds: [],
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toBe(
      "This workspace already has 100 pending invitations, the most it may hold. Cancel some, or wait until they're accepted or expire.",
    );
    // Expired ones don't count.
    await sql`update invitation set expires_at = now() - interval '1 minute' where email = 'p1@x.example'`.execute(
      h.test.db,
    );
    expect(
      (
        await owner.post("/workspace/invitations", {
          email: "one-more@x.example",
          role: "member",
          policyIds: [],
        })
      ).status,
    ).toBe(201);
  });

  test("resends sent together claim the 30-second slot first: one email goes out", async () => {
    const owner = await setUpNamedOwner(h);
    const created = await invite(owner, "x@y.example");
    await sql`update invitation set last_emailed_at = now() - interval '1 minute'`.execute(
      h.test.db,
    );
    const before = h.outside.emails.filter((mail) => mail.to === "x@y.example").length;
    // A provider that takes a moment to answer, as a real one does: every resend sent in that
    // window used to get through.
    const http = h.services.http;
    h.services.http = async (input, init) => {
      await Bun.sleep(300);
      return http(input, init);
    };
    const replies = await Promise.all(
      Array.from({ length: 10 }, () =>
        owner.post(`/workspace/invitations/${created.body.invitation.id}/resend`),
      ),
    ).finally(() => {
      h.services.http = http;
    });
    const after = h.outside.emails.filter((mail) => mail.to === "x@y.example").length;
    expect(after - before).toBe(1);
    expect(replies.filter((reply) => reply.status === 200)).toHaveLength(1);
    expect(replies.filter((reply) => reply.status === 429)).toHaveLength(9);
    // A resend that couldn't be emailed gives the slot back.
    await sql`update invitation set last_emailed_at = now() - interval '1 minute'`.execute(
      h.test.db,
    );
    h.outside.resendStatus = 500;
    const failed = await owner.post(`/workspace/invitations/${created.body.invitation.id}/resend`);
    expect(failed.body.delivery.emailed).toBe(false);
    h.outside.resendStatus = 200;
    expect(
      (await owner.post(`/workspace/invitations/${created.body.invitation.id}/resend`)).status,
    ).toBe(200);
  });
});
