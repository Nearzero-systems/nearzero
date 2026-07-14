import type {
	ApplicationBuildPlan,
	ApplicationBuildPlanDiagnostic,
	ApplicationBuildType,
	BuildSelectionMode,
	DetectedApplicationBuildTarget,
} from "@nearzero/server/types/application-build-plan";
import type { ApplicationNested } from "@nearzero/server/utils/builders";
import { paths } from "@nearzero/server/constants";
import {
	assertPathWithinApplicationSource,
	getApplicationBuildDirectory,
} from "@nearzero/server/utils/filesystem/directory";
import {
	execAsync,
	execAsyncRemote,
} from "@nearzero/server/utils/process/execAsync";
import path from "node:path";
import { quote } from "shell-quote";

const execute = (serverId: string | null, command: string) =>
	serverId ? execAsyncRemote(serverId, command) : execAsync(command);

const packageManagerLockfiles = [
	{ file: "bun.lock", packageManager: "bun" },
	{ file: "bun.lockb", packageManager: "bun" },
	{ file: "pnpm-lock.yaml", packageManager: "pnpm" },
	{ file: "yarn.lock", packageManager: "yarn" },
	{ file: "package-lock.json", packageManager: "npm" },
] as const;

export function selectApplicationBuilder(input: {
	selectionMode: BuildSelectionMode;
	requestedBuilder: ApplicationBuildType;
	hasDockerfile: boolean;
	hasCustomCommands?: boolean;
	hasWorkspaceDependencies?: boolean;
	hasManagedFramework?: boolean;
	hasDockerfilePackageManagerMismatch?: boolean;
	hasManagedPackageManagerAgreement?: boolean;
	hasDockerfileOverrides?: boolean;
}): ApplicationBuildType {
	if (input.selectionMode === "explicit") {
		return input.requestedBuilder;
	}
	if (input.hasCustomCommands || input.hasWorkspaceDependencies) {
		return "nixpacks";
	}
	if (
		input.hasDockerfile &&
		input.hasManagedFramework &&
		input.hasDockerfilePackageManagerMismatch &&
		input.hasManagedPackageManagerAgreement &&
		!input.hasDockerfileOverrides
	) {
		return "railpack";
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

// Railpack owns its install command, so automatic selection is safe only when
// its documented lockfile precedence resolves to the same package manager as
// Nearzero's source inspection. This matters when a repository commits more
// than one lockfile.
function detectRailpackPackageManager(
	files: Set<string>,
	packageManager?: string,
) {
	if (packageManager) return packageManager.split("@")[0] || null;
	if (files.has("pnpm-lock.yaml") || files.has("pnpm-workspace.yaml")) {
		return "pnpm";
	}
	if (files.has("bun.lock") || files.has("bun.lockb")) return "bun";
	if (files.has(".yarnrc.yml") || files.has(".yarnrc.yaml")) return "yarn";
	if (files.has("yarn.lock")) return "yarn";
	return "npm";
}

function findPackageManagerLockfiles(files: Set<string>) {
	const matches = packageManagerLockfiles.filter(({ file }) => files.has(file));
	return {
		lockfiles: matches.map(({ file }) => file),
		packageManagers: [...new Set(matches.map(({ packageManager }) => packageManager))],
	};
}

function parseDockerfilePackageManagerFingerprint(fingerprint: string | undefined) {
	const supportedPackageManagers = new Set(["npm", "pnpm", "yarn", "bun"]);
	return [
		...new Set(
			(fingerprint ?? "")
				.split(/[,\n]/)
				.map((value) => value.trim().toLowerCase())
				.filter((value) => supportedPackageManagers.has(value)),
		),
	];
}

const platformManagedDockerBuildKeys = new Set(["NEARZERO_DEPLOY_URL"]);

function hasUserDockerBuildValues(value: string | null | undefined) {
	return (value ?? "")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.some((line) => {
			const separator = line.indexOf("=");
			const key = (separator >= 0 ? line.slice(0, separator) : line).trim();
			return !platformManagedDockerBuildKeys.has(key);
		});
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
	packages: Array<{
		relativePath: string;
		packageJson: Record<string, any> | null;
		files: Set<string>;
	}>;
	rootFiles: Set<string>;
	rootPackageJson: Record<string, any> | null;
}): DetectedApplicationBuildTarget[] {
	const rootPackageManager = repoPackageManager(input.rootFiles, input.rootPackageJson);
	const rootHasTurboBuildPipeline = hasTurboBuildPipeline(
		input.rootFiles,
		input.rootPackageJson,
	);
	const apps: DetectedApplicationBuildTarget[] = [];
	for (const { relativePath, packageJson, files: packageFiles } of input.packages) {
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
	const directory = quote([buildDirectory]);
	const sourceDirectoryQuoted = quote([sourceDirectory]);
	const configuredDockerfile = input.application.dockerfile || "Dockerfile";
	let dockerfile: string | null = null;
	let dockerfilePathError: Error | null = null;
	try {
		const dockerfilePath = assertPathWithinApplicationSource(
			sourceDirectory,
			path.join(buildDirectory, configuredDockerfile),
			"Dockerfile path",
		);
		dockerfile = quote([path.relative(sourceDirectory, dockerfilePath)]);
	} catch (error) {
		dockerfilePathError =
			error instanceof Error
				? error
				: new Error("Dockerfile path must stay inside the checked-out source directory.");
	}
	const { stdout } = await execute(
		input.buildServerId,
		[
			`cd ${sourceDirectoryQuoted}`,
			"printf '%s\\n' '__NZ_FILES__'",
			'for file in Dockerfile bun.lock bun.lockb pnpm-lock.yaml pnpm-workspace.yaml .yarnrc.yml .yarnrc.yaml yarn.lock package-lock.json package.json turbo.json turbo.jsonc; do test -f "$file" && printf \'%s\\n\' "$file"; done',
			dockerfile
				? `test -f ${dockerfile} && printf '%s\\n' '__NZ_DOCKERFILE_PRESENT__' || true`
				: "true",
			"printf '%s\\n' '__NZ_DOCKERFILE_PACKAGE_MANAGERS__'",
			dockerfile
				? `if test -f ${dockerfile}; then NZ_DOCKERFILE_RUN_INSTRUCTIONS="$(head -c 131072 ${dockerfile} | sed -E '/^[[:space:]]*#/d; s/[[:space:]]+#.*$//' | grep -Ei '^[[:space:]]*RUN[[:space:]]' || true)"; printf '%s\\n' "$NZ_DOCKERFILE_RUN_INSTRUCTIONS" | grep -Eiq '.*[^[:alnum:]_]npm[[:space:]]+(ci|install|i)([^[:alnum:]_]|$)' && printf '%s\\n' npm; printf '%s\\n' "$NZ_DOCKERFILE_RUN_INSTRUCTIONS" | grep -Eiq '.*[^[:alnum:]_]pnpm[[:space:]]+(install|i|fetch)([^[:alnum:]_]|$)' && printf '%s\\n' pnpm; printf '%s\\n' "$NZ_DOCKERFILE_RUN_INSTRUCTIONS" | grep -Eiq '.*[^[:alnum:]_]yarn[[:space:]]+(install|--immutable)([^[:alnum:]_]|$)' && printf '%s\\n' yarn; printf '%s\\n' "$NZ_DOCKERFILE_RUN_INSTRUCTIONS" | grep -Eiq '.*[^[:alnum:]_]bun[[:space:]]+(install|i)([^[:alnum:]_]|$)' && printf '%s\\n' bun; fi`
				: "true",
			"printf '%s\\n' '__NZ_REVISION__'",
			"git rev-parse HEAD 2>/dev/null || true",
			"printf '%s\\n' '__NZ_PACKAGES__'",
			"find . -maxdepth 4 \\( -path './node_modules/*' -o -path './.git/*' -o -path './.next/*' -o -path './dist/*' -o -path './build/*' \\) -prune -o -name package.json -type f -print 2>/dev/null | sort | while IFS= read -r file; do rel=${file#./}; dir=$(dirname \"$rel\"); [ \"$dir\" = \".\" ] && dir=\".\"; printf '__NZ_PACKAGE_PATH__%s\\n__NZ_PACKAGE_FILES__\\n' \"$dir\"; for candidate in bun.lock bun.lockb pnpm-lock.yaml pnpm-workspace.yaml .yarnrc.yml .yarnrc.yaml yarn.lock package-lock.json; do test -f \"$dir/$candidate\" && printf '%s\\n' \"$candidate\"; done; printf '%s\\n' '__NZ_PACKAGE_JSON__'; base64 < \"$file\" | tr -d '\\n'; printf '\\n__NZ_PACKAGE_END__\\n'; done",
			"printf '%s\\n' '__NZ_SELECTED_FILES__'",
			`(cd ${directory} && for candidate in package.json bun.lock bun.lockb pnpm-lock.yaml pnpm-workspace.yaml .yarnrc.yml .yarnrc.yaml yarn.lock package-lock.json; do test -f "$candidate" && printf '%s\\n' "$candidate"; done) || true`,
			"printf '%s\\n' '__NZ_SELECTED_PACKAGE_JSON__'",
			`cd ${directory} && test -f package.json && cat package.json || true`,
		].join("\n"),
	);
	const filesBlock = stdout
		.split("__NZ_FILES__")[1]
		?.split("__NZ_DOCKERFILE_PACKAGE_MANAGERS__")[0];
	const dockerfilePackageManagersBlock = stdout
		.split("__NZ_DOCKERFILE_PACKAGE_MANAGERS__")[1]
		?.split("__NZ_REVISION__")[0]
		?.trim();
	const revisionBlock = stdout
		.split("__NZ_REVISION__")[1]
		?.split("__NZ_PACKAGES__")[0];
	const packagesBlock = stdout
		.split("__NZ_PACKAGES__")[1]
		?.split("__NZ_SELECTED_FILES__")[0];
	const selectedFilesBlock = stdout
		.split("__NZ_SELECTED_FILES__")[1]
		?.split("__NZ_SELECTED_PACKAGE_JSON__")[0];
	const selectedPackageJsonBlock = stdout
		.split("__NZ_SELECTED_PACKAGE_JSON__")[1]
		?.trim();
	const dockerfilePackageManagers = parseDockerfilePackageManagerFingerprint(
		dockerfilePackageManagersBlock,
	);
	const files = new Set(
		(filesBlock ?? "")
			.split("\n")
			.map((value) => value.trim())
			.filter(Boolean),
	);
	const packages: Array<{
		relativePath: string;
		packageJson: Record<string, any> | null;
		files: Set<string>;
	}> = [];
	for (const block of (packagesBlock ?? "").split("__NZ_PACKAGE_PATH__")) {
		const trimmed = block.trim();
		if (!trimmed) continue;
		const [relativePathLine, ...rest] = trimmed.split("\n");
		const payload = rest.join("\n");
		const packageFilesBlock = payload
			.split("__NZ_PACKAGE_FILES__")[1]
			?.split("__NZ_PACKAGE_JSON__")[0];
		const encoded = payload
			.split("__NZ_PACKAGE_JSON__")[1]
			?.split("__NZ_PACKAGE_END__")[0]
			?.trim();
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
			files: new Set(
				(packageFilesBlock ?? "")
					.split("\n")
					.map((value) => value.trim())
					.filter(Boolean),
			),
		});
	}
	const rootPackageJson =
		packages.find((pkg) => pkg.relativePath === ".")?.packageJson ?? null;
	const buildPath = normalizeBuildPath(getConfiguredBuildPath(input.application));
	const selectedPackage = packages.find(
		(pkg) => pkg.relativePath === toRelativePath(buildPath),
	);
	const packageJson =
		selectedPackage?.packageJson ?? parsePackageJson(selectedPackageJsonBlock);
	const selectedPackageFiles = new Set(
		(selectedFilesBlock ?? "")
			.split("\n")
			.map((value) => value.trim())
			.filter(Boolean),
	);
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
			packageManager:
				detectPackageManager(
					selectedPackageFiles,
					packageJson?.packageManager,
				) ?? repoPackageManager(files, rootPackageJson),
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
					detectPackageManager(
						selectedPackageFiles,
						packageJson?.packageManager,
					) ?? repoPackageManager(files, rootPackageJson),
				),
				build: packageJson?.scripts?.build
					? commandForPackageManager(
							detectPackageManager(
								selectedPackageFiles,
								packageJson?.packageManager,
							) ?? repoPackageManager(files, rootPackageJson),
							toRelativePath(buildPath),
							"build",
						)
					: null,
				start: packageJson?.scripts?.start
					? commandForPackageManager(
							detectPackageManager(
								selectedPackageFiles,
								packageJson?.packageManager,
							) ?? repoPackageManager(files, rootPackageJson),
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
	const hasDockerfile = files.has("__NZ_DOCKERFILE_PRESENT__");
	const hasDockerfilePackageManagerMismatch = Boolean(
		hasDockerfile &&
			selectedDetectedApp.packageManager &&
			dockerfilePackageManagers.length === 1 &&
			!dockerfilePackageManagers.includes(selectedDetectedApp.packageManager),
	);
	const railpackPackageManager = detectRailpackPackageManager(
		selectedPackageFiles,
		packageJson?.packageManager,
	);
	const hasManagedPackageManagerAgreement = Boolean(
		selectedDetectedApp.packageManager &&
			railpackPackageManager === selectedDetectedApp.packageManager,
	);
	const hasDockerfileOverrides = Boolean(
		configuredDockerfile !== "Dockerfile" ||
			input.application.dockerContextPath?.trim() ||
			input.application.dockerBuildStage?.trim() ||
			hasUserDockerBuildValues(input.application.buildArgs) ||
			hasUserDockerBuildValues(input.application.buildSecrets),
	);
	let selectedBuilder = selectApplicationBuilder({
		selectionMode,
		requestedBuilder,
		hasDockerfile,
		hasCustomCommands: customCommandConfigured,
		hasWorkspaceDependencies: hasWorkspaceDeps,
		hasManagedFramework: Boolean(selectedDetectedApp.framework),
		hasDockerfilePackageManagerMismatch,
		hasManagedPackageManagerAgreement,
		hasDockerfileOverrides,
	});
	if (selectedBuilder === "dockerfile" && dockerfilePathError) {
		throw dockerfilePathError;
	}
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

	const diagnostics: ApplicationBuildPlanDiagnostic[] = [];
	const lockfileEvidence = findPackageManagerLockfiles(
		hasWorkspaceDeps ? files : selectedPackageFiles,
	);
	if (lockfileEvidence.packageManagers.length > 1) {
		diagnostics.push({
			code: "multiple_package_manager_lockfiles",
			severity: "warning",
			lockfiles: lockfileEvidence.lockfiles,
			packageManagers: lockfileEvidence.packageManagers,
			message:
				`Multiple package-manager lockfiles were detected (${lockfileEvidence.lockfiles.join(", ")}). ` +
				"Retain one canonical lockfile and ensure packageManager identifies the intended tool for deterministic managed builds.",
		});
	}

	if (
		selectionMode === "automatic" &&
		hasDockerfile &&
		selectedBuilder !== "dockerfile" &&
		hasDockerfilePackageManagerMismatch &&
		selectedDetectedApp.framework &&
		selectedDetectedApp.packageManager
	) {
		diagnostics.push({
			code: "managed_builder_preferred_over_dockerfile",
			severity: "info",
			dockerfile: configuredDockerfile,
			framework: selectedDetectedApp.framework,
			repositoryPackageManager: selectedDetectedApp.packageManager,
			dockerfilePackageManagers,
			preferredBuilder: selectedBuilder,
			message:
				`Automatic mode preferred ${selectedBuilder} for the detected ${selectedDetectedApp.framework} application because repository detection resolves to ${selectedDetectedApp.packageManager}, ` +
				`while ${configuredDockerfile} appears to use ${dockerfilePackageManagers.join(", ")}. ` +
				"Select Dockerfile explicitly to make its commands authoritative.",
		});
	}

	if (selectedBuilder === "dockerfile") {
		diagnostics.push({
			code: "dockerfile_authoritative",
			severity: "info",
			dockerfile: configuredDockerfile,
			message:
				`Repository Dockerfile ${configuredDockerfile} controls dependency installation, build, and start commands. ` +
				"Nearzero will not override those commands.",
		});
		if (
			selectedDetectedApp.packageManager &&
			dockerfilePackageManagers.length > 0 &&
			!dockerfilePackageManagers.includes(selectedDetectedApp.packageManager)
		) {
			diagnostics.push({
				code: "dockerfile_package_manager_mismatch",
				severity: "warning",
				repositoryPackageManager: selectedDetectedApp.packageManager,
				dockerfilePackageManagers,
				message:
					`Repository detection resolves to ${selectedDetectedApp.packageManager}, but ${configuredDockerfile} appears to use ${dockerfilePackageManagers.join(", ")}. ` +
					"Dockerfile commands remain authoritative; align metadata and lockfiles for deterministic managed builds.",
			});
		}
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
		diagnostics,
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
