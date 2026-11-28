import { AppError, JOIN_TOKEN_PREFIX, RUNNER_CREDENTIAL_PREFIX } from "@nearzero/shared";
import { sql } from "kysely";
import type { Db } from "../db/database.ts";
import { constantTimeEqual, randomToken, sha256Hex } from "../security/tokens.ts";

/**
 * Runner credentials and join tokens (spec 25 D1, spec 22.4 rule 7).
 *
 * - A join token is one-time and short-lived: `nzj1.<token id>.<secret>`. A runner trades it for
 *   its credential, once.
 * - A credential is `nzr1.<runner id>.<secret>`. Only the SHA-256 of the secret is stored. Each
 *   server's runner has its own; joining again (setup run again) issues a new one and the old one
 *   stops working; deleting the server or revoking removes it.
 * - Secrets are compared in constant time.
 */

export const JOIN_TOKEN_TTL_MS = 60 * 60_000;
/** The host's handoff token lives longer: the runner may start well after the control plane. */
export const HOST_JOIN_TOKEN_TTL_MS = 24 * 60 * 60_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function split(token: string, prefix: string): { id: string; secret: string } | null {
  const parts = token.trim().split(".");
  if (parts.length !== 3 || parts[0] !== prefix) return null;
  const [, id = "", secret = ""] = parts;
  if (!UUID.test(id) || secret.length < 32 || secret.length > 128) return null;
  return { id, secret };
}

export const JOIN_TOKEN_REFUSED =
  "This join token isn't valid any more: it was used already, it expired (join tokens last an hour), or the server was deleted. Create a new join command on the server's page.";

export const CREDENTIAL_REFUSED =
  "This runner's credential isn't accepted: the server was deleted, the runner was revoked, or setup ran again and gave the server a new one. Run setup again (or the join command) on the server.";

/** A new one-time join token for a server (null: the Nearzero host). */
export async function createJoinToken(
  db: Db,
  serverId: string | null,
  options: { createdBy?: string | null; ttlMs?: number } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const secret = randomToken(32);
  const expiresAt = new Date(Date.now() + (options.ttlMs ?? JOIN_TOKEN_TTL_MS));
  const row = await db
    .insertInto("runner_join_token")
    .values({
      server_id: serverId,
      token_hash: sha256Hex(secret),
      expires_at: expiresAt,
      created_by: options.createdBy ?? null,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { token: `${JOIN_TOKEN_PREFIX}.${row.id}.${secret}`, expiresAt };
}

export interface Enrollment {
  runnerId: string;
  serverId: string | null;
  credential: string;
}

/**
 * Trades a join token for a credential. The token is marked used in the same transaction, so two
 * runners racing with one token can't both join. Joining again replaces the server's credential.
 */
export async function redeemJoinToken(db: Db, token: string): Promise<Enrollment> {
  const parts = split(token, JOIN_TOKEN_PREFIX);
  if (!parts) throw new AppError("unauthenticated", JOIN_TOKEN_REFUSED);
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom("runner_join_token")
      .select(["id", "server_id", "token_hash", "expires_at", "used_at"])
      .where("id", "=", parts.id)
      .forUpdate()
      .executeTakeFirst();
    const matches = row ? constantTimeEqual(sha256Hex(parts.secret), row.token_hash) : false;
    if (!row || !matches || row.used_at !== null || row.expires_at.getTime() <= Date.now()) {
      throw new AppError("unauthenticated", JOIN_TOKEN_REFUSED);
    }
    await trx
      .updateTable("runner_join_token")
      .set({ used_at: new Date() })
      .where("id", "=", row.id)
      .execute();
    const secret = randomToken(32);
    const hash = sha256Hex(secret);
    let existing = trx.selectFrom("runner").select("id");
    existing =
      row.server_id === null
        ? existing.where("server_id", "is", null)
        : existing.where("server_id", "=", row.server_id);
    const found = await existing.forUpdate().executeTakeFirst();
    let runnerId: string;
    if (found) {
      await trx
        .updateTable("runner")
        .set({
          credential_hash: hash,
          credential_issued_at: new Date(),
          revoked_at: null,
          refusal: null,
          updated_at: new Date(),
        })
        .where("id", "=", found.id)
        .execute();
      runnerId = found.id;
    } else {
      const inserted = await trx
        .insertInto("runner")
        .values({
          server_id: row.server_id,
          credential_hash: hash,
          credential_issued_at: new Date(),
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      runnerId = inserted.id;
    }
    return {
      runnerId,
      serverId: row.server_id,
      credential: `${RUNNER_CREDENTIAL_PREFIX}.${runnerId}.${secret}`,
    };
  });
}

export interface VerifiedRunner {
  runnerId: string;
  serverId: string | null;
}

/** The runner a credential belongs to, or null (wrong, rotated or revoked). */
export async function verifyCredential(db: Db, credential: string): Promise<VerifiedRunner | null> {
  const parts = split(credential, RUNNER_CREDENTIAL_PREFIX);
  if (!parts) return null;
  const row = await db
    .selectFrom("runner")
    .select(["id", "server_id", "credential_hash", "revoked_at"])
    .where("id", "=", parts.id)
    .executeTakeFirst();
  // Compare even when there's no row, so a missing runner takes as long as a wrong secret.
  const stored = row?.credential_hash ?? "0".repeat(64);
  const matches = constantTimeEqual(sha256Hex(parts.secret), stored);
  if (!row || !matches || row.credential_hash === null || row.revoked_at !== null) return null;
  return { runnerId: row.id, serverId: row.server_id };
}

/** Revokes a server's runner credential (null: the host's). */
export async function revokeRunner(db: Db, serverId: string | null): Promise<void> {
  let query = db
    .updateTable("runner")
    .set({ credential_hash: null, revoked_at: new Date(), updated_at: new Date() });
  query =
    serverId === null
      ? query.where("server_id", "is", null)
      : query.where("server_id", "=", serverId);
  await query.execute();
}

/** Drops used and expired join tokens; unused host tokens are replaced at every start. */
export async function pruneJoinTokens(db: Db, options: { hostToo?: boolean } = {}): Promise<void> {
  let query = db
    .deleteFrom("runner_join_token")
    .where((eb) => eb.or([eb("used_at", "is not", null), eb("expires_at", "<", sql<Date>`now()`)]));
  if (options.hostToo) {
    query = db
      .deleteFrom("runner_join_token")
      .where((eb) =>
        eb.or([
          eb("used_at", "is not", null),
          eb("expires_at", "<", sql<Date>`now()`),
          eb("server_id", "is", null),
        ]),
      );
  }
  await query.execute();
}
