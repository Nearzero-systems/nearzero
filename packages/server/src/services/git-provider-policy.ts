import { getEdition } from "@nearzero/edition-contract";

export type GitProviderConnectionInput = {
	connectionMode?: string | null;
	gitProvider?: { connectionMode?: string | null } | null;
};

const HOSTED_EDITION_LABEL = "Cloud/Enterprise";

export function isHostedEditionMode(): boolean {
	return getEdition().edition === "cloud";
}

export function getGitProviderConnectionMode(
	input: GitProviderConnectionInput | null | undefined,
) {
	return input?.connectionMode ?? input?.gitProvider?.connectionMode ?? "byo";
}

export function isNearzeroManagedConnection(
	input: GitProviderConnectionInput | null | undefined,
) {
	return getEdition().isNearzeroManagedConnection(input);
}

export function isGitProviderConnectionAllowed(
	input: GitProviderConnectionInput | null | undefined,
) {
	return getEdition().isGitProviderConnectionAllowed(input);
}

export function assertGitProviderConnectionAllowed(
	input: GitProviderConnectionInput | null | undefined,
	providerLabel = "Git provider",
) {
	getEdition().assertGitProviderConnectionAllowed(input, providerLabel);
}

export function assertByoGitProvidersAllowed(providerLabel = "Git provider") {
	getEdition().assertByoGitProvidersAllowed(providerLabel);
}

export function assertHostedManagedGitProvidersAvailable() {
	getEdition().assertHostedManagedGitProvidersAvailable();
}

export function getHostedEditionLabel() {
	return HOSTED_EDITION_LABEL;
}
