import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { resolve } from "node:path";
import { runCommand } from "../src/cli/commands.ts";
import { totpCode, totpStep } from "../src/security/totp.ts";
import { TEST_DATABASE_URL } from "./support/database.ts";
import {
  addMemberThroughInvitation,
  CONSOLE_URL,
  createHarness,
  fakeIo,
  type Harness,
  INSTANCE_RESEND,
  setUpNamedOwner as namedOwner,
  PASSWORD,
  setUpOwner,
  TEST_SECRET,
} from "./support/harness.ts";

// Throwaway databases can take seconds to create and migrate on a busy machine.
setDefaultTimeout(120_000);

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.drop();
});

beforeEach(async () => {
  await h.reset();
  h.services.instanceEmail = null;
});

/** An owner with a named workspace, with email on so members can join from their links. */
async function setUpNamedOwner(harness: Harness) {
  harness.services.instanceEmail = INSTANCE_RESEND;
  return namedOwner(harness);
}

describe("create-owner (spec 03 3.4)", () => {
  test("reads email and password as two lines without a terminal", async () => {
    const io = fakeIo(["Owner@Example.com", PASSWORD]);
    expect(await runCommand(["create-owner"], h.services, io)).toBe(0);
    expect(io.output).toEqual([
      `Admin account created. Sign in at ${CONSOLE_URL} as owner@example.com`,
    ]);
    expect(io.errors).toEqual([]);
    expect(JSON.stringify(io.output)).not.toContain(PASSWORD);

    const person = await h.test.db
      .selectFrom("person")
      .select(["first_name", "onboarding_step", "email_verified_at"])
      .executeTakeFirstOrThrow();
    // No name, so the first sign-in runs onboarding.
    expect(person.first_name).toBeNull();
    expect(person.onboarding_step).toBe("workspace");
    expect(person.email_verified_at).not.toBeNull();

    const first = await h.test.db
      .selectFrom("install_state as s")
      .innerJoin("workspace as w", "w.id", "s.first_workspace_id")
      .select(["w.name", "w.is_personal"])
      .executeTakeFirstOrThrow();
    expect(first).toEqual({ name: "My Workspace", is_personal: true });
  });

  test("refuses when an owner exists", async () => {
    await runCommand(["create-owner"], h.services, fakeIo(["owner@example.com", PASSWORD]));
    const io = fakeIo(["other@example.com", PASSWORD]);
    expect(await runCommand(["create-owner"], h.services, io)).toBe(1);
    expect(io.errors).toEqual([
      "This server already has an owner: owner@example.com",
      "Forgot the password? Run: sudo nearzero reset-password",
    ]);
  });

  test("checks the email and the password", async () => {
    const badEmail = fakeIo(["not-an-email", PASSWORD]);
    expect(await runCommand(["create-owner"], h.services, badEmail)).toBe(1);
    expect(badEmail.errors).toEqual(["Enter a valid email address, like you@company.com."]);
    const shortPassword = fakeIo(["owner@example.com", "short"]);
    expect(await runCommand(["create-owner"], h.services, shortPassword)).toBe(1);
    expect(shortPassword.errors).toEqual(["Use 8 to 128 characters."]);
  });

  test("asks again on a terminal until the answers are good", async () => {
    const io = fakeIo(
      ["nope", "owner@example.com", "short", "long enough 1", "different 2", PASSWORD, PASSWORD],
      true,
    );
    expect(await runCommand(["create-owner"], h.services, io)).toBe(0);
    expect(io.errors).toEqual([
      "Enter a valid email address, like you@company.com.",
      "Use 8 to 128 characters.",
      "The passwords don't match. Try again.",
    ]);
  });

  test("the owner can sign in and is an instance administrator", async () => {
    const owner = await setUpOwner(h);
    const me = await owner.get("/me");
    expect(me.body.isInstanceAdmin).toBe(true);
    expect(me.body.onboarding.step).toBe("workspace");
  });
});

