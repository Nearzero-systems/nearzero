import { join } from "node:path";
import { paths } from "@nearzero/server/constants";
import type {
	apiBitbucketTestConnection,
	apiFindBitbucketBranches,
} from "@nearzero/server/db/schema";
import {
	type Bitbucket,
	findBitbucketById,
	updateBitbucket,
} from "@nearzero/server/services/bitbucket";
import { assertGitProviderConnectionAllowed } from "@nearzero/server/services/git-provider-policy";
import {
	getManagedBitbucketConfig,
	isNearzeroManagedGitProvider,
} from "@nearzero/server/services/managed-git-shared";
import type { InferResultType } from "@nearzero/server/types/with";
import { TRPCError } from "@trpc/server";
import type { z } from "zod";

export type ApplicationWithBitbucket = InferResultType<
	"applications",
	{ bitbucket: true }
>;

export type ComposeWithBitbucket = InferResultType<
	"compose",
	{ bitbucket: true }
>;

export const getBitbucketCloneUrl = (
	bitbucketProvider: {
		apiToken?: string | null;
		accessToken?: string | null;
		bitbucketUsername?: string | null;
		appPassword?: string | null;
		bitbucketEmail?: string | null;
		bitbucketWorkspaceName?: string | null;
	} | null,
	repoClone: string,
) => {
	if (!bitbucketProvider) {
		throw new Error("Bitbucket provider is required");
	}

	if (bitbucketProvider.accessToken) {
		return `https://x-token-auth:${bitbucketProvider.accessToken}@${repoClone}`;
	}

	if (bitbucketProvider.apiToken) {
		return `https://x-bitbucket-api-token-auth:${bitbucketProvider.apiToken}@${repoClone}`;
	}

	// For app passwords, use username:app_password format
	if (!bitbucketProvider.bitbucketUsername || !bitbucketProvider.appPassword) {
		throw new Error(
			"Username and app password are required when not using API token",
		);
	}
	return `https://${bitbucketProvider.bitbucketUsername}:${bitbucketProvider.appPassword}@${repoClone}`;
};

export const getBitbucketHeaders = (bitbucketProvider: Bitbucket) => {
	if (bitbucketProvider.accessToken) {
		return {
			Authorization: `Bearer ${bitbucketProvider.accessToken}`,
		};
	}

	if (bitbucketProvider.apiToken) {
		// According to Bitbucket official docs, for API calls with API tokens:
		// "You will need both your Atlassian account email and an API token"
		// Use: {atlassian_account_email}:{api_token}

		if (!bitbucketProvider.bitbucketEmail) {
			throw new Error(
				"Atlassian account email is required when using API token for API calls",
			);
		}

		return {
			Authorization: `Basic ${Buffer.from(`${bitbucketProvider.bitbucketEmail}:${bitbucketProvider.apiToken}`).toString("base64")}`,
		};
	}

	// For app passwords, use HTTP Basic auth with username and app password
	if (!bitbucketProvider.bitbucketUsername || !bitbucketProvider.appPassword) {
		throw new Error(
			"Username and app password are required when not using API token",
		);
	}
	return {
		Authorization: `Basic ${Buffer.from(`${bitbucketProvider.bitbucketUsername}:${bitbucketProvider.appPassword}`).toString("base64")}`,
	};
};

export const refreshBitbucketToken = async (bitbucketProviderId: string) => {
	const bitbucketProvider = await findBitbucketById(bitbucketProviderId);
	assertGitProviderConnectionAllowed(bitbucketProvider, "Bitbucket");
	if (!isNearzeroManagedGitProvider(bitbucketProvider)) {
		return bitbucketProvider.accessToken ?? bitbucketProvider.apiToken ?? null;
	}
	if (!bitbucketProvider.refreshToken) {
		return bitbucketProvider.accessToken ?? null;
	}

	const expiresAt = bitbucketProvider.expiresAt
		? Date.parse(bitbucketProvider.expiresAt)
		: 0;
	const safetyMarginMs = 60_000;
	if (
		bitbucketProvider.accessToken &&
		expiresAt &&
		Date.now() + safetyMarginMs < expiresAt
	) {
		return bitbucketProvider.accessToken;
	}

	const config = getManagedBitbucketConfig();
	const response = await fetch("https://bitbucket.org/site/oauth2/access_token", {
		method: "POST",
		headers: {
			Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: bitbucketProvider.refreshToken,
		}),
	});

	if (!response.ok) {
		return bitbucketProvider.accessToken ?? null;
	}

	const data = await response.json();
	const accessToken = data.access_token as string | undefined;
	if (!accessToken) return bitbucketProvider.accessToken ?? null;
	const expiresIn = Number(data.expires_in || 7200);
	await updateBitbucket(bitbucketProviderId, {
		bitbucketId: bitbucketProviderId,
		gitProviderId: bitbucketProvider.gitProviderId,
		name: bitbucketProvider.gitProvider.name,
		accessToken,
		refreshToken: (data.refresh_token as string | undefined) ?? bitbucketProvider.refreshToken,
		expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
	});
	return accessToken;
};

interface CloneBitbucketRepository {
	appName: string;
	bitbucketRepository: string | null;
	bitbucketRepositorySlug?: string | null;
	bitbucketOwner: string | null;
	bitbucketBranch: string | null;
	bitbucketId: string | null;
	enableSubmodules: boolean;
	serverId: string | null;
	type?: "application" | "compose";
	outputPathOverride?: string;
}

