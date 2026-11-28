import { AppError } from "@nearzero/shared";
import { sql } from "kysely";
import type { ControlServices } from "../services.ts";
import { BitbucketClient } from "./bitbucket.ts";
import type { ProviderClient } from "./client.ts";
import { GiteaClient } from "./gitea.ts";
import { GithubClient } from "./github.ts";
import { GitlabClient } from "./gitlab.ts";
import { ProviderError } from "./http.ts";
import { type OAuthKind, TokenSource } from "./oauth.ts";
import {
  type BitbucketSecrets,
  type BitbucketSettings,
  consoleAddress,
  type GithubSecrets,
  type GithubSettings,
  type OAuthSecrets,
  type OAuthSettings,
  oauthCallbackPath,
  openProviderSecrets,
  type ProviderRow,
  sealProviderSecrets,
  settingsOf,
} from "./records.ts";

/** A ready client for one stored provider, with refreshed tokens saved back. */

export const GITHUB_NOT_INSTALLED =
  "The GitHub App isn't installed yet. Choose Install in Settings → Git providers.";

/** The redirect address sent to GitLab or Gitea: 1.0's, or 0.1.x's for a moved connection. */
export function redirectUriFor(
  services: ControlServices,
  kind: OAuthKind,
  settings?: Partial<OAuthSettings> | null,
): string | null {
  if (settings?.legacyCallback && settings.redirectUri) return settings.redirectUri;
  return consoleAddress(services, oauthCallbackPath(kind, settings));
}

/**
 * One token source per saved connection while its stored secrets stay the same (B1-41): a
 * refresh token is good for one use, so parallel deploys and reads near expiry must share one
 * refresh rather than each spending it. The next client after the save starts from the new row.
 */
const sharedSources = new Map<string, { stamp: string; source: TokenSource }>();

export function oauthClient(
  services: ControlServices,
  kind: OAuthKind,
  settings: OAuthSettings,
  secrets: OAuthSecrets,
  login: string | null,
  save: (secrets: OAuthSecrets) => Promise<void> = async () => {},
  share?: { providerId: string; stamp: string },
): ProviderClient {
  const known = share ? sharedSources.get(share.providerId) : undefined;
  const source =
    known && known.stamp === share?.stamp
      ? known.source
      : new TokenSource(
          services.http,
          kind,
          settings,
          secrets,
          redirectUriFor(services, kind, settings),
          save,
          services.now,
        );
  if (share && source !== known?.source) {
    sharedSources.set(share.providerId, { stamp: share.stamp, source });
  }
  const token = () => source.token();
  return kind === "gitlab"
    ? new GitlabClient(services.http, settings, token)
    : new GiteaClient(services.http, settings, token, login);
}

export function clientFor(services: ControlServices, row: ProviderRow): ProviderClient {
  switch (row.kind) {
    case "github": {
      if (!row.installation_id) throw new ProviderError("credentials", GITHUB_NOT_INSTALLED);
      return new GithubClient(
        services.http,
        settingsOf<GithubSettings>(row),
        openProviderSecrets<GithubSecrets>(services, row),
        Number(row.installation_id),
        services.now,
      );
    }
    case "gitlab":
    case "gitea":
      return oauthClient(
        services,
        row.kind,
        settingsOf<OAuthSettings>(row),
        openProviderSecrets<OAuthSecrets>(services, row),
        row.account_login,
        async (secrets) => {
          await services.db
            .updateTable("git_provider")
            .set({
              secrets_sealed: sealProviderSecrets(services, row.id, secrets),
              updated_at: sql<Date>`now()`,
            })
            .where("id", "=", row.id)
            .execute();
        },
        { providerId: row.id, stamp: row.secrets_sealed ?? "" },
      );
    case "bitbucket":
      return new BitbucketClient(
        services.http,
        settingsOf<BitbucketSettings>(row),
        openProviderSecrets<BitbucketSecrets>(services, row),
      );
  }
}

/**
 * Runs a call against the host and turns its refusal into the API's error. A refused credential
 * is remembered on the provider so the list can say so.
 */
export async function withProvider<T>(
  services: ControlServices,
  row: ProviderRow,
  work: (client: ProviderClient) => Promise<T>,
): Promise<T> {
  try {
    return await work(clientFor(services, row));
  } catch (error) {
    if (error instanceof ProviderError) {
      if (error.failure === "credentials") {
        await services.db
          .updateTable("git_provider")
          .set({ last_error: error.message })
          .where("id", "=", row.id)
          .execute();
      }
      throw error.toAppError();
    }
    if (error instanceof AppError) throw error;
    throw error;
  }
}
