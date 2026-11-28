import type { HttpFetch } from "../services.ts";
import { joinUrl, ProviderError, providerRequest } from "./http.ts";
import type { OAuthSecrets, OAuthSettings } from "./records.ts";

/**
 * OAuth for GitLab and Gitea (spec 16.3, 16.5): the authorization address the person is sent to,
 * exchanging the code for tokens, and refreshing them before they run out. Token calls go to the
 * internal URL when one is set (a self-hosted host on a private address); the person's browser
 * always goes to the public URL.
 */

export type OAuthKind = "gitlab" | "gitea";

const LABELS: Record<OAuthKind, string> = { gitlab: "GitLab", gitea: "Gitea" };

const PATHS: Record<OAuthKind, { authorize: string; token: string; scope: string | null }> = {
  // api: reading repositories and adding the deploy webhook; read_user: who connected.
  gitlab: { authorize: "/oauth/authorize", token: "/oauth/token", scope: "api read_user" },
  gitea: { authorize: "/login/oauth/authorize", token: "/login/oauth/access_token", scope: null },
};

export function apiBase(settings: Pick<OAuthSettings, "url" | "internalUrl">): string {
  return settings.internalUrl || settings.url;
}

export function authorizeAddress(
  kind: OAuthKind,
  settings: Pick<OAuthSettings, "url" | "clientId">,
  redirectUri: string,
  state: string,
): string {
  const query = new URLSearchParams({
    client_id: settings.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    state,
  });
  const scope = PATHS[kind].scope;
  if (scope) query.set("scope", scope);
  return `${joinUrl(settings.url, PATHS[kind].authorize)}?${query.toString()}`;
}

function tokensFrom(json: Record<string, unknown> | null, now: number): OAuthSecrets {
  const accessToken = typeof json?.access_token === "string" ? json.access_token : "";
  if (!accessToken) throw new ProviderError("failed", "The provider's answer had no access token.");
  const expiresIn = Number(json?.expires_in ?? 0);
  return {
    accessToken,
    ...(typeof json?.refresh_token === "string" && json.refresh_token
      ? { refreshToken: json.refresh_token }
      : {}),
    ...(expiresIn > 0 ? { expiresAt: now + expiresIn * 1000 } : {}),
  };
}

async function tokenCall(
  http: HttpFetch,
  kind: OAuthKind,
  settings: OAuthSettings,
  form: Record<string, string>,
  now: number,
  refusal: string,
): Promise<OAuthSecrets> {
  const answer = await providerRequest(http, LABELS[kind], {
    method: "POST",
    url: joinUrl(apiBase(settings), PATHS[kind].token),
    form,
    allow: [400, 401, 403],
  });
  if (answer.status >= 400) throw new ProviderError("credentials", refusal, answer.status);
  return tokensFrom(answer.json, now);
}

export function exchangeCode(
  http: HttpFetch,
  kind: OAuthKind,
  settings: OAuthSettings,
  clientSecret: string,
  code: string,
  redirectUri: string,
  now: number,
): Promise<OAuthSecrets> {
  return tokenCall(
    http,
    kind,
    settings,
    {
      client_id: settings.clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    },
    now,
    `${LABELS[kind]} refused the authorization. Check the ${kind === "gitlab" ? "Application ID and secret" : "Client ID and secret"} and that the redirect URI matches, then authorize again.`,
  );
}

export function refreshTokens(
  http: HttpFetch,
  kind: OAuthKind,
  settings: OAuthSettings,
  secrets: OAuthSecrets,
  redirectUri: string,
  now: number,
): Promise<OAuthSecrets> {
  return tokenCall(
    http,
    kind,
    settings,
    {
      client_id: settings.clientId,
      client_secret: secrets.clientSecret ?? "",
      refresh_token: secrets.refreshToken ?? "",
      grant_type: "refresh_token",
      redirect_uri: redirectUri,
    },
    now,
    `${LABELS[kind]} ended this connection's authorization. Choose Reconnect in Settings → Git providers.`,
  );
}

/**
 * The current access token of one provider, refreshed a minute before it expires and saved
 * back (refresh tokens are used once, so concurrent callers share one refresh).
 */
export class TokenSource {
  #pending: Promise<string> | null = null;

  constructor(
    private readonly http: HttpFetch,
    private readonly kind: OAuthKind,
    private readonly settings: OAuthSettings,
    private secrets: OAuthSecrets,
    private readonly redirectUri: string | null,
    private readonly save: (secrets: OAuthSecrets) => Promise<void>,
    private readonly now: () => number,
  ) {}

  async token(): Promise<string> {
    const { accessToken, expiresAt, refreshToken } = this.secrets;
    if (!accessToken) {
      throw new ProviderError(
        "credentials",
        `This ${LABELS[this.kind]} connection isn't authorized yet. Choose Authorize in Settings → Git providers.`,
      );
    }
    if (!expiresAt || expiresAt - 60_000 > this.now() || !refreshToken) return accessToken;
    this.#pending ??= (async () => {
      try {
        const next = await refreshTokens(
          this.http,
          this.kind,
          this.settings,
          this.secrets,
          this.redirectUri ?? "",
          this.now(),
        );
        this.secrets = { ...this.secrets, ...next };
        await this.save(this.secrets);
        return next.accessToken as string;
      } finally {
        this.#pending = null;
      }
    })();
    return this.#pending;
  }
}
