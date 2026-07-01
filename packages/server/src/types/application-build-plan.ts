export type ApplicationBuildType =
	| "dockerfile"
	| "heroku_buildpacks"
	| "paketo_buildpacks"
	| "nixpacks"
	| "static"
	| "railpack";

export type BuildSelectionMode = "automatic" | "explicit";

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
	healingHints: string[];
	requiredCapabilities: string[];
	generatedAt: string;
}
