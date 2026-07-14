export function getGitlabAuthUrl(
	clientId: string,
	state: string,
	gitlabUrl: string,
	callbackBaseUrl: string,
) {
	const redirectUri = `${callbackBaseUrl.replace(/\/+$/, "")}/api/providers/gitlab/callback`;
	const scope = "api read_user read_repository";
	const url = new URL("/oauth/authorize", gitlabUrl);
	url.searchParams.set("client_id", clientId);
	url.searchParams.set("redirect_uri", redirectUri);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("scope", scope);
	url.searchParams.set("state", state);
	return url.toString();
}
