import { readFileSync } from "node:fs";
import path from "node:path";
import type { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	assertGitProviderReadable,
	assertGitProviderWritable,
	toPublicBitbucketDetails,
	toPublicGiteaDetails,
	toPublicGithubDetails,
	toPublicGitlabDetails,
	toPublicGitProvider,
} from "@/server/api/utils/git-provider-security";

const mocks = vi.hoisted(() => ({
	getAccessibleGitProviderIds: vi.fn(),
	findGithubById: vi.fn(),
	findGitlabById: vi.fn(),
	findBitbucketById: vi.fn(),
	findGiteaById: vi.fn(),
}));

vi.mock("@nearzero/server", () => ({
	getAccessibleGitProviderIds: mocks.getAccessibleGitProviderIds,
	findGithubById: mocks.findGithubById,
	findGitlabById: mocks.findGitlabById,
	findBitbucketById: mocks.findBitbucketById,
	findGiteaById: mocks.findGiteaById,
}));

const session = {
	userId: "user-a",
	activeOrganizationId: "organization-a",
};

const provider = {
	gitProviderId: "provider-a",
	organizationId: "organization-a",
	userId: "user-a",
};

describe("Git provider response redaction", () => {
	it("returns only public provider metadata", () => {
		const storedProvider = {
			...provider,
			name: "Production Git",
			providerType: "github",
			connectionMode: "byo",
			createdAt: "2026-07-13T00:00:00.000Z",
			sharedWithOrganization: false,
		};

		expect(toPublicGitProvider(storedProvider)).toEqual({
			gitProviderId: "provider-a",
			name: "Production Git",
			providerType: "github",
			connectionMode: "byo",
			createdAt: "2026-07-13T00:00:00.000Z",
			sharedWithOrganization: false,
		});
		expect(toPublicGitProvider(storedProvider)).not.toHaveProperty("userId");
		expect(toPublicGitProvider(storedProvider)).not.toHaveProperty(
			"organizationId",
		);
	});

	it("replaces every provider secret with explicit readiness flags", () => {
		const canaries = {
			githubClientSecret: "GITHUB_CLIENT_SECRET_CANARY",
			githubPrivateKey: "GITHUB_PRIVATE_KEY_CANARY",
			githubWebhookSecret: "GITHUB_WEBHOOK_SECRET_CANARY",
			gitlabSecret: "GITLAB_SECRET_CANARY",
			gitlabAccessToken: "GITLAB_ACCESS_TOKEN_CANARY",
			gitlabRefreshToken: "GITLAB_REFRESH_TOKEN_CANARY",
			bitbucketAppPassword: "BITBUCKET_APP_PASSWORD_CANARY",
			bitbucketApiToken: "BITBUCKET_API_TOKEN_CANARY",
			bitbucketAccessToken: "BITBUCKET_ACCESS_TOKEN_CANARY",
			bitbucketRefreshToken: "BITBUCKET_REFRESH_TOKEN_CANARY",
			giteaClientSecret: "GITEA_CLIENT_SECRET_CANARY",
			giteaAccessToken: "GITEA_ACCESS_TOKEN_CANARY",
			giteaRefreshToken: "GITEA_REFRESH_TOKEN_CANARY",
		};

		const publicDetails = {
			github: toPublicGithubDetails({
				githubId: "github-a",
				githubAppId: 42,
				githubInstallationId: "installation-a",
				githubClientSecret: canaries.githubClientSecret,
				githubPrivateKey: canaries.githubPrivateKey,
				githubWebhookSecret: canaries.githubWebhookSecret,
			}),
			gitlab: toPublicGitlabDetails({
				gitlabId: "gitlab-a",
				secret: canaries.gitlabSecret,
				accessToken: canaries.gitlabAccessToken,
				refreshToken: canaries.gitlabRefreshToken,
			}),
			bitbucket: toPublicBitbucketDetails({
				bitbucketId: "bitbucket-a",
				appPassword: canaries.bitbucketAppPassword,
				apiToken: canaries.bitbucketApiToken,
				accessToken: canaries.bitbucketAccessToken,
				refreshToken: canaries.bitbucketRefreshToken,
			}),
			gitea: toPublicGiteaDetails({
				giteaId: "gitea-a",
				clientId: "client-a",
				clientSecret: canaries.giteaClientSecret,
				accessToken: canaries.giteaAccessToken,
				refreshToken: canaries.giteaRefreshToken,
			}),
		};

		const serialized = JSON.stringify(publicDetails);
		for (const canary of Object.values(canaries)) {
			expect(serialized).not.toContain(canary);
		}

		expect(publicDetails.github).toMatchObject({
			hasAppId: true,
			hasInstallation: true,
			hasClientSecret: true,
			hasPrivateKey: true,
			hasWebhookSecret: true,
		});
		expect(publicDetails.gitlab).toMatchObject({
			hasSecret: true,
			hasAccessToken: true,
			hasRefreshToken: true,
		});
		expect(publicDetails.bitbucket).toMatchObject({
			hasAppPassword: true,
			hasApiToken: true,
			hasAccessToken: true,
			hasRefreshToken: true,
		});
		expect(publicDetails.gitea).toMatchObject({
			hasClientId: true,
			hasClientSecret: true,
			hasAccessToken: true,
			hasRefreshToken: true,
		});
	});

	it("wires every Git provider route through access checks and public DTOs", () => {
		const routerDirectory = path.resolve(process.cwd(), "server/api/routers");
		const providerRouters = {
			github: "toPublicGithubDetails",
			gitlab: "toPublicGitlabDetails",
			bitbucket: "toPublicBitbucketDetails",
			gitea: "toPublicGiteaDetails",
		};

		for (const [routerName, publicMapper] of Object.entries(providerRouters)) {
			const source = readFileSync(
				path.join(routerDirectory, `${routerName}.ts`),
				"utf8",
			);
			expect(source).toContain("assertGitProviderReadable");
			expect(source).toContain("assertGitProviderWritable");
			expect(source).toContain(publicMapper);
			expect(source).toContain("toPublicGitProvider");
			expect(source).not.toMatch(
				/return await find(?:Github|Gitlab|Bitbucket|Gitea)ById/,
			);
		}

		const aggregateRouter = readFileSync(
			path.join(routerDirectory, "git-provider.ts"),
			"utf8",
		);
		expect(aggregateRouter).toContain("...toPublicGitProvider(r)");
		for (const publicMapper of Object.values(providerRouters)) {
			expect(aggregateRouter).toContain(publicMapper);
		}
		expect(aggregateRouter).not.toMatch(/\.\.\.r[,\n]/);
	});
});

