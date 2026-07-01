import { joinBackendUrl } from "./backendProxy";

export type SocialAuthProviderId = "github" | "google";

export const ALL_SOCIAL_AUTH_PROVIDERS: SocialAuthProviderId[] = [
	"github",
	"google",
];

export type ResolvedSocialAuthProviders = {
	providers: SocialAuthProviderId[];
	/** True when the platform reported an explicit provider list. */
	known: boolean;
};

function parseSocialAuthProviders(raw: unknown): SocialAuthProviderId[] {
	if (!Array.isArray(raw)) return [];
	return raw.filter(
		(provider): provider is SocialAuthProviderId =>
			provider === "github" || provider === "google",
	);
}

/** Show all buttons unless the platform returns a definitive provider list. */
export function resolveSocialAuthProviders(
	fetched: SocialAuthProviderId[],
): ResolvedSocialAuthProviders {
	if (fetched.length > 0) {
		return { providers: fetched, known: true };
	}
	return { providers: ALL_SOCIAL_AUTH_PROVIDERS, known: false };
}

export async function fetchSocialAuthProviders(): Promise<
	SocialAuthProviderId[]
> {
	try {
		const res = await fetch(joinBackendUrl("/api/auth/social-providers"), {
			method: "GET",
		});
		if (!res.ok) return [];
		const data = (await res.json()) as { providers?: unknown };
		return parseSocialAuthProviders(data.providers);
	} catch {
		return [];
	}
}

export async function fetchResolvedSocialAuthProviders(): Promise<ResolvedSocialAuthProviders> {
	return resolveSocialAuthProviders(await fetchSocialAuthProviders());
}

export function isSocialAuthProviderEnabled(
	providers: readonly SocialAuthProviderId[],
	provider: SocialAuthProviderId,
) {
	return providers.includes(provider);
}
