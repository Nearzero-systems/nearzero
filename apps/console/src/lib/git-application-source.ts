import { trpcQuery } from "@/lib/client-api";

export type GithubRepoOption = { owner: string; repo: string };
export type GitlabRepoOption = {
	owner: string;
	repo: string;
	gitlabPathNamespace: string;
	id: number | null;
};
export type BitbucketRepoOption = { owner: string; repo: string; slug: string };
export type GiteaRepoOption = { owner: string; repo: string };

export type GitProviderKind = "github" | "gitlab" | "bitbucket" | "gitea";

export type RepoOptionJson =
	| GithubRepoOption
	| GitlabRepoOption
	| BitbucketRepoOption
	| GiteaRepoOption;

export type GitProviderAccount = {
	id: string;
	label: string;
};

export type DetectedRepositoryApp = {
	path: string;
	packageName: string | null;
	framework: string | null;
	packageManager: string | null;
	hasWorkspaceDependencies: boolean;
	recommendedCommands: {
		install: string;
		build: string | null;
		start: string | null;
	};
};

export type SaveProviderWizardState = {
	provider: GitProviderKind;
	accountId: string;
	repoPayload: RepoOptionJson;
	branch: string;
	buildPath: string;
	watchPaths?: string[];
	enableSubmodules?: boolean;
};

export type SaveProviderMutation =
	| { procedure: "application.saveGithubProvider"; input: Record<string, unknown> }
	| { procedure: "application.saveGitlabProvider"; input: Record<string, unknown> }
	| { procedure: "application.saveBitbucketProvider"; input: Record<string, unknown> }
	| { procedure: "application.saveGiteaProvider"; input: Record<string, unknown> };

export type PublicGitRepoIdentity =
	| { platform: "github"; owner: string; repo: string }
	| { platform: "gitlab"; pathWithNamespace: string };

export function parsePublicGitRepoIdentity(
	raw: string,
): PublicGitRepoIdentity | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;

	const ssh = /^git@([^:]+):(.+)$/i.exec(trimmed);
	if (ssh) {
		const host = ssh[1].toLowerCase();
		const path = ssh[2].replace(/\.git$/i, "");
		const segments = path.split("/").filter(Boolean);
		if (segments.length < 2) return null;
		const repo = segments[segments.length - 1];
		const owner = segments.slice(0, -1).join("/");
		if (host === "github.com") {
			return { platform: "github", owner, repo };
		}
		if (host === "gitlab.com") {
			return { platform: "gitlab", pathWithNamespace: `${owner}/${repo}` };
		}
		return null;
	}

	try {
		const withScheme = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
		const parsed = new URL(withScheme);
		const host = parsed.hostname.toLowerCase();
		const segments = parsed.pathname.split("/").filter(Boolean);
		if (segments.length < 2) return null;
		const repo = segments[segments.length - 1].replace(/\.git$/i, "");
		if (!repo) return null;
		const ownerPath = segments.slice(0, -1).join("/");
		if (host === "github.com") {
			return { platform: "github", owner: ownerPath, repo };
		}
		if (host === "gitlab.com") {
			return { platform: "gitlab", pathWithNamespace: `${ownerPath}/${repo}` };
		}
	} catch {
		return null;
	}

	return null;
}

export async function resolvePublicGitDefaultBranch(raw: string): Promise<string> {
	const identity = parsePublicGitRepoIdentity(raw);
	if (!identity) return "main";

	if (identity.platform === "github") {
		try {
			const res = await fetch(
				`https://api.github.com/repos/${identity.owner}/${identity.repo}`,
				{ headers: { Accept: "application/vnd.github+json" } },
			);
			if (res.ok) {
				const data = (await res.json()) as { default_branch?: string };
				const branch = data.default_branch?.trim();
				if (branch) return branch;
			}
		} catch {
			/* fall through */
		}
		return "main";
	}

	try {
		const enc = encodeURIComponent(identity.pathWithNamespace);
		const res = await fetch(`https://gitlab.com/api/v4/projects/${enc}`);
		if (res.ok) {
			const data = (await res.json()) as { default_branch?: string };
			const branch = data.default_branch?.trim();
			if (branch) return branch;
		}
	} catch {
		/* fall through */
	}

	return "main";
}

