import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { nodemailerConnector, type SmtpSendOptions, type SmtpSettings } from "../src/email/smtp.ts";
import {
  addMemberThroughInvitation,
  type Browser,
  createHarness,
  type Harness,
  INSTANCE_RESEND,
  personIdOf,
  setUpNamedOwner,
} from "./support/harness.ts";

/**
 * C1-05 (B1-20 by a second route, spec 23.9): a workspace's own SMTP server is never this
 * machine, a private network or a cloud's metadata address unless an instance administrator saves
 * it. Refused before anything is saved or connected to; checked again at every send and connected
 * to the very address checked; and a server someone typed never has its words (a banner) quoted.
 */

setDefaultTimeout(120_000);

let harness: Harness;
let owner: Browser;
let banner: Server;
let port = 0;
let connections = 0;
/** Where the real SMTP client was pointed, and with what. */
const sends: { settings: SmtpSettings; options: SmtpSendOptions | undefined }[] = [];

beforeAll(async () => {
  // An internal service on loopback that greets with a banner, as sshd or redis would.
  banner = createServer((socket) => {
    connections++;
    socket.write("SSH-2.0-OpenSSH_9.6 internal-secret-banner\r\n");
    setTimeout(() => socket.end(), 300);
  });
  await new Promise<void>((resolve) => banner.listen(0, "127.0.0.1", () => resolve()));
  port = (banner.address() as { port: number }).port;
  harness = await createHarness({
    instanceEmail: INSTANCE_RESEND,
    extra: {
      smtp: async (settings, mail, options) => {
        sends.push({ settings, options });
        // Only loopback is really connected to; public test names stop here.
        if ((options?.connectTo ?? settings.host) !== "127.0.0.1")
          return { sent: false, reason: "not sent in this test" };
        return nodemailerConnector(settings, mail, options);
      },
    },
  });
  owner = await setUpNamedOwner(harness);
});

afterAll(async () => {
  banner?.close();
  await harness?.drop();
});

/** A member who isn't an instance administrator, acting from her own personal workspace. */
async function mallory(): Promise<Browser> {
  const email = `mallory-${Date.now()}@example.com`;
  const member = await addMemberThroughInvitation(harness, owner, email);
  const person = await personIdOf(harness, email);
  const personal = await harness.test.db
    .selectFrom("membership as m")
    .innerJoin("workspace as w", "w.id", "m.workspace_id")
    .select("w.id")
    .where("m.person_id", "=", person)
    .where("w.is_personal", "=", true)
    .executeTakeFirstOrThrow();
  const switched = await member.post(`/workspaces/${personal.id}/switch`);
  if (switched.status !== 200) throw new Error(JSON.stringify(switched.body));
  return member;
}

const smtp = (host: string, smtpPort = port) => ({
  provider: "smtp",
  host,
  port: smtpPort,
  security: "none",
  username: "",
  from: "team@b.example",
});

describe("a workspace's SMTP server (C1-05)", () => {
  test("a member is refused loopback, metadata and internal names, before any connection", async () => {
    const member = await mallory();
    harness.outside.dns.set("nearzero1-postgres", ["172.18.0.5"]);
    harness.outside.dns.set("rebind.example.net", ["34.120.0.10", "10.0.0.7"]);
    const before = connections;
    for (const [host, target] of [
      ["127.0.0.1", port],
      ["169.254.169.254", 80],
      ["nearzero1-postgres", 5432],
      ["rebind.example.net", 25],
      ["::1", 25],
    ] as const) {
      const saved = await member.put("/workspace/email", smtp(host, target));
      expect(saved.status).toBe(400);
      expect(saved.body.error.fields.host).toBe(
        `${host} is a private or internal address. A workspace's email goes only to a public mail server, unless a Nearzero administrator saves it.`,
      );
      expect(JSON.stringify(saved.body)).not.toContain("internal-secret-banner");
    }
    expect(connections).toBe(before);
    const view = (await member.get("/workspace/email")).body;
    expect(view.workspace).toBeNull();
  });

  test("a public server is saved, and a name that later points inside is refused at send", async () => {
    const member = await mallory();
    harness.outside.dns.set("smtp.mallory.test", ["34.120.0.20"]);
    const saved = await member.put("/workspace/email", smtp("smtp.mallory.test", 587));
    expect(saved.status).toBe(200);
    // Connected to the address that was checked, the name kept for TLS.
    expect(sends.at(-1)?.options).toEqual({ connectTo: "34.120.0.20", quoteReplies: false });
    // The name now points at loopback (rebinding): the next send never connects there.
    harness.outside.dns.set("smtp.mallory.test", ["127.0.0.1"]);
    const count = sends.length;
    const before = connections;
    const invited = await member.post("/workspace/invitations", {
      email: `bob-${Date.now()}@example.com`,
      role: "member",
    });
    expect(invited.status).toBeLessThan(500);
    expect(sends.length).toBe(count);
    expect(connections).toBe(before);
  });

  test("an instance administrator may save an internal server, whose replies are quoted", async () => {
    const saved = await owner.put("/workspace/email", smtp("127.0.0.1"));
    expect(saved.status).toBe(200);
    expect(saved.body.testSent).toBe(false);
    expect(sends.at(-1)?.options).toEqual({ connectTo: "127.0.0.1", quoteReplies: true });
    const row = await harness.test.db
      .selectFrom("workspace_email")
      .select("internal_allowed")
      .where("smtp_host", "=", "127.0.0.1")
      .executeTakeFirstOrThrow();
    expect(row.internal_allowed).toBe(true);
  });

  test("a server someone typed never has its own words in the reason", async () => {
    const settings: SmtpSettings = {
      host: "127.0.0.1",
      port,
      security: "none",
      username: "",
      password: "",
    };
    const mail = { to: "a@example.com", from: "b@example.com", subject: "s", text: "t", html: "t" };
    const typed = await nodemailerConnector(settings, mail, { quoteReplies: false });
    expect(typed.sent).toBe(false);
    expect(JSON.stringify(typed)).not.toContain("internal-secret-banner");
    expect(JSON.stringify(typed)).not.toContain("OpenSSH");
  });
});
