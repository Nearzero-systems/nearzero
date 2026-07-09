import { getEdition } from "@nearzero/edition-contract";

export const DEFAULT_BUILD_EXECUTION_TARGET = "deploy_server" as const;

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

export type ApplicationExecutionPlacementErrorCode =
	| "server_required"
	| "registry_required"
	| "invalid_cloud_placement"
	| "placement_changed";

export class ApplicationExecutionPlacementError extends Error {
	public readonly code: ApplicationExecutionPlacementErrorCode;

	constructor(
		code: ApplicationExecutionPlacementErrorCode,
		message: string,
	) {
		super(message);
		this.name = "ApplicationExecutionPlacementError";
		this.code = code;
	}
}

export const resolveApplicationExecutionPlacement = (
	application: BuildExecutionApplication,
): ApplicationExecutionPlacement =>
	getEdition().resolveApplicationExecutionPlacement(application);

export const assertApplicationExecutionPlacement = (
	application: BuildExecutionApplication,
	placement = resolveApplicationExecutionPlacement(application),
): ApplicationExecutionPlacement => {
	if (placement.mode === "cloud") {
		if (!placement.deployServerId || !placement.buildServerId) {
			throw new ApplicationExecutionPlacementError(
				"server_required",
				"Nearzero Cloud requires an active, ready application server before deployment.",
			);
		}
		if (placement.buildServerId !== placement.deployServerId) {
			throw new ApplicationExecutionPlacementError(
				"invalid_cloud_placement",
				"Nearzero Cloud must build and deploy on the same application server.",
			);
		}
	}

	if (
		placement.requiresRegistryTransfer &&
		!application.registryId &&
		!application.registry
	) {
		throw new ApplicationExecutionPlacementError(
			"registry_required",
			"Building locally and deploying remotely requires a registry so the deploy server can pull the image.",
		);
	}

	return placement;
};

export const assertApplicationExecutionPlacementSnapshot = (
	current: ApplicationExecutionPlacement,
	expected: ApplicationExecutionPlacement,
) => {
	if (
		current.mode !== expected.mode ||
		current.buildServerId !== expected.buildServerId ||
		current.deployServerId !== expected.deployServerId ||
		current.buildLocation !== expected.buildLocation ||
		current.requiresRegistryTransfer !== expected.requiresRegistryTransfer
	) {
		throw new ApplicationExecutionPlacementError(
			"placement_changed",
			"Application execution placement changed after the deployment was queued. Queue a new deployment.",
		);
	}
};

export const resolveApplicationBuildExecutionServerId = (
	application: BuildExecutionApplication,
): string | null =>
	resolveApplicationExecutionPlacement(application).buildServerId;

export const getApplicationBuildTargetLabel = (
	application: BuildExecutionApplication,
): string =>
	resolveApplicationBuildExecutionServerId(application)
		? "selected server"
		: "Nearzero host";