export const cloneBitbucketRepository = async ({
	type = "application",
	...entity
}: CloneBitbucketRepository, options?: { targetServerId?: string | null }) => {
	let command = "set -e;";
	const {
		appName,
		bitbucketRepository,
		bitbucketOwner,
		bitbucketBranch,
		bitbucketId,
		enableSubmodules,
		serverId,
		outputPathOverride,
	} = entity;
	const targetServerId = options?.targetServerId ?? serverId;
	const { COMPOSE_PATH, APPLICATIONS_PATH } = paths(!!targetServerId);

	if (!bitbucketId) {
		command += `echo "Error: ❌ Bitbucket Provider not found"; exit 1;`;
		return command;
	}
	const bitbucket = await findBitbucketById(bitbucketId);

	if (!bitbucket) {
		command += `echo "Error: ❌ Bitbucket Provider not found"; exit 1;`;
		return command;
	}
	await refreshBitbucketToken(bitbucketId);
	const refreshedBitbucket = await findBitbucketById(bitbucketId);
	const basePath = type === "compose" ? COMPOSE_PATH : APPLICATIONS_PATH;
	const outputPath = outputPathOverride ?? join(basePath, appName, "code");
	command += `rm -rf ${outputPath};`;
	command += `mkdir -p ${outputPath};`;
	const repoToUse = entity.bitbucketRepositorySlug || bitbucketRepository;
	const repoclone = `bitbucket.org/${bitbucketOwner}/${repoToUse}.git`;
	const cloneUrl = getBitbucketCloneUrl(refreshedBitbucket, repoclone);
	command += `echo "Cloning Repo ${repoclone} to ${outputPath}: ✅";`;
	command += `git clone --branch ${bitbucketBranch} --depth 1 ${enableSubmodules ? "--recurse-submodules" : ""} ${cloneUrl} ${outputPath} --progress;`;
	return command;
};

export const getBitbucketRepositories = async (bitbucketId?: string) => {
	if (!bitbucketId) {
		return [];
	}
	await refreshBitbucketToken(bitbucketId);
	const bitbucketProvider = await findBitbucketById(bitbucketId);

	const username =
		bitbucketProvider.bitbucketWorkspaceName ||
		bitbucketProvider.bitbucketUsername;
	let url = bitbucketProvider.accessToken && !username
		? "https://api.bitbucket.org/2.0/repositories?role=member&pagelen=100"
		: `https://api.bitbucket.org/2.0/repositories/${username}?pagelen=100`;
	let repositories: {
		name: string;
		url: string;
		slug: string;
		owner: { username: string };
	}[] = [];

	try {
		while (url) {
			const response = await fetch(url, {
				method: "GET",
				headers: getBitbucketHeaders(bitbucketProvider),
			});

			if (!response.ok) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `Failed to fetch repositories: ${response.statusText}`,
				});
			}

			const data = await response.json();

			const mappedData = data.values.map((repo: any) => ({
				name: repo.name,
				url: repo.links.html.href,
				slug: repo.slug,
				owner: {
					username: repo.workspace.slug,
				},
			}));
			repositories = repositories.concat(mappedData);
			url = data.next || null;
		}
		return repositories;
	} catch (error) {
		throw error;
	}
};

export const getBitbucketBranches = async (
	input: z.infer<typeof apiFindBitbucketBranches>,
) => {
	if (!input.bitbucketId) {
		return [];
	}
	await refreshBitbucketToken(input.bitbucketId);
	const bitbucketProvider = await findBitbucketById(input.bitbucketId);
	const { owner, repo } = input;
	let url = `https://api.bitbucket.org/2.0/repositories/${owner}/${repo}/refs/branches?pagelen=1`;
	let allBranches: {
		name: string;
		commit: {
			sha: string;
		};
	}[] = [];

	try {
		while (url) {
			const response = await fetch(url, {
				method: "GET",
				headers: getBitbucketHeaders(bitbucketProvider),
			});

			if (!response.ok) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `HTTP error! status: ${response.status}`,
				});
			}

			const data = await response.json();

			const mappedData = data.values.map((branch: any) => {
				return {
					name: branch.name,
					commit: {
						sha: branch.target.hash,
					},
				};
			});
			allBranches = allBranches.concat(mappedData);
			url = data.next || null;
		}

		return allBranches as {
			name: string;
			commit: {
				sha: string;
			};
		}[];
	} catch (error) {
		throw error;
	}
};

export const testBitbucketConnection = async (
	input: z.infer<typeof apiBitbucketTestConnection>,
) => {
	await refreshBitbucketToken(input.bitbucketId);
	const provider = await findBitbucketById(input.bitbucketId);
	const { bitbucketUsername, workspaceName } = input;

	const username = workspaceName || bitbucketUsername || provider.bitbucketWorkspaceName;

	const url = provider.accessToken && !username
		? "https://api.bitbucket.org/2.0/repositories?role=member&pagelen=100"
		: `https://api.bitbucket.org/2.0/repositories/${username}`;
	try {
		const response = await fetch(url, {
			method: "GET",
			headers: getBitbucketHeaders(provider),
		});

		if (!response.ok) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: `Failed to fetch repositories: ${response.statusText}`,
			});
		}

		const data = await response.json();

		const mappedData = data.values.map((repo: any) => {
			return {
				name: repo.name,
				url: repo.links.html.href,
				owner: {
					username: repo.workspace.slug,
				},
			};
		}) as [];

		return mappedData.length;
	} catch (error) {
		throw error;
	}
};
