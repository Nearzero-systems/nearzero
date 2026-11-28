import { AppError, WEBHOOK_AUTODEPLOY_OFF } from "@nearzero/shared";
import { Hono } from "hono";
import { sql } from "kysely";
import { recordAudit } from "../audit/audit.ts";
import { requestDeploy } from "../deploys/queue.ts";
import { providerCallVerdict } from "../git-providers/push.ts";
import type { AppEnv } from "../http/context.ts";
import { type AttemptLimit, isLimited, recordAttempt } from "../identity/attempts.ts";
import { readAppSettings } from "../service-runtime/app-settings.ts";
import type { ControlServices } from "../services.ts";
import { classifyCall, decideCall, pingAnswer, type SourceForCall } from "./calls.ts";
import { serviceOfToken, WEBHOOK_REFUSED } from "./tokens.ts";

/**
 * The generic deploy webhook (spec 6.6, 24 G4): POST /api/v1/webhooks/deploy/<token>, bodies up
 * to 25 MB (G2-04); a GET answers 405 (G4-17). No session; the token in the URL is the credential. Calls are rate-limited per webhook, and a
 * burst queues at most one deploy (the queue keeps one waiting, replaced by newer calls).
 * Ignored when Autodeploy is off.
 *
 * The raw body is read once, as bytes, before anything parses it, so provider signature checks
 * can verify the exact bytes that arrived. Then calls.ts reads what the call is: a Git host's
 * ping is answered and deploys nothing, other events of a Git host never deploy, pushes deploy
 * by the source's branch, trigger, watch paths and skip keywords, a registry's push redeploys an
 * image app only for its own image and tag, and a plain call deploys.
 */

/** 30 calls a minute per webhook; past that, 429 until the minute passes. */
export const WEBHOOK_LIMIT: AttemptLimit = { bucket: "deploy-webhook", max: 30, windowSeconds: 60 };
/**
 * The largest webhook body taken (31b G2-04): GitHub sends push payloads of up to 25 MB, and a
 * push of many commits or thousands of files must still get its branch and watch-path check.
 */
export const WEBHOOK_MAX_BODY_BYTES = 25 * 1024 * 1024;

export const WEBHOOK_NEEDS_POST = "Call this webhook with POST.";

/**
 * A GET (or HEAD) to a webhook address deploys nothing (link previewers used to trigger deploys)
 * and says which method to use (31d G4-17), whatever the token: it tells nothing about it.
 */
export function webhookNeedsPost(): never {
  throw new AppError("method_not_allowed", WEBHOOK_NEEDS_POST);
}

/** The service's source as the webhook's decision needs it. */
function sourceForCall(kind: string, settings: Record<string, unknown> | null): SourceForCall {
  const source = readAppSettings(settings).source;
  if (source?.type === "git" || source?.type === "provider") {
    return {
      type: "git",
      trigger: source.trigger,
      branch: source.branch,
      watchPaths: source.watchPaths,
      repository: source.type === "provider" ? source.repository : null,
    };
  }
  if (kind === "application" && source?.type === "image")
    return { type: "image", image: source.image };
  if (kind === "application" && source?.type === "upload") return { type: "upload" };
  return { type: "other" };
}

export function webhookRoutes(services: ControlServices): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { db } = services;

  app.get("/webhooks/deploy/:token", (c) => {
    c.header("allow", "POST");
    return webhookNeedsPost();
  });

  app.post("/webhooks/deploy/:token", async (c) => {
    const found = await serviceOfToken(db, c.req.param("token"));
    if (!found) throw WEBHOOK_REFUSED;
    if (await isLimited(db, WEBHOOK_LIMIT, found.webhookId)) {
      throw new AppError(
        "rate_limited",
        "Too many calls to this webhook in the last minute. A deploy is already queued; wait a minute.",
      );
    }
    await recordAttempt(db, WEBHOOK_LIMIT, found.webhookId);
    const raw = new Uint8Array(await c.req.arrayBuffer());
    if (raw.length > WEBHOOK_MAX_BODY_BYTES) {
      throw new AppError("payload_too_large", "The webhook body is larger than 25 MB.");
    }
    let body: unknown = null;
    if (raw.length > 0) {
      try {
        body = JSON.parse(new TextDecoder().decode(raw));
      } catch {
        body = null;
      }
    }
    const service = await db
      .selectFrom("service")
      .select(["id", "workspace_id", "kind", "settings", "deleting_run_id"])
      .where("id", "=", found.serviceId)
      .executeTakeFirst();
    if (!service) throw WEBHOOK_REFUSED;
    await db
      .updateTable("deploy_webhook")
      .set({ last_called_at: sql<Date>`now()` })
      .where("id", "=", found.webhookId)
      .execute();
    // A service linked to GitLab, Bitbucket or Gitea whose webhook has its own secret accepts
    // only calls carrying it, checked on the raw bytes before anything else (spec 16.6, G4).
    const provider = await providerCallVerdict(services, service, c.req.raw.headers, raw, body);
    const settings = readAppSettings(service.settings);
    const call = provider.kind === "generic" ? classifyCall(c.req.raw.headers, body) : null;
    // A Git host checking the webhook (GitHub's ping when it is added) deploys nothing.
    if (call?.kind === "ping") {
      return c.json({
        deployed: false,
        message: settings.deploy.autodeploy ? pingAnswer() : WEBHOOK_AUTODEPLOY_OFF,
      });
    }
    if (!settings.deploy.autodeploy) {
      return c.json({ deployed: false, message: WEBHOOK_AUTODEPLOY_OFF });
    }
    if (provider.kind === "ignored") return c.json({ deployed: false, message: provider.message });
    let commit: string | null = null;
    let tag: string | null = null;
    let title: string | undefined;
    if (provider.kind === "deploy") {
      commit = provider.commit;
      tag = provider.tag;
      if (provider.title) title = provider.title.slice(0, 300);
    } else if (call) {
      const decision = decideCall(sourceForCall(service.kind, service.settings), call);
      if (!decision.deploy) return c.json({ deployed: false, message: decision.message });
      commit = decision.commit;
      tag = decision.tag;
      if (decision.title) title = decision.title.slice(0, 300);
    }
    const result = await requestDeploy(db, {
      serviceId: service.id,
      workspaceId: service.workspace_id,
      // A recognised Git push names the branch or the tag it deployed (spec 6.3).
      trigger: provider.kind === "deploy" ? (tag ? "tag" : "push") : "webhook",
      requestedBy: null,
      ...(title ? { title } : {}),
      commit,
      tag,
    });
    await recordAudit(
      db,
      services.log,
      { kind: "system", label: "deploy webhook" },
      {
        action: "service.deploy-requested",
        workspaceId: service.workspace_id,
        target: { kind: "service", id: service.id },
        details: { deploymentId: result.deployment.id, via: "webhook", replaced: result.replaced },
      },
    );
    return c.json(
      {
        deployed: true,
        deploymentId: result.deployment.id,
        queued: result.waiting,
        replaced: result.replaced,
        message: result.replaced
          ? "A deploy was already waiting; it now uses this call."
          : result.waiting
            ? "Deploy queued after the running one."
            : "Deploy started.",
      },
      202,
    );
  });

  return app;
}