describe("answers for scripts: --json (spec 03 3.1, 3.4)", () => {
  test("owner-status says whether the admin account exists, without asking anything", async () => {
    const before = fakeIo([]);
    expect(await runCommand(["owner-status", "--json"], h.services, before)).toBe(0);
    expect(before.output).toEqual(['{"owner":"missing"}']);
    expect(before.errors).toEqual([
      "This server has no owner yet. Run: sudo nearzero create-owner",
    ]);
    await runCommand(["create-owner"], h.services, fakeIo(["owner@example.com", PASSWORD]));
    const after = fakeIo([]);
    expect(await runCommand(["owner-status", "--json"], h.services, after)).toBe(0);
    expect(JSON.parse(after.output[0] as string)).toEqual({
      owner: "exists",
      email: "owner@example.com",
    });
    // For people it is a sentence.
    const human = fakeIo([]);
    expect(await runCommand(["owner-status"], h.services, human)).toBe(0);
    expect(human.output).toEqual(["The admin account is owner@example.com."]);
  });

  test("create-owner --json: one JSON line on standard output, an exit code per outcome", async () => {
    const empty = fakeIo([]);
    expect(await runCommand(["create-owner", "--json"], h.services, empty)).toBe(2);
    expect(empty.output).toEqual(['{"result":"no_input"}']);
    const badEmail = fakeIo(["not-an-email", PASSWORD]);
    expect(await runCommand(["create-owner", "--json"], h.services, badEmail)).toBe(2);
    expect(JSON.parse(badEmail.output[0] as string)).toEqual({
      result: "invalid_input",
      field: "email",
    });
    const short = fakeIo(["owner@example.com", "short"]);
    expect(await runCommand(["create-owner", "--json"], h.services, short)).toBe(2);
    expect(JSON.parse(short.output[0] as string)).toEqual({
      result: "invalid_input",
      field: "password",
    });

    const created = fakeIo(["Owner@Example.com", PASSWORD]);
    expect(await runCommand(["create-owner", "--json"], h.services, created)).toBe(0);
    expect(created.output).toEqual(['{"result":"created","email":"owner@example.com"}']);
    // The sentence for people goes to standard error, and the password nowhere.
    expect(created.errors).toEqual([
      `Admin account created. Sign in at ${CONSOLE_URL} as owner@example.com`,
    ]);
    expect(JSON.stringify([created.output, created.errors])).not.toContain(PASSWORD);

    const again = fakeIo([]);
    expect(await runCommand(["create-owner", "--json"], h.services, again)).toBe(3);
    expect(JSON.parse(again.output[0] as string)).toEqual({
      result: "owner_exists",
      email: "owner@example.com",
    });
    expect(again.errors[0]).toBe("This server already has an owner: owner@example.com");
    // Without --json the exit code stays 1 for every refusal.
    expect(await runCommand(["create-owner"], h.services, fakeIo([]))).toBe(1);
  });
});

