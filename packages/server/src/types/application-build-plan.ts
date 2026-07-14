export type ApplicationBuildType =
	| "dockerfile"
	| "heroku_buildpacks"
	| "paketo_buildpacks"
	| "nixpacks"
	| "static"
	| "railpack";

export type BuildSelectionMode = "automatic" | "explicit";

/**
 * Facts discovered while Nearzero inspects a repository before building it.
 * Diagnostics explain the resolved build authority but never rewrite source.
 */
export type ApplicationBuildPlanDiagnostic =
	| {
			code: "dockerfile_authoritative";
			severity: "info";
			message: string;
			dockerfile: string;
	  }
	| {
			code: "multiple_package_manager_lockfiles";
			severity: "warning";
			message: string;
			lockfiles: string[];
			packageManagers: string[];
	  }
	| {
			code: "dockerfile_package_manager_mismatch";
			severity: "warning";
			message: string;
			repositoryPackageManager: string;
			dockerfilePackageManagers: string[];
	  }
	| {
			code: "managed_builder_preferred_over_dockerfile";
			severity: "info";
			message: string;
			dockerfile: string;
			framework: string;
			repositoryPackageManager: string;
			dockerfilePackageManagers: string[];
			preferredBuilder: ApplicationBuildType;
	  };

export interface DetectedApplicationBuildTarget {
	path: string;
	packageName: string | null;
	framework: string | null;
	packageManager: string | null;
	hasWorkspaceDependencies: boolean;
	scripts: {
		install: string | null;
		build: string | null;
		start: string | null;
	};
	recommendedCommands: {
		install: string | null;
		build: string | null;
		start: string | null;
	};
}

export interface ApplicationBuildPlan {
	version: 1;
	selectionMode: BuildSelectionMode;
	requestedBuilder: ApplicationBuildType;
	selectedBuilder: ApplicationBuildType;
	fallbackReason: string | null;
	sourceRevision: string | null;
	buildPath: string;
	workspaceRoot: string | null;
	selectedAppPath: string;
	appCount: number;
	detectedApps: DetectedApplicationBuildTarget[];
	packageManager: string | null;
	framework: string | null;
	commands: {
		install: string | null;
		build: string | null;
		start: string | null;
	};
	/** Optional so deployments created before this diagnostic existed remain valid. */
	diagnostics?: ApplicationBuildPlanDiagnostic[];
	healingHints: string[];
	requiredCapabilities: string[];
	generatedAt: string;
}
