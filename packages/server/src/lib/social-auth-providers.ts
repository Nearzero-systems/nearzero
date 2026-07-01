export type SocialAuthProviderId = "github" | "google";

type SocialAuthProviderEnv = {
	GITHUB_CLIENT_ID?: string;
	GITHUB_CLIENT_SECRET?: string;
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
};

export function getConfiguredSocialAuthProviders(
	env: SocialAuthProviderEnv = process.env as SocialAuthProviderEnv,
): SocialAuthProviderId[] {
	const providers: SocialAuthProviderId[] = [];
	if (env.GITHUB_CLIENT_ID?.trim() && env.GITHUB_CLIENT_SECRET?.trim()) {
		providers.push("github");
	}
	if (env.GOOGLE_CLIENT_ID?.trim() && env.GOOGLE_CLIENT_SECRET?.trim()) {
		providers.push("google");
	}
	return providers;
}
