import { AppError } from "@nearzero/shared";
import { Hono } from "hono";
import type { AppEnv } from "../http/context.ts";
import { verifyCredential } from "../runners/credentials.ts";
import { targetOf } from "../runners/hub.ts";
import type { ControlServices } from "../services.ts";
import { isInstanceAdmin } from "../workspaces/workspaces.ts";
import { consoleTarget, findConsolePath } from "./console-paths.ts";
import { archiveBytes } from "./import-extras.ts";

/**
 * What a move from 0.1.x keeps working after it (spec 29.5, 29a.9.1):
 * - a runner's download of a volume archive a move restores on another machine: its own
 *   credential, never a person's session, and only an archive of a service on that runner's
 *   server; the pieces are opened as they stream and nothing plain is written on the way;
 * - the lookup of an old console address: the object behind it, for a member of its workspace.
 *   Signed out, it only says the address is known, so the console asks for sign-in first.
 */
export function runnerMigrationRoutes(services: ControlServices): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get("/migration/console-path", async (c) => {
    const found = await findConsolePath(services.db, c.req.query("path") ?? "");
    const target = found ? await consoleTarget(services.db, found) : null;
    if (!target) throw new AppError("not_found", "No page here had that address before.");
    const session = c.get("session");
    if (!session) return c.json({ signIn: true });
    const member = await services.db
      .selectFrom("membership")
      .select("workspace_id")
      .where("workspace_id", "=", target.workspaceId)
      .where("person_id", "=", session.personId)
      .executeTakeFirst();
    if (!member && !(await isInstanceAdmin(services.db, session.personId))) {
      throw new AppError("not_found", "No page here had that address before.");
    }
    const { workspaceId: _hidden, ...visible } = target;
    return c.json({ target: visible });
  });
  app.get("/runner/migration-archives/:archiveId", async (c) => {
    const header = c.req.header("authorization") ?? "";
    const credential = /^Bearer\s+(\S{10,512})$/i.exec(header)?.[1];
    const runner = credential ? await verifyCredential(services.db, credential) : null;
    if (!runner) throw new AppError("unauthenticated", "This runner's credential isn't accepted.");
    const id = c.req.param("archiveId");
    const row = /^[0-9a-f-]{36}$/.test(id)
      ? await services.db
          .selectFrom("migration_volume_archive as a")
          .innerJoin("service as s", "s.id", "a.service_id")
          .select(["a.id", "a.size_bytes", "s.server_id"])
          .where("a.id", "=", id)
          .executeTakeFirst()
      : undefined;
    if (!row || targetOf(row.server_id) !== targetOf(runner.serverId)) {
      throw new AppError("not_found", "There's no such archive for this server.");
    }
    const pieces = archiveBytes(services.db, services.secrets, row.id);
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await pieces.next();
        if (next.done) controller.close();
        else controller.enqueue(new Uint8Array(next.value));
      },
    });
    return new Response(body, {
      headers: {
        "content-type": "application/x-tar",
        "content-length": String(row.size_bytes),
        "cache-control": "no-store",
      },
    });
  });
  return app;
}
