import { AppError, GIT_PROVIDER_LABELS, WEBHOOK_AUTODEPLOY_OFF } from "@nearzero/shared";
import { sql } from "kysely";
import { recordAudit } from "../audit/audit.ts";
import { requestDeploy } from "../deploys/queue.ts";
import { isOurId } from "../projects/objects.ts";
import { readAppSettings } from "../service-runtime/app-settings.ts";
import type { ControlServices } from "../services.ts";
import { pingAnswer } from "../webhooks/calls.ts";
import { type PushDecision, shouldDeployPush } from "../webhooks/push-rules.ts";
import { clientFor } from "./clients.ts";
import { applyInstallationEvent } from "./connect.ts";
import { type ParsedPushes, type ProviderPush, parsePushes } from "./events.ts";
import { type GithubSecrets, openProviderSecrets, type ProviderRow } from "./records.ts";
import { verifyGithubSignature, verifyProviderCall } from "./signatures.ts";
import { hookSecret, type ProviderSource, providerSourceOf } from "./sources.ts";

/**
 * Push deploys from connected providers (spec 6.6, 16.2, 16.6, 24 G4): GitHub through the app's
 * own webhook, GitLab, Bitbucket and Gitea through each service's deploy webhook URL with the
 * host's secret or signature checked on the raw body first. The trigger (On push / On tag) and
 * watch paths decide with the deploy engine's shouldDeployPush; the deploy queue keeps one deploy
 * running and one waiting, so pushes during a deploy queue exactly one more and none is lost.
 */

export const SIGNATURE_REFUSED =
  "The webhook's signature doesn't match. It wasn't sent by the Git host with this service's secret.";

function sameRepository(source: ProviderSource, repository: ParsedPushes["repository"]): boolean {
  if (repository.id && source.repositoryId && repository.id === source.repositoryId) return true;
  return (
    repository.fullName !== null &&
    repository.fullName.toLowerCase() === source.repository.toLowerCase()
  );
}

/** One service's decision over the refs in one push (Bitbucket can send several). */
export async function decideForSource(
  services: ControlServices,
  provider: ProviderRow | null,
  source: ProviderSource,
  pushes: readonly ProviderPush[],
): Promise<(PushDecision & { subject?: string | null }) | { deploy: false; reason: string }> {
  let last: PushDecision = { deploy: false, reason: "The push changed no branch or tag." };
  const rules = { trigger: source.trigger, branch: source.branch, watchPaths: source.watchPaths };
  for (const push of pushes) {
    let decision = shouldDeployPush(rules, push);
    if (
      decision.deploy &&
      source.watchPaths.length > 0 &&
      !push.files &&
      push.before &&
      push.commit &&
      provider
    ) {
      // Bitbucket doesn't list the files a push touched; ask for them before deploying.
      try {
        const client = clientFor(services, provider);
        if (client.changedFiles) {
          const repository = await client.getRepository(source.repository);
          const files = await client.changedFiles(repository, push.before, push.commit);
          if (files) {
            decision = shouldDeployPush(rules, {
              ...push,
              files: { added: [], modified: files, removed: [] },
            });
          }
        }
      } catch {
        // Without the list, the push deploys (the watch paths can't be checked).
      }
    }
    if (decision.deploy) return { ...decision, subject: push.subject };
    last = decision;
  }
  return last;
}

async function deliveredBefore(
  services: ControlServices,
  providerId: string,
  deliveryId: string | null,
): Promise<boolean> {
  if (!deliveryId) return false;
  await services.db
    .deleteFrom("git_push_delivery")
    .where("received_at", "<", sql<Date>`now() - interval '1 day'`)
    .execute();
  const inserted = await services.db
    .insertInto("git_push_delivery")
    .values({ provider_id: providerId, delivery_id: deliveryId.slice(0, 100) })
    .onConflict((conflict) => conflict.doNothing())
    .returning("delivery_id")
    .executeTakeFirst();
  return inserted === undefined;
}

export interface GithubWebhookResult {
  status: 200 | 202;
  body: Record<string, unknown>;
}