describe("reset-password (spec 03 3.4)", () => {
  test("sets a new password for the owner by default and signs out its sessions", async () => {
    const owner = await setUpOwner(h);
    // Without an email argument the first line names the account; empty means the owner (G1-01).
    const io = fakeIo(["", "a new password 1"]);
    expect(await runCommand(["reset-password"], h.services, io)).toBe(0);
    expect(io.output).toEqual([
      "Password updated for owner@example.com. Its other sessions were signed out.",
    ]);
    expect((await owner.get("/me")).status).toBe(401);
    expect((await h.browser().signIn("owner@example.com", PASSWORD)).status).toBe(401);
    expect((await h.browser().signIn("owner@example.com", "a new password 1")).status).toBe(200);
  });

  test("lifts a sign-in lockout", async () => {
    await setUpOwner(h);
    const browser = h.browser();
    for (let i = 0; i < 10; i++) await browser.signIn("owner@example.com", "wrong guess!");
    expect((await browser.signIn("owner@example.com")).status).toBe(429);
    await runCommand(["reset-password", "owner@example.com"], h.services, fakeIo([PASSWORD]));
    expect((await browser.signIn("owner@example.com")).status).toBe(200);
  });

  test("names an unknown account and a bad password", async () => {
    await setUpOwner(h);
    const unknown = fakeIo(["whatever 123"]);
    expect(await runCommand(["reset-password", "ghost@example.com"], h.services, unknown)).toBe(1);
    expect(unknown.errors).toEqual(["No account exists for ghost@example.com."]);
    const short = fakeIo(["", "short"]);
    expect(await runCommand(["reset-password"], h.services, short)).toBe(1);
    expect(short.errors).toEqual(["Use a password between 8 and 128 characters."]);
    const ghost = fakeIo(["ghost@example.com", "whatever 123"]);
    expect(await runCommand(["reset-password"], h.services, ghost)).toBe(1);
    expect(ghost.errors).toEqual(["No account exists for ghost@example.com."]);
  });

  test("G1-01: 0.1.x's two lines (email, then password) reset that account, not the owner's", async () => {
    const owner = await setUpNamedOwner(h);
    const bob = await addMemberThroughInvitation(h, owner, "bob@example.com");
    // printf 'bob@example.com\nNewPass123\n' | sudo nearzero reset-password
    const io = fakeIo(["bob@example.com", "NewPass123"]);
    expect(await runCommand(["reset-password"], h.services, io)).toBe(0);
    expect(io.output).toEqual([
      "Password updated for bob@example.com. Its other sessions were signed out.",
    ]);
    expect((await bob.get("/me")).status).toBe(401);
    expect((await h.browser().signIn("bob@example.com", "NewPass123")).status).toBe(200);
    // The owner's password and sessions are untouched.
    expect((await owner.get("/me")).status).toBe(200);
    expect((await h.browser().signIn("owner@example.com", PASSWORD)).status).toBe(200);
    expect((await h.browser().signIn("owner@example.com", "bob@example.com")).status).toBe(401);
  });

  test("G1-01: an empty first line means the owner; an email argument still takes one line", async () => {
    const owner = await setUpNamedOwner(h);
    const bob = await addMemberThroughInvitation(h, owner, "bob@example.com");
    // printf '\nNewPass123\n' | sudo nearzero reset-password
    expect(await runCommand(["reset-password"], h.services, fakeIo(["", "NewPass123"]))).toBe(0);
    expect((await h.browser().signIn("owner@example.com", "NewPass123")).status).toBe(200);
    expect((await bob.get("/me")).status).toBe(200);
    // printf 'NewPass456\n' | sudo nearzero reset-password bob@example.com
    const one = fakeIo(["NewPass456"]);
    expect(await runCommand(["reset-password", "bob@example.com"], h.services, one)).toBe(0);
    expect((await h.browser().signIn("bob@example.com", "NewPass456")).status).toBe(200);
    expect((await h.browser().signIn("owner@example.com", "NewPass123")).status).toBe(200);
  });

  test("G1-01: on a terminal it asks which account first, offering the owner, and names it", async () => {
    const owner = await setUpNamedOwner(h);
    await addMemberThroughInvitation(h, owner, "bob@example.com");
    const prompts: string[] = [];
    const answers = ["bob@example.com", "NewPass123", "NewPass123"];
    const io = {
      ...fakeIo([], true),
      readLine: async (prompt: string) => {
        prompts.push(prompt);
        return answers.shift() ?? null;
      },
      readSecret: async (prompt: string) => {
        prompts.push(prompt);
        return answers.shift() ?? null;
      },
    };
    expect(await runCommand(["reset-password"], h.services, io)).toBe(0);
    expect(prompts).toEqual([
      "Email [owner@example.com]: ",
      "New password for bob@example.com (8+ characters): ",
      "Confirm password: ",
    ]);
    expect((await h.browser().signIn("bob@example.com", "NewPass123")).status).toBe(200);
  });
});

