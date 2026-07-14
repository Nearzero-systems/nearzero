import { readFileSync } from "node:fs";
import path from "node:path";
import {
	consumeByoGitProviderOAuthState,
	inspectByoGitProviderOAuthState,
	issueByoGitProviderOAuthState,
} from "@nearzero/server/services/git-provider-oauth-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getGiteaOAuthUrl } from "../../../console/src/lib/gitea-utils";
import { getGitlabAuthUrl } from "../../../console/src/lib/gitlab-utils";

const mocks = vi.hoisted(() => ({
	insertValues: vi.fn(),
	findFirst: vi.fn(),
	updateSet: vi.fn(),
	updateWhere: vi.fn(),
	updateReturning: vi.fn(),
}));

vi.mock("@nearzero/server/db", () => ({
	db: {
		insert: vi.fn(() => ({ values: mocks.insertValues })),
		query: {
			gitProviderOAuthState: { findFirst: mocks.findFirst },
		},
		update: vi.fn(() => ({
			set: (value: unknown) => {
				mocks.updateSet(value);
				return {
					where: (condition: unknown) => {
						mocks.updateWhere(condition);
						return { returning: mocks.updateReturning };
					},
				};
			},
		})),
	},
}));

const now = new Date("2026-07-13T12:00:00.000Z");

function storedState(
	overrides: Partial<{
		providerType: "github" | "gitlab" | "bitbucket" | "gitea";
		targetGitProviderId: string | null;
		expiresAt: string;
		consumedAt: string | null;
	}> = {},
) {
	return {
		stateId: "state-id",
		stateHash: "state-hash",
		providerType: "gitlab" as const,
		organizationId: "organization-a",
		userId: "user-a",
		targetGitProviderId: "provider-a",
		returnTo: "/dashboard/project/project-a",
		createdAt: now.toISOString(),
		expiresAt: new Date(now.getTime() + 60_000).toISOString(),
		consumedAt: null,
		...overrides,
	};
}

