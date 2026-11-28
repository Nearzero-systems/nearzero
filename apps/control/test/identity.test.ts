import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { SESSION_COOKIE } from "@nearzero/shared";
import { sql } from "kysely";
import { createApp } from "../src/app.ts";
import { silentLogger } from "../src/log.ts";
import { PasswordHasher } from "../src/security/passwords.ts";
import { totpCode, totpStep } from "../src/security/totp.ts";
import { createServices } from "../src/services.ts";
import {
  type Browser,
  createHarness,
  type Harness,
  INSTANCE_RESEND,
  PASSWORD,
  personIdOf,
  setUpOwner,
  TEST_SECRET,
} from "./support/harness.ts";

// Throwaway databases can take seconds to create and migrate on a busy machine.
setDefaultTimeout(120_000);

let h: Harness;
const clock = { now: Date.UTC(2026, 10, 25, 12, 0, 0) };

beforeAll(async () => {
  h = await createHarness({ instanceEmail: INSTANCE_RESEND, extra: { now: () => clock.now } });
});

afterAll(async () => {
  await h.drop();
});

beforeEach(async () => {
  await h.reset();
  clock.now += 10 * 60_000;
});

const OWNER = "owner@example.com";

function cookieLine(setCookies: string[], name: string): string {
  const line = setCookies.find((item) => item.startsWith(`${name}=`));
  if (!line) throw new Error(`no ${name} cookie was set`);
  return line;
}

describe("session info and the sign-in page", () => {
  test("says whether the install has an owner yet, without anyone signed in", async () => {
    const browser = h.browser();
    expect((await browser.get("/auth/session")).body).toEqual({
      signedIn: false,
      setup: { hasOwner: false },
    });
    await setUpOwner(h);
    expect((await browser.get("/auth/session")).body).toEqual({
      signedIn: false,
      setup: { hasOwner: true },
    });
  });

  test("a signed-in session reports the person, the workspace and the next step", async () => {
    const owner = await setUpOwner(h);
    const reply = await owner.get("/auth/session");
    expect(reply.status).toBe(200);
    expect(reply.body.signedIn).toBe(true);
    expect(reply.body.person.email).toBe(OWNER);
    expect(reply.body.person.hasRealName).toBe(false);
    expect(reply.body.person.isInstanceAdmin).toBe(true);
    expect(reply.body.workspace.name).toBe("My Workspace");
    expect(reply.body.next).toEqual({ kind: "onboarding", step: "workspace" });
  });
});