describe("set-email (31a G1-02)", () => {
  test("gives an account a new confirmed address, ends its sessions and is audited", async () => {
    const owner = await setUpNamedOwner(h);
    const bob = await addMemberThroughInvitation(h, owner, "bob@exmaple.com");
    const io = fakeIo([]);
    expect(
      await runCommand(["set-email", "bob@exmaple.com", "Bob@Example.com"], h.services, io),
    ).toBe(0);
    expect(io.output).toEqual([
      "Email changed from bob@exmaple.com to bob@example.com. It counts as confirmed, and the account's sessions were signed out.",
    ]);
    expect((await bob.get("/me")).status).toBe(401);
    const again = h.browser();
    expect((await again.signIn("bob@example.com")).status).toBe(200);
    expect((await again.get("/me")).body).toMatchObject({
      email: "bob@example.com",
      emailVerified: true,
    });
    const audit = await h.test.db
      .selectFrom("audit_event")
      .select(["action", "actor_kind", "details"])
      .where("action", "=", "person.email-set")
      .executeTakeFirstOrThrow();
    expect(audit.actor_kind).toBe("command");
    expect(audit.details).toMatchObject({ from: "bob@exmaple.com", to: "bob@example.com" });
    expect((await owner.get("/me")).status).toBe(200);
  });

  test("refuses an address in use, an unknown account and a bad address; confirms an own address", async () => {
    const owner = await setUpNamedOwner(h);
    await addMemberThroughInvitation(h, owner, "bob@example.com");
    const taken = fakeIo([]);
    expect(
      await runCommand(["set-email", "bob@example.com", "owner@example.com"], h.services, taken),
    ).toBe(1);
    expect(taken.errors).toEqual([
      "Another account already uses this email address. Use a different one.",
    ]);
    const ghost = fakeIo([]);
    expect(
      await runCommand(["set-email", "ghost@x.example", "a@b.example"], h.services, ghost),
    ).toBe(1);
    expect(ghost.errors).toEqual(["No account exists for ghost@x.example."]);
    const bad = fakeIo([]);
    expect(
      await runCommand(["set-email", "bob@example.com", "not-an-email"], h.services, bad),
    ).toBe(1);
    expect(bad.errors).toEqual(["Enter a valid email address, like you@company.com."]);
    const usage = fakeIo([]);
    expect(await runCommand(["set-email", "bob@example.com"], h.services, usage)).toBe(1);
    expect(usage.errors).toEqual(["Usage: sudo nearzero set-email <current email> <new email>"]);
    // An unconfirmed address given again is confirmed, and its sessions stay.
    await h.test.db
      .updateTable("person")
      .set({ email_verified_at: null })
      .where("email", "=", "bob@example.com")
      .execute();
    const confirm = fakeIo([]);
    expect(
      await runCommand(["set-email", "bob@example.com", "bob@example.com"], h.services, confirm),
    ).toBe(0);
    expect(confirm.output).toEqual(["bob@example.com is confirmed."]);
    const confirmedAgain = fakeIo([]);
    await runCommand(
      ["set-email", "bob@example.com", "bob@example.com"],
      h.services,
      confirmedAgain,
    );
    expect(confirmedAgain.output).toEqual([
      "bob@example.com is already this account's confirmed address.",
    ]);
  });
});

describe("reset-2fa (spec 03 3.4)", () => {
  test("turns two-factor off after confirmation", async () => {
    const owner = await setUpOwner(h);
    const setup = await owner.post("/me/two-factor/setup", { password: PASSWORD });
    await owner.post("/me/two-factor/enable", {
      code: totpCode(setup.body.secret, totpStep(Date.now())),
    });

    const noTerminal = fakeIo([]);
    expect(await runCommand(["reset-2fa"], h.services, noTerminal)).toBe(1);
    expect(noTerminal.errors[0]).toContain("No terminal to confirm on, so nothing was changed.");

    const declined = fakeIo(["n"], true);
    expect(await runCommand(["reset-2fa"], h.services, declined)).toBe(1);
    expect(declined.output).toEqual(["Nothing was changed."]);

    const confirmed = fakeIo(["y"], true);
    expect(await runCommand(["reset-2fa", "owner@example.com"], h.services, confirmed)).toBe(0);
    expect(confirmed.output[0]).toStartWith("Two-factor sign-in is off for owner@example.com.");
    expect((await h.browser().signIn("owner@example.com")).body.status).toBe("signed_in");

    const already = fakeIo([]);
    expect(await runCommand(["reset-2fa", "--yes"], h.services, already)).toBe(0);
    expect(already.output).toEqual(["Two-factor sign-in is already off for owner@example.com."]);
  });
});

