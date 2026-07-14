import {
	findBitbucketById,
	findGiteaById,
	findGithubById,
	findGitlabById,
	getAccessibleGitProviderIds,
} from "@nearzero/server";
import { TRPCError } from "@trpc/server";

export type GitProviderAccessSession = {
	userId: string;
	activeOrganizationId: string;
};

export type GitProviderAccessRecord = {
	gitProviderId: string;
	organizationId: string;
	userId: string;
};

export type PublicGitProvider = {
	gitProviderId: string;
	name: string;
	providerType: string;
	connectionMode: string;
	createdAt: string;
	sharedWithOrganization: boolean;
};

const providerNotFound = () =>
	new TRPCError({
		code: "NOT_FOUND",
		message: "Git provider not found",
	});

export async function assertGitProviderReadable(
	session: GitProviderAccessSession,
	provider: GitProviderAccessRecord,
	expectedGitProviderId?: string,
) {
	if (
		provider.organizationId !== session.activeOrganizationId ||
		(expectedGitProviderId !== undefined &&
			provider.gitProviderId !== expectedGitProviderId)
	) {
		throw providerNotFound();
	}

	const accessibleIds = await getAccessibleGitProviderIds(session);
	if (!accessibleIds.has(provider.gitProviderId)) {
		throw providerNotFound();
	}
}

export async function assertGitProviderWritable(
	session: GitProviderAccessSession,
	userRole: string,
	provider: GitProviderAccessRecord,
	expectedGitProviderId?: string,
) {
	await assertGitProviderReadable(session, provider, expectedGitProviderId);
	if (
		provider.userId !== session.userId &&
		userRole !== "owner" &&
		userRole !== "admin"
	) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You are not allowed to modify this Git provider",
		});
	}
}

export async function assertGitProviderAssociationsReadable(
	session: GitProviderAccessSession,
	references: {
		githubId?: string | null;
		gitlabId?: string | null;
		bitbucketId?: string | null;
		giteaId?: string | null;
	},
) {
	if (references.githubId) {
		const provider = await findGithubById(references.githubId);
		await assertGitProviderReadable(session, provider.gitProvider);
	}
	if (references.gitlabId) {
		const provider = await findGitlabById(references.gitlabId);
		await assertGitProviderReadable(session, provider.gitProvider);
	}
	if (references.bitbucketId) {
		const provider = await findBitbucketById(references.bitbucketId);
		await assertGitProviderReadable(session, provider.gitProvider);
	}
	if (references.giteaId) {
		const provider = await findGiteaById(references.giteaId);
		await assertGitProviderReadable(session, provider.gitProvider);
	}
}

export function toPublicGitProvider(provider: {
	gitProviderId: string;
	name: string;
	providerType: string;
	connectionMode: string;
	createdAt: string;
	sharedWithOrganization: boolean;
}): PublicGitProvider {
	return {
		gitProviderId: provider.gitProviderId,
		name: provider.name,
		providerType: provider.providerType,
		connectionMode: provider.connectionMode,
		createdAt: provider.createdAt,
		sharedWithOrganization: provider.sharedWithOrganization,
	};
}

export function toPublicGithubDetails(provider: {
	githubId: string;
	githubAppName?: string | null;
	githubAppId?: number | null;
	githubClientId?: string | null;
	githubClientSecret?: string | null;
	githubInstallationId?: string | null;
	githubPrivateKey?: string | null;
	githubWebhookSecret?: string | null;
	gitProviderId?: string | null;
}) {
	return {
		githubId: provider.githubId,
		githubAppName: provider.githubAppName ?? null,
		githubAppId: provider.githubAppId ?? null,
		githubClientId: provider.githubClientId ?? null,
		githubInstallationId: provider.githubInstallationId ?? null,
		gitProviderId: provider.gitProviderId ?? null,
		hasAppId: Boolean(provider.githubAppId),
		hasInstallation: Boolean(provider.githubInstallationId),
		hasClientSecret: Boolean(provider.githubClientSecret),
		hasPrivateKey: Boolean(provider.githubPrivateKey),
		hasWebhookSecret: Boolean(provider.githubWebhookSecret),
	};
}

export function toPublicGitlabDetails(provider: {
	gitlabId: string;
	gitlabUrl?: string | null;
	gitlabInternalUrl?: string | null;
	applicationId?: string | null;
	redirectUri?: string | null;
	secret?: string | null;
	accessToken?: string | null;
	refreshToken?: string | null;
	groupName?: string | null;
	expiresAt?: number | null;
	gitProviderId?: string | null;
}) {
	return {
		gitlabId: provider.gitlabId,
		gitlabUrl: provider.gitlabUrl ?? null,
		gitlabInternalUrl: provider.gitlabInternalUrl ?? null,
		applicationId: provider.applicationId ?? null,
		redirectUri: provider.redirectUri ?? null,
		groupName: provider.groupName ?? null,
		expiresAt: provider.expiresAt ?? null,
		gitProviderId: provider.gitProviderId ?? null,
		hasSecret: Boolean(provider.secret),
		hasAccessToken: Boolean(provider.accessToken),
		hasRefreshToken: Boolean(provider.refreshToken),
	};
}

export function toPublicBitbucketDetails(provider: {
	bitbucketId: string;
	bitbucketUsername?: string | null;
	bitbucketEmail?: string | null;
	appPassword?: string | null;
	apiToken?: string | null;
	accessToken?: string | null;
	refreshToken?: string | null;
	expiresAt?: string | null;
	bitbucketWorkspaceName?: string | null;
	gitProviderId?: string | null;
}) {
	return {
		bitbucketId: provider.bitbucketId,
		bitbucketUsername: provider.bitbucketUsername ?? null,
		bitbucketEmail: provider.bitbucketEmail ?? null,
		expiresAt: provider.expiresAt ?? null,
		bitbucketWorkspaceName: provider.bitbucketWorkspaceName ?? null,
		gitProviderId: provider.gitProviderId ?? null,
		hasAppPassword: Boolean(provider.appPassword),
		hasApiToken: Boolean(provider.apiToken),
		hasAccessToken: Boolean(provider.accessToken),
		hasRefreshToken: Boolean(provider.refreshToken),
	};
}

export function toPublicGiteaDetails(provider: {
	giteaId: string;
	giteaUrl?: string | null;
	giteaInternalUrl?: string | null;
	redirectUri?: string | null;
	clientId?: string | null;
	clientSecret?: string | null;
	accessToken?: string | null;
	refreshToken?: string | null;
	expiresAt?: number | null;
	scopes?: string | null;
	lastAuthenticatedAt?: number | null;
	gitProviderId?: string | null;
}) {
	return {
		giteaId: provider.giteaId,
		giteaUrl: provider.giteaUrl ?? null,
		giteaInternalUrl: provider.giteaInternalUrl ?? null,
		redirectUri: provider.redirectUri ?? null,
		clientId: provider.clientId ?? null,
		expiresAt: provider.expiresAt ?? null,
		scopes: provider.scopes ?? null,
		lastAuthenticatedAt: provider.lastAuthenticatedAt ?? null,
		gitProviderId: provider.gitProviderId ?? null,
		hasClientId: Boolean(provider.clientId),
		hasClientSecret: Boolean(provider.clientSecret),
		hasAccessToken: Boolean(provider.accessToken),
		hasRefreshToken: Boolean(provider.refreshToken),
	};
}
