import { join, posix as pathPosix } from "node:path";
import { paths } from "@nearzero/server/constants";
import type { apiFindGithubBranches } from "@nearzero/server/db/schema";
import { findGithubById, type Github } from "@nearzero/server/services/github";
import {
	assertGitProviderConnectionAllowed,
	isHostedEditionMode,
} from "@nearzero/server/services/git-provider-policy";
import {
	getManagedGithubConfig,
	isNearzeroManagedGitProvider,
} from "@nearzero/server/services/managed-git-provider";
import type { InferResultType } from "@nearzero/server/types/with";
import { createAppAuth } from "@octokit/auth-app";
import { TRPCError } from "@trpc/server";
import { Octokit } from "octokit";
import type { z } from "zod";

type GithubWithProvider = Github & {
	gitProvider?: { connectionMode?: string | null } | null;
};

const resolveGithubAppCredentials = (githubProvider: GithubWithProvider) => {
	assertGitProviderConnectionAllowed(githubProvider, "GitHub");

	if (isNearzeroManagedGitProvider(githubProvider)) {
		const config = getManagedGithubConfig();
		return {
			appId: config.appId,
			privateKey: config.privateKey,
			installationId: githubProvider.githubInstallationId,
			webhookSecret: config.webhookSecret,
		};
	}

	return {
		appId: githubProvider.githubAppId,
		privateKey: githubProvider.githubPrivateKey,
		installationId: githubProvider.githubInstallationId,
		webhookSecret: githubProvider.githubWebhookSecret,
	};
};

export const authGithub = (githubProvider: Github): Octokit => {
	if (!haveGithubRequirements(githubProvider)) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Github Account not configured correctly",
		});
	}
	const credentials = resolveGithubAppCredentials(githubProvider);

	const octokit: Octokit = new Octokit({
		authStrategy: createAppAuth,
		auth: {
			appId: credentials.appId || 0,
			privateKey: credentials.privateKey || "",
			installationId: credentials.installationId,
		},
	});

	return octokit;
};

export const getGithubToken = async (
	octokit: ReturnType<typeof authGithub>,
) => {
	const installation = (await octokit.auth({
		type: "installation",
	})) as {
		token: string;
	};

	return installation.token;
};

export const getGithubWebhookSecret = (githubProvider: Github) => {
	return resolveGithubAppCredentials(githubProvider).webhookSecret ?? null;
};

/**
 * Check if a GitHub user has write/admin permissions on a repository
 * This is used to validate PR authors before allowing preview deployments
 */
export const checkUserRepositoryPermissions = async (
	githubProvider: Github,
	owner: string,
	repo: string,
	username: string,
): Promise<{ hasWriteAccess: boolean; permission: string | null }> => {
	try {
		const octokit = authGithub(githubProvider);

		// Check if user is a collaborator with write permissions
		const { data: permission } =
			await octokit.rest.repos.getCollaboratorPermissionLevel({
				owner,
				repo,
				username,
			});

		// Allow only users with 'write', 'admin', or 'maintain' permissions
		// Currently exists Read, Triage, Write, Maintain, Admin
		const allowedPermissions = ["write", "admin", "maintain"];
		const hasWriteAccess = allowedPermissions.includes(permission.permission);

		return {
			hasWriteAccess,
			permission: permission.permission,
		};
	} catch (error) {
		// If user is not a collaborator, GitHub API returns 404
		console.warn(
			`User ${username} is not a collaborator of ${owner}/${repo}:`,
			error,
		);
		return {
			hasWriteAccess: false,
			permission: null,
		};
	}
};

export const haveGithubRequirements = (githubProvider: Github) => {
	if (isHostedEditionMode() && !isNearzeroManagedGitProvider(githubProvider)) {
		return false;
	}
	const credentials = resolveGithubAppCredentials(githubProvider);
	return !!(
		credentials.appId &&
		credentials.privateKey &&
		credentials.installationId
	);
};

const getErrorCloneRequirements = (entity: {
	repository?: string | null;
	owner?: string | null;
	branch?: string | null;
}) => {
	const reasons: string[] = [];
	const { repository, owner, branch } = entity;

	if (!repository) reasons.push("1. Repository not assigned.");
	if (!owner) reasons.push("2. Owner not specified.");
	if (!branch) reasons.push("3. Branch not defined.");

	return reasons;
};

