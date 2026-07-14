import {
	consumeManagedGitProviderState,
	createGitlab,
	getManagedGitlabConfig,
	getManagedGitProviderCallbackBaseUrl,
	isHostedEditionMode,
	isManagedGitProviderState,
	updateGitlab,
} from "@nearzero/server";
import { db } from "@nearzero/server/db";
import { eq } from "drizzle-orm";
import { parseGitProviderBaseUrl } from "@/server/api/utils/git-provider-url-security";
import { gitlab } from "@/server/db/schema";
import { consumeByoGitProviderTargetState } from "@/server/routes/handlers/providers/byo-oauth-state";
import type { ApiRequest, ApiResponse } from "@/server/types/api";

function redirectWithError(res: ApiResponse, error: string) {
	return res.redirect(
		307,
		`/dashboard/settings/git-providers?error=${encodeURIComponent(error)}`,
	);
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
	const { code, state } = req.query;

	if (!code || Array.isArray(code)) {
		return res.status(400).json({ error: "Missing or invalid code" });
	}

	const managedStateToken = typeof state === "string" ? state : "";
	if (isManagedGitProviderState(managedStateToken)) {
		const managedState = await consumeManagedGitProviderState(
			managedStateToken,
			"gitlab",
		);
		const config = getManagedGitlabConfig();
		const tokenBaseUrl = config.gitlabInternalUrl || config.gitlabUrl;
		const response = await fetch(`${tokenBaseUrl}/oauth/token`, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				client_id: config.clientId,
				client_secret: config.clientSecret,
				code: code as string,
				grant_type: "authorization_code",
				redirect_uri: `${getManagedGitProviderCallbackBaseUrl()}/api/providers/gitlab/callback`,
			}),
		});
		const result = await response.json();

		if (!result.access_token || !result.refresh_token) {
			return redirectWithError(
				res,
				"Missing or invalid GitLab authorization code",
			);
		}

		const expiresAt = Math.floor(Date.now() / 1000) + result.expires_in;
		await createGitlab(
			{
				name: "GitLab",
				gitlabUrl: config.gitlabUrl,
				gitlabInternalUrl: config.gitlabInternalUrl,
				applicationId: config.clientId,
				redirectUri: `${getManagedGitProviderCallbackBaseUrl()}/api/providers/gitlab/callback`,
				accessToken: result.access_token,
				refreshToken: result.refresh_token,
				expiresAt,
				authId: managedState.userId,
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
			"Cloud/Enterprise workspaces connect GitLab with the Nearzero-managed app.",
		);
	}

	if (typeof state !== "string") {
		return redirectWithError(res, "Invalid GitLab authorization state");
	}

	try {
		const { state: byoState, provider } =
			await consumeByoGitProviderTargetState(state, "gitlab");
		const integration = await db.query.gitlab.findFirst({
			where: eq(gitlab.gitProviderId, provider.gitProviderId),
		});
		if (
			!integration?.applicationId ||
			!integration.secret ||
			!integration.redirectUri
		) {
			return redirectWithError(res, "Incomplete GitLab OAuth configuration");
		}

		const tokenBaseUrl = parseGitProviderBaseUrl(
			integration.gitlabInternalUrl || integration.gitlabUrl,
			"GitLab token URL",
		);
		const headers: HeadersInit = {
			"Content-Type": "application/x-www-form-urlencoded",
		};
		const tokenUrl = `${tokenBaseUrl}/oauth/token`;
		const response = await fetch(tokenUrl, {
			method: "POST",
			headers,
			body: new URLSearchParams({
				client_id: integration.applicationId,
				client_secret: integration.secret,
				code: code as string,
				grant_type: "authorization_code",
				redirect_uri: integration.redirectUri,
			}),
		});
		const result = await response.json();
		if (!result.access_token || !result.refresh_token) {
			return redirectWithError(
				res,
				"Missing or invalid GitLab authorization code",
			);
		}

		const expiresAt = Math.floor(Date.now() / 1000) + result.expires_in;
		await updateGitlab(integration.gitlabId, {
			accessToken: result.access_token,
			refreshToken: result.refresh_token,
			expiresAt,
		});

		return res.redirect(
			307,
			byoState.returnTo || "/dashboard/settings/git-providers?connected=true",
		);
	} catch {
		return redirectWithError(
			res,
			"Invalid or expired GitLab authorization state",
		);
	}
}
