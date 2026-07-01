import { describe, expect, test } from "bun:test";
import {
	buildSaveProviderInput,
	formatEnvBlock,
	parseEnvBlock,
} from "../src/lib/git-application-source";

describe("formatEnvBlock / parseEnvBlock", () => {
	test("round-trip key=value rows", () => {
		const rows = [
			{ key: "NODE_ENV", value: "production" },
			{ key: "PORT", value: "3000" },
		];
		const text = formatEnvBlock(rows);
		expect(text).toBe("NODE_ENV=production\nPORT=3000");
		expect(parseEnvBlock(text)).toEqual(rows);
	});

	test("skips empty lines and comments", () => {
		const parsed = parseEnvBlock("# comment\n\nFOO=bar\n");
		expect(parsed).toEqual([{ key: "FOO", value: "bar" }]);
	});

	test("formatEnvBlock omits rows without keys", () => {
		expect(formatEnvBlock([{ key: "", value: "x" }, { key: "A", value: "1" }])).toBe(
			"A=1",
		);
	});
});

describe("buildSaveProviderInput", () => {
	const applicationId = "app-123";

	test("github provider shape", () => {
		const result = buildSaveProviderInput(
			{
				provider: "github",
				accountId: "gh-1",
				repoPayload: { owner: "acme", repo: "web" },
				branch: "main",
				buildPath: "/apps/web",
			},
			applicationId,
		);
		expect(result.procedure).toBe("application.saveGithubProvider");
		expect(result.input).toMatchObject({
			applicationId,
			githubId: "gh-1",
			owner: "acme",
			repository: "web",
			branch: "main",
			buildPath: "/apps/web",
			triggerType: "push",
		});
	});

	test("gitlab provider shape", () => {
		const result = buildSaveProviderInput(
			{
				provider: "gitlab",
				accountId: "gl-1",
				repoPayload: {
					owner: "team",
					repo: "api",
					gitlabPathNamespace: "team/api",
					id: 42,
				},
				branch: "develop",
				buildPath: "/",
			},
			applicationId,
		);
		expect(result.procedure).toBe("application.saveGitlabProvider");
		expect(result.input).toMatchObject({
			gitlabId: "gl-1",
			gitlabProjectId: 42,
			gitlabBranch: "develop",
			gitlabPathNamespace: "team/api",
		});
	});

	test("bitbucket provider uses slug", () => {
		const result = buildSaveProviderInput(
			{
				provider: "bitbucket",
				accountId: "bb-1",
				repoPayload: { owner: "ws", repo: "My Repo", slug: "my-repo" },
				branch: "main",
				buildPath: "/",
			},
			applicationId,
		);
		expect(result.procedure).toBe("application.saveBitbucketProvider");
		expect(result.input).toMatchObject({
			bitbucketRepositorySlug: "my-repo",
			bitbucketBranch: "main",
		});
	});

	test("gitea provider shape", () => {
		const result = buildSaveProviderInput(
			{
				provider: "gitea",
				accountId: "gt-1",
				repoPayload: { owner: "team", repo: "service" },
				branch: "main",
				buildPath: "/app",
			},
			applicationId,
		);
		expect(result.procedure).toBe("application.saveGiteaProvider");
		expect(result.input).toMatchObject({
			applicationId,
			giteaId: "gt-1",
			giteaOwner: "team",
			giteaRepository: "service",
			giteaBranch: "main",
			giteaBuildPath: "/app",
		});
	});
});