export function formatEnvBlock(rows: { key: string; value: string }[]): string {
	return rows
		.filter((row) => row.key.trim())
		.map((row) => `${row.key.trim()}=${row.value}`)
		.join("\n");
}

export function parseEnvBlock(text: string): { key: string; value: string }[] {
	const rows: { key: string; value: string }[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq === -1) continue;
		rows.push({
			key: trimmed.slice(0, eq).trim(),
			value: trimmed.slice(eq + 1),
		});
	}
	return rows;
}

const BROWSER_PUBLIC_ENV_PREFIX =
	/^(?:NEXT_PUBLIC_|VITE_|PUBLIC_|REACT_APP_|NUXT_PUBLIC_)/i;
const SECRET_LIKE_ENV_NAME =
	/(?:^|_)(?:SECRET|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_TOKEN|REFRESH_TOKEN|AUTH_TOKEN|API_KEY)(?:_|$)/i;

/**
 * Framework public prefixes cause values to be compiled into browser code.
 * Return names only so the warning path never has to handle secret values.
 */
export function findBrowserExposedSecretEnvKeys(
	rows: ReadonlyArray<{ key: string }>,
): string[] {
	return Array.from(
		new Set(
			rows
				.map((row) => row.key.trim())
				.filter(
					(key) =>
						BROWSER_PUBLIC_ENV_PREFIX.test(key) &&
						SECRET_LIKE_ENV_NAME.test(key),
				),
		),
	);
}

export function buildSaveProviderInput(
	state: SaveProviderWizardState,
	applicationId: string,
): SaveProviderMutation {
	const buildPath = state.buildPath.trim() || "/";
	const watchPaths = state.watchPaths ?? [];
	const enableSubmodules = state.enableSubmodules ?? false;

	if (state.provider === "github") {
		const repo = state.repoPayload as GithubRepoOption;
		return {
			procedure: "application.saveGithubProvider",
			input: {
				applicationId,
				githubId: state.accountId,
				owner: repo.owner,
				repository: repo.repo,
				branch: state.branch,
				buildPath,
				triggerType: "push",
				watchPaths,
				enableSubmodules,
			},
		};
	}

	if (state.provider === "gitlab") {
		const repo = state.repoPayload as GitlabRepoOption;
		return {
			procedure: "application.saveGitlabProvider",
			input: {
				applicationId,
				gitlabId: state.accountId,
				gitlabOwner: repo.owner,
				gitlabRepository: repo.repo,
				gitlabPathNamespace: repo.gitlabPathNamespace,
				gitlabProjectId: repo.id,
				gitlabBranch: state.branch,
				gitlabBuildPath: buildPath,
				watchPaths,
				enableSubmodules,
			},
		};
	}

	if (state.provider === "bitbucket") {
		const repo = state.repoPayload as BitbucketRepoOption;
		return {
			procedure: "application.saveBitbucketProvider",
			input: {
				applicationId,
				bitbucketId: state.accountId,
				bitbucketOwner: repo.owner,
				bitbucketRepository: repo.repo,
				bitbucketRepositorySlug: repo.slug || repo.repo,
				bitbucketBranch: state.branch,
				bitbucketBuildPath: buildPath,
				watchPaths: [],
				enableSubmodules: false,
			},
		};
	}

	const repo = state.repoPayload as GiteaRepoOption;
	return {
		procedure: "application.saveGiteaProvider",
		input: {
			applicationId,
			giteaId: state.accountId,
			giteaOwner: repo.owner,
			giteaRepository: repo.repo,
			giteaBranch: state.branch,
			giteaBuildPath: buildPath,
			watchPaths,
			enableSubmodules,
		},
	};
}

export async function fetchGithubRepositories(githubId: string) {
	const repos = await trpcQuery<any[]>("github.getGithubRepositories", { githubId });
	return (repos ?? []).map((repo) => ({
		owner: repo.owner.login as string,
		repo: repo.name as string,
		label: `${repo.name} (${repo.owner.login})`,
		isPrivate: Boolean(repo.private),
	}));
}

