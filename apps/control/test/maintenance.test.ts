import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { sql } from "kysely";
import { pruneIdentityRecords } from "../src/identity/maintenance.ts";
import { silentLogger } from "../src/log.ts";
import {
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

async function count(table: "person_session" | "attempt_record" | "audit_event" | "invitation") {
  const row = await h.test.db
    .selectFrom(table)
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

describe("daily identity clean-up", () => {
  test("removes ended sessions, old attempts, stale invitations and audit events past 90 days", async () => {
    const owner = await setUpNamedOwner(h);
    await owner.post("/workspace/invitations", { email: "old@example.com", role: "member" });
    await owner.post("/workspace/invitations", { email: "fresh@example.com", role: "member" });
    await h.test.db
      .updateTable("invitation")
      .set({ expires_at: sql<Date>`now() - interval '8 days'` })
      .where("email", "=", "old@example.com")
      .execute();
    const laptop = h.browser();
    await laptop.signIn("owner@example.com");
    await h.test.db
      .updateTable("person_session")
      .set({ expires_at: sql<Date>`now() - interval '1 minute'` })
      .where(
        "id",
        "=",
        (
          await h.test.db
            .selectFrom("person_session")
            .select("id")
            .orderBy("created_at", "desc")
            .executeTakeFirstOrThrow()
        ).id,
      )
      .execute();
    await h.test.db
      .insertInto("attempt_record")
      .values({
        bucket: "sign-in",
        subject: "x|y",
        attempted_at: sql<Date>`now() - interval '2 days'`,
      })
      .execute();
    await h.test.db
      .insertInto("audit_event")
      .values({
        actor_kind: "system",
        action: "test.old-event",
        occurred_at: sql<Date>`now() - interval '91 days'`,
      })
      .execute();
    const before = {
      sessions: await count("person_session"),
      attempts: await count("attempt_record"),
      audit: await count("audit_event"),
      invitations: await count("invitation"),
    };

    const controller = new AbortController();
    await pruneIdentityRecords.run(
      {},
      {
        db: h.test.db,
        log: silentLogger,
        signal: controller.signal,
        job: { id: 1, kind: pruneIdentityRecords.kind, payload: {}, attempt: 1, maxAttempts: 3 },
      },
    );

    expect(await count("person_session")).toBe(before.sessions - 1);
    expect(await count("attempt_record")).toBe(before.attempts - 1);
    expect(await count("audit_event")).toBe(before.audit - 1);
    expect(await count("invitation")).toBe(before.invitations - 1);
    expect((await owner.get("/me")).status).toBe(200);
  });
});
