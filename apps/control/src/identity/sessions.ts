import { AppError, SESSION_COOKIE, SESSION_DAYS } from "@nearzero/shared";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { sql } from "kysely";
import type { Db } from "../db/database.ts";
import { clientInfo } from "../http/client.ts";
import type { AppEnv } from "../http/context.ts";
import { hashToken, randomToken } from "../security/tokens.ts";
import type { ControlServices } from "../services.ts";

/**
 * Sessions (spec 04 4.1): an opaque random token in an HttpOnly, SameSite=Lax cookie that is
 * Secure only when the browser reached the console over HTTPS (spec 21.9). The database keeps
 * only the token's hash. A session lasts 7 days and is renewed on use.
 */

export const SESSION_LIFETIME_SECONDS = SESSION_DAYS * 24 * 60 * 60;
/** A session is renewed at most this often, so every request doesn't write. */
const RENEW_EVERY_SECONDS = 10 * 60;

export interface SessionContext {
  id: string;
  personId: string;
  activeWorkspaceId: string | null;
}

export interface NewSession {
  personId: string;
  clientAddress: string;
  userAgent: string | null;
  activeWorkspaceId?: string | null;
}

export async function createSession(
  db: Db,
  input: NewSession,
): Promise<{ id: string; token: string }> {
  const token = randomToken(32);
  const row = await db
    .insertInto("person_session")
    .values({
      person_id: input.personId,
      token_hash: hashToken(token),
      active_workspace_id: input.activeWorkspaceId ?? null,
      client_address: input.clientAddress,
      user_agent: input.userAgent?.slice(0, 400) ?? null,
      expires_at: sql<Date>`now() + make_interval(secs => ${SESSION_LIFETIME_SECONDS}::double precision)`,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { id: row.id, token };
}

export function setSessionCookie(c: Context<AppEnv>, token: string, secure: boolean): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure,
    maxAge: SESSION_LIFETIME_SECONDS,
  });
}

export function clearSessionCookie(c: Context<AppEnv>, secure: boolean): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure, httpOnly: true, sameSite: "Lax" });
}

/** Reads the session cookie on every request; renews a live session, forgets a dead one. */
export function sessionMiddleware(services: ControlServices): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set("session", undefined);
    const token = getCookie(c, SESSION_COOKIE);
    if (token && token.length <= 128) {
      const row = await services.db
        .selectFrom("person_session")
        .select([
          "id",
          "person_id",
          "active_workspace_id",
          sql<boolean>`last_used_at < now() - make_interval(secs => ${RENEW_EVERY_SECONDS}::double precision)`.as(
            "due_for_renewal",
          ),
        ])
        .where("token_hash", "=", hashToken(token))
        .where("expires_at", ">", sql<Date>`now()`)
        .executeTakeFirst();
      const secure = clientInfo(c, services.trustedProxies).secure;
      if (row) {
        c.set("session", {
          id: row.id,
          personId: row.person_id,
          activeWorkspaceId: row.active_workspace_id,
        });
        if (row.due_for_renewal) {
          await services.db
            .updateTable("person_session")
            .set({
              last_used_at: sql<Date>`now()`,
              expires_at: sql<Date>`now() + make_interval(secs => ${SESSION_LIFETIME_SECONDS}::double precision)`,
            })
            .where("id", "=", row.id)
            .execute();
          setSessionCookie(c, token, secure);
        }
      } else {
        clearSessionCookie(c, secure);
      }
    }
    await next();
  };
}

/** The signed-in person's session, or a refusal that tells them to sign in. */
export function requireSession(c: Context<AppEnv>): SessionContext {
  const session = c.get("session");
  if (!session) {
    throw new AppError("unauthenticated", "Your session has ended. Sign in again to continue.");
  }
  return session;
}

export async function endSession(db: Db, sessionId: string): Promise<void> {
  await db.deleteFrom("person_session").where("id", "=", sessionId).execute();
}

/** Signs out every session of an account except, optionally, the one making the change. */
export async function endOtherSessions(
  db: Db,
  personId: string,
  keepSessionId: string | null,
): Promise<number> {
  let query = db.deleteFrom("person_session").where("person_id", "=", personId);
  if (keepSessionId) query = query.where("id", "!=", keepSessionId);
  const result = await query.executeTakeFirst();
  return Number(result.numDeletedRows);
}
