import {
	consumeManagedGitProviderState,
	createGitea,
	getManagedGitProviderCallbackBaseUrl,
	getManagedGiteaConfig,
	isHostedEditionMode,
	isManagedGitProviderState,
	updateGitea,
} from "@nearzero/server";
import type { ApiRequest, ApiResponse } from "@/server/types/api";
import { findGitea, type Gitea, redirectWithError } from "./helper";

// Helper to parse the state parameter
const parseState = (state: string): string | null => {
	try {
		const stateObj =
			state.startsWith("{") && state.endsWith("}") ? JSON.parse(state) : {};
		return stateObj.giteaId || state || null;
	} catch {
		return null;
	}
};

// Helper to fetch access token from Gitea
const fetchAccessToken = async (gitea: Gitea, code: string) => {
	// Use internal URL for token exchange when Gitea is on same instance as Nearzero
	const baseUrl = gitea.giteaInternalUrl || gitea.giteaUrl;
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
		: { error: "Token exchange failed", responseText };
};

export default async function handler(
	req: ApiRequest,
	res: ApiResponse,
) {
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
				scopes: config.scope,
			},
			managedState.organizationId,
			managedState.userId,
			{ connectionMode: "nearzero_managed" },
		);

		return res.redirect(
			307,
			managedState.returnTo || "/dashboard/settings/git-providers?connected=true",
		);
	}

	if (isHostedEditionMode()) {
		return redirectWithError(
			res,
			"Cloud/Enterprise workspaces connect Gitea with the Nearzero-managed app.",
		);
	}

	const giteaId = parseState(state as string);
	if (!giteaId) return redirectWithError(res, "Invalid state format");

	const gitea = await findGitea(giteaId);
	if (!gitea) return redirectWithError(res, "Failed to find Gitea provider");

	// Fetch the access token from Gitea
	const result = await fetchAccessToken(gitea, code as string);

	if (result.error) {
		console.error("Token exchange failed:", result);
		return redirectWithError(res, result.error);
	}

	if (!result.access_token) {
		console.error("Missing access token:", result);
		return redirectWithError(res, "No access token received");
	}

	const expiresAt = result.expires_in
		? Math.floor(Date.now() / 1000) + result.expires_in
		: null;

	try {
		await updateGitea(gitea.giteaId, {
			accessToken: result.access_token,
			refreshToken: result.refresh_token,
			expiresAt,
			...(result.organizationName
				? { organizationName: result.organizationName }
				: {}),
		});

		return res.redirect(
			307,
			"/dashboard/settings/git-providers?connected=true",
		);
	} catch (updateError) {
		console.error("Failed to update Gitea provider:", updateError);
		return redirectWithError(res, "Failed to store access token");
	}
}