export type ApplicationWithGithub = InferResultType<
	"applications",
	{ github: true }
>;

export type ComposeWithGithub = InferResultType<"compose", { github: true }>;

interface CloneGithubRepository {
	appName: string;
	owner: string | null;
	branch: string | null;
	githubId: string | null;
	repository: string | null;
	type?: "application" | "compose";
	enableSubmodules: boolean;
	serverId: string | null;
	outputPathOverride?: string;
}
export const cloneGithubRepository = async ({
	type = "application",
	...entity
}: CloneGithubRepository, options?: { targetServerId?: string | null }) => {
	let command = "set -e;";
	const isCompose = type === "compose";
	const {
		appName,
		repository,
		owner,
		branch,
		githubId,
		enableSubmodules,
		serverId,
		outputPathOverride,
	} = entity;
	const targetServerId = options?.targetServerId ?? serverId;
	const { APPLICATIONS_PATH, COMPOSE_PATH } = paths(!!targetServerId);

	if (!githubId) {
		command += `echo "Error: ❌ Github Provider not found"; exit 1;`;

		return command;
	}

	const requirements = getErrorCloneRequirements(entity);

	// Check if requirements are met
	if (requirements.length > 0) {
		command += `echo "GitHub Repository configuration failed for application: ${appName}"; echo "Reasons:"; echo "${requirements.join("\n")}"; exit 1;`;
		return command;
	}

	const githubProvider = await findGithubById(githubId);
	const basePath = isCompose ? COMPOSE_PATH : APPLICATIONS_PATH;
	const outputPath = outputPathOverride ?? join(basePath, appName, "code");
	const octokit = authGithub(githubProvider);
	const token = await getGithubToken(octokit);
	const repoclone = `github.com/${owner}/${repository}.git`;
	command += `rm -rf ${outputPath};`;
	command += `mkdir -p ${outputPath};`;
	const cloneUrl = `https://oauth2:${token}@${repoclone}`;

	command += `echo "Cloning Repo ${repoclone} to ${outputPath}: ✅";`;
	command += `git clone --branch ${branch} --depth 1 ${enableSubmodules ? "--recurse-submodules" : ""} ${cloneUrl} ${outputPath} --progress;`;

	return command;
};

export const getGithubRepositories = async (githubId?: string) => {
	if (!githubId) {
		return [];
	}

	const githubProvider = await findGithubById(githubId);

	const octokit = authGithub(githubProvider);

	const repositories = (await octokit.paginate(
		octokit.rest.apps.listReposAccessibleToInstallation,
	)) as unknown as Awaited<
		ReturnType<typeof octokit.rest.apps.listReposAccessibleToInstallation>
	>["data"]["repositories"];

	return repositories;
};

export type GithubRepositoryDetectedApp = {
	path: string;
	packageName: string | null;
	framework: string | null;
	packageManager: string | null;
	hasWorkspaceDependencies: boolean;
	scripts: {
		build: string | null;
		start: string | null;
	};
	recommendedCommands: {
		install: string;
		build: string | null;
		start: string | null;
	};
};

const ignoredTreeSegments = new Set([
	".git",
	".next",
	"build",
	"dist",
	"node_modules",
	"out",
]);

function isIgnoredRepoPath(filePath: string) {
	return filePath.split("/").some((part) => ignoredTreeSegments.has(part));
}

function parseRepositoryPackageJson(raw: string) {
	try {
		return JSON.parse(raw) as Record<string, any>;
	} catch {
		return null;
	}
}

function detectRepositoryFramework(packageJson: Record<string, any> | null) {
	const dependencies = {
		...(packageJson?.dependencies ?? {}),
		...(packageJson?.devDependencies ?? {}),
	};
	for (const framework of [
		"next",
		"astro",
		"vite",
		"react",
		"vue",
		"nuxt",
		"svelte",
		"@sveltejs/kit",
		"@remix-run/react",
		"@angular/core",
	]) {
		if (framework in dependencies) return framework;
	}
	return null;
}

