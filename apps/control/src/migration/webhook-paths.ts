import { API_PREFIX, AppError } from "@nearzero/shared";
import { Hono } from "hono";
import type { AppEnv } from "../http/context.ts";
import type { ControlServices } from "../services.ts";
import { webhookNeedsPost } from "../webhooks/routes.ts";
import { matchWebhookPath } from "./legacy-fields.ts";
import "./tables.ts";

/**
 * The 0.1.x webhook addresses a move carried over (spec 29.5 "Old webhook paths", 29a.9): the
 * console passes a POST no page of its own takes on as `/api/v1/webhooks/legacy/<old path>`, and
 * it reaches the same handler as 1.0's own address, so Git hosts keep their settings. A deploy
 * webhook's token is checked exactly as on 1.0's path (it was imported hashed); the GitHub App's
 * old address goes to the app the delivery names (GitHub's installation-target header), whose
 * signature is checked as usual.
 */

export const LEGACY_WEBHOOK_PREFIX = `${API_PREFIX}/webhooks/legacy`;

export type Dispatch = (path: string, init: RequestInit, env: unknown) => Promise<Response>;

function noSuchAddress(): never {
  throw new AppError("not_found", "Nothing here takes this request.");
}

/** The kept 0.1.x webhook address this path is, if any. */
async function keptAddress(services: ControlServices, path: string) {
  if (!path.startsWith("/") || path.startsWith(`${API_PREFIX}/`)) return null;
  const patterns = await services.db
    .selectFrom("migration_webhook_path")
    .select(["pattern", "kind"])
    .execute();
  // An exact path (the GitHub App's) wins over a token pattern it would also fit, like
  // /api/deploy/github under /api/deploy/{token}.
  return (
    patterns
      .sort(
        (a, b) =>
          Number(a.pattern.includes("{token}")) - Number(b.pattern.includes("{token}")) ||
          b.pattern.length - a.pattern.length,
      )
      .map((item) => ({ ...item, token: matchWebhookPath(item.pattern, path) }))
      .find((item) => item.token !== null) ?? null
  );
}

export function legacyWebhookRoutes(services: ControlServices, dispatch: Dispatch): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  // 0.1.x also deployed on a GET; a kept address now says to use POST (31d G4-17). The console
  // asks this for a GET no page takes.
  app.get("/webhooks/legacy/*", async (c) => {
    const found = await keptAddress(services, c.req.path.slice(LEGACY_WEBHOOK_PREFIX.length));
    if (!found) noSuchAddress();
    c.header("allow", "POST");
    return webhookNeedsPost();
  });
  app.post("/webhooks/legacy/*", async (c) => {
    const path = c.req.path.slice(LEGACY_WEBHOOK_PREFIX.length);
    const found = await keptAddress(services, path);
    if (!found) noSuchAddress();
    const body = new Uint8Array(await c.req.arrayBuffer());
    const headers = new Headers(c.req.raw.headers);
    headers.delete("content-length");
    const init = (): RequestInit => ({ method: "POST", headers, body });
    if (found.kind === "deploy") {
      if (!found.token) noSuchAddress();
      return dispatch(
        `${API_PREFIX}/webhooks/deploy/${encodeURIComponent(found.token)}`,
        init(),
        c.env,
      );
    }
    // The GitHub App's old address: the app the delivery names, else each imported app in turn
    // until one accepts the signature.
    const target = c.req.header("x-github-hook-installation-target-id");
    let query = services.db.selectFrom("git_provider").select("id").where("kind", "=", "github");
    if (target && /^\d{1,20}$/.test(target)) query = query.where("github_app_id", "=", target);
    const providers = await query.orderBy("created_at").execute();
    let last: Response | null = null;
    for (const provider of providers) {
      last = await dispatch(`${API_PREFIX}/webhooks/github/${provider.id}`, init(), c.env);
      if (last.status !== 401) return last;
    }
    return last ?? noSuchAddress();
  });
  return app;
}
