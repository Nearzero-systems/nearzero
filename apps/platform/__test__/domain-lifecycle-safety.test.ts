import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readRepositoryFile = (path: string) =>
	readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

describe("domain lifecycle safety wiring", () => {
	it("keeps platform hostnames system-assigned and validates external changes", () => {
		const router = readRepositoryFile(
			"apps/platform/server/api/routers/domain.ts",
		);
		const library = readRepositoryFile(
			"packages/server/src/services/domain-library.ts",
		);
		const service = readRepositoryFile(
			"packages/server/src/services/domain.ts",
		);

		expect(router).toContain('.enum(["external", "nearzero_managed"])');
		expect(library).toContain('dnsMode?: "external" | "nearzero_managed"');
		expect(library).toContain('dnsMode?: string }).dnsMode === "platform"');
		expect(library).toContain(
			"await assertExternalDomainPointsToServer(host, input.serverId)",
		);
		expect(router).toContain(
			'input.dnsMode === "external" && input.serverId === undefined',
		);
		expect(service).toContain("assertHostnameIsNotReservedForPlatform");
		expect(service).toContain(
			"await assertExternalDomainPointsToServer(normalizedHost, routeServerId)",
		);
		expect(service).not.toContain(
			'if (normalizedHost.endsWith(".sslip.io")) return',
		);
	});

	it("serializes Compose mutations and reconciles both create and update", () => {
		const service = readRepositoryFile(
			"packages/server/src/services/domain.ts",
		);
		const router = readRepositoryFile(
			"apps/platform/server/api/routers/domain.ts",
		);
		const provision = readRepositoryFile(
			"packages/server/src/services/managed-domain-provision.ts",
		);

		expect(service).toContain("withComposeRoutingMutationLock(input.composeId");
		expect(service).toContain("reconcileComposeDomainRoutes(");
		expect(router).toContain("withDomainRoutingMutationLock(");
		expect(router).toContain("composeBefore.domains.filter(");
		expect(provision).toContain("composeRouteApplied = reconciliation.applied");
		expect(provision).toContain("composeRoutingLockHeld: true");
	});

	it("reconciles system-assigned domains when an environment DNS binding changes", () => {
		const provision = readRepositoryFile(
			"packages/server/src/services/managed-domain-provision.ts",
		);
		const environment = readRepositoryFile(
			"apps/platform/server/api/routers/environment.ts",
		);
		expect(provision).toContain(
			"const migratableFallback = attachedDomains.find(isNearzeroAssignedDomain)",
		);
		expect(provision).toContain("reconcileEnvironmentDefaultDomains(");
		expect(environment).toContain("domainBindingChanged");
		expect(environment).toContain(
			"await reconcileEnvironmentDefaultDomains(environmentId)",
		);
		const schema = readRepositoryFile(
			"packages/server/src/db/schema/domain.ts",
		);
		expect(schema).toContain('isSystemAssigned: boolean("isSystemAssigned")');
		expect(provision).toContain("isSystemAssigned: true");
		expect(provision).toContain("service.domains.find(isNearzeroAssignedDomain)");
	});

	it("removes domains before deleting application, Compose, and server parents", () => {
		const application = readRepositoryFile(
			"apps/platform/server/api/routers/application.ts",
		);
		const compose = readRepositoryFile(
			"apps/platform/server/api/routers/compose.ts",
		);
		const server = readRepositoryFile(
			"apps/platform/server/api/routers/server.ts",
		);

		const applicationDelete = application.slice(
			application.indexOf("delete: protectedProcedure"),
			application.indexOf("stop: protectedProcedure"),
		);
		expect(
			applicationDelete.indexOf("removeDomainById(domainId)"),
		).toBeGreaterThan(-1);
		expect(applicationDelete).toContain("application.previewDeployments");
		expect(
			applicationDelete.indexOf("removeDomainById(domainId)"),
		).toBeLessThan(applicationDelete.indexOf(".delete(applications)"));
		expect(
			applicationDelete.indexOf("const serviceRemoval = await removeService("),
		).toBeLessThan(applicationDelete.indexOf(".delete(applications)"));

		const composeDelete = compose.slice(
			compose.indexOf("delete: protectedProcedure"),
			compose.indexOf("cleanQueues: protectedProcedure"),
		);
		expect(
			composeDelete.indexOf("removeDomainById(domain.domainId)"),
		).toBeGreaterThan(-1);
		expect(
			composeDelete.indexOf("removeDomainById(domain.domainId)"),
		).toBeLessThan(composeDelete.indexOf(".delete(composeTable)"));
		expect(composeDelete.indexOf("await removeCompose(")).toBeLessThan(
			composeDelete.indexOf(".delete(composeTable)"),
		);

		const applicationCleanup = server.slice(
			server.indexOf("deleteAttachedApplicationForServerDelete"),
			server.indexOf("deleteAttachedComposeForServerDelete"),
		);
		const composeCleanup = server.slice(
			server.indexOf("deleteAttachedComposeForServerDelete"),
			server.indexOf("deleteAttachedDatabaseForServerDelete"),
		);
		expect(applicationCleanup).toContain("removeDomainById(domainId)");
		expect(applicationCleanup).toContain(
			"currentApplication.previewDeployments",
		);
		expect(composeCleanup).toContain("removeDomainById(domain.domainId)");

		const queueSafety = readRepositoryFile(
			"apps/platform/server/queues/queueSetup.ts",
		);
		expect(queueSafety).toContain(
			'if (states.includes("active")) return false',
		);
		expect(queueSafety).toContain("await job.remove()");

		const dockerRuntime = readRepositoryFile(
			"packages/server/src/utils/docker/utils.ts",
		);
		const composeRuntime = readRepositoryFile(
			"packages/server/src/services/compose.ts",
		);
		expect(dockerRuntime).toContain("still exists after removal timeout\\n");
		expect(composeRuntime).toContain(
			"still has running services after removal timeout\\n",
		);
		expect(composeRuntime).toContain(
			"label=com.docker.compose.project=${appNameArg}",
		);
		expect(composeRuntime).toContain(
			"still has containers after removal timeout\\n",
		);
		expect(composeRuntime).toContain(
			"still has managed networks after removal\\n",
		);
	});

	it("blocks recursive project deletion while services remain", () => {
		const project = readRepositoryFile(
			"packages/server/src/services/project.ts",
		);
		expect(project).toContain('.for("update")');
		expect(project).toContain("const hasServices = projectEnvironments.some(");
		expect(project).toContain("Project still contains services");
	});
});
