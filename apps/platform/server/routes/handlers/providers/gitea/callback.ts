import {
	consumeManagedGitProviderState,
	createGitea,
	getManagedGiteaConfig,
	getManagedGitProviderCallbackBaseUrl,
	isHostedEditionMode,
	isManagedGitProviderState,
	updateGitea,
} from "@nearzero/server";
import { db } from "@nearzero/server/db";
import { eq } from "drizzle-orm";
import { parseGitProviderBaseUrl } from "@/server/api/utils/git-provider-url-security";
import { gitea } from "@/server/db/schema";
import { consumeByoGitProviderTargetState } from "@/server/routes/handlers/providers/byo-oauth-state";
import type { ApiRequest, ApiResponse } from "@/server/types/api";
import { type Gitea, redirectWithError } from "./helper";

// Helper to fetch access token from Gitea
const fetchAccessToken = async (gitea: Gitea, code: string) => {
	// Use internal URL for token exchange when Gitea is on same instance as Nearzero
	const baseUrl = parseGitProviderBaseUrl(
		gitea.giteaInternalUrl || gitea.giteaUrl,
		"Gitea token URL",
	);
	const response = await fetch(`${baseUrl}/login/oauth/access_token`, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		},
		body: new URLSearchParams({
			client_id: gitea.clientId as string,
			client_secret: gitea.clientSecret as string,
			code,
			grant_type: "authorization_code",
			redirect_uri: gitea.redirectUri || "",
		}),
	});

	const responseText = await response.text();
	return response.ok
		? JSON.parse(responseText)
		: { error: "Token exchange failed" };
};

export default async function handler(req: ApiRequest, res: ApiResponse) {
	const { code, state } = req.query;

	if (!code || Array.isArray(code) || !state || Array.isArray(state)) {
		return redirectWithError(
			res,
			"Invalid authorization code or state parameter",
		);
	}

	if (isManagedGitProviderState(state)) {
		const managedState = await consumeManagedGitProviderState(state, "gitea");
		const config = getManagedGiteaConfig();
		const result = await fetchAccessToken(
			{
				giteaId: "",
				gitProviderId: "",
				giteaUrl: config.giteaUrl,
				giteaInternalUrl: config.giteaInternalUrl ?? null,
				clientId: config.clientId,
				clientSecret: config.clientSecret,
				redirectUri: `${getManagedGitProviderCallbackBaseUrl()}/api/providers/gitea/callback`,
				accessToken: null,
				refreshToken: null,
				expiresAt: null,
				gitProvider: {
					name: "Gitea",
					gitProviderId: "",
					providerType: "gitea",
					createdAt: new Date().toISOString(),
					organizationId: managedState.organizationId,
				},
			},
			code as string,
		);

		if (result.error || !result.access_token) {
			return redirectWithError(res, result.error || "No access token received");
		}

		const expiresAt = result.expires_in
			? Math.floor(Date.now() / 1000) + result.expires_in
			: undefined;

		await createGitea(
			{
				name: "Gitea",
				giteaUrl: config.giteaUrl,
				giteaInternalUrl: config.giteaInternalUrl,
				clientId: config.clientId,
				redirectUri: `${getManagedGitProviderCallbackBaseUrl()}/api/providers/gitea/callback`,
				accessToken: result.access_token,
				refreshToken: result.refresh_token,
				expiresAt,
				scopes: config.scope ?? undefined,
			},
			managedState.organizationId,
			managedState.userId,
			{ connectionMode: "nearzero_managed" },
		);

		return res.redirect(
			307,
			managedState.returnTo ||
				"/dashboard/settings/git-providers?connected=true",
		);
	}

	if (isHostedEditionMode()) {
		return redirectWithError(
			res,
			"Cloud/Enterprise workspaces connect Gitea with the Nearzero-managed app.",
		);
	}

	try {
		const { state: byoState, provider } =
			await consumeByoGitProviderTargetState(state, "gitea");
		const integration = await db.query.gitea.findFirst({
			where: eq(gitea.gitProviderId, provider.gitProviderId),
			with: { gitProvider: true },
		});
		if (!integration) {
			return redirectWithError(res, "Gitea provider not found");
		}

		const result = await fetchAccessToken(integration, code as string);
		if (result.error || !result.access_token) {
			return redirectWithError(res, "Gitea token exchange failed");
		}
		const expiresAt = result.expires_in
			? Math.floor(Date.now() / 1000) + result.expires_in
			: null;

		await updateGitea(integration.giteaId, {
			accessToken: result.access_token,
			refreshToken: result.refresh_token,
			expiresAt,
			...(result.organizationName
				? { organizationName: result.organizationName }
				: {}),
		});

		return res.redirect(
			307,
			byoState.returnTo || "/dashboard/settings/git-providers?connected=true",
		);
	} catch {
		return redirectWithError(
			res,
			"Invalid or expired Gitea authorization state",
		);
	}
}