/** POST /webhooks/github/:providerId: the GitHub App's events (spec 16.2). */
export async function handleGithubWebhook(
  services: ControlServices,
  providerId: string,
  headers: Headers,
  raw: Uint8Array,
): Promise<GithubWebhookResult> {
  const row = isOurId(providerId)
    ? await services.db
        .selectFrom("git_provider")
        .selectAll()
        .where("id", "=", providerId)
        .where("kind", "=", "github")
        .executeTakeFirst()
    : undefined;
  let secret = "";
  if (row) {
    try {
      secret = openProviderSecrets<GithubSecrets>(services, row).webhookSecret ?? "";
    } catch {
      secret = "";
    }
  }
  // Checked before anything else, also when no provider matches, in the same time.
  const valid = verifyGithubSignature(
    secret || "no provider has this id",
    raw,
    headers.get("x-hub-signature-256"),
  );
  if (!row || !valid || !secret) throw new AppError("unauthenticated", SIGNATURE_REFUSED);
  let body: unknown = null;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new AppError("invalid_request", "The webhook body isn't JSON.");
  }
  const event = headers.get("x-github-event") ?? "";
  if (event === "ping") return { status: 200, body: { ok: true, message: "Pong" } };
  if (event === "installation" || event === "installation_repositories") {
    const value = body as {
      action?: string;
      installation?: { id?: number; account?: { login?: string } };
    };
    await applyInstallationEvent(services, row, {
      action: String(value.action ?? ""),
      installationId: typeof value.installation?.id === "number" ? value.installation.id : null,
      account: value.installation?.account?.login ?? null,
    });
    return { status: 200, body: { ok: true } };
  }
  if (event !== "push") return { status: 200, body: { ok: true, ignored: event } };
  const installation = (body as { installation?: { id?: number } }).installation?.id;
  if (row.installation_id && installation && Number(row.installation_id) !== installation) {
    return { status: 200, body: { ok: true, ignored: "another installation" } };
  }
  const delivery = headers.get("x-github-delivery");
  if (await deliveredBefore(services, row.id, delivery)) {
    return { status: 200, body: { ok: true, duplicate: true } };
  }
  let results: ServiceResult[];
  try {
    const parsed = parsePushes("github", body, headers);
    results = await deployMatchingServices(services, row, parsed, "GitHub");
  } catch (error) {
    // Not handled after all: forget the delivery, so GitHub's Redeliver deploys it.
    await forgetDelivery(services, row.id, delivery).catch(() => {});
    throw error;
  }
  return {
    status: results.some((item) => item.deployed) ? 202 : 200,
    body: { ok: true, services: results },
  };
}

async function forgetDelivery(
  services: ControlServices,
  providerId: string,
  deliveryId: string | null,
): Promise<void> {
  if (!deliveryId) return;
  await services.db
    .deleteFrom("git_push_delivery")
    .where("provider_id", "=", providerId)
    .where("delivery_id", "=", deliveryId.slice(0, 100))
    .execute();
}

interface ServiceResult {
  serviceId: string;
  deployed: boolean;
  deploymentId?: string;
  queued?: boolean;
  message: string;
}

/** Every service of the provider's workspace that deploys this repository through it. */
async function deployMatchingServices(
  services: ControlServices,
  provider: ProviderRow,
  parsed: ParsedPushes,
  via: string,
): Promise<ServiceResult[]> {
  const candidates = await services.db
    .selectFrom("service")
    .select(["id", "workspace_id", "settings", "deleting_run_id"])
    .where("workspace_id", "=", provider.workspace_id)
    .where("kind", "in", ["application", "compose"])
    .where(sql<boolean>`settings -> 'source' ->> 'type' = 'provider'`)
    .where(sql<boolean>`settings -> 'source' ->> 'providerId' = ${provider.id}`)
    .execute();
  const results: ServiceResult[] = [];
  for (const service of candidates) {
    const source = providerSourceOf(service.settings);
    if (!source || !sameRepository(source, parsed.repository)) continue;
    if (service.deleting_run_id) continue;
    if (!readAppSettings(service.settings).deploy.autodeploy) {
      results.push({ serviceId: service.id, deployed: false, message: WEBHOOK_AUTODEPLOY_OFF });
      continue;
    }
    const decision = await decideForSource(services, provider, source, parsed.pushes);
    if (!decision.deploy) {
      results.push({ serviceId: service.id, deployed: false, message: decision.reason });
      continue;
    }
    try {
      const subject = "subject" in decision ? decision.subject : null;
      const result = await requestDeploy(services.db, {
        serviceId: service.id,
        workspaceId: service.workspace_id,
        trigger: decision.tag ? "tag" : "push",
        requestedBy: null,
        ...(subject ? { title: subject.slice(0, 300) } : {}),
        commit: decision.commit,
        tag: decision.tag,
      });
      await recordAudit(
        services.db,
        services.log,
        { kind: "system", label: `${via} push` },
        {
          action: "service.deploy-requested",
          workspaceId: service.workspace_id,
          target: { kind: "service", id: service.id },
          details: {
            deploymentId: result.deployment.id,
            via: provider.kind,
            replaced: result.replaced,
          },
        },
      );
      results.push({
        serviceId: service.id,
        deployed: true,
        deploymentId: result.deployment.id,
        queued: result.waiting,
        message: result.replaced
          ? "A deploy was already waiting; it now uses this push."
          : result.waiting
            ? "Deploy queued after the running one."
            : "Deploy started.",
      });
    } catch (error) {
      // A refusal (the service is being deleted, say) is that service's answer; anything else
      // fails the whole delivery, so it can be delivered again.
      if (!(error instanceof AppError)) throw error;
      results.push({ serviceId: service.id, deployed: false, message: error.message });
    }
  }
  return results;
}

