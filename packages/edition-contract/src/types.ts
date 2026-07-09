export const EDITION_FEATURES = {
	sso: "sso",
	customRoles: "customRoles",
	auditLogs: "auditLogs",
	whitelabeling: "whitelabeling",
	cloudBilling: "cloudBilling",
	managedSupport: "managedSupport",
} as const;

export type EditionFeature =
	(typeof EDITION_FEATURES)[keyof typeof EDITION_FEATURES];

export type RuntimeEdition = "community" | "cloud";

export type EditionFeatureContext = {
	organizationId?: string | null;
	userId?: string | null;
};

export type BuildExecutionTarget = "deploy_server" | "nearzero_host";

export interface BuildExecutionApplication {
	buildExecutionTarget: BuildExecutionTarget;
	serverId?: string | null;
	sourceType?: string | null;
	registryId?: string | null;
	registry?: unknown | null;
}

export interface ApplicationExecutionPlacement {
	mode: "cloud" | "community";
	buildServerId: string | null;
	deployServerId: string | null;
	buildLocation: "local" | "remote";
	requiresRegistryTransfer: boolean;
}

export type GitProviderConnectionInput = {
	connectionMode?: string | null;
	gitProvider?: { connectionMode?: string | null } | null;
};

export interface CreateAuditLogInput {
	organizationId: string;
	userId: string;
	userEmail: string;
	userRole: string;
	action: string;
	resourceType: string;
	resourceId?: string;
	resourceName?: string;
	metadata?: Record<string, unknown>;
}

export interface EditionManifest {
	edition: RuntimeEdition;
	features: Record<EditionFeature, boolean>;
	agent: {
		requiresOrgProviderKey: boolean;
		allowsEnvProviderKey: boolean;
	};
	gitProviders: {
		allowsByo: boolean;
		allowsManaged: boolean;
	};
	billing: {
		enforced: boolean;
	};
}

export interface EditionCapabilities {
	readonly edition: RuntimeEdition;

	getManifest(): EditionManifest;

	isFeatureEnabled(
		feature: EditionFeature,
		ctx?: EditionFeatureContext,
	): boolean;

	requiresRemoteRuntimeServer(): boolean;

	shouldEnforceCloudBilling(): boolean;

	allowsEnvAgentProviderKey(): boolean;

	hasValidLicense(organizationId: string): Promise<boolean>;

	assertByoGitProvidersAllowed(providerLabel?: string): void;

	assertGitProviderConnectionAllowed(
		input: GitProviderConnectionInput | null | undefined,
		providerLabel?: string,
	): void;

	assertHostedManagedGitProvidersAvailable(): void;

	isGitProviderConnectionAllowed(
		input: GitProviderConnectionInput | null | undefined,
	): boolean;

	isNearzeroManagedConnection(
		input: GitProviderConnectionInput | null | undefined,
	): boolean;

	resolveApplicationExecutionPlacement(
		application: BuildExecutionApplication,
	): ApplicationExecutionPlacement;

	createAuditLog(input: CreateAuditLogInput): Promise<void>;
}