export async function fetchGithubBranches(
	githubId: string,
	owner: string,
	repo: string,
) {
	const branches = await trpcQuery<any[]>("github.getGithubBranches", {
		githubId,
		owner,
		repo,
	});
	return (branches ?? []).map((b) => b.name as string);
}

export async function fetchGithubDetectedApps(
	githubId: string,
	owner: string,
	repo: string,
	branch: string,
) {
	return await trpcQuery<DetectedRepositoryApp[]>("github.detectRepositoryApps", {
		githubId,
		owner,
		repo,
		branch,
	});
}

export async function fetchGitlabRepositories(gitlabId: string) {
	const repos = await trpcQuery<any[]>("gitlab.getGitlabRepositories", { gitlabId });
	return (repos ?? []).map((repo) => {
		const owner = repo.owner?.username ?? repo.namespace?.path ?? "";
		const path = repo.path as string;
		return {
			owner,
			repo: path,
			gitlabPathNamespace: repo.path_with_namespace as string,
			id: (repo.id as number | null) ?? null,
			label: (repo.path_with_namespace as string) ?? path,
			isPrivate: repo.visibility === "private",
		};
	});
}

export async function fetchGitlabBranches(
	gitlabId: string,
	repo: GitlabRepoOption,
) {
	const branches = await trpcQuery<any[]>("gitlab.getGitlabBranches", {
		gitlabId,
		owner: repo.owner,
		repo: repo.repo,
		gitlabPathNamespace: repo.gitlabPathNamespace,
		gitlabProjectId: repo.id,
	});
	return (branches ?? []).map((b) => b.name as string);
}

export async function fetchBitbucketRepositories(bitbucketId: string) {
	const repos = await trpcQuery<any[]>("bitbucket.getBitbucketRepositories", {
		bitbucketId,
	});
	return (repos ?? []).map((repo) => ({
		owner: repo.owner?.username ?? repo.workspace?.slug ?? "",
		repo: repo.name as string,
		slug: (repo.slug as string) ?? (repo.name as string),
		label: (repo.full_name as string) ?? (repo.name as string),
		isPrivate: repo.is_private === true,
	}));
}

export async function fetchBitbucketBranches(
	bitbucketId: string,
	repo: BitbucketRepoOption,
) {
	const branches = await trpcQuery<any[]>("bitbucket.getBitbucketBranches", {
		bitbucketId,
		owner: repo.owner,
		repo: repo.slug || repo.repo,
	});
	return (branches ?? []).map((b) => b.name as string);
}

export async function fetchGiteaRepositories(giteaId: string) {
	const repos = await trpcQuery<any[]>("gitea.getGiteaRepositories", { giteaId });
	return (repos ?? []).map((repo) => {
		const owner =
			repo.owner?.username ??
			repo.owner?.login ??
			String(repo.full_name ?? "").split("/")[0] ??
			"";
		return {
			owner,
			repo: repo.name as string,
			label: (repo.full_name as string) ?? `${owner}/${repo.name}`,
			isPrivate: repo.private === true,
		};
	});
}

export async function fetchGiteaBranches(
	giteaId: string,
	repo: GiteaRepoOption,
) {
	const branches = await trpcQuery<any[]>("gitea.getGiteaBranches", {
		giteaId,
		owner: repo.owner,
		repositoryName: repo.repo,
	});
	return (branches ?? []).map((b) => b.name as string);
}

export async function loadGithubRepos(githubId: string, repoSel: HTMLSelectElement) {
	repoSel.innerHTML = `<option value="">Loading...</option>`;
	const repos = await fetchGithubRepositories(githubId);
	repoSel.innerHTML = `<option value="">Select repository</option>`;
	for (const repo of repos) {
		const opt = document.createElement("option");
		opt.value = JSON.stringify({ owner: repo.owner, repo: repo.repo });
		opt.textContent = repo.label;
		repoSel.appendChild(opt);
	}
}

