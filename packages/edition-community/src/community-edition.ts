import {
	EDITION_FEATURES,
	type ApplicationExecutionPlacement,
	type BuildExecutionApplication,
	type CreateAuditLogInput,
	type EditionCapabilities,
	type EditionFeature,
	type EditionFeatureContext,
	type EditionManifest,
	type GitProviderConnectionInput,
	setEdition,
} from "@nearzero/edition-contract";
import { TRPCError } from "@trpc/server";

const HOSTED_EDITION_LABEL = "Cloud/Enterprise";

function getGitProviderConnectionMode(
	input: GitProviderConnectionInput | null | undefined,
) {
	return input?.connectionMode ?? input?.gitProvider?.connectionMode ?? "byo";
}

function communityManifest(): EditionManifest {
	return {
		edition: "community",
		features: {
			[EDITION_FEATURES.sso]: false,
			[EDITION_FEATURES.customRoles]: false,
			[EDITION_FEATURES.auditLogs]: false,
			[EDITION_FEATURES.whitelabeling]: false,
			[EDITION_FEATURES.cloudBilling]: false,
			[EDITION_FEATURES.managedSupport]: false,
		},
		agent: {
			requiresOrgProviderKey: true,
			allowsEnvProviderKey: false,
		},
		gitProviders: {
			allowsByo: true,
			allowsManaged: false,
		},
		billing: {
			enforced: false,
		},
	};
}

export class CommunityEditionCapabilities implements EditionCapabilities {
	readonly edition = "community" as const;

	getManifest(): EditionManifest {
		return communityManifest();
	}

	isFeatureEnabled(_feature: EditionFeature, _ctx?: EditionFeatureContext): boolean {
		return false;
	}

	requiresRemoteRuntimeServer(): boolean {
		return false;
	}

	shouldEnforceCloudBilling(): boolean {
		return false;
	}

	allowsEnvAgentProviderKey(): boolean {
		return false;
	}

	async hasValidLicense(_organizationId: string): Promise<boolean> {
		return false;
	}

	assertByoGitProvidersAllowed(_providerLabel = "Git provider"): void {
		return;
	}

	assertGitProviderConnectionAllowed(
		_input: GitProviderConnectionInput | null | undefined,
		_providerLabel = "Git provider",
	): void {
		return;
	}

	assertHostedManagedGitProvidersAvailable(): void {
		throw new TRPCError({
			code: "FORBIDDEN",
			message:
				"Nearzero-managed git providers are only available in Cloud/Enterprise mode.",
		});
	}

	isGitProviderConnectionAllowed(
		input: GitProviderConnectionInput | null | undefined,
	): boolean {
		return !this.isNearzeroManagedConnection(input);
	}

	isNearzeroManagedConnection(
		input: GitProviderConnectionInput | null | undefined,
	): boolean {
		return getGitProviderConnectionMode(input) === "nearzero_managed";
	}

	resolveApplicationExecutionPlacement(
		application: BuildExecutionApplication,
	): ApplicationExecutionPlacement {
		const deployServerId = application.serverId ?? null;
		const buildServerId =
			application.sourceType === "docker"
				? deployServerId
				: application.buildExecutionTarget === "nearzero_host"
					? null
					: deployServerId;

		return {
			mode: "community",
			buildServerId,
			deployServerId,
			buildLocation: buildServerId ? "remote" : "local",
			requiresRegistryTransfer:
				application.sourceType !== "docker" &&
				deployServerId !== null &&
				buildServerId !== deployServerId,
		};
	}

	async createAuditLog(_input: CreateAuditLogInput): Promise<void> {
		return;
	}
}

export const communityEdition = new CommunityEditionCapabilities();

export function bootstrapCommunityEdition(): void {
	setEdition(communityEdition);
}

export function assertCommunityOnlyMode(): void {
	return;
}