describe("signing in (spec 04 4.1)", () => {
  test("validates the form with the page's words", async () => {
    const browser = h.browser();
    const empty = await browser.post("/auth/sign-in", { email: "", password: "" });
    expect(empty.status).toBe(400);
    expect(empty.body.error.fields).toEqual({
      email: "Enter your email address.",
      password: "Enter your password.",
    });
    const bad = await browser.post("/auth/sign-in", { email: "nope", password: "short" });
    expect(bad.body.error.fields).toEqual({
      email: "Use a valid email address.",
      password: "Password must be at least 8 characters.",
    });
  });

  test("refuses anything but JSON", async () => {
    const reply = await h.browser().request("POST", "/auth/sign-in", undefined, {
      "content-type": "application/x-www-form-urlencoded",
    });
    expect(reply.status).toBe(400);
  });

  test("sets an HttpOnly, SameSite=Lax session cookie, Secure only over HTTPS", async () => {
    await setUpOwner(h);
    const plain = await h.browser().signIn(OWNER);
    expect(plain.status).toBe(200);
    expect(plain.body.status).toBe("signed_in");
    const line = cookieLine(plain.setCookies, SESSION_COOKIE);
    expect(line).toContain("HttpOnly");
    expect(line).toContain("SameSite=Lax");
    expect(line).toContain("Path=/");
    expect(line).toContain(`Max-Age=${7 * 24 * 60 * 60}`);
    expect(line).not.toContain("Secure");

    const https = await h
      .browser({ headers: { "x-forwarded-proto": "https", "x-forwarded-for": "198.51.100.7" } })
      .signIn(OWNER);
    expect(cookieLine(https.setCookies, SESSION_COOKIE)).toContain("Secure");

    // A client talking to the API directly can't claim HTTPS (or an address) with headers.
    const spoofed = await h
      .browser({ peer: "203.0.113.50", headers: { "x-forwarded-proto": "https" } })
      .signIn(OWNER);
    expect(cookieLine(spoofed.setCookies, SESSION_COOKIE)).not.toContain("Secure");
  });

  test("the session token is stored only as a hash", async () => {
    await setUpOwner(h);
    const browser = h.browser();
    await browser.signIn(OWNER);
    const token = browser.cookies.get(SESSION_COOKIE) ?? "";
    expect(token.length).toBeGreaterThan(30);
    const rows = await sql<{ found: number }>`
      select count(*)::int as found from person_session where encode(token_hash, 'escape') like ${`%${token}%`}
    `.execute(h.test.db);
    expect(rows.rows[0]?.found).toBe(0);
  });

  test("a wrong password and an unknown email get the same answer", async () => {
    await setUpOwner(h);
    const wrong = await h.browser().signIn(OWNER, "wrong password!");
    const unknown = await h.browser().signIn("nobody@example.com", "wrong password!");
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    const strip = (body: { error: { reference?: string } }) => ({ ...body.error, reference: "" });
    expect(strip(wrong.body)).toEqual(strip(unknown.body));
    expect(wrong.body.error.message).toBe("Invalid email or password.");
    expect(wrong.setCookies).toEqual([]);
    expect(unknown.setCookies).toEqual([]);
  });

  test("a wrong password and an unknown email take the same time, within noise", async () => {
    // Heavier hashing than the other tests, so the hash dominates like it does in production.
    const heavy = { memoryCost: 16_384, timeCost: 2 };
    const services = createServices({
      db: h.test.db,
      log: silentLogger,
      authSecret: TEST_SECRET,
      passwordHashing: heavy,
    });
    const app = createApp({ db: h.test.db, log: silentLogger, services });
    await setUpOwner(h);
    await h.test.db
      .updateTable("person")
      .set({ password_hash: await new PasswordHasher(heavy).hash(PASSWORD) })
      .where("email", "=", OWNER)
      .execute();
    const time = async (email: string, n: number) => {
      const started = performance.now();
      const reply = await h
        .browser({ headers: { "x-forwarded-for": `192.0.2.${n}` } })
        .use(app)
        .signIn(email, "wrong password!");
      expect(reply.status).toBe(401);
      return performance.now() - started;
    };
    await time("warm-up@example.com", 1);
    const known: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i < 6; i++) {
      known.push(await time(OWNER, 10 + i));
      unknown.push(await time(`ghost${i}@example.com`, 30 + i));
    }
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1] ?? 0;
    const ratio = median(known) / median(unknown);
    expect(ratio).toBeGreaterThan(0.6);
    expect(ratio).toBeLessThan(1.6);
  });

  test("the 11th failure in 15 minutes is refused, even after a restart and with the right password", async () => {
    await setUpOwner(h);
    const browser = h.browser({ headers: { "x-forwarded-for": "198.51.100.20" } });
    for (let i = 0; i < 10; i++) {
      expect((await browser.signIn(OWNER, "wrong password!")).status).toBe(401);
    }
    const restarted = browser.use(h.restart());
    const refused = await restarted.signIn(OWNER, PASSWORD);
    expect(refused.status).toBe(429);
    expect(refused.body.error.message).toBe(
      "Too many failed sign-in attempts. Wait a few minutes and try again.",
    );
    // Unknown emails are limited the same way.
    for (let i = 0; i < 10; i++) await browser.signIn("ghost@example.com", "wrong password!");
    expect((await browser.signIn("ghost@example.com", "wrong password!")).status).toBe(429);
  });

  test("wrong passwords sent all at once still stop at the limit (B1-24)", async () => {
    await setUpOwner(h);
    const browser = h.browser({ headers: { "x-forwarded-for": "198.51.100.21" } });
    const replies = await Promise.all(
      Array.from({ length: 20 }, () => browser.signIn(OWNER, "wrong password!")),
    );
    const checked = replies.filter((reply) => reply.status === 401).length;
    const limited = replies.filter((reply) => reply.status === 429).length;
    expect(checked).toBe(10);
    expect(limited).toBe(10);
    expect((await browser.signIn(OWNER, PASSWORD)).status).toBe(429);

    // The 50-per-email backstop holds the same way across many addresses.
    await h.test.db.deleteFrom("attempt_record").execute();
    const spread = await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        h
          .browser({ headers: { "x-forwarded-for": `198.51.100.${100 + (i % 30)}` } })
          .signIn(OWNER, "wrong password!"),
      ),
    );
    expect(spread.filter((reply) => reply.status === 401).length).toBe(50);
    // A right password in between is not counted as a failure.
    await h.test.db.deleteFrom("attempt_record").execute();
    const mixed = await Promise.all([
      ...Array.from({ length: 9 }, () => browser.signIn(OWNER, "wrong password!")),
      browser.signIn(OWNER, PASSWORD),
    ]);
    expect(mixed.some((reply) => reply.status === 429)).toBe(false);
  });

  test("clients behind different addresses are limited separately, by the real address", async () => {
    await setUpOwner(h);
    const attacker = h.browser({ headers: { "x-forwarded-for": "198.51.100.30" } });
    for (let i = 0; i < 10; i++) await attacker.signIn(OWNER, "wrong password!");
    expect((await attacker.signIn(OWNER, PASSWORD)).status).toBe(429);
    const person = h.browser({ headers: { "x-forwarded-for": "198.51.100.31" } });
    expect((await person.signIn(OWNER, PASSWORD)).status).toBe(200);

    // Straight to the API, X-Forwarded-For is ignored: the peer's own address is limited.
    const direct = h.browser({ peer: "203.0.113.60", headers: { "x-forwarded-for": "1.2.3.4" } });
    for (let i = 0; i < 10; i++) await direct.signIn(OWNER, "wrong password!");
    const rotated = h.browser({ peer: "203.0.113.60", headers: { "x-forwarded-for": "5.6.7.8" } });
    expect((await rotated.signIn(OWNER, PASSWORD)).status).toBe(429);
  });

  test("records sign-ins and failures in the audit log with the client address", async () => {
    await setUpOwner(h);
    await h.browser({ headers: { "x-forwarded-for": "198.51.100.40" } }).signIn(OWNER, "nope nope");
    const events = await h.test.db
      .selectFrom("audit_event")
      .select(["action", "client_address", "actor_label"])
      .where("action", "like", "auth.%")
      .orderBy("id")
      .execute();
    expect(events).toContainEqual({
      action: "auth.sign-in-failed",
      client_address: "198.51.100.40",
      actor_label: OWNER,
    });
    expect(events.some((event) => event.action === "auth.sign-in")).toBe(true);
  });
});

