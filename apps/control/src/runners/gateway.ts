import { AppError, agreeProtocol, enrollRequestSchema, RUNNER_CLOSE } from "@nearzero/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import { recordAudit } from "../audit/audit.ts";
import { clientInfo } from "../http/client.ts";
import type { AppEnv } from "../http/context.ts";
import { readBody } from "../http/validate.ts";
import type { ControlServices } from "../services.ts";
import { CREDENTIAL_REFUSED, redeemJoinToken, verifyCredential } from "./credentials.ts";
import { HOST_TARGET, targetOf } from "./hub.ts";

/**
 * The runner gateway (docs/runner-protocol.md): enrollment with a one-time join token, a check a
 * runner makes before connecting, and the WebSocket itself. None of these use a person's session;
 * they authenticate with the token or the runner's credential.
 */

function bearer(c: Context<AppEnv>): string | null {
  const header = c.req.header("authorization") ?? "";
  const match = /^Bearer\s+(\S{10,512})$/i.exec(header);
  return match?.[1] ?? null;
}

async function serverName(services: ControlServices, serverId: string | null): Promise<string> {
  if (serverId === null) return "Nearzero host";
  const row = await services.db
    .selectFrom("server")
    .select("name")
    .where("id", "=", serverId)
    .executeTakeFirst();
  return row?.name ?? "server";
}

export function runnerGatewayRoutes(services: ControlServices): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post("/runner/enroll", async (c) => {
    const input = await readBody(c, enrollRequestSchema);
    const agreement = agreeProtocol({
      protocol: input.protocol,
      minProtocol: input.minProtocol,
      version: input.runnerVersion,
    });
    if (!agreement.ok) throw new AppError("conflict", agreement.message);
    const enrolled = await redeemJoinToken(services.db, input.joinToken);
    const target = targetOf(enrolled.serverId);
    // A runner still connected with the old credential is replaced by this one.
    services.runners.disconnect(target, RUNNER_CLOSE.revoked, "credential rotated");
    const name = await serverName(services, enrolled.serverId);
    await recordAudit(
      services.db,
      services.log,
      {
        kind: "system",
        label: `runner on ${name}`,
        clientAddress: clientInfo(c, services.trustedProxies).address,
      },
      {
        action: "runner.enrolled",
        target: { kind: target === HOST_TARGET ? "host" : "server", id: target },
        details: { runnerVersion: input.runnerVersion },
      },
    );
    c.header("cache-control", "no-store");
    return c.json({ serverId: target, serverName: name, credential: enrolled.credential }, 201);
  });

  app.get("/runner/check", async (c) => {
    const credential = bearer(c);
    const runner = credential ? await verifyCredential(services.db, credential) : null;
    if (!runner) throw new AppError("unauthenticated", CREDENTIAL_REFUSED);
    return c.json({ ok: true, serverId: targetOf(runner.serverId) });
  });

  app.get("/runner/connect", async (c) => {
    const credential = bearer(c);
    const runner = credential ? await verifyCredential(services.db, credential) : null;
    if (!runner) throw new AppError("unauthenticated", CREDENTIAL_REFUSED);
    const upgrade = c.env?.upgrade;
    if (!upgrade || c.req.header("upgrade")?.toLowerCase() !== "websocket") {
      throw new AppError("invalid_request", "Connect here with a WebSocket.");
    }
    let link: ReturnType<typeof services.runners.attach> | null = null;
    const ok = upgrade(c.req.raw, {
      open(socket) {
        link = services.runners.attach(
          {
            send: (data) => {
              socket.send(data);
            },
            close: (code, reason) => socket.close(code, reason),
          },
          {
            runnerId: runner.runnerId,
            serverId: runner.serverId,
            // Only a label for older runners, which don't say where they are: newer ones do,
            // and only what they say decides whether they are moved (hub.ts).
            encrypted:
              c.env?.runnerLinkTls === true ||
              c.req.header("x-forwarded-proto")?.split(",").pop()?.trim().toLowerCase() === "https",
          },
        );
      },
      message(_socket, data) {
        link?.message(typeof data === "string" ? data : new TextDecoder().decode(data));
      },
      close(_socket, code) {
        link?.closed(code);
      },
    });
    if (!ok) throw new AppError("invalid_request", "Connect here with a WebSocket.");
    return new Response(null);
  });

  return app;
}
