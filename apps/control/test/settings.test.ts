import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { defaultAgentPolicies, PRODUCTION_CONFIRMATION_PHRASE } from "@nearzero/shared";
import { sql } from "kysely";
import { agentSettings, configureAgent } from "../src/agent/settings.ts";
import { silentLogger } from "../src/log.ts";
import { createServices } from "../src/services.ts";
import { readWorkspaceKey } from "../src/settings/keys.ts";
import {
  addMemberThroughInvitation,
  type Browser,
  createHarness,
  type Harness,
  INSTANCE_RESEND,
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
  h.services.instanceEmailProblem = null;
});

async function owned(): Promise<{ owner: Browser; mia: Browser }> {
  const owner = await setUpNamedOwner(h);
  const mia = await addMemberThroughInvitation(h, owner, "mia@example.com");
  return { owner, mia };
}

describe("Agent policies (spec 19.9)", () => {
  test("new workspaces use the defaults", async () => {
    const { owner } = await owned();
    const reply = await owner.get("/workspace/agent-policies");
    expect(reply.body).toEqual({
      switches: defaultAgentPolicies(),
      usingDefaults: true,
      savedAt: null,
      savedBy: null,
    });
    expect(reply.body.switches["projects.delete-without-production"]).toBe(false);
    expect(reply.body.switches["services.deploy"]).toBe(true);
    expect(reply.body.switches.production).toBe(false);
  });

  test("Import from Git and Assign domains need Create and configure, both ways", async () => {
    const { owner } = await owned();
    const off = await owner.put("/workspace/agent-policies", {
      switches: { "services.configure": false },
    });
    expect(off.body.switches).toMatchObject({
      "services.configure": false,
      "services.import-git": false,
      "services.assign-domains": false,
    });
    expect(off.body.usingDefaults).toBe(false);
    expect(off.body.savedBy.name).toBe("Olivia Owner");
    const on = await owner.put("/workspace/agent-policies", {
      switches: { "services.assign-domains": true },
    });
    expect(on.body.switches).toMatchObject({
      "services.configure": true,
      "services.assign-domains": true,
      "services.import-git": false,
    });
  });

  test("production changes need the typed phrase, enforced by the platform", async () => {
    const { owner } = await owned();
    const refused = await owner.put("/workspace/agent-policies", {
      switches: { production: true },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toBe(
      "Type ALLOW PRODUCTION AGENT ACTIONS to let the Agent change production environments.",
    );
    const wrong = await owner.put("/workspace/agent-policies", {
      switches: { production: true },
      productionConfirmation: "allow production agent actions",
    });
    expect(wrong.status).toBe(400);
    const allowed = await owner.put("/workspace/agent-policies", {
      switches: { production: true },
      productionConfirmation: PRODUCTION_CONFIRMATION_PHRASE,
    });
    expect(allowed.body.switches.production).toBe(true);
    // Saving other switches later doesn't ask again.
    expect(
      (await owner.put("/workspace/agent-policies", { switches: { "tasks.run": false } })).status,
    ).toBe(200);
    expect(
      (await owner.put("/workspace/agent-policies", { switches: { "launch.rockets": true } }))
        .status,
    ).toBe(400);
  });

  test("members can't read or change them", async () => {
    const { mia } = await owned();
    expect((await mia.get("/workspace/agent-policies")).status).toBe(403);
    expect((await mia.put("/workspace/agent-policies", { switches: {} })).status).toBe(403);
  });
});

describe("model and research keys (spec 04 4.8)", () => {
  test("saving masks the key and records who added it; removing deletes it", async () => {
    const { owner } = await owned();
    const empty = await owner.get("/workspace/keys");
    expect(empty.body.keys).toEqual([
      { kind: "model", status: "not_added", masked: null, addedAt: null, addedBy: null },
      { kind: "research", status: "not_added", masked: null, addedAt: null, addedBy: null },
    ]);
    const saved = await owner.put("/workspace/keys/model", {
      key: "sk-or-v1-0123456789abcdefwxyz",
    });
    expect(saved.status).toBe(200);
    expect(saved.body.key).toMatchObject({
      kind: "model",
      status: "added",
      masked: "sk-…wxyz",
      addedBy: { name: "Olivia Owner" },
    });
    expect(JSON.stringify(saved.body)).not.toContain("0123456789abcdef");
    const value = await readWorkspaceKey(
      h.services,
      saved.body.key && (await owner.get("/workspace")).body.workspace.id,
      "model",
    );
    expect(value).toEqual({ status: "ok", value: "sk-or-v1-0123456789abcdefwxyz" });
    const stored = await h.test.db
      .selectFrom("workspace_secret")
      .select("sealed")
      .executeTakeFirstOrThrow();
    expect(stored.sealed).not.toContain("0123456789abcdef");

    expect((await owner.put("/workspace/keys/model", { key: "short" })).body.error.message).toBe(
      "Paste the whole key.",
    );
    expect((await owner.delete("/workspace/keys/model")).body).toEqual({ removed: true });
    expect((await owner.get("/workspace/keys")).body.keys[0].status).toBe("not_added");
    const audit = await h.test.db
      .selectFrom("audit_event")
      .select(["action", "details"])
      .where("action", "like", "keys.%")
      .orderBy("id")
      .execute();
    expect(audit.map((row) => row.action)).toEqual(["keys.model-saved", "keys.model-removed"]);
    expect(JSON.stringify(audit)).not.toContain("0123456789abcdef");
  });

  test("the research key is checked with Firecrawl, and says what happened", async () => {
    const { owner } = await owned();
    const notFirecrawl = await owner.put("/workspace/keys/research", { key: "sk-something-long" });
    expect(notFirecrawl.body.error.message).toBe(
      "That doesn't look like a Firecrawl API key. Keys start with fc-.",
    );
    expect(h.outside.firecrawlCalls).toBe(0);

    h.outside.firecrawl = 401;
    const rejected = await owner.put("/workspace/keys/research", { key: "fc-rejected-key" });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.message).toStartWith("Firecrawl rejected this key.");
    expect((await owner.get("/workspace/keys")).body.keys[1].status).toBe("not_added");

    h.outside.firecrawl = "down";
    const unreachable = await owner.put("/workspace/keys/research", { key: "fc-unchecked-key" });
    expect(unreachable.body.message).toBe(
      "Saved. Firecrawl couldn't be reached to check it; it is checked again on first use.",
    );

    h.outside.firecrawl = 200;
    const accepted = await owner.put("/workspace/keys/research", { key: "fc-good-key-1234" });
    expect(accepted.body.message).toBe("Saved. Firecrawl accepted the key.");
    expect(accepted.body.key.masked).toBe("fc-…1234");
  });

  test("the research key is checked at the configured research provider's address (punch list 25)", async () => {
    const { owner } = await owned();
    const asked: string[] = [];
    const before = agentSettings(h.services);
    configureAgent(h.services, {
      researchUrl: "https://research.example.test/",
      fetch: async (url, init) => {
        asked.push(url);
        const key = new Headers(init?.headers).get("authorization");
        return new Response("{}", { status: key === "Bearer fc-local-good" ? 200 : 401 });
      },
    });
    try {
      const calls = h.outside.firecrawlCalls;
      const good = await owner.put("/workspace/keys/research", { key: "fc-local-good" });
      expect(good.body.message).toBe("Saved. Firecrawl accepted the key.");
      const bad = await owner.put("/workspace/keys/research", { key: "fc-local-bad" });
      expect(bad.status).toBe(400);
      expect(asked).toEqual([
        "https://research.example.test/v1/team/credit-usage",
        "https://research.example.test/v1/team/credit-usage",
      ]);
      expect(h.outside.firecrawlCalls).toBe(calls);
    } finally {
      configureAgent(h.services, before);
    }
  });

  test("a key saved under another install secret shows Add it again", async () => {
    const { owner } = await owned();
    await owner.put("/workspace/keys/model", { key: "sk-or-v1-0123456789abcdefwxyz" });
    const moved = createServices({
      db: h.test.db,
      log: silentLogger,
      authSecret: "a-different-install-secret-0123456789abcdef",
    });
    const workspaceId = (await owner.get("/workspace")).body.workspace.id;
    expect(await readWorkspaceKey(moved, workspaceId, "model")).toEqual({ status: "unreadable" });
  });

  test("only owners and admins see the workspace's API keys", async () => {
    const { mia } = await owned();
    const reply = await mia.get("/workspace/keys");
    expect(reply.status).toBe(403);
    expect(reply.body.error.message).toStartWith(
      "Only owners and admins can see the workspace's API keys.",
    );
    expect((await mia.put("/workspace/keys/model", { key: "sk-or-v1-123456789" })).status).toBe(
      403,
    );
    expect((await mia.delete("/workspace/keys/model")).status).toBe(403);
  });
});

describe("invitation emails (spec 04 4.7, decision D4)", () => {
  test("the strip says how invitations are sent", async () => {
    const { owner } = await owned();
    expect((await owner.get("/workspace/email")).body).toMatchObject({
      on: true,
      source: "instance",
      detail: "Sent with this server's email settings.",
      canManage: true,
      canAddWithPassword: true,
    });
    h.services.instanceEmail = null;
    expect((await owner.get("/workspace/email")).body).toMatchObject({
      on: false,
      source: "none",
      detail: "New invitations give you a link to send yourself",
    });
  });

  test("saving a Resend key sends a test to the saver; invitations then use it", async () => {
    const { owner } = await owned();
    const noKey = await owner.put("/workspace/email", {
      provider: "resend",
      from: "team@acme.test",
    });
    expect(noKey.body.error.message).toBe("Paste your Resend API key.");
    const badKey = await owner.put("/workspace/email", {
      provider: "resend",
      apiKey: "sk_live_123",
      from: "team@acme.test",
    });
    expect(badKey.body.error.message).toBe(
      "That doesn't look like a Resend API key. Resend keys start with re_.",
    );
    const badSender = await owner.put("/workspace/email", {
      provider: "resend",
      apiKey: "re_workspace_key_9876",
      from: "Team <not an address>",
    });
    expect(badSender.body.error.message).toBe(
      "Enter the sender as team@yourdomain.com or Your Team <team@yourdomain.com>.",
    );

    const saved = await owner.put("/workspace/email", {
      provider: "resend",
      apiKey: "re_workspace_key_9876",
      from: "Acme Team <team@acme.test>",
    });
    expect(saved.status).toBe(200);
    expect(saved.body.message).toBe(
      "Saved. A test email was sent to owner@example.com. Check that it arrived.",
    );
    expect(saved.body.settings).toMatchObject({
      on: true,
      source: "workspace",
      detail: "Sent from Acme Team <team@acme.test> with your Resend key re_…9876.",
    });
    expect(h.outside.lastEmailTo("owner@example.com")).toMatchObject({
      subject: "Nearzero invitation emails are working",
      apiKey: "re_workspace_key_9876",
    });
    // It names the workspace and says invitations come from this address (31a G1-07).
    expect(h.outside.lastEmailTo("owner@example.com")?.text).toContain(
      "are set up. People you invite will get their invitation from this address.",
    );

    await owner.post("/workspace/invitations", { email: "dev@example.com", role: "member" });
    expect(h.outside.lastEmailTo("dev@example.com")).toMatchObject({
      from: "Acme Team <team@acme.test>",
      apiKey: "re_workspace_key_9876",
    });

    // A blank key keeps the saved one.
    const kept = await owner.put("/workspace/email", {
      provider: "resend",
      from: "team@acme.test",
    });
    expect(kept.status).toBe(200);
    expect(h.outside.lastEmailTo("owner@example.com")?.apiKey).toBe("re_workspace_key_9876");
  });

  test("a failing test is reported, the settings still saved", async () => {
    const { owner } = await owned();
    h.outside.resendStatus = 401;
    const reply = await owner.put("/workspace/email", {
      provider: "resend",
      apiKey: "re_bad_key_0000",
      from: "team@acme.test",
    });
    expect(reply.status).toBe(200);
    expect(reply.body.testSent).toBe(false);
    expect(reply.body.message).toBe(
      "Saved, but the test email to owner@example.com failed. Resend rejected the API key. Check it and save it again.",
    );
  });

  test("SMTP works as the alternative to Resend", async () => {
    const { owner } = await owned();
    const missingPassword = await owner.put("/workspace/email", {
      provider: "smtp",
      host: "smtp.acme.test",
      port: 587,
      username: "mailer",
      from: "team@acme.test",
    });
    expect(missingPassword.body.error.message).toBe("Enter the SMTP password.");
    const saved = await owner.put("/workspace/email", {
      provider: "smtp",
      host: "smtp.acme.test",
      port: 587,
      security: "starttls",
      username: "mailer",
      password: "smtp-secret-pw",
      from: "team@acme.test",
    });
    expect(saved.body.testSent).toBe(true);
    expect(saved.body.settings.workspace).toMatchObject({
      provider: "smtp",
      smtp: { host: "smtp.acme.test", port: 587, security: "starttls", username: "mailer" },
    });
    expect(JSON.stringify(saved.body)).not.toContain("smtp-secret-pw");
    expect(h.outside.lastEmailTo("owner@example.com")?.smtp).toEqual({
      host: "smtp.acme.test",
      port: 587,
      security: "starttls",
      username: "mailer",
      password: "smtp-secret-pw",
    });
  });

  test("a saved SMTP password shows nothing of itself, here or in the audit trail (B1-50)", async () => {
    const { owner } = await owned();
    const saved = await owner.put("/workspace/email", {
      provider: "smtp",
      host: "smtp.acme.test",
      port: 587,
      security: "starttls",
      username: "mailer",
      password: "abc1234",
      from: "team@acme.test",
    });
    expect(saved.status).toBe(200);
    const view = (await owner.get("/workspace/email")).body;
    expect(view.workspace.maskedSecret).toBe("Saved");
    expect(view.workspace.savedBy.name).toBe("Olivia Owner");
    const everything = JSON.stringify(view);
    expect(everything).not.toContain("abc");
    expect(everything).not.toContain("1234");
    const audit = await h.test.db
      .selectFrom("audit_event")
      .select("details")
      .where("action", "=", "email-settings.saved")
      .execute();
    expect(JSON.stringify(audit)).not.toContain("1234");
    expect(audit.at(-1)?.details).toEqual({
      provider: "smtp",
      sender: "team@acme.test",
      smtpHost: "smtp.acme.test",
    });

    // Masks stored before 0700 are scrubbed by it, in the table and the audit trail.
    await h.test.db
      .updateTable("workspace_secret")
      .set({ masked: "abc…1234" })
      .where("kind", "=", "email-smtp-password")
      .execute();
    await sql`update audit_event set details = ${JSON.stringify({ provider: "smtp", sender: "team@acme.test", masked: "abc…1234" })}::jsonb where action = 'email-settings.saved'`.execute(
      h.test.db,
    );
    const migration = await Bun.file(
      new URL("../migrations/0700_smtp_password_masks.sql", import.meta.url),
    ).text();
    await sql.raw(migration).execute(h.test.db);
    const stored = await h.test.db.selectFrom("workspace_secret").select("masked").execute();
    expect(stored).toEqual([{ masked: "Saved" }]);
    const scrubbed = await h.test.db
      .selectFrom("audit_event")
      .select("details")
      .where("action", "=", "email-settings.saved")
      .execute();
    expect(JSON.stringify(scrubbed)).not.toContain("1234");
  });

  test("the saved SMTP password never goes to a server it wasn't saved for (B1-51)", async () => {
    const { owner } = await owned();
    const settings = {
      provider: "smtp",
      host: "smtp.acme.test",
      port: 587,
      security: "starttls",
      username: "mailer",
      from: "team@acme.test",
    };
    await owner.put("/workspace/email", { ...settings, password: "smtp-secret-pw" });
    const sent = h.outside.emails.length;
    for (const change of [
      { host: "mail.attacker.test" },
      { port: 25 },
      { security: "none" },
      { username: "someone-else" },
    ]) {
      const refused = await owner.put("/workspace/email", { ...settings, ...change });
      expect(refused.status).toBe(400);
      expect(refused.body.error.fields.password).toBe(
        "Enter the SMTP password again: the saved one is only sent to the server it was saved for.",
      );
    }
    expect(h.outside.emails.length).toBe(sent);
    const view = (await owner.get("/workspace/email")).body;
    expect(view.workspace.smtp.host).toBe("smtp.acme.test");
    // The same server keeps the saved password; a new server with a new password is fine.
    expect((await owner.put("/workspace/email", settings)).status).toBe(200);
    const moved = await owner.put("/workspace/email", {
      ...settings,
      host: "mail.acme.test",
      password: "another-pw",
    });
    expect(moved.status).toBe(200);
    expect(h.outside.lastEmailTo("owner@example.com")?.smtp?.password).toBe("another-pw");
  });

  test("half-made server email settings are shown to those who manage email (30a R1-04)", async () => {
    const { owner } = await owned();
    h.services.instanceEmail = null;
    h.services.instanceEmailProblem =
      "NEARZERO_EMAIL_FROM is not set, so this server's email settings can't be used. Set it to the sender, like Nearzero <team@example.com>.";
    expect((await owner.get("/workspace/email")).body).toMatchObject({
      on: false,
      source: "none",
      serverProblem: h.services.instanceEmailProblem,
    });
  });

  test("an unreadable saved key must be pasted again", async () => {
    const { owner } = await owned();
    await owner.put("/workspace/email", {
      provider: "resend",
      apiKey: "re_workspace_key_9876",
      from: "team@acme.test",
    });
    await h.test.db
      .updateTable("workspace_secret")
      .set({ sealed: "nzs1.otherkey00.aaaa.bbbb" })
      .where("kind", "=", "email-resend-key")
      .execute();
    const view = await owner.get("/workspace/email");
    expect(view.body.workspace.secretReadable).toBe(false);
    const blank = await owner.put("/workspace/email", {
      provider: "resend",
      from: "team@acme.test",
    });
    expect(blank.body.error.message).toBe(
      "The saved key can't be read on this server anymore. Paste it again.",
    );
    const invited = await owner.post("/workspace/invitations", {
      email: "dev@example.com",
      role: "member",
    });
    expect(invited.body.delivery.reason).toBe(
      "Not emailed. The saved key can't be read on this server anymore. Paste it again.",
    );
  });

  test("removing falls back to the server's settings; members can't change any of it", async () => {
    const { owner, mia } = await owned();
    await owner.put("/workspace/email", {
      provider: "resend",
      apiKey: "re_workspace_key_9876",
      from: "team@acme.test",
    });
    const removed = await owner.delete("/workspace/email");
    expect(removed.body.settings.source).toBe("instance");
    expect(await h.test.db.selectFrom("workspace_secret").select("kind").execute()).toEqual([]);

    expect((await mia.get("/workspace/email")).status).toBe(403);
    expect(
      (
        await mia.put("/workspace/email", {
          provider: "resend",
          apiKey: "re_x_123456",
          from: "a@b.co",
        })
      ).status,
    ).toBe(403);
    expect((await mia.delete("/workspace/email")).status).toBe(403);
  });
});