describe("sessions (spec 04 4.1)", () => {
  test("signing out ends the session", async () => {
    const owner = await setUpOwner(h);
    expect((await owner.get("/me")).status).toBe(200);
    const token = owner.cookies.get(SESSION_COOKIE);
    expect((await owner.post("/auth/sign-out")).body).toEqual({ signedOut: true });
    expect(owner.cookies.has(SESSION_COOKIE)).toBe(false);
    // Even the old token no longer works.
    const replay = h.browser();
    replay.cookies.set(SESSION_COOKIE, token ?? "");
    const reply = await replay.get("/me");
    expect(reply.status).toBe(401);
    expect(reply.body.error.code).toBe("unauthenticated");
  });

  test("a session is renewed on use and ends after 7 days unused", async () => {
    const owner = await setUpOwner(h);
    await h.test.db
      .updateTable("person_session")
      .set({
        last_used_at: sql<Date>`now() - interval '2 days'`,
        expires_at: sql<Date>`now() + interval '5 days'`,
      })
      .execute();
    const renewed = await owner.get("/me");
    expect(renewed.status).toBe(200);
    expect(cookieLine(renewed.setCookies, SESSION_COOKIE)).toContain("Max-Age=604800");
    const row = await h.test.db
      .selectFrom("person_session")
      .select(sql<boolean>`expires_at > now() + interval '6 days 23 hours'`.as("fresh"))
      .executeTakeFirstOrThrow();
    expect(row.fresh).toBe(true);

    await h.test.db
      .updateTable("person_session")
      .set({ expires_at: sql<Date>`now() - interval '1 second'` })
      .execute();
    const expired = await owner.get("/me");
    expect(expired.status).toBe(401);
    expect(owner.cookies.has(SESSION_COOKIE)).toBe(false);
  });

  test("signing in again in the same browser ends its previous session", async () => {
    const owner = await setUpOwner(h);
    await owner.signIn(OWNER);
    const count = await h.test.db
      .selectFrom("person_session")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .executeTakeFirstOrThrow();
    expect(Number(count.n)).toBe(1);
  });
});

