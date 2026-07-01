import { describe, expect, it, vi } from "vitest";
import { sanitizeProjectTree } from "@nearzero/server/services/agent-workspace";
import { DEFAULT_PROJECT_ENVIRONMENT_NAME } from "@nearzero/server/services/environment";
import * as auditLogModule from "@nearzero/server/services/proprietary/audit-log";

describe("agent workspace helpers", () => {
	it("redacts env fields in project trees", () => {
		const sanitized = sanitizeProjectTree({
			name: "demo",
			env: "SECRET=1",
			environments: [{ name: "development", env: "DB=postgres" }],
		});
		expect(sanitized.env).toBe("[redacted]");
		expect((sanitized.environments as Array<{ env: string }>)[0]?.env).toBe(
			"[redacted]",
		);
	});

	it("defaults new projects to development", () => {
		expect(DEFAULT_PROJECT_ENVIRONMENT_NAME).toBe("development");
	});
});

describe("agent workspace audits", () => {
	it("createAuditLog accepts agent actor metadata", async () => {
		const auditSpy = vi.spyOn(auditLogModule, "createAuditLog");
		await auditLogModule.createAuditLog({
			organizationId: "org_1",
			userId: "user_1",
			userEmail: "user@test.com",
			userRole: "owner",
			action: "create",
			resourceType: "compose",
			resourceId: "compose_1",
			resourceName: "redis",
			metadata: { actorType: "agent", agentThreadId: "thread_1" },
		});
		expect(auditSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "create",
				resourceType: "compose",
			}),
		);
		auditSpy.mockRestore();
	});
});

describe("agent tool exposure", () => {
	it("exposes project, service, infra, and deployment tools", async () => {
		const { agentToolDefinitions } = await import(
			"../../../../packages/agent/src/engine/loop/tool-schemas"
		);
		const names = agentToolDefinitions.map((tool) => tool.function.name);
		expect(names).toContain("createProject");
		expect(names).toContain("updateProject");
		expect(names).toContain("deleteProject");
		expect(names).toContain("getProject");
		expect(names).toContain("createApplicationFromGit");
		expect(names).toContain("createApplicationFromImage");
		expect(names).toContain("createComposeService");
		expect(names).toContain("createDatabaseService");
		expect(names).toContain("assignDomainToService");
		expect(names).toContain("configureApplicationSource");
		expect(names).toContain("configureApplicationBuild");
		expect(names).toContain("configureServicePorts");
		expect(names).toContain("configureServiceEnv");
		expect(names).toContain("configureServiceMounts");
		expect(names).toContain("runServiceAction");
		expect(names).toContain("runDeployment");
		expect(names).toContain("listDeployments");
		expect(names).toContain("listRuntimeServers");
		expect(names).toContain("validateServer");
		expect(names).toContain("runServerSetup");
		expect(names).toContain("getRuntimeStatus");
		expect(names).toContain("getRuntimeLogs");
	});

	it("lets the Git import tool carry monorepo build settings", async () => {
		const { agentToolDefinitions } = await import(
			"../../../../packages/agent/src/engine/loop/tool-schemas"
		);
		const gitTool = agentToolDefinitions.find(
			(tool) => tool.function.name === "createApplicationFromGit",
		);
		expect(gitTool).toBeDefined();
		const properties = (
			gitTool?.function.parameters as {
				properties?: Record<string, unknown>;
			}
		).properties;
		expect(properties).toHaveProperty("buildPath");
		expect(properties).toHaveProperty("buildType");
		expect(properties).toHaveProperty("buildSelectionMode");
		expect(properties).toHaveProperty("buildExecutionTarget");
		expect(properties).toHaveProperty("customInstallCommand");
		expect(properties).toHaveProperty("customBuildCommand");
		expect(properties).toHaveProperty("customStartCommand");
	});
});