describe("Git provider access boundaries", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getAccessibleGitProviderIds.mockResolvedValue(
			new Set([provider.gitProviderId]),
		);
	});

	it("allows a provider only when it belongs to the active organization and is accessible", async () => {
		await expect(
			assertGitProviderReadable(session, provider),
		).resolves.toBeUndefined();

		await expect(
			assertGitProviderReadable(session, {
				...provider,
				organizationId: "organization-b",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" } satisfies Partial<TRPCError>);

		mocks.getAccessibleGitProviderIds.mockResolvedValueOnce(new Set());
		await expect(
			assertGitProviderReadable(session, provider),
		).rejects.toMatchObject({ code: "NOT_FOUND" } satisfies Partial<TRPCError>);
	});

	it("rejects a mismatched parent provider identifier", async () => {
		await expect(
			assertGitProviderReadable(session, provider, "provider-b"),
		).rejects.toMatchObject({ code: "NOT_FOUND" } satisfies Partial<TRPCError>);
		expect(mocks.getAccessibleGitProviderIds).not.toHaveBeenCalled();
	});

	it("limits writes to the provider owner or an organization administrator", async () => {
		const somebodyElsesProvider = { ...provider, userId: "user-b" };

		await expect(
			assertGitProviderWritable(session, "member", somebodyElsesProvider),
		).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		} satisfies Partial<TRPCError>);
		await expect(
			assertGitProviderWritable(session, "admin", somebodyElsesProvider),
		).resolves.toBeUndefined();
		await expect(
			assertGitProviderWritable(session, "member", provider),
		).resolves.toBeUndefined();
	});
});
