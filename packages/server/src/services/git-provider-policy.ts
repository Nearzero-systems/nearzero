import { TRPCError } from "@trpc/server";
import { isCloudMode } from "./runtime-mode";

type GitProviderConnectionInput = {
	connectionMode?: string | null;
	gitProvider?: { connectionMode?: string | null } | null;
};

const HOSTED_EDITION_LABEL = "Cloud/Enterprise";

export function isHostedEditionMode(): boolean {
	return isCloudMode();
}

export function getGitProviderConnectionMode(
	input: GitProviderConnectionInput | null | undefined,
) {
	return input?.connectionMode ?? input?.gitProvider?.connectionMode ?? "byo";
}

export function isNearzeroManagedConnection(
	input: GitProviderConnectionInput | null | undefined,
) {
	return getGitProviderConnectionMode(input) === "nearzero_managed";
}

export function isGitProviderConnectionAllowed(
	input: GitProviderConnectionInput | null | undefined,
) {
	return !isHostedEditionMode() || isNearzeroManagedConnection(input);
}

export function assertGitProviderConnectionAllowed(
	input: GitProviderConnectionInput | null | undefined,
	providerLabel = "Git provider",
) {
	if (!isGitProviderConnectionAllowed(input)) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: `${HOSTED_EDITION_LABEL} workspaces must use the Nearzero-managed ${providerLabel} app.`,
		});
	}
}

export function assertByoGitProvidersAllowed(providerLabel = "Git provider") {
	if (isHostedEditionMode()) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: `${HOSTED_EDITION_LABEL} workspaces connect ${providerLabel} with the Nearzero-managed app.`,
		});
	}
}

export function assertHostedManagedGitProvidersAvailable() {
	if (!isHostedEditionMode()) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "Nearzero-managed git providers are only available in Cloud/Enterprise mode.",
		});
	}
}