export async function loadGithubBranches(
	githubId: string,
	owner: string,
	repo: string,
	branchSel: HTMLSelectElement,
	current?: string,
) {
	branchSel.innerHTML = `<option value="">Loading...</option>`;
	const branches = await fetchGithubBranches(githubId, owner, repo);
	branchSel.innerHTML = `<option value="">Select branch</option>`;
	for (const name of branches) {
		const opt = document.createElement("option");
		opt.value = name;
		opt.textContent = name;
		if (current && name === current) opt.selected = true;
		branchSel.appendChild(opt);
	}
}

export async function loadGitlabRepos(gitlabId: string, repoSel: HTMLSelectElement) {
	repoSel.innerHTML = `<option value="">Loading...</option>`;
	const repos = await fetchGitlabRepositories(gitlabId);
	repoSel.innerHTML = `<option value="">Select repository</option>`;
	for (const repo of repos) {
		const opt = document.createElement("option");
		opt.value = JSON.stringify({
			owner: repo.owner,
			repo: repo.repo,
			gitlabPathNamespace: repo.gitlabPathNamespace,
			id: repo.id,
		});
		opt.textContent = repo.label;
		repoSel.appendChild(opt);
	}
}

export async function loadGitlabBranches(
	gitlabId: string,
	owner: string,
	repo: string,
	gitlabPathNamespace: string,
	id: number | null,
	branchSel: HTMLSelectElement,
	current?: string,
) {
	branchSel.innerHTML = `<option value="">Loading...</option>`;
	const branches = await fetchGitlabBranches(gitlabId, {
		owner,
		repo,
		gitlabPathNamespace,
		id,
	});
	branchSel.innerHTML = `<option value="">Select branch</option>`;
	for (const name of branches) {
		const opt = document.createElement("option");
		opt.value = name;
		opt.textContent = name;
		if (current && name === current) opt.selected = true;
		branchSel.appendChild(opt);
	}
}

export async function loadBitbucketRepos(
	bitbucketId: string,
	repoSel: HTMLSelectElement,
) {
	repoSel.innerHTML = `<option value="">Loading...</option>`;
	const repos = await fetchBitbucketRepositories(bitbucketId);
	repoSel.innerHTML = `<option value="">Select repository</option>`;
	for (const repo of repos) {
		const opt = document.createElement("option");
		opt.value = JSON.stringify({
			owner: repo.owner,
			repo: repo.repo,
			slug: repo.slug,
		});
		opt.textContent = repo.label;
		repoSel.appendChild(opt);
	}
}

export async function loadBitbucketBranches(
	bitbucketId: string,
	repo: BitbucketRepoOption,
	branchSel: HTMLSelectElement,
	current?: string,
) {
	branchSel.innerHTML = `<option value="">Loading...</option>`;
	const branches = await fetchBitbucketBranches(bitbucketId, repo);
	branchSel.innerHTML = `<option value="">Select branch</option>`;
	for (const name of branches) {
		const opt = document.createElement("option");
		opt.value = name;
		opt.textContent = name;
		if (current && name === current) opt.selected = true;
		branchSel.appendChild(opt);
	}
}

export async function loadGiteaRepos(giteaId: string, repoSel: HTMLSelectElement) {
	repoSel.innerHTML = `<option value="">Loading...</option>`;
	const repos = await fetchGiteaRepositories(giteaId);
	repoSel.innerHTML = `<option value="">Select repository</option>`;
	for (const repo of repos) {
		const opt = document.createElement("option");
		opt.value = JSON.stringify({ owner: repo.owner, repo: repo.repo });
		opt.textContent = repo.label;
		repoSel.appendChild(opt);
	}
}

export async function loadGiteaBranches(
	giteaId: string,
	repo: GiteaRepoOption,
	branchSel: HTMLSelectElement,
	current?: string,
) {
	branchSel.innerHTML = `<option value="">Loading...</option>`;
	const branches = await fetchGiteaBranches(giteaId, repo);
	branchSel.innerHTML = `<option value="">Select branch</option>`;
	for (const name of branches) {
		const opt = document.createElement("option");
		opt.value = name;
		opt.textContent = name;
		if (current && name === current) opt.selected = true;
		branchSel.appendChild(opt);
	}
}
