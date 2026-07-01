export const getGiteaOAuthUrl = (
	giteaId: string,
	clientId: string,
	giteaUrl: string,
	baseUrl: string,
): string => {
	if (!clientId || !giteaUrl || !baseUrl) {
		return "#";
	}

	const redirectUri = `${baseUrl}/api/providers/gitea/callback`;
	const scopes = "read:repository read:user read:organization";

	return `${giteaUrl}/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(
		redirectUri,
	)}&response_type=code&scope=${encodeURIComponent(scopes)}&state=${encodeURIComponent(giteaId)}`;
};