describe("BYO Git provider OAuth state", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		vi.setSystemTime(now);
		mocks.insertValues.mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("stores only a hash and binds state to the trusted identity and target", async () => {
		const issued = await issueByoGitProviderOAuthState({
			providerType: "gitlab",
			organizationId: "organization-a",
			userId: "user-a",
			targetGitProviderId: "provider-a",
			returnTo: "/dashboard/project/project-a",
		});

		expect(issued.state).toMatch(/^nz_b_[A-Za-z0-9_-]{43}$/);
		expect(issued.expiresAt).toBe("2026-07-13T12:10:00.000Z");
		expect(mocks.insertValues).toHaveBeenCalledOnce();
		const inserted = mocks.insertValues.mock.calls[0]?.[0];
		expect(inserted).toMatchObject({
			providerType: "gitlab",
			organizationId: "organization-a",
			userId: "user-a",
			targetGitProviderId: "provider-a",
			returnTo: "/dashboard/project/project-a",
			expiresAt: issued.expiresAt,
		});
		expect(inserted.stateHash).toMatch(/^[a-f0-9]{64}$/);
		expect(JSON.stringify(inserted)).not.toContain(issued.state);
	});

	it("drops external and browser-normalized return targets", async () => {
		for (const returnTo of [
			"https://attacker.example/steal",
			"//attacker.example/steal",
			"/\\attacker.example/steal",
			"/safe\r\nLocation: https://attacker.example",
		]) {
			await issueByoGitProviderOAuthState({
				providerType: "github",
				organizationId: "organization-a",
				userId: "user-a",
				returnTo,
			});
		}

		for (const call of mocks.insertValues.mock.calls) {
			expect(call[0]).toMatchObject({
				returnTo: null,
				targetGitProviderId: null,
			});
		}
	});

	it("consumes state with one atomic conditional update and rejects replay", async () => {
		mocks.updateReturning
			.mockResolvedValueOnce([storedState({ consumedAt: now.toISOString() })])
			.mockResolvedValueOnce([]);

		await expect(
			consumeByoGitProviderOAuthState("nz_b_valid-token", "gitlab"),
		).resolves.toMatchObject({
			providerType: "gitlab",
			organizationId: "organization-a",
			userId: "user-a",
			targetGitProviderId: "provider-a",
		});
		expect(mocks.updateSet).toHaveBeenCalledWith({
			consumedAt: now.toISOString(),
		});
		expect(mocks.updateWhere).toHaveBeenCalledOnce();

		await expect(
			consumeByoGitProviderOAuthState("nz_b_valid-token", "gitlab"),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("rejects expired, consumed, wrong-provider, and malformed state", async () => {
		mocks.findFirst
			.mockResolvedValueOnce(
				storedState({
					expiresAt: new Date(now.getTime() - 1).toISOString(),
				}),
			)
			.mockResolvedValueOnce(storedState({ consumedAt: now.toISOString() }))
			.mockResolvedValueOnce(storedState({ providerType: "gitea" }));

		for (let attempt = 0; attempt < 3; attempt += 1) {
			await expect(
				inspectByoGitProviderOAuthState("nz_b_valid-token", "gitlab"),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		}
		await expect(
			inspectByoGitProviderOAuthState("raw-provider-id", "gitlab"),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("places opaque state in provider URLs without exposing database IDs", () => {
		const state = "nz_b_opaque-state";
		const gitlabUrl = new URL(
			getGitlabAuthUrl(
				"client-id",
				state,
				"https://gitlab.example",
				"https://nearzero.example",
			),
		);
		expect(gitlabUrl.searchParams.get("state")).toBe(state);
		expect(gitlabUrl.searchParams.get("redirect_uri")).toBe(
			"https://nearzero.example/api/providers/gitlab/callback",
		);
		expect(gitlabUrl.searchParams.has("gitlabId")).toBe(false);

		const giteaUrl = new URL(
			getGiteaOAuthUrl(
				state,
				"client-id",
				"https://gitea.example",
				"https://nearzero.example",
			),
		);
		expect(giteaUrl.searchParams.get("state")).toBe(state);
		expect(giteaUrl.searchParams.get("redirect_uri")).toBe(
			"https://nearzero.example/api/providers/gitea/callback",
		);
	});

	it("wires every BYO callback through the one-time state boundary", () => {
		const providerHandlers = path.resolve(
			process.cwd(),
			"server/routes/handlers/providers",
		);
		const githubCallback = readFileSync(
			path.join(providerHandlers, "github/setup.ts"),
			"utf8",
		);
		const gitlabCallback = readFileSync(
			path.join(providerHandlers, "gitlab/callback.ts"),
			"utf8",
		);
		const giteaCallback = readFileSync(
			path.join(providerHandlers, "gitea/callback.ts"),
			"utf8",
		);
		const giteaAuthorize = readFileSync(
			path.join(providerHandlers, "gitea/authorize.ts"),
			"utf8",
		);
		const router = readFileSync(
			path.resolve(process.cwd(), "server/api/routers/git-provider.ts"),
			"utf8",
		);
		const consoleScript = readFileSync(
			path.resolve(
				process.cwd(),
				"../console/src/scripts/git-providers-dashboard.ts",
			),
			"utf8",
		);

		expect(githubCallback).toContain("consumeByoGitProviderOAuthState");
		expect(gitlabCallback).toContain("consumeByoGitProviderTargetState");
		expect(giteaCallback).toContain("consumeByoGitProviderTargetState");
		expect(giteaAuthorize).toContain("inspectByoGitProviderTargetState");
		for (const source of [
			githubCallback,
			gitlabCallback,
			giteaCallback,
			giteaAuthorize,
			consoleScript,
		]) {
			expect(source).not.toMatch(/gh_(?:init|setup):/);
			expect(source).not.toContain("console.error");
		}
		expect(gitlabCallback).not.toContain("gitlabId as string");
		expect(giteaCallback).not.toContain("parseState");
		expect(router).toContain("createByoOAuthState: withPermission");
		expect(router).toContain("assertGitProviderWritable");
		expect(consoleScript).toContain("gitProvider.createByoOAuthState");
	});
});