function hasRepositoryWorkspaceDependencies(packageJson: Record<string, any> | null) {
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

function hasRepositoryTurboBuildPipeline(
	paths: Set<string>,
	rootPackageJson: Record<string, any> | null,
) {
	if (!paths.has("turbo.json") && !paths.has("turbo.jsonc")) {
		return false;
	}
	const dependencies = {
		...(rootPackageJson?.dependencies ?? {}),
		...(rootPackageJson?.devDependencies ?? {}),
	};
	return "turbo" in dependencies;
}

function detectRepositoryPackageManager(paths: Set<string>, packageManager?: string) {
	if (packageManager) return packageManager.split("@")[0] || null;
	if (paths.has("pnpm-workspace.yaml") || paths.has("pnpm-lock.yaml")) return "pnpm";
	if (paths.has("bun.lock") || paths.has("bun.lockb")) return "bun";
	if (paths.has("yarn.lock")) return "yarn";
	if (paths.has("package-lock.json")) return "npm";
	return null;
}

function installCommandForRepositoryPackageManager(packageManager: string | null) {
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

function isSafeRepositoryPackageName(packageName: string | null | undefined) {
	return Boolean(
		packageName &&
			/^(@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+$/.test(packageName),
	);
}

function turboRepositoryBuildCommand(
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

function runCommandForRepositoryPackageManager(
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
		isSafeRepositoryPackageName(options.packageName)
	) {
		return turboRepositoryBuildCommand(packageManager, options.packageName!);
	}
	const directoryPrefix = relativePath === "." ? "" : `cd ${relativePath} && `;
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

function normalizedRepositoryFramework(framework: string | null | undefined) {
	const value = (framework ?? "").trim().toLowerCase();
	if (value === "next" || value === "nextjs") return "nextjs";
	if (value === "@sveltejs/kit" || value === "svelte") return "sveltekit";
	if (value === "@remix-run/react" || value === "remix") return "remix";
	if (value === "@angular/core" || value === "angular") return "angular";
	return value || null;
}

function repositoryPathSegment(buildPath: string) {
	return buildPath.split("/").filter(Boolean).pop()?.toLowerCase() ?? "";
}

function isNextRepositoryApp(app: GithubRepositoryDetectedApp) {
	return normalizedRepositoryFramework(app.framework) === "nextjs";
}

function repositoryAppPriority(
	app: GithubRepositoryDetectedApp,
	apps: GithubRepositoryDetectedApp[],
) {
	const nextApps = apps.filter(isNextRepositoryApp);
	if (isNextRepositoryApp(app)) {
		if (nextApps.length === 1) return 0;
		const segment = repositoryPathSegment(app.path);
		if (segment === "web") return 1;
		if (segment === "app") return 2;
		return 3;
	}
	if (app.framework) return 20;
	if (app.path === "/") return 40;
	return 30;
}

function sortRepositoryApps(apps: GithubRepositoryDetectedApp[]) {
	return [...apps].sort((a, b) => {
		const priority = repositoryAppPriority(a, apps) - repositoryAppPriority(b, apps);
		if (priority !== 0) return priority;
		return a.path.localeCompare(b.path);
	});
}

export const detectGithubRepositoryApps = async (input: {
	githubId: string;
	owner: string;
	repo: string;
	branch?: string | null;
}): Promise<GithubRepositoryDetectedApp[]> => {
	const githubProvider = await findGithubById(input.githubId);
	const octokit = authGithub(githubProvider);
	const branch = input.branch?.trim() || "main";
	let treeSha = branch;
	try {
		const branchResult = await octokit.rest.repos.getBranch({
			owner: input.owner,
			repo: input.repo,
			branch,
		});
		treeSha = branchResult.data.commit.sha;
	} catch {
		treeSha = branch;
	}

	const { data: tree } = await octokit.rest.git.getTree({
		owner: input.owner,
		repo: input.repo,
		tree_sha: treeSha,
		recursive: "true",
	});
	const repoPaths = new Set(
		tree.tree
			.map((item) => item.path)
			.filter((value): value is string => Boolean(value)),
	);
	const packageItems = tree.tree
		.filter(
			(item) =>
				item.type === "blob" &&
				item.path?.endsWith("package.json") &&
				!isIgnoredRepoPath(item.path) &&
				item.path.split("/").length <= 5 &&
				Boolean(item.sha),
		)
		.slice(0, 30);
	const packages = await Promise.all(
		packageItems.map(async (item) => {
			const blob = await octokit.rest.git.getBlob({
				owner: input.owner,
				repo: input.repo,
				file_sha: item.sha!,
			});
			const raw = Buffer.from(blob.data.content, "base64").toString("utf8");
			const relativePath = item.path === "package.json" ? "." : pathPosix.dirname(item.path!);
			return {
				relativePath,
				packageJson: parseRepositoryPackageJson(raw),
			};
		}),
	);
	const rootPackageJson =
		packages.find((pkg) => pkg.relativePath === ".")?.packageJson ?? null;
	const rootPackageManager = detectRepositoryPackageManager(
		repoPaths,
		rootPackageJson?.packageManager,
	);
	const rootHasTurboBuildPipeline = hasRepositoryTurboBuildPipeline(
		repoPaths,
		rootPackageJson,
	);
	const apps = packages
		.map(({ relativePath, packageJson }) => {
			const scripts = packageJson?.scripts ?? {};
			const framework = detectRepositoryFramework(packageJson);
			const hasWorkspaceDependencies = hasRepositoryWorkspaceDependencies(packageJson);
			const hasRunnableScripts = Boolean(scripts.build || scripts.start);
			const packageName =
				typeof packageJson?.name === "string" ? packageJson.name : null;
			if (!framework && !hasWorkspaceDependencies && !hasRunnableScripts) {
				return null;
			}
			const packageManager =
				detectRepositoryPackageManager(repoPaths, packageJson?.packageManager) ??
				rootPackageManager;
			return {
				path: relativePath === "." ? "/" : `/${relativePath}`,
				packageName,
				framework,
				packageManager,
				hasWorkspaceDependencies,
				scripts: {
					build: typeof scripts.build === "string" ? scripts.build : null,
					start: typeof scripts.start === "string" ? scripts.start : null,
				},
				recommendedCommands: {
					install: installCommandForRepositoryPackageManager(packageManager),
					build: scripts.build
						? runCommandForRepositoryPackageManager(
								packageManager,
								relativePath,
								"build",
								{
									hasTurboBuildPipeline: rootHasTurboBuildPipeline,
									hasWorkspaceDependencies,
									packageName,
								},
							)
						: null,
					start: scripts.start
						? runCommandForRepositoryPackageManager(
								packageManager,
								relativePath,
								"start",
							)
						: null,
				},
			} satisfies GithubRepositoryDetectedApp;
		})
		.filter((app): app is GithubRepositoryDetectedApp => Boolean(app));
	return sortRepositoryApps(apps);
};

/**
 * Returns the login of the GitHub account (user or organization) that the
 * GitHub App installation belongs to (e.g. "theshreyanshsingh").
 *
 * This is resilient by design: any failure (missing configuration, network
 * error, revoked installation, etc.) resolves to `null` so callers can safely
 * fall back to another label without breaking the surrounding request.
 */
export const getGithubInstallationAccountName = async (
	githubId?: string,
): Promise<string | null> => {
	if (!githubId) {
		return null;
	}

	try {
		const githubProvider = await findGithubById(githubId);

		if (
			!haveGithubRequirements(githubProvider) ||
			!githubProvider.githubInstallationId
		) {
			return null;
		}

		// Authenticate as the GitHub App (JWT), NOT as the installation.
		// `apps.getInstallation` is an app-level endpoint and rejects
		// installation tokens, so we intentionally omit `installationId` here.
		const credentials = resolveGithubAppCredentials(githubProvider);
		const octokit = new Octokit({
			authStrategy: createAppAuth,
			auth: {
				appId: credentials.appId,
				privateKey: credentials.privateKey,
			},
		});

		const { data } = await octokit.rest.apps.getInstallation({
			installation_id: Number(githubProvider.githubInstallationId),
		});

		const account = data.account as { login?: string } | null;
		return account?.login ?? null;
	} catch {
		return null;
	}
};

export const getGithubBranches = async (
	input: z.infer<typeof apiFindGithubBranches>,
) => {
	if (!input.githubId) {
		return [];
	}
	const githubProvider = await findGithubById(input.githubId);

	const octokit = authGithub(githubProvider);

	const branches = (await octokit.paginate(octokit.rest.repos.listBranches, {
		owner: input.owner,
		repo: input.repo,
	})) as unknown as Awaited<
		ReturnType<typeof octokit.rest.repos.listBranches>
	>["data"];

	return branches;
};
