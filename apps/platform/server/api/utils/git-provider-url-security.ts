import { TRPCError } from "@trpc/server";

type GitProviderUrlType = "gitlab" | "gitea";

const DEFAULT_ORIGINS: Record<GitProviderUrlType, string> = {
	gitlab: "https://gitlab.com",
	gitea: "https://gitea.com",
};

function invalidUrl(label: string): TRPCError {
	return new TRPCError({
		code: "BAD_REQUEST",
		message: `${label} must be an HTTP(S) base URL without credentials, a query, or a fragment`,
	});
}

export function parseGitProviderBaseUrl(
	value: string,
	label = "Git provider URL",
): string {
	const trimmed = value.trim();
	if (!trimmed) throw invalidUrl(label);

	try {
		const url = new URL(trimmed);
		if (
			(url.protocol !== "http:" && url.protocol !== "https:") ||
			!url.hostname ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		) {
			throw invalidUrl(label);
		}

		const pathname = url.pathname.replace(/\/+$/, "");
		return `${url.origin}${pathname === "/" ? "" : pathname}`;
	} catch (error) {
		if (error instanceof TRPCError) throw error;
		throw invalidUrl(label);
	}
}

export function assertGitProviderUrlConfigurationAllowed(input: {
	providerType: GitProviderUrlType;
	userRole: string;
	providerUrl: string;
	internalUrl?: string | null;
}): { providerUrl: string; internalUrl: string | null } {
	const providerUrl = parseGitProviderBaseUrl(
		input.providerUrl,
		`${input.providerType === "gitlab" ? "GitLab" : "Gitea"} URL`,
	);
	const internalUrl = input.internalUrl?.trim()
		? parseGitProviderBaseUrl(
				input.internalUrl,
				`${input.providerType === "gitlab" ? "GitLab" : "Gitea"} internal URL`,
			)
		: null;
	const isPrivileged = input.userRole === "owner" || input.userRole === "admin";
	const isCustomOrigin =
		new URL(providerUrl).origin !== DEFAULT_ORIGINS[input.providerType];

	if ((internalUrl || isCustomOrigin) && !isPrivileged) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message:
				"Only an organization owner or admin can configure self-hosted or internal Git provider URLs",
		});
	}

	return { providerUrl, internalUrl };
}
