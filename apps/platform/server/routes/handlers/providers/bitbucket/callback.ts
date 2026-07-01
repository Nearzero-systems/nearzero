import {
	consumeManagedGitProviderState,
	createBitbucket,
	getManagedBitbucketConfig,
	getManagedGitProviderCallbackBaseUrl,
	isManagedGitProviderState,
} from "@nearzero/server";
import type { ApiRequest, ApiResponse } from "@/server/types/api";

function redirectWithError(res: ApiResponse, error: string) {
	return res.redirect(
		307,
		`/dashboard/settings/git-providers?error=${encodeURIComponent(error)}`,
	);
}

async function readBitbucketAccount(accessToken: string) {
	const headers = { Authorization: `Bearer ${accessToken}` };
	const [userResponse, workspacesResponse] = await Promise.all([
		fetch("https://api.bitbucket.org/2.0/user", { headers }).catch(() => null),
		fetch("https://api.bitbucket.org/2.0/workspaces?role=member&pagelen=1", {
			headers,
		}).catch(() => null),
	]);
	const user = userResponse?.ok ? await userResponse.json().catch(() => null) : null;
	const workspaces = workspacesResponse?.ok
		? await workspacesResponse.json().catch(() => null)
		: null;
	const workspace = Array.isArray(workspaces?.values)
		? workspaces.values[0]
		: null;
	return {
		username: user?.username ?? user?.nickname ?? null,
		workspaceName: workspace?.slug ?? workspace?.name ?? null,
	};
}

export default async function handler(
	req: ApiRequest,
	res: ApiResponse,
) {
	const { code, state } = req.query;
	const managedStateToken = typeof state === "string" ? state : "";
	if (!code || Array.isArray(code) || !isManagedGitProviderState(managedStateToken)) {
		return redirectWithError(res, "Invalid Bitbucket authorization response");
	}

	const managedState = await consumeManagedGitProviderState(
		managedStateToken,
		"bitbucket",
	);
	const config = getManagedBitbucketConfig();
	const response = await fetch("https://bitbucket.org/site/oauth2/access_token", {
		method: "POST",
		headers: {
			Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code: code as string,
			redirect_uri: `${getManagedGitProviderCallbackBaseUrl()}/api/providers/bitbucket/callback`,
		}),
	});
	const result = await response.json();
	if (!result.access_token) {
		return redirectWithError(res, "Missing or invalid Bitbucket authorization code");
	}

	const account = await readBitbucketAccount(result.access_token);
	const expiresIn = Number(result.expires_in || 7200);
	await createBitbucket(
		{
			name: account.workspaceName || account.username || "Bitbucket",
			bitbucketUsername: account.username ?? undefined,
			bitbucketWorkspaceName: account.workspaceName ?? undefined,
			accessToken: result.access_token,
			refreshToken: result.refresh_token,
			expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
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
