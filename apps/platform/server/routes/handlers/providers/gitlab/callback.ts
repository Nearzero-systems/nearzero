import {
	consumeManagedGitProviderState,
	createGitlab,
	findGitlabById,
	getManagedGitProviderCallbackBaseUrl,
	getManagedGitlabConfig,
	isHostedEditionMode,
	isManagedGitProviderState,
	updateGitlab,
} from "@nearzero/server";
import type { ApiRequest, ApiResponse } from "@/server/types/api";

function redirectWithError(res: ApiResponse, error: string) {
	return res.redirect(
		307,
		`/dashboard/settings/git-providers?error=${encodeURIComponent(error)}`,
	);
}

export default async function handler(
	req: ApiRequest,
	res: ApiResponse,
) {
	const { code, gitlabId, state } = req.query;

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
			return redirectWithError(res, "Missing or invalid GitLab authorization code");
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
			managedState.returnTo || "/dashboard/settings/git-providers?connected=true",
		);
	}

	if (isHostedEditionMode()) {
		return redirectWithError(
			res,
			"Cloud/Enterprise workspaces connect GitLab with the Nearzero-managed app.",
		);
	}

	const gitlab = await findGitlabById(gitlabId as string);
	// Use internal URL for token exchange when GitLab is on same instance as Nearzero
	const baseUrl = gitlab.gitlabInternalUrl || gitlab.gitlabUrl;
	const gitlabUrl = new URL(baseUrl);

	const headers: HeadersInit = {
		"Content-Type": "application/x-www-form-urlencoded",
	};

	// In case of basic auth being present in the URL, we need to remove it from the URL
	// and add it to the Authorization header.
	if (gitlabUrl.username && gitlabUrl.password) {
		headers.Authorization = `Basic ${Buffer.from(`${gitlabUrl.username}:${gitlabUrl.password}`).toString("base64")}`;
	}

	const url =
		gitlabUrl.username && gitlabUrl.password
			? new URL(gitlabUrl, {
					...gitlabUrl,
					username: "",
					password: "",
				}).toString()
			: gitlabUrl.toString();

	const response = await fetch(`${url}/oauth/token`, {
		method: "POST",
		headers,
		body: new URLSearchParams({
			client_id: gitlab.applicationId as string,
			client_secret: gitlab.secret as string,
			code: code as string,
			grant_type: "authorization_code",
			redirect_uri: `${gitlab.redirectUri}?gitlabId=${gitlabId}`,
		}),
	});

	const result = await response.json();

	if (!result.access_token || !result.refresh_token) {
		return res.status(400).json({ error: "Missing or invalid code" });
	}

	const expiresAt = Math.floor(Date.now() / 1000) + result.expires_in;
	await updateGitlab(gitlab.gitlabId, {
		accessToken: result.access_token,
		refreshToken: result.refresh_token,
		expiresAt,
	});

	return res.redirect(307, "/dashboard/settings/git-providers?connected=true");
}
