import { AppError, DEPLOY_WEBHOOK_PATH } from "@nearzero/shared";
import type { Db } from "../db/database.ts";
import { constantTimeEqual, randomToken, sha256Hex } from "../security/tokens.ts";
import type { ControlServices } from "../services.ts";

/**
 * Generic deploy webhook tokens (spec 6.6, 24 G4): nzw1.<webhook id>.<secret>. The secret's
 * SHA-256 checks a call, in constant time also when no webhook matches; a sealed copy lets
 * people with deploy rights show the URL again. Replacing the token makes the old URL answer 401.
 */

export const WEBHOOK_TOKEN_PREFIX = "nzw1";
const TOKEN = /^nzw1\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{20,128})$/;
/** A deploy webhook token imported from 0.1.x: long enough to be a secret, safe in a URL. */
export const IMPORTED_TOKEN = /^(?!nzw1\.)[A-Za-z0-9._~-]{16,256}$/;
/** Compared against when no webhook matches, so a wrong id costs the same time. */
const NO_MATCH_HASH = sha256Hex("no webhook has this id");

function sealContext(serviceId: string): string {
  return `service:${serviceId}:deploy-webhook`;
}

export function webhookUrl(services: ControlServices, token: string): string {
  // NEARZERO_GIT_PUBLIC_URL (0.1.x's PUBLIC_GIT_PROVIDER_BASE_URL) when set (31d G4-19).
  const base = services.gitPublicUrl() ?? "";
  return `${base.replace(/\/+$/, "")}${DEPLOY_WEBHOOK_PATH}/${token}`;
}

/** Makes a new token for the service, replacing any earlier one. Returns the token. */
export async function replaceWebhookToken(
  services: ControlServices,
  service: { id: string; workspace_id: string },
  personId: string,
): Promise<string> {
  const id = crypto.randomUUID();
  const secret = randomToken(32);
  const token = `${WEBHOOK_TOKEN_PREFIX}.${id}.${secret}`;
  await services.db.transaction().execute(async (trx) => {
    await trx.deleteFrom("deploy_webhook").where("service_id", "=", service.id).execute();
    await trx
      .insertInto("deploy_webhook")
      .values({
        id,
        service_id: service.id,
        workspace_id: service.workspace_id,
        secret_hash: sha256Hex(secret),
        token_sealed: services.secrets.seal(token, sealContext(service.id)),
        created_by: personId,
      })
      .execute();
  });
  return token;
}

/** The service's current token, or null when it has none (or it can't be opened any more). */
export async function currentWebhookToken(
  services: ControlServices,
  serviceId: string,
): Promise<{ token: string | null; createdAt: Date; lastCalledAt: Date | null } | null> {
  const row = await services.db
    .selectFrom("deploy_webhook")
    .select(["token_sealed", "created_at", "last_called_at"])
    .where("service_id", "=", serviceId)
    .executeTakeFirst();
  if (!row) return null;
  const opened = services.secrets.open(row.token_sealed, sealContext(serviceId));
  return {
    token: opened.ok ? opened.value : null,
    createdAt: row.created_at,
    lastCalledAt: row.last_called_at,
  };
}

/** The service a token belongs to, or null (wrong, replaced or malformed: all the same). */
export async function serviceOfToken(
  db: Db,
  token: string,
): Promise<{ serviceId: string; webhookId: string } | null> {
  const match = TOKEN.exec(token);
  // A token carried over from 0.1.x (spec 29.5) keeps its own shape; it is stored like a secret,
  // as the SHA-256 of the whole token, and found by that hash.
  const imported = !match && IMPORTED_TOKEN.test(token);
  const row = match
    ? await db
        .selectFrom("deploy_webhook")
        .select(["id", "service_id", "secret_hash"])
        .where("id", "=", match[1] as string)
        .executeTakeFirst()
    : imported
      ? await db
          .selectFrom("deploy_webhook")
          .select(["id", "service_id", "secret_hash"])
          .where("secret_hash", "=", sha256Hex(token))
          .executeTakeFirst()
      : undefined;
  const given = sha256Hex(match?.[2] ?? token);
  const ok = constantTimeEqual(given, row?.secret_hash ?? NO_MATCH_HASH) && row !== undefined;
  return ok && row ? { serviceId: row.service_id, webhookId: row.id } : null;
}

/** Upload sources have no deploy webhook (30b R2-03): there is nothing to redeploy from. */
export const WEBHOOK_UPLOAD_SOURCE =
  "Apps from an uploaded archive have no deploy webhook: upload a new archive to deploy one.";

export const WEBHOOK_REFUSED = new AppError(
  "unauthenticated",
  "This webhook URL isn't valid. It may have been replaced; copy the current one from the service's Settings tab.",
);
