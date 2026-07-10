import { TRPCError } from "@trpc/server";
import {
	isNearzeroManagedConnection,
	type GitProviderConnectionInput,
} from "./git-provider-policy";

const MANAGED_STATE_PREFIX = "nz_m_";

export type ManagedGitProviderState = {
	organizationId: string;
	userId: string;
	returnTo?: string | null;
};

function cloudOnly(feature: string): never {
	throw new TRPCError({
		code: "FORBIDDEN",
		message: `${feature} is only available in Nearzero Cloud/Enterprise.`,
	});
}

export function isNearzeroManagedGitProvider(input: unknown) {
	return isNearzeroManagedConnection(
		input as GitProviderConnectionInput | null | undefined,
	);
}

export function isManagedGitProviderState(value: unknown) {
	return typeof value === "string" && value.startsWith(MANAGED_STATE_PREFIX);
}

export function getManagedGitProviderCallbackBaseUrl(): string {
	return cloudOnly("Managed git provider callbacks");
}

export function getManagedGithubConfig(): {
	appId: number;
	privateKey: string;
	webhookSecret: string;
	appSlug: string;
	clientId: string;
} {
	return cloudOnly("Nearzero-managed GitHub");
}

export function getManagedGitlabConfig(): {
	clientId: string;
	clientSecret: string;
	gitlabUrl: string;
	gitlabInternalUrl?: string | null;
} {
	return cloudOnly("Nearzero-managed GitLab");
}

export function getManagedGiteaConfig(): {
	clientId: string;
	clientSecret: string;
	giteaUrl: string;
	giteaInternalUrl?: string | null;
	scope?: string | null;
} {
	return cloudOnly("Nearzero-managed Gitea");
}

export function getManagedBitbucketConfig(): {
	clientId: string;
	clientSecret: string;
} {
	return cloudOnly("Nearzero-managed Bitbucket");
}

export async function consumeManagedGitProviderState(
	_token: string,
	_expectedProviderType: string,
): Promise<ManagedGitProviderState> {
	return cloudOnly("Nearzero-managed git provider connections");
}

export async function startManagedGitProviderConnection(_input: {
	providerType: string;
	organizationId: string;
	userId: string;
	returnTo?: string | null;
}): Promise<{ url: string }> {
	return cloudOnly("Nearzero-managed git provider connections");
}
