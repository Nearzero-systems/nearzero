import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

const root = join(import.meta.dir, "..");
const failures: string[] = [];

const publicSourceRoots = [
	"apps/console/src",
	"apps/platform/server",
	"packages/server/src",
	"packages/agent/src",
	"packages/edition-community/src",
	"packages/edition-contract/src",
];

const forbiddenPublicImportPatterns = [
	"@nearzero/cloud",
	"/proprietary/",
	"services/proprietary/",
	"routers/proprietary/",
	"routers/stripe",
	"handlers/stripe/",
	"managed-git-provider",
];

const forbiddenPublicPaths = [
	"apps/platform/server/api/routers/proprietary",
	"apps/platform/server/api/routers/stripe.ts",
	"apps/platform/server/routes/handlers/stripe",
	"packages/server/src/services/proprietary",
	"packages/server/src/services/managed-git-provider.ts",
];

function read(path: string) {
	return readFileSync(join(root, path), "utf8");
}

function expectIncludes(path: string, pattern: string, label: string) {
	const contents = read(path);
	if (!contents.includes(pattern)) {
		failures.push(`${path}: missing ${label}`);
	}
}

function expectOrder(path: string, first: string, second: string, label: string) {
	const contents = read(path);
	const firstIndex = contents.indexOf(first);
	const secondIndex = contents.indexOf(second);
	if (firstIndex === -1 || secondIndex === -1 || firstIndex > secondIndex) {
		failures.push(`${path}: invalid order for ${label}`);
	}
}

function walk(dir: string, output: string[] = []) {
	for (const entry of readdirSync(dir)) {
		if (
			entry === ".git" ||
			entry === "node_modules" ||
			entry === ".turbo" ||
			entry === "dist"
		) {
			continue;
		}
		const absolute = join(dir, entry);
		const stat = statSync(absolute);
		if (stat.isDirectory()) {
			walk(absolute, output);
		} else if (/\.(ts|tsx|astro|mjs|js)$/.test(entry)) {
			output.push(relative(root, absolute));
		}
	}
	return output;
}

function walkAll(dir: string, output: string[] = []) {
	for (const entry of readdirSync(dir)) {
		if (entry === ".git" || entry === "node_modules" || entry === ".turbo") {
			continue;
		}
		const absolute = join(dir, entry);
		const stat = statSync(absolute);
		if (stat.isDirectory()) {
			walkAll(absolute, output);
		} else {
			output.push(relative(root, absolute));
		}
	}
	return output;
}

expectIncludes(
	"apps/platform/server/edition-bootstrap.ts",
	"bootstrapCommunityEdition",
	"community edition bootstrap",
);
expectIncludes(
	"apps/platform/server/server.ts",
	"bootstrapEdition",
	"platform edition bootstrap call",
);
expectIncludes(
	"packages/edition-community/src/community-edition.ts",
	"allowsEnvAgentProviderKey(): boolean",
	"community BYOK agent policy",
);
expectIncludes(
	"packages/agent/src/engine/resolve-provider.ts",
	"allowsEnvAgentProviderKey",
	"agent provider edition gate",
);
expectIncludes(
	"apps/platform/server/api/routers/settings.ts",
	"getEditionManifest",
	"edition manifest API",
);

expectIncludes(
	"packages/server/src/services/git-provider-policy.ts",
	"getEdition()",
	"edition-backed git provider policy",
);
expectIncludes(
	"apps/platform/server/api/routers/github.ts",
	'assertByoGitProvidersAllowed("GitHub")',
	"GitHub BYO route block",
);
expectIncludes(
	"apps/platform/server/api/routers/github.ts",
	"isGitProviderConnectionAllowed(provider)",
	"GitHub hosted provider filter",
);
expectIncludes(
	"packages/server/src/services/github.ts",
	'assertGitProviderConnectionAllowed(githubProviderResult, "GitHub")',
	"GitHub stored provider lookup block",
);
expectIncludes(
	"packages/server/src/utils/providers/github.ts",
	'assertGitProviderConnectionAllowed(githubProvider, "GitHub")',
	"GitHub credential resolver block",
);
expectIncludes(
	"apps/platform/server/routes/handlers/deploy/github.ts",
	"res.status(403).json({ message: error.message });",
	"GitHub webhook hosted BYO rejection",
);
expectOrder(
	"apps/platform/server/routes/handlers/providers/github/setup.ts",
	"isManagedGitProviderState(state)",
	"isHostedEditionMode()",
	"managed GitHub state before hosted BYO block",
);

expectIncludes(
	"apps/console/src/components/dashboard/settings/GitProvidersDashboard.astro",
	"data-is-community=\"1\"",
	"Astro Community-only Git provider modals",
);
expectIncludes(
	"apps/console/src/components/dashboard/settings/GitProvidersDashboard.astro",
	"<GitProviderModals",
	"Astro Git provider modals",
);

expectIncludes(
	"apps/console/src/pages/dashboard/about-nearzero.astro",
	"<AboutNearzeroDashboard />",
	"Astro About Nearzero dashboard render",
);
expectIncludes(
	"apps/console/src/lib/settings-nav.ts",
	'return "/dashboard/about-nearzero";',
	"Astro settings default About Nearzero path",
);
expectIncludes(
	"apps/console/src/components/dashboard/navMenu.ts",
	"settings-about-nearzero",
	"Astro sidebar About Nearzero entry",
);
expectIncludes(
	"apps/console/src/pages/dashboard/monitoring.astro",
	"Astro.redirect(scopeDashboardHref",
	"Astro monitoring redirect",
);
expectIncludes(
	"apps/console/src/pages/dashboard/monitoring.astro",
	"/dashboard/about-nearzero",
	"Astro monitoring redirect target",
);

expectIncludes(
	".github/workflows/pull-request.yml",
	"verify:edition-split",
	"PR edition split pipeline guard",
);

for (const forbiddenPath of forbiddenPublicPaths) {
	try {
		statSync(join(root, forbiddenPath));
		failures.push(`${forbiddenPath}: must not exist in the Community tree`);
	} catch {
		// expected
	}
}

for (const sourceRoot of publicSourceRoots) {
	for (const path of walk(join(root, sourceRoot))) {
		if (path.includes("/__test__/")) continue;
		const contents = read(path);
		for (const pattern of forbiddenPublicImportPatterns) {
			if (contents.includes(pattern)) {
				failures.push(`${path}: forbidden public reference to ${pattern}`);
			}
		}
	}
}

const managedSecretNames = [
	"NEARZERO_GITHUB_APP_PRIVATE_KEY",
	"NEARZERO_GITHUB_CLIENT_SECRET",
	"NEARZERO_GITLAB_CLIENT_SECRET",
	"NEARZERO_GITEA_CLIENT_SECRET",
	"NEARZERO_BITBUCKET_CLIENT_SECRET",
];

for (const path of walkAll(root)) {
	const name = basename(path);
	if (!name.includes(".env")) continue;
	const contents = read(path);
	for (const secretName of managedSecretNames) {
		if (contents.includes(secretName)) {
			failures.push(
				`${path}: managed Cloud/Enterprise secret ${secretName} must not be documented in env files`,
			);
		}
	}
}

if (failures.length > 0) {
	console.error("Edition split verification failed:");
	for (const failure of failures) {
		console.error(`- ${failure}`);
	}
	process.exit(1);
}

console.log("Edition split verification passed.");
