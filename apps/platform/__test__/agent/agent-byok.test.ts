import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	decryptOrgOpenRouterKey,
	encryptOrgOpenRouterKey,
	getAgentProviderStatus,
	isValidOpenRouterKeyShape,
} from "@nearzero/server/services/agent-openrouter-key";
import {
	agentToolDefinitions,
	exposedToolNames,
} from "../../../../packages/agent/src/engine/loop/tool-schemas";

describe("agent OpenRouter key service", () => {
	const originalSecret = process.env.BETTER_AUTH_SECRET;
	const originalEnvKey = process.env.OPENROUTER_API_KEY;

	afterEach(() => {
		process.env.BETTER_AUTH_SECRET = originalSecret;
		process.env.OPENROUTER_API_KEY = originalEnvKey;
	});

	it("validates OpenRouter key shape", () => {
		expect(isValidOpenRouterKeyShape("sk-or-test-key")).toBe(true);
		expect(isValidOpenRouterKeyShape("short")).toBe(false);
		expect(isValidOpenRouterKeyShape("")).toBe(false);
	});

	it("encrypts and decrypts org keys with BETTER_AUTH_SECRET", async () => {
		process.env.BETTER_AUTH_SECRET = "test-secret-for-openrouter-key-encryption";
		const ciphertext = await encryptOrgOpenRouterKey("sk-or-roundtrip-key");
		expect(ciphertext).not.toContain("sk-or-roundtrip-key");
		const plaintext = await decryptOrgOpenRouterKey(ciphertext);
		expect(plaintext).toBe("sk-or-roundtrip-key");
	});

	it("reports env override as configured", async () => {
		process.env.OPENROUTER_API_KEY = "sk-or-env-override";
		const status = await getAgentProviderStatus("org_test");
		expect(status).toEqual({ configured: true, source: "env" });
	});
});

describe("agent tool exposure", () => {
	it("exposes only scoped workspace tools", () => {
		const names = agentToolDefinitions.map((tool) => tool.function.name);
		expect(names).toEqual([
			"listProjects",
			"getProject",
			"getEnvironment",
			"getService",
			"createProject",
			"updateProject",
			"deleteProject",
			"createEnvironment",
			"listDeployments",
			"getDeploymentLogs",
			"listRuntimeServers",
			"getServer",
			"validateServer",
			"getServerSetupLogs",
			"listSshKeys",
			"requestSshKeySetup",
			"createServer",
			"runServerSetup",
			"runServerSecurityAudit",
			"listGitProviders",
			"listGitRepositories",
			"listGitBranches",
			"createApplicationFromGit",
			"createApplicationFromImage",
			"createComposeService",
			"createDatabaseService",
			"assignDomainToService",
			"configureApplicationSource",
			"configureApplicationBuild",
			"configureServicePorts",
			"configureServiceEnv",
			"configureServiceMounts",
			"runServiceAction",
			"rollbackDeployment",
			"getRuntimeStatus",
			"getRuntimeLogs",
			"suggest",
			"deploy",
			"runDeployment",
			"webSearch",
			"analyzeLogs",
		]);
		expect(exposedToolNames.has("verify")).toBe(false);
		expect(exposedToolNames.has("delegate")).toBe(false);
	});

	it("does not expose raw secret-value parameters", () => {
		const forbidden = new Set([
			"apiKey",
			"envVariables",
			"password",
			"privateKey",
			"secret",
			"token",
		]);
		for (const tool of agentToolDefinitions) {
			const properties =
				(tool.function.parameters as { properties?: Record<string, unknown> })
					.properties ?? {};
			for (const key of Object.keys(properties)) {
				expect(forbidden.has(key), `${tool.function.name}.${key}`).toBe(false);
			}
		}
	});
});

describe("agent wire onboarding event", () => {
	it("accepts provider_setup_required payload", async () => {
		const { agentWirePayloadSchema } = await import(
			path.resolve(
				__dirname,
				"../../../../packages/agent/src/wire.ts",
			)
		);
		const parsed = agentWirePayloadSchema.parse({
			kind: "provider_setup_required",
			canConfigure: true,
			waitingLabel: "Waiting for the key",
		});
		expect(parsed.kind).toBe("provider_setup_required");
	});

	it("accepts user_input_required payload", async () => {
		const { agentWirePayloadSchema } = await import(
			path.resolve(
				__dirname,
				"../../../../packages/agent/src/wire.ts",
			)
		);
		const parsed = agentWirePayloadSchema.parse({
			kind: "user_input_required",
			field: "gitProviderId",
			waitingLabel: "Waiting for Git provider connection",
			prompt: "Connect a Git provider",
			submitLabel: "Connect",
			inputType: "text",
			secret: false,
			options: [
				{
					label: "GitHub",
					value: "connect:github",
					action: "connectGitProvider",
					providerType: "github",
					href: "/dashboard/settings/git-providers?connect=github",
				},
			],
		});
		expect(parsed.field).toBe("gitProviderId");
		expect(parsed.secret).toBe(false);
		expect(parsed.options?.[0]?.action).toBe("connectGitProvider");
	});
});
