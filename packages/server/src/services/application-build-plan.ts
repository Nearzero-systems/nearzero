import type {
	ApplicationBuildPlan,
	ApplicationBuildType,
	BuildSelectionMode,
	DetectedApplicationBuildTarget,
} from "@nearzero/server/types/application-build-plan";
import type { ApplicationNested } from "@nearzero/server/utils/builders";
import { paths } from "@nearzero/server/constants";
import { getApplicationBuildDirectory } from "@nearzero/server/utils/filesystem/directory";
import {
	execAsync,
	execAsyncRemote,
} from "@nearzero/server/utils/process/execAsync";
import path from "node:path";
import { quote } from "shell-quote";

const execute = (serverId: string | null, command: string) =>
	serverId ? execAsyncRemote(serverId, command) : execAsync(command);

export function selectApplicationBuilder(input: {
	selectionMode: BuildSelectionMode;
	requestedBuilder: ApplicationBuildType;
	hasDockerfile: boolean;
	hasCustomCommands?: boolean;
	hasWorkspaceDependencies?: boolean;
}): ApplicationBuildType {
	if (input.selectionMode === "explicit") {
		return input.requestedBuilder;
	}
	if (input.hasCustomCommands || input.hasWorkspaceDependencies) {
		return "nixpacks";
	}
	return input.hasDockerfile ? "dockerfile" : "railpack";
}

function getConfiguredBuildPath(application: ApplicationNested) {
	switch (application.sourceType) {
		case "github":
			return application.buildPath || "/";
		case "gitlab":
			return application.gitlabBuildPath || "/";
		case "bitbucket":
			return application.bitbucketBuildPath || "/";
		case "gitea":
			return application.giteaBuildPath || "/";
		case "drop":
			return application.dropBuildPath || "/";
		case "git":
			return application.customGitBuildPath || "/";
		default:
			return "/";
	}
}

function detectPackageManager(files: Set<string>, packageManager?: string) {
	if (packageManager) return packageManager.split("@")[0] || null;
	if (files.has("pnpm-workspace.yaml")) return "pnpm";
	if (files.has("bun.lock") || files.has("bun.lockb")) return "bun";
	if (files.has("pnpm-lock.yaml")) return "pnpm";
	if (files.has("yarn.lock")) return "yarn";
	if (files.has("package-lock.json")) return "npm";
	return null;
}

function sourceDirectoryFor(application: ApplicationNested, buildServerId: string | null) {
	return path.join(paths(!!buildServerId).APPLICATIONS_PATH, application.appName, "code");
}

function normalizeBuildPath(value: string | null | undefined) {
	const trimmed = value?.trim() || "/";
	if (trimmed === "." || trimmed === "./" || trimmed === "") return "/";
	const withoutTrailing = trimmed.replace(/\/+$/, "");
	const prefixed = withoutTrailing.startsWith("/") ? withoutTrailing : `/${withoutTrailing}`;
	return prefixed || "/";
}

function toRelativePath(buildPath: string) {
	return buildPath === "/" ? "." : buildPath.replace(/^\/+/, "");
}

function packagePathFromRelative(relativePath: string) {
	return relativePath === "." ? "/" : `/${relativePath}`;
}

function detectFramework(packageJson: Record<string, any> | null) {
	const dependencies = {
		...(packageJson?.dependencies ?? {}),
		...(packageJson?.devDependencies ?? {}),
	};
	for (const framework of [
		"next",
		"astro",
		"nuxt",
		"vite",
		"gatsby",
		"remix",
		"@sveltejs/kit",
	]) {
		if (framework in dependencies) return framework;
	}
	return null;
}

function hasWorkspaceDependencies(packageJson: Record<string, any> | null) {
	const dependencies = {
		...(packageJson?.dependencies ?? {}),
		...(packageJson?.devDependencies ?? {}),
		...(packageJson?.optionalDependencies ?? {}),
		...(packageJson?.peerDependencies ?? {}),
	};
	return Object.values(dependencies).some(
		(value) => typeof value === "string" && value.startsWith("workspace:"),
	);
}

