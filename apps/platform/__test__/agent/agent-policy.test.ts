import { readFileSync } from "node:fs";
import type { AgentPolicyAction } from "@nearzero/server/services/agent-policy";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getOrganizationSettings: vi.fn(),
	findEnvironmentById: vi.fn(),
	auditAgentAction: vi.fn(),
}));

vi.mock("@nearzero/server/services/organization-settings", () => ({
	getOrganizationSettings: mocks.getOrganizationSettings,
}));

vi.mock("@nearzero/server/services/environment", () => ({
	findEnvironmentById: mocks.findEnvironmentById,
	isProductionEnvironment: (environment: {
		name?: string;
		isProduction?: boolean;
	}) =>
		Boolean(environment?.isProduction) ||
		environment?.name?.toLowerCase() === "production",
}));

vi.mock("@nearzero/server/services/agent-audit", () => ({
	auditAgentAction: mocks.auditAgentAction,
}));

const { evaluateAgentPolicy, assertAgentPolicy, sanitizeAgentPolicyMetadata } =
	await import("@nearzero/server/services/agent-policy");

const actor = {
	userId: "user-1",
	organizationId: "org-1",
	userEmail: "owner@example.com",
	userRole: "owner",
	threadId: "thread-1",
};

const actionSettings = [
	["agent.openrouter.setup", "allowAgentOpenRouterSetup"],
	["agent.project.create", "allowAgentProjectCreation"],
	["agent.project.update", "allowAgentProjectUpdates"],
	["agent.project.delete", "allowAgentDevProjectDeletion"],
	["agent.service.create", "allowAgentServiceCreation"],
	["agent.service.importGit", "allowAgentServiceImports"],
	["agent.service.setupSsh", "allowAgentSshServiceSetup"],
	["agent.domain.assign", "allowAgentDomainAssignment"],
	["agent.server.create", "allowAgentServerCreation"],
	["agent.deploy.run", "allowAgentDeployments"],
	["agent.production.mutate", "allowAgentProductionActions"],
] as const satisfies ReadonlyArray<readonly [AgentPolicyAction, string]>;

type PolicySettingKey = (typeof actionSettings)[number][1];

function organizationSettings(
	overrides: Partial<Record<PolicySettingKey, boolean>> = {},
) {
	return {
		organizationId: "org-1",
		allowAgentOpenRouterSetup: true,
		allowAgentProjectCreation: true,
		allowAgentProjectUpdates: true,
		allowAgentDevProjectDeletion: true,
		allowAgentServiceCreation: true,
		allowAgentServiceImports: true,
		allowAgentSshServiceSetup: true,
		allowAgentDomainAssignment: true,
		allowAgentServerCreation: true,
		allowAgentDeployments: true,
		allowAgentProductionActions: true,
		openRouterApiKeyCiphertext: null,
		openRouterApiKeyConfiguredAt: null,
		openRouterApiKeyConfiguredByUserId: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getOrganizationSettings.mockResolvedValue(organizationSettings());
	mocks.findEnvironmentById.mockResolvedValue({
		environmentId: "env-1",
		projectId: "project-1",
		name: "development",
		isDefault: true,
	});
	mocks.auditAgentAction.mockResolvedValue(undefined);
});

