export function getGitlabAuthUrl(
	clientId: string,
	gitlabId: string,
	gitlabUrl: string,
	callbackBaseUrl: string,
) {
	const redirectUri = `${callbackBaseUrl.replace(/\/+$/, "")}/api/providers/gitlab/callback?gitlabId=${encodeURIComponent(gitlabId)}`;
	const scope = "api read_user read_repository";
	const url = new URL("/oauth/authorize", gitlabUrl);
	url.searchParams.set("client_id", clientId);
	url.searchParams.set("redirect_uri", redirectUri);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("scopes", scope);
	return url.toString();
}
