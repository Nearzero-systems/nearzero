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
import { createAuditLog as createCloudAuditLog } from "./services/proprietary/audit-log";

const HOSTED_EDITION_LABEL = "Cloud/Enterprise";

function isStripeConfigured() {
	return Boolean(process.env.STRIPE_SECRET_KEY?.trim());
}

function getGitProviderConnectionMode(
	input: GitProviderConnectionInput | null | undefined,
) {
	return input?.connectionMode ?? input?.gitProvider?.connectionMode ?? "byo";
}

function cloudManifest(): EditionManifest {
	return {
		edition: "cloud",
		features: {
			[EDITION_FEATURES.sso]: true,
			[EDITION_FEATURES.customRoles]: true,
			[EDITION_FEATURES.auditLogs]: true,
			[EDITION_FEATURES.whitelabeling]: true,
			[EDITION_FEATURES.cloudBilling]: true,
			[EDITION_FEATURES.managedSupport]: true,
		},
		agent: {
			requiresOrgProviderKey: false,
			allowsEnvProviderKey: true,
		},
		gitProviders: {
			allowsByo: false,
			allowsManaged: true,
		},
		billing: {
			enforced:
				isStripeConfigured() &&
				process.env.NODE_ENV === "production" &&
				process.env.NEARZERO_DEV_BYPASS_BILLING !== "true" &&
				process.env.NEARZERO_DEV_BYPASS_BILLING !== "1",
		},
	};
}

export class CloudEditionCapabilities implements EditionCapabilities {
	readonly edition = "cloud" as const;

	getManifest(): EditionManifest {
		return cloudManifest();
	}

	isFeatureEnabled(_feature: EditionFeature, _ctx?: EditionFeatureContext): boolean {
		return true;
	}

	requiresRemoteRuntimeServer(): boolean {
		return true;
	}

	shouldEnforceCloudBilling(): boolean {
		return cloudManifest().billing.enforced;
	}

	allowsEnvAgentProviderKey(): boolean {
		return true;
	}

	async hasValidLicense(_organizationId: string): Promise<boolean> {
		return true;
	}

	assertByoGitProvidersAllowed(providerLabel = "Git provider"): void {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: `${HOSTED_EDITION_LABEL} workspaces connect ${providerLabel} with the Nearzero-managed app.`,
		});
	}

	assertGitProviderConnectionAllowed(
		input: GitProviderConnectionInput | null | undefined,
		providerLabel = "Git provider",
	): void {
		if (!this.isGitProviderConnectionAllowed(input)) {
			throw new TRPCError({
				code: "FORBIDDEN",
				message: `${HOSTED_EDITION_LABEL} workspaces must use the Nearzero-managed ${providerLabel} app.`,
			});
		}
	}

	assertHostedManagedGitProvidersAvailable(): void {
		return;
	}

	isGitProviderConnectionAllowed(
		input: GitProviderConnectionInput | null | undefined,
	): boolean {
		return this.isNearzeroManagedConnection(input);
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
		return {
			mode: "cloud",
			buildServerId: deployServerId,
			deployServerId,
			buildLocation: "remote",
			requiresRegistryTransfer: false,
		};
	}

	async createAuditLog(input: CreateAuditLogInput): Promise<void> {
		await createCloudAuditLog(input);
	}
}

export const cloudEdition = new CloudEditionCapabilities();

export function bootstrapCloudEdition(): void {
	setEdition(cloudEdition);
}