describe("agent policy engine", () => {
	for (const [action] of actionSettings) {
		it(`allows ${action} when its code policy is enabled`, async () => {
			const result = await evaluateAgentPolicy(actor, action, {
				resourceType: "settings",
				resourceName: action,
			});

			expect(result).toMatchObject({ allowed: true, code: "ok", action });
		});
	}

	for (const [action, setting] of actionSettings) {
		it(`denies ${action} when ${setting} is disabled`, async () => {
			mocks.getOrganizationSettings.mockResolvedValueOnce(
				organizationSettings({ [setting]: false }),
			);

			const result = await evaluateAgentPolicy(actor, action, {
				resourceType: "settings",
				resourceName: action,
			});

			expect(result.allowed).toBe(false);
			expect(result.code).not.toBe("ok");
		});
	}

	it("requires service creation policy before Git import policy", async () => {
		mocks.getOrganizationSettings.mockResolvedValueOnce(
			organizationSettings({
				allowAgentServiceCreation: false,
				allowAgentServiceImports: true,
			}),
		);

		const result = await evaluateAgentPolicy(actor, "agent.service.importGit");

		expect(result).toMatchObject({
			allowed: false,
			code: "policy_service_setup_disabled",
		});
	});

	it("requires service creation policy before domain assignment policy", async () => {
		mocks.getOrganizationSettings.mockResolvedValueOnce(
			organizationSettings({
				allowAgentServiceCreation: false,
				allowAgentDomainAssignment: true,
			}),
		);

		const result = await evaluateAgentPolicy(actor, "agent.domain.assign");

		expect(result).toMatchObject({
			allowed: false,
			code: "policy_service_setup_disabled",
		});
	});

	it("requires production policy for production-scoped mutations", async () => {
		mocks.getOrganizationSettings.mockResolvedValueOnce(
			organizationSettings({
				allowAgentDeployments: true,
				allowAgentProductionActions: false,
			}),
		);

		const result = await evaluateAgentPolicy(actor, "agent.deploy.run", {
			isProduction: true,
			resourceType: "application",
			resourceId: "app-1",
		});

		expect(result).toMatchObject({
			allowed: false,
			code: "policy_production_blocked",
		});
	});

	it("blocks secret-bearing contexts and redacts metadata", async () => {
		const result = await evaluateAgentPolicy(actor, "agent.project.update", {
			containsSecretValue: true,
			auditMetadata: {
				apiKey: "sk-or-secret",
				env: "PASSWORD=value",
				nested: { privateKey: "-----BEGIN PRIVATE KEY-----" },
				label: "project-env",
			},
		});

		const serialized = JSON.stringify(result);
		expect(result).toMatchObject({
			allowed: false,
			code: "policy_secret_exposure_blocked",
		});
		expect(serialized).toContain("project-env");
		expect(serialized).not.toContain("sk-or-secret");
		expect(serialized).not.toContain("PASSWORD=value");
		expect(serialized).not.toContain("BEGIN PRIVATE KEY");
	});

	it("audits denied policy decisions as Agent policy blocks", async () => {
		mocks.getOrganizationSettings.mockResolvedValueOnce(
			organizationSettings({ allowAgentProjectCreation: false }),
		);

		await expect(
			assertAgentPolicy(actor, "agent.project.create", {
				resourceType: "project",
				resourceName: "Paper",
			}),
		).rejects.toMatchObject({
			harnessCode: "policy_project_create_disabled",
		});

		expect(mocks.auditAgentAction).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "stop",
				resourceType: "project",
				resourceName: "Paper",
				metadata: expect.objectContaining({
					allowed: false,
					policyAction: "agent.project.create",
					policyCode: "policy_project_create_disabled",
				}),
			}),
		);
	});

	it("redacts secret-like metadata keys recursively", () => {
		expect(
			sanitizeAgentPolicyMetadata({
				token: "token-value",
				service: { password: "pw", name: "api" },
				items: [{ privateKey: "key" }],
			}),
		).toEqual({
			token: "[redacted]",
			service: { password: "[redacted]", name: "api" },
			items: [{ privateKey: "[redacted]" }],
		});
	});
});

describe("agent harness policy wiring", () => {
	const workspaceSource = readFileSync(
		new URL(
			"../../../../packages/server/src/services/agent-workspace.ts",
			import.meta.url,
		),
		"utf8",
	);
	const deploySuggestionSource = readFileSync(
		new URL(
			"../../../../packages/agent/src/engine/tools/nearzero/deploySuggestion.ts",
			import.meta.url,
		),
		"utf8",
	);

	function functionBody(source: string, name: string) {
		const exportedStart = source.indexOf(`export async function ${name}`);
		const start =
			exportedStart >= 0 ? exportedStart : source.indexOf(`async function ${name}`);
		expect(start).toBeGreaterThanOrEqual(0);
		const next = source.indexOf("\nexport async function ", start + 1);
		return source.slice(start, next === -1 ? undefined : next);
	}

	function expectBefore(body: string, first: string, second: string) {
		const firstIndex = body.indexOf(first);
		const secondIndex = body.indexOf(second);
		expect(firstIndex).toBeGreaterThanOrEqual(0);
		expect(secondIndex).toBeGreaterThanOrEqual(0);
		expect(firstIndex).toBeLessThan(secondIndex);
	}

	it("checks policy before project creation", () => {
		expectBefore(
			functionBody(workspaceSource, "createDevProjectForAgent"),
			'"agent.project.create"',
			"createProject(",
		);
	});

	it("checks policy before project updates and deletes", () => {
		expectBefore(
			functionBody(workspaceSource, "updateProjectForAgent"),
			'"agent.project.update"',
			"updateProjectCore(",
		);
		expectBefore(
			functionBody(workspaceSource, "deleteDevProjectForAgent"),
			'"agent.project.delete"',
			"deleteProject(",
		);
	});

	it("checks policy before service imports and deployments", () => {
		expectBefore(
			functionBody(workspaceSource, "importGitApplicationForAgent"),
			'"agent.service.importGit"',
			"createApplication(",
		);
		expectBefore(
			functionBody(workspaceSource, "runDeploymentForAgent"),
			'"agent.deploy.run"',
			"triggerAgentDeployment(",
		);
	});

	it("checks policy before agent domain assignment", () => {
		expectBefore(
			functionBody(workspaceSource, "importGitApplicationForAgent"),
			'"agent.domain.assign"',
			"ensureDefaultServiceDomain(",
		);
	});

	it("checks policy before compose creation from deploy suggestions", () => {
		expectBefore(
			functionBody(workspaceSource, "createComposeServiceForAgent"),
			"ensureServiceCreateAllowed",
			"createCompose(",
		);
		expect(functionBody(workspaceSource, "ensureServiceCreateAllowed")).toContain(
			'"agent.service.create"',
		);
		expectBefore(
			functionBody(deploySuggestionSource, "deploySuggestion"),
			"createComposeServiceForAgent(",
			"assignDomainToServiceForAgent(",
		);
	});
});