export type ProviderCallVerdict =
  | { kind: "generic" }
  | { kind: "ignored"; message: string }
  | { kind: "deploy"; commit: string | null; tag: string | null; title: string | null };

/**
 * For the service's deploy webhook (webhooks/routes.ts). A service linked to GitLab, Bitbucket or
 * Gitea through a connected account gets a secret of its own for its webhook (16.6); once it has
 * one, every call must carry it, checked on the raw bytes, whatever headers the call has (24 G4):
 * leaving the host's event header out doesn't make a call a generic one. Then its push decides.
 *
 * Without such a secret (a webhook carried over from 0.1.x, which someone added at the Git host
 * by hand, spec 29.5), the URL's token is the credential, as for every generic webhook, and the
 * call is read as one; the service's Source panel and the move report ask for Register webhook.
 * Throws 401 for a wrong or missing signature.
 */
export async function providerCallVerdict(
  services: ControlServices,
  service: { id: string; workspace_id: string; settings: Record<string, unknown> | null },
  headers: Headers,
  raw: Uint8Array,
  body: unknown,
): Promise<ProviderCallVerdict> {
  const source = providerSourceOf(service.settings);
  if (!source || source.provider === "github") return { kind: "generic" };
  const label = GIT_PROVIDER_LABELS[source.provider];
  const registered = await services.db
    .selectFrom("git_service_hook")
    .select("service_id")
    .where("service_id", "=", service.id)
    .executeTakeFirst();
  if (!registered) return { kind: "generic" };
  const hook = await hookSecret(services, service.id);
  if (!hook) {
    throw new AppError(
      "unauthenticated",
      `This service's ${label} webhook secret can't be read any more. Register the webhook again on its Source panel.`,
    );
  }
  if (!verifyProviderCall(source.provider, hook.secret, raw, headers)) {
    throw new AppError("unauthenticated", SIGNATURE_REFUSED);
  }
  const parsed = parsePushes(source.provider, body, headers);
  if (parsed.event === "ping") return { kind: "ignored", message: pingAnswer() };
  if (parsed.event !== "push") {
    return { kind: "ignored", message: `Only push events deploy; ${label} sent another event.` };
  }
  if (!sameRepository(source, parsed.repository)) {
    return {
      kind: "ignored",
      message: `The push was to ${parsed.repository.fullName ?? "another repository"}; this service deploys ${source.repository}.`,
    };
  }
  const provider = source.providerId
    ? ((await services.db
        .selectFrom("git_provider")
        .selectAll()
        .where("id", "=", source.providerId)
        .where("workspace_id", "=", service.workspace_id)
        .executeTakeFirst()) ?? null)
    : null;
  const decision = await decideForSource(services, provider, source, parsed.pushes);
  if (!decision.deploy) return { kind: "ignored", message: decision.reason };
  return {
    kind: "deploy",
    commit: decision.commit,
    tag: decision.tag,
    title: "subject" in decision ? (decision.subject ?? null) : null,
  };
}
