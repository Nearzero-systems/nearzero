import {
	toPublicRegistryRelations,
	toPublicServerRelation,
} from "@nearzero/server";

const PROVIDER_ID_FIELDS = {
	github: "githubId",
	gitlab: "gitlabId",
	bitbucket: "bitbucketId",
	gitea: "giteaId",
} as const;

function publicProviderRelation(
	value: unknown,
	idField: (typeof PROVIDER_ID_FIELDS)[keyof typeof PROVIDER_ID_FIELDS],
) {
	if (!value || typeof value !== "object") return value;
	const provider = value as Record<string, unknown>;
	return {
		[idField]: provider[idField] ?? null,
		gitProviderId: provider.gitProviderId ?? null,
	};
}

/**
 * API-boundary redaction for application and Compose records.
 *
 * Internal deployment code intentionally loads full provider, registry, and
 * environment state. Those records must never be serialized as a convenient
 * side effect of returning a service relation to the browser.
 */
export function toPublicService<T extends object>(service: T) {
	const publicService = {
		...toPublicRegistryRelations(toPublicServerRelation(service)),
	} as Record<string, unknown>;

	publicService.hasDockerPassword =
		typeof publicService.password === "string" &&
		publicService.password.length > 0;
	publicService.hasEnvironmentVariables =
		typeof publicService.env === "string" && publicService.env.length > 0;
	publicService.hasBuildSecrets =
		typeof publicService.buildSecrets === "string" &&
		publicService.buildSecrets.length > 0;
	publicService.hasPreviewEnvironmentVariables =
		typeof publicService.previewEnv === "string" &&
		publicService.previewEnv.length > 0;
	publicService.hasPreviewBuildSecrets =
		typeof publicService.previewBuildSecrets === "string" &&
		publicService.previewBuildSecrets.length > 0;

	for (const key of [
		"password",
		"refreshToken",
		"env",
		"previewEnv",
		"buildArgs",
		"buildSecrets",
		"previewBuildArgs",
		"previewBuildSecrets",
	] as const) {
		delete publicService[key];
	}

	for (const [key, idField] of Object.entries(PROVIDER_ID_FIELDS)) {
		publicService[key] = publicProviderRelation(publicService[key], idField);
	}

	const environment = publicService.environment;
	if (environment && typeof environment === "object") {
		const publicEnvironment = {
			...(environment as Record<string, unknown>),
		};
		delete publicEnvironment.env;
		const project = publicEnvironment.project;
		if (project && typeof project === "object") {
			const publicProject = { ...(project as Record<string, unknown>) };
			delete publicProject.env;
			publicEnvironment.project = publicProject;
		}
		publicService.environment = publicEnvironment;
	}

	// File-mount contents and backup credentials have their own permissioned
	// APIs. Do not leak either through a generic service-read response.
	if (Array.isArray(publicService.mounts)) {
		publicService.mounts = publicService.mounts.map((mount) => {
			if (!mount || typeof mount !== "object") return mount;
			const publicMount = { ...(mount as Record<string, unknown>) };
			publicMount.hasContent =
				typeof publicMount.content === "string" &&
				publicMount.content.length > 0;
			delete publicMount.content;
			return publicMount;
		});
	}
	delete publicService.backups;

	return publicService;
}