describe("profile (spec 04 4.6)", () => {
  test("names can be set but not cleared", async () => {
    const owner = await setUpOwner(h);
    const set = await owner.patch("/me", { firstName: "Ada", lastName: "Lovelace" });
    expect(set.status).toBe(200);
    expect(set.body.message).toBe("Profile updated");
    expect(set.body.person).toMatchObject({
      firstName: "Ada",
      lastName: "Lovelace",
      hasRealName: true,
    });
    const cleared = await owner.patch("/me", { firstName: "  " });
    expect(cleared.status).toBe(400);
    expect(cleared.body.error.fields.firstName).toBe("Enter your first name.");
  });

  test("avatar: initials color, gravatar hashed on the server, and an uploaded image under 2 MB", async () => {
    const owner = await setUpOwner(h);
    const color = await owner.patch("/me", { avatarColor: "teal" });
    expect(color.body.person.avatar).toMatchObject({
      kind: "initials",
      color: "teal",
      initials: "O",
    });
    // Any color as #rrggbb (spec 4.6), kept lowercase; anything else is refused.
    const custom = await owner.patch("/me", { avatarColor: "#1E90FF" });
    expect(custom.status).toBe(200);
    expect(custom.body.person.avatar.color).toBe("#1e90ff");
    const bad = await owner.patch("/me", { avatarColor: "url(evil)" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.fields.avatarColor).toBe(
      "Pick one of the colors, or any color as #rrggbb.",
    );
    const gravatar = await owner.patch("/me", { avatarKind: "gravatar" });
    expect(gravatar.body.person.avatar.imageUrl).toMatch(
      /^https:\/\/gravatar\.com\/avatar\/[0-9a-f]{64}\?/,
    );

    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const uploaded = await owner.request("PUT", "/me/avatar", png, { "content-type": "image/png" });
    expect(uploaded.status).toBe(200);
    expect(uploaded.body.person.avatar.kind).toBe("image");
    const image = await owner.get(uploaded.body.person.avatar.imageUrl.replace("/api/v1", ""));
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(image.body as ArrayBuffer)).toEqual(png);

    // Someone who shares no workspace can't load it.
    const ownerId = await personIdOf(h, OWNER);
    const stranger = await h.browser();
    expect((await stranger.get(`/people/${ownerId}/avatar`)).status).toBe(401);

    const html = new TextEncoder().encode("<html><script>alert(1)</script>");
    const refused = await owner.request("PUT", "/me/avatar", html, { "content-type": "image/png" });
    expect(refused.status).toBe(400);
    const big = new Uint8Array(2 * 1024 * 1024 + 1);
    big.set(png);
    const tooBig = await owner.request("PUT", "/me/avatar", big, { "content-type": "image/png" });
    expect(tooBig.status).toBe(413);
    expect(tooBig.body.error.message).toBe("Use an image under 2 MB.");
  });

  test("changing the password needs the current one and signs out the other sessions", async () => {
    const owner = await setUpOwner(h);
    const laptop = h.browser();
    await laptop.signIn(OWNER);

    const wrong = await owner.post("/me/password", {
      currentPassword: "not my password",
      newPassword: "a brand new password",
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.message).toBe("Current password is incorrect");
    const missing = await owner.post("/me/password", {
      currentPassword: PASSWORD,
      newPassword: "",
    });
    expect(missing.body.error.fields.newPassword).toBe("New password is required");

    const changed = await owner.post("/me/password", {
      currentPassword: PASSWORD,
      newPassword: "a brand new password",
    });
    expect(changed.body).toEqual({ changed: true, otherSessionsEnded: 1 });
    expect((await owner.get("/me")).status).toBe(200);
    expect((await laptop.get("/me")).status).toBe(401);
    expect((await h.browser().signIn(OWNER, "a brand new password")).status).toBe(200);
  });

  test("changing the email needs the current password and notifies the old address (G9)", async () => {
    const owner = await setUpOwner(h);
    const without = await owner.post("/me/email", { email: "new@example.com" });
    expect(without.status).toBe(400);
    expect(without.body.error.fields.currentPassword).toBe("Enter your current password.");
    const wrong = await owner.post("/me/email", {
      email: "new@example.com",
      currentPassword: "not my password",
    });
    expect(wrong.body.error.message).toBe("Current password is incorrect");
    expect((await owner.get("/me")).body.email).toBe(OWNER);

    const asked = await owner.post("/me/email", {
      email: "New@Example.com",
      currentPassword: PASSWORD,
    });
    expect(asked.status).toBe(200);
    // The old address stays in use until the link sent to the new one is opened (R1-02).
    expect(asked.body.person.email).toBe(OWNER);
    expect(asked.body.person.pendingEmail).toBe("new@example.com");
    const link = new URL(h.outside.linkIn(h.outside.lastEmailTo("new@example.com")));
    const confirmed = await owner.post("/me/email/confirm", {
      token: link.searchParams.get("token"),
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.person.email).toBe("new@example.com");
    expect(confirmed.body.noticeSent).toBe(true);
    const notice = h.outside.lastEmailTo(OWNER);
    expect(notice?.subject).toBe("Your Nearzero email address was changed");
    expect(notice?.text).toContain("new@example.com");
  });

  test("wrong current passwords are limited per account", async () => {
    const owner = await setUpOwner(h);
    for (let i = 0; i < 10; i++) {
      await owner.post("/me/two-factor/verify-password", { password: "wrong password" });
    }
    const limited = await owner.post("/me/two-factor/verify-password", { password: PASSWORD });
    expect(limited.status).toBe(429);
  });
});

describe("two-factor sign-in (spec 04 4.6 acceptance, spec 24 G12)", () => {
  async function enable(owner: Browser) {
    const setup = await owner.post("/me/two-factor/setup", { password: PASSWORD });
    expect(setup.status).toBe(200);
    const { secret, backupCodes, qrSvg, otpauthUri } = setup.body;
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(backupCodes).toHaveLength(10);
    expect(qrSvg).toContain("<svg");
    expect(otpauthUri).toContain(`secret=${secret}`);
    const enabled = await owner.post("/me/two-factor/enable", {
      code: totpCode(secret, totpStep(clock.now)),
    });
    expect(enabled.body).toEqual({ enabled: true, message: "2FA configured successfully" });
    return { secret: secret as string, backupCodes: backupCodes as string[] };
  }

  test("set-up needs the password and a first code", async () => {
    const owner = await setUpOwner(h);
    expect((await owner.post("/me/two-factor/setup", { password: "wrong one!" })).status).toBe(400);
    const setup = await owner.post("/me/two-factor/setup", { password: PASSWORD });
    const bad = await owner.post("/me/two-factor/enable", { code: "000000" });
    expect(bad.body.error.message).toBe("That code is not valid. Try again.");
    expect((await owner.get("/me/two-factor")).body).toEqual({
      enabled: false,
      backupCodesLeft: 0,
    });
    const ok = await owner.post("/me/two-factor/enable", {
      code: totpCode(setup.body.secret, totpStep(clock.now)),
    });
    expect(ok.status).toBe(200);
    expect((await owner.get("/me/two-factor")).body).toEqual({
      enabled: true,
      backupCodesLeft: 10,
    });
    // The secret is sealed at rest.
    const row = await h.test.db
      .selectFrom("two_factor")
      .select("secret_sealed")
      .executeTakeFirstOrThrow();
    expect(row.secret_sealed).not.toContain(setup.body.secret);
  });

  test("with 2FA on, the password alone never creates a session", async () => {
    const owner = await setUpOwner(h);
    const { secret } = await enable(owner);
    await owner.post("/auth/sign-out");

    const browser = h.browser();
    const first = await browser.signIn(OWNER);
    expect(first.body).toEqual({ status: "two_factor_required", expiresInSeconds: 600 });
    expect(browser.cookies.has(SESSION_COOKIE)).toBe(false);
    expect((await browser.get("/me")).status).toBe(401);

    const wrong = await browser.post("/auth/two-factor", { code: "123456" });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.message).toBe("That code is not valid. Try again.");

    clock.now += 30_000;
    const right = await browser.post("/auth/two-factor", {
      code: totpCode(secret, totpStep(clock.now)),
    });
    expect(right.status).toBe(200);
    expect(right.body.status).toBe("signed_in");
    expect((await browser.get("/me")).status).toBe(200);

    // The same code can't be used again, even within its 30 seconds.
    const again = h.browser();
    await again.signIn(OWNER);
    const replay = await again.post("/auth/two-factor", {
      code: totpCode(secret, totpStep(clock.now)),
    });
    expect(replay.status).toBe(401);
  });

  test("a backup code works once; regenerating replaces them; checking the password changes nothing", async () => {
    const owner = await setUpOwner(h);
    const { backupCodes } = await enable(owner);
    const [first, second, third] = backupCodes;

    const once = h.browser();
    await once.signIn(OWNER);
    expect((await once.post("/auth/two-factor", { code: first })).status).toBe(200);
    const twice = h.browser();
    await twice.signIn(OWNER);
    expect((await twice.post("/auth/two-factor", { code: first })).status).toBe(401);

    // Manage → password: a check only (G12). Old codes keep working.
    expect(
      (await owner.post("/me/two-factor/verify-password", { password: PASSWORD })).body,
    ).toEqual({
      ok: true,
    });
    expect((await owner.get("/me/two-factor")).body.backupCodesLeft).toBe(9);
    const stillWorks = h.browser();
    await stillWorks.signIn(OWNER);
    expect(
      (await stillWorks.post("/auth/two-factor", { code: (second ?? "").toUpperCase() })).status,
    ).toBe(200);

    const regenerated = await owner.post("/me/two-factor/backup-codes", { password: PASSWORD });
    expect(regenerated.body.backupCodes).toHaveLength(10);
    const old = h.browser();
    await old.signIn(OWNER);
    expect((await old.post("/auth/two-factor", { code: third })).status).toBe(401);
    expect(
      (await old.post("/auth/two-factor", { code: regenerated.body.backupCodes[0] })).status,
    ).toBe(200);
  });

  test("at most 3 codes per 10 seconds; the challenge lasts 10 minutes", async () => {
    const owner = await setUpOwner(h);
    const { secret } = await enable(owner);
    const browser = h.browser();
    await browser.signIn(OWNER);
    for (let i = 0; i < 3; i++) {
      expect((await browser.post("/auth/two-factor", { code: "111111" })).status).toBe(401);
    }
    const limited = await browser.post("/auth/two-factor", {
      code: totpCode(secret, totpStep(clock.now + 30_000)),
    });
    expect(limited.status).toBe(429);

    await h.test.db
      .updateTable("sign_in_challenge")
      .set({ window_started_at: sql<Date>`now() - interval '11 seconds'` })
      .execute();
    await h.test.db
      .updateTable("attempt_record")
      .set({ attempted_at: sql<Date>`now() - interval '11 seconds'` })
      .where("bucket", "=", "two-factor")
      .execute();
    clock.now += 30_000;
    expect(
      (await browser.post("/auth/two-factor", { code: totpCode(secret, totpStep(clock.now)) }))
        .status,
    ).toBe(200);

    const late = h.browser();
    await late.signIn(OWNER);
    await h.test.db
      .updateTable("sign_in_challenge")
      .set({ expires_at: sql<Date>`now() - interval '1 second'` })
      .where("consumed_at", "is", null)
      .execute();
    clock.now += 30_000;
    const expired = await late.post("/auth/two-factor", {
      code: totpCode(secret, totpStep(clock.now)),
    });
    expect(expired.status).toBe(401);
    expect(expired.body.error.message).toBe(
      "This sign-in has expired. Enter your email and password again.",
    );
  });

  test("signing in again never brings more codes: the limits are per account (B1-25)", async () => {
    const owner = await setUpOwner(h);
    const { secret } = await enable(owner);
    const tries = async (code: string) => {
      const browser = h.browser();
      expect((await browser.signIn(OWNER)).body.status).toBe("two_factor_required");
      return browser.post("/auth/two-factor", { code });
    };
    // Three codes, each from its own fresh challenge, then the fourth is refused.
    for (let i = 0; i < 3; i++) expect((await tries("111111")).status).toBe(401);
    const fourth = await tries("111111");
    expect(fourth.status).toBe(429);
    expect(fourth.body.error.message).toBe(
      "Too many codes tried. Wait a few seconds and try again.",
    );
    // Codes sent at once from many challenges are counted one after another.
    await h.test.db.deleteFrom("attempt_record").execute();
    const burst = await Promise.all(Array.from({ length: 12 }, () => tries("222222")));
    expect(burst.filter((reply) => reply.status === 401).length).toBe(3);

    // After 10 wrong codes in 15 minutes, even the right code is refused for a while.
    await h.test.db.deleteFrom("attempt_record").execute();
    for (let i = 0; i < 10; i++) {
      expect((await tries("333333")).status).toBe(401);
      await h.test.db
        .updateTable("attempt_record")
        .set({ attempted_at: sql<Date>`now() - interval '11 seconds'` })
        .where("bucket", "=", "two-factor")
        .execute();
    }
    clock.now += 30_000;
    const locked = await tries(totpCode(secret, totpStep(clock.now)));
    expect(locked.status).toBe(429);
    expect(locked.body.error.message).toBe(
      "Too many wrong codes for this account. Wait 15 minutes, then sign in again.",
    );
    await h.test.db
      .updateTable("attempt_record")
      .set({ attempted_at: sql<Date>`now() - interval '16 minutes'` })
      .execute();
    expect((await tries(totpCode(secret, totpStep(clock.now)))).status).toBe(200);
  });

  test("turning 2FA off needs the password, then the password is enough again", async () => {
    const owner = await setUpOwner(h);
    await enable(owner);
    expect((await owner.post("/me/two-factor/disable", { password: "wrong one!" })).status).toBe(
      400,
    );
    expect((await owner.post("/me/two-factor/disable", { password: PASSWORD })).body).toEqual({
      enabled: false,
    });
    expect((await h.browser().signIn(OWNER)).body.status).toBe("signed_in");
  });
});

describe("registration (spec 04 4.2)", () => {
  test("nobody signs up without an invitation", async () => {
    await setUpOwner(h);
    const reply = await h.browser().post("/auth/register", {
      token: "x".repeat(43),
      password: PASSWORD,
    });
    expect(reply.status).toBe(404);
    expect(reply.body.error.message).toBe("Invitation not found");
    const incomplete = await h.browser().post("/auth/register", { password: PASSWORD });
    expect(incomplete.status).toBe(400);
    expect(incomplete.body.error.fields.token).toBe("This link is incomplete");
  });
});