describe("the command entry point", () => {
  test("an unknown command prints usage and exits 1", async () => {
    const io = fakeIo([]);
    expect(await runCommand(["frobnicate"], h.services, io)).toBe(1);
    expect(io.errors[0]).toBe("Unknown command: frobnicate");
  });

  test("runs as a process, reading answers from standard input", async () => {
    const url = new URL(TEST_DATABASE_URL);
    url.pathname = `/${(await h.test.db.selectNoFrom((eb) => eb.fn<string>("current_database", []).as("name")).executeTakeFirstOrThrow()).name}`;
    const child = Bun.spawn(
      ["bun", resolve(import.meta.dir, "..", "src", "cli.ts"), "create-owner"],
      {
        env: {
          PATH: process.env.PATH ?? "",
          DATABASE_URL: url.toString(),
          NEARZERO_AUTH_SECRET: TEST_SECRET,
          NEARZERO_CONSOLE_URL: "https://nearzero.example.com",
        },
        stdin: new TextEncoder().encode(`cli@example.com\n${PASSWORD}\n`),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(out).toBe(
      "Admin account created. Sign in at https://nearzero.example.com as cli@example.com\n",
    );
  }, 30_000);

  test("with --json and no database, scripts still get an answer", async () => {
    const child = Bun.spawn(
      ["bun", resolve(import.meta.dir, "..", "src", "cli.ts"), "owner-status", "--json"],
      {
        env: {
          PATH: process.env.PATH ?? "",
          DATABASE_URL: "postgres://nobody:nothing@127.0.0.1:9/none",
          NEARZERO_AUTH_SECRET: TEST_SECRET,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(1);
    expect(out).toBe('{"result":"database_unavailable"}\n');
    expect(err).toContain("Nearzero can't prepare its database");
  }, 30_000);
});

describe("audit (spec 22.4 rule 8, 30d R4-16)", () => {
  test("prints the audit record as JSON lines, oldest first, in a date range, redacted", async () => {
    await setUpOwner(h);
    const db = h.test.db;
    await db.deleteFrom("audit_event").execute();
    await db
      .insertInto("audit_event")
      .values([
        {
          occurred_at: new Date("2026-10-30T08:00:00Z"),
          actor_kind: "person",
          actor_label: "owner@example.com",
          action: "auth.sign-in",
          details: JSON.stringify({}),
        },
        {
          occurred_at: new Date("2026-11-02T09:30:00Z"),
          actor_kind: "agent",
          actor_label: "owner@example.com",
          action: "agent.delete-project",
          target_kind: "project",
          target_id: "p1",
          // Stored before a redaction rule existed: still never printed.
          details: JSON.stringify({
            project: "shop",
            apiToken: "tok3n-value",
            nested: { password: "x" },
          }),
        },
        {
          occurred_at: new Date("2026-11-05T23:59:00Z"),
          actor_kind: "command",
          actor_label: "nearzero reset-2fa",
          action: "command.reset-two-factor",
          details: JSON.stringify({}),
        },
      ])
      .execute();
    const io = fakeIo([]);
    expect(
      await runCommand(["audit", "--since", "2026-11-01", "--until=2026-11-05"], h.services, io),
    ).toBe(0);
    const lines = io.output.map((line) => JSON.parse(line));
    expect(lines.map((line) => line.action)).toEqual([
      "agent.delete-project",
      "command.reset-two-factor",
    ]);
    expect(lines[0]).toMatchObject({
      at: "2026-11-02T09:30:00.000Z",
      actor: { kind: "agent", label: "owner@example.com" },
      target: { kind: "project", id: "p1" },
      details: { project: "shop", apiToken: "[redacted]", nested: { password: "[redacted]" } },
    });
    expect(io.output.join("\n")).not.toContain("tok3n");

    const all = fakeIo([]);
    expect(await runCommand(["audit"], h.services, all)).toBe(0);
    expect(all.output).toHaveLength(3);

    const bad = fakeIo([]);
    expect(await runCommand(["audit", "--since", "yesterday"], h.services, bad)).toBe(2);
    expect(bad.errors[0]).toBe(
      "--since must be a date like 2026-11-01 or a time like 2026-11-01T09:30:00Z.",
    );
    const none = fakeIo([]);
    expect(await runCommand(["audit", "--since", "2027-01-01"], h.services, none)).toBe(0);
    expect(none.errors).toEqual(["No audit events in that range."]);
  });
});