function hasTurboBuildPipeline(
	rootFiles: Set<string>,
	rootPackageJson: Record<string, any> | null,
) {
	if (!rootFiles.has("turbo.json") && !rootFiles.has("turbo.jsonc")) {
		return false;
	}
	const dependencies = {
		...(rootPackageJson?.dependencies ?? {}),
		...(rootPackageJson?.devDependencies ?? {}),
	};
	return "turbo" in dependencies;
}

function isSafePackageName(packageName: string | null | undefined) {
	return Boolean(
		packageName &&
			/^(@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+$/.test(packageName),
	);
}

function turboBuildCommandForPackageManager(
	packageManager: string | null,
	packageName: string,
) {
	const filter = `--filter=${packageName}...`;
	switch (packageManager) {
		case "bun":
			return `bunx turbo run build ${filter}`;
		case "pnpm":
			return `pnpm exec turbo run build ${filter}`;
		case "yarn":
			return `yarn turbo run build ${filter}`;
		default:
			return `npx --no-install turbo run build ${filter}`;
	}
}

function parsePackageJson(raw: string | undefined) {
	if (!raw) return null;
	try {
		return JSON.parse(raw) as Record<string, any>;
	} catch {
		return null;
	}
}

function commandForPackageManager(
	packageManager: string | null,
	relativePath: string,
	script: string,
	options?: {
		hasTurboBuildPipeline?: boolean;
		hasWorkspaceDependencies?: boolean;
		packageName?: string | null;
	},
) {
	if (
		script === "build" &&
		options?.hasTurboBuildPipeline &&
		options.hasWorkspaceDependencies &&
		isSafePackageName(options.packageName)
	) {
		return turboBuildCommandForPackageManager(
			packageManager,
			options.packageName!,
		);
	}
	const directoryPrefix =
		relativePath === "." ? "" : `cd ${quote([relativePath])} && `;
	switch (packageManager) {
		case "bun":
			return `${directoryPrefix}bun run ${script}`;
		case "pnpm":
			return `${directoryPrefix}pnpm run ${script}`;
		case "yarn":
			return `${directoryPrefix}yarn run ${script}`;
		default:
			return `${directoryPrefix}npm run ${script}`;
	}
}

function installCommandForPackageManager(packageManager: string | null) {
	switch (packageManager) {
		case "bun":
			return "bun install --frozen-lockfile";
		case "pnpm":
			return "pnpm install --frozen-lockfile";
		case "yarn":
			return "yarn install --frozen-lockfile";
		default:
			return "npm install";
	}
}

function customCommands(application: ApplicationNested) {
	return {
		install: application.customInstallCommand?.trim() || null,
		build: application.customBuildCommand?.trim() || null,
		start: application.customStartCommand?.trim() || null,
	};
}

function hasCustomCommands(application: ApplicationNested) {
	const commands = customCommands(application);
	return Boolean(commands.install || commands.build || commands.start);
}

function repoPackageManager(rootFiles: Set<string>, rootPackageJson: Record<string, any> | null) {
	return detectPackageManager(rootFiles, rootPackageJson?.packageManager);
}

function buildDetectedApps(input: {
	packages: Array<{ relativePath: string; packageJson: Record<string, any> | null }>;
	rootFiles: Set<string>;
	rootPackageJson: Record<string, any> | null;
}): DetectedApplicationBuildTarget[] {
	const rootPackageManager = repoPackageManager(input.rootFiles, input.rootPackageJson);
	const rootHasTurboBuildPipeline = hasTurboBuildPipeline(
		input.rootFiles,
		input.rootPackageJson,
	);
	const apps: DetectedApplicationBuildTarget[] = [];
	for (const { relativePath, packageJson } of input.packages) {
		const packageFiles = new Set<string>();
		const packageManager = detectPackageManager(
			packageFiles,
			packageJson?.packageManager,
		) ?? rootPackageManager;
		const scripts = packageJson?.scripts ?? {};
		const framework = detectFramework(packageJson);
		const workspaceDependencies = hasWorkspaceDependencies(packageJson);
		const hasRunnableScripts = Boolean(scripts.build || scripts.start);
		const packageName =
			typeof packageJson?.name === "string" ? packageJson.name : null;
		if (!framework && !workspaceDependencies && !hasRunnableScripts) {
			continue;
		}
		apps.push({
			path: packagePathFromRelative(relativePath),
			packageName,
			framework,
			packageManager,
			hasWorkspaceDependencies: workspaceDependencies,
			scripts: {
				install: typeof scripts.install === "string" ? scripts.install : null,
				build: typeof scripts.build === "string" ? scripts.build : null,
				start: typeof scripts.start === "string" ? scripts.start : null,
			},
			recommendedCommands: {
				install: installCommandForPackageManager(packageManager),
				build: scripts.build
					? commandForPackageManager(packageManager, relativePath, "build", {
							hasTurboBuildPipeline: rootHasTurboBuildPipeline,
							hasWorkspaceDependencies: workspaceDependencies,
							packageName,
						})
					: null,
				start: scripts.start
					? commandForPackageManager(packageManager, relativePath, "start")
					: null,
			},
		});
	}
	return apps;
}

function selectDetectedApp(
	detectedApps: DetectedApplicationBuildTarget[],
	buildPath: string,
) {
	return (
		detectedApps.find((app) => app.path === buildPath) ??
		detectedApps.find((app) => app.path === "/") ??
		preferDetectedApps(detectedApps)[0] ??
		null
	);
}

function normalizedFramework(framework: string | null | undefined) {
	const value = (framework ?? "").trim().toLowerCase();
	if (value === "next" || value === "nextjs") return "nextjs";
	if (value === "@sveltejs/kit" || value === "svelte") return "sveltekit";
	if (value === "@remix-run/react" || value === "remix") return "remix";
	if (value === "@angular/core" || value === "angular") return "angular";
	return value || null;
}

function lastPathSegment(buildPath: string) {
	return buildPath.split("/").filter(Boolean).pop()?.toLowerCase() ?? "";
}

function isNextDetectedApp(app: DetectedApplicationBuildTarget) {
	return normalizedFramework(app.framework) === "nextjs";
}

function detectedAppPriority(
	app: DetectedApplicationBuildTarget,
	apps: DetectedApplicationBuildTarget[],
) {
	const nextApps = apps.filter(isNextDetectedApp);
	if (isNextDetectedApp(app)) {
		if (nextApps.length === 1) return 0;
		const segment = lastPathSegment(app.path);
		if (segment === "web") return 1;
		if (segment === "app") return 2;
		return 3;
	}
	if (app.framework) return 20;
	if (app.path === "/") return 40;
	return 30;
}

function preferDetectedApps(apps: DetectedApplicationBuildTarget[]) {
	return [...apps].sort((a, b) => {
		const priority = detectedAppPriority(a, apps) - detectedAppPriority(b, apps);
		if (priority !== 0) return priority;
		return a.path.localeCompare(b.path);
	});
}

export async function createApplicationBuildPlan(input: {
	application: ApplicationNested;
	buildServerId: string | null;
}): Promise<ApplicationBuildPlan> {
	const sourceDirectory = sourceDirectoryFor(input.application, input.buildServerId);
	const buildDirectory = getApplicationBuildDirectory(input.application, input.buildServerId);
	const selectedRelativePath = path.relative(sourceDirectory, buildDirectory) || ".";
	const directory = quote([buildDirectory]);
	const sourceDirectoryQuoted = quote([sourceDirectory]);
	const dockerfile = quote([
		path.join(selectedRelativePath, input.application.dockerfile || "Dockerfile"),
	]);
	const { stdout } = await execute(
		input.buildServerId,
		[
			`cd ${sourceDirectoryQuoted}`,
			"printf '%s\\n' '__NZ_FILES__'",
			'for file in Dockerfile bun.lock bun.lockb pnpm-lock.yaml pnpm-workspace.yaml yarn.lock package-lock.json package.json turbo.json turbo.jsonc; do test -f "$file" && printf \'%s\\n\' "$file"; done',
			`test -f ${dockerfile} && printf '%s\\n' '__NZ_DOCKERFILE_PRESENT__' || true`,
			"printf '%s\\n' '__NZ_REVISION__'",
			"git rev-parse HEAD 2>/dev/null || true",
			"printf '%s\\n' '__NZ_PACKAGES__'",
			"find . -maxdepth 4 \\( -path './node_modules/*' -o -path './.git/*' -o -path './.next/*' -o -path './dist/*' -o -path './build/*' \\) -prune -o -name package.json -type f -print 2>/dev/null | sort | while IFS= read -r file; do rel=${file#./}; dir=$(dirname \"$rel\"); [ \"$dir\" = \".\" ] && dir=\".\"; printf '__NZ_PACKAGE_PATH__%s\\n' \"$dir\"; base64 < \"$file\" | tr -d '\\n'; printf '\\n__NZ_PACKAGE_END__\\n'; done",
			"printf '%s\\n' '__NZ_SELECTED_PACKAGE_JSON__'",
			`cd ${directory} && test -f package.json && cat package.json || true`,
		].join("\n"),
	);
	const filesBlock = stdout
		.split("__NZ_FILES__")[1]
		?.split("__NZ_REVISION__")[0];
	const revisionBlock = stdout
		.split("__NZ_REVISION__")[1]
		?.split("__NZ_PACKAGES__")[0];
	const packagesBlock = stdout
		.split("__NZ_PACKAGES__")[1]
		?.split("__NZ_SELECTED_PACKAGE_JSON__")[0];
	const selectedPackageJsonBlock = stdout
		.split("__NZ_SELECTED_PACKAGE_JSON__")[1]
		?.trim();
	const files = new Set(
		(filesBlock ?? "")
			.split("\n")
			.map((value) => value.trim())
			.filter(Boolean),
	);
	const packages: Array<{
		relativePath: string;
		packageJson: Record<string, any> | null;
	}> = [];
	for (const block of (packagesBlock ?? "").split("__NZ_PACKAGE_PATH__")) {
		const trimmed = block.trim();
		if (!trimmed) continue;
		const [relativePathLine, ...rest] = trimmed.split("\n");
		const encoded = rest.join("\n").split("__NZ_PACKAGE_END__")[0]?.trim();
		if (!relativePathLine || !encoded) continue;
		let decoded = "";
		try {
			decoded = Buffer.from(encoded, "base64").toString("utf8");
		} catch {
			decoded = "";
		}
		packages.push({
			relativePath: relativePathLine.trim() || ".",
			packageJson: parsePackageJson(decoded),
		});
	}
	const rootPackageJson =
		packages.find((pkg) => pkg.relativePath === ".")?.packageJson ?? null;
	const packageJson = parsePackageJson(selectedPackageJsonBlock);
	const buildPath = normalizeBuildPath(getConfiguredBuildPath(input.application));
	const detectedApps = preferDetectedApps(
		buildDetectedApps({
			packages,
			rootFiles: files,
			rootPackageJson,
		}),
	);
	const selectedDetectedApp =
		selectDetectedApp(detectedApps, buildPath) ??
		({
			path: buildPath,
			packageName:
				typeof packageJson?.name === "string" ? packageJson.name : null,
			framework: detectFramework(packageJson),
			packageManager: detectPackageManager(files, packageJson?.packageManager),
			hasWorkspaceDependencies: hasWorkspaceDependencies(packageJson),
			scripts: {
				install:
					typeof packageJson?.scripts?.install === "string"
						? packageJson.scripts.install
						: null,
				build:
					typeof packageJson?.scripts?.build === "string"
						? packageJson.scripts.build
						: null,
				start:
					typeof packageJson?.scripts?.start === "string"
						? packageJson.scripts.start
						: null,
			},
			recommendedCommands: {
				install: installCommandForPackageManager(
					detectPackageManager(files, packageJson?.packageManager),
				),
				build: packageJson?.scripts?.build
					? commandForPackageManager(
							detectPackageManager(files, packageJson?.packageManager),
							toRelativePath(buildPath),
							"build",
						)
					: null,
				start: packageJson?.scripts?.start
					? commandForPackageManager(
							detectPackageManager(files, packageJson?.packageManager),
							toRelativePath(buildPath),
							"start",
						)
					: null,
			},
		} satisfies DetectedApplicationBuildTarget);
	const commands = customCommands(input.application);
	const hasWorkspaceDeps = selectedDetectedApp.hasWorkspaceDependencies;
	const rootHasTurboBuildPipeline = hasTurboBuildPipeline(files, rootPackageJson);
	const customCommandConfigured = hasCustomCommands(input.application);

	const selectionMode = input.application.buildSelectionMode ?? "explicit";
	const requestedBuilder = input.application.buildType as ApplicationBuildType;
	let selectedBuilder = selectApplicationBuilder({
		selectionMode,
		requestedBuilder,
		hasDockerfile: files.has("__NZ_DOCKERFILE_PRESENT__"),
		hasCustomCommands: customCommandConfigured,
		hasWorkspaceDependencies: hasWorkspaceDeps,
	});
	let fallbackReason: string | null = null;
	const healingHints: string[] = [];
	if (
		selectedBuilder === "railpack" &&
		(hasWorkspaceDeps || customCommandConfigured)
	) {
		selectedBuilder = "nixpacks";
		fallbackReason =
			hasWorkspaceDeps
				? "Workspace dependencies require a repository-root build context."
				: "Custom build commands require Nixpacks or Dockerfile builds.";
	}
	if (hasWorkspaceDeps) {
		healingHints.push(
			rootHasTurboBuildPipeline
				? `Detected Turbo workspace dependencies in ${selectedDetectedApp.path}; build the selected app through Turbo so dependency packages are built first.`
				: `Detected workspace dependencies in ${selectedDetectedApp.path}; build from repository root and run the selected app commands from that directory.`,
		);
	}
	if (customCommandConfigured) {
		healingHints.push("Using user-provided build commands.");
	}

	return {
		version: 1,
		selectionMode,
		requestedBuilder,
		selectedBuilder,
		fallbackReason,
		sourceRevision: revisionBlock?.trim() || null,
		buildPath,
		workspaceRoot: hasWorkspaceDeps ? "/" : null,
		selectedAppPath: selectedDetectedApp.path,
		appCount: detectedApps.length,
		detectedApps,
		packageManager: selectedDetectedApp.packageManager,
		framework: selectedDetectedApp.framework,
		commands: {
			install: commands.install ?? selectedDetectedApp.recommendedCommands.install,
			build: commands.build ?? selectedDetectedApp.recommendedCommands.build,
			start: commands.start ?? selectedDetectedApp.recommendedCommands.start,
		},
		healingHints,
		requiredCapabilities: ["docker", selectedBuilder],
		generatedAt: new Date().toISOString(),
	};
}

export function fallbackApplicationBuildPlanToNixpacks(
	plan: ApplicationBuildPlan,
	reason: string,
): ApplicationBuildPlan {
	if (
		plan.selectionMode !== "automatic" ||
		plan.selectedBuilder !== "railpack"
	) {
		throw new Error("Builder fallback is not allowed for this build plan.");
	}
	return {
		...plan,
		selectedBuilder: "nixpacks",
		fallbackReason: reason,
		requiredCapabilities: ["docker", "nixpacks"],
	};
}
