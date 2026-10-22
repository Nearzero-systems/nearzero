import { readFileSync } from "node:fs";
import {
	extractLocalContainerAppNames,
	isReservedSystemAppName,
} from "@nearzero/server/services/instance-access";
import { describe, expect, it } from "vitest";

const COMPOSE_PATH = "/etc/nearzero/compose";

const platformSource = (relativePath: string) =>
	readFileSync(
		new URL(`../../server/${relativePath}`, import.meta.url),
		"utf8",
	);

describe("local container ownership labels", () => {
	it("maps swarm service containers to their appName", () => {
		expect(
			extractLocalContainerAppNames(
				{ "com.docker.swarm.service.name": "web-abc123" },
				COMPOSE_PATH,
			),
		).toEqual(["web-abc123"]);
	});

	it("maps stack services to their namespace, not the stack service name", () => {
		expect(
			extractLocalContainerAppNames(
				{
					"com.docker.swarm.service.name": "shop-x1_api",
					"com.docker.stack.namespace": "shop-x1",
				},
				COMPOSE_PATH,
			),
		).toEqual(["shop-x1"]);
	});

	it("maps compose projects only when they were deployed from COMPOSE_PATH", () => {
		expect(
			extractLocalContainerAppNames(
				{
					"com.docker.compose.project": "shop-x1",
					"com.docker.compose.project.working_dir": `${COMPOSE_PATH}/shop-x1/code`,
				},
				COMPOSE_PATH,
			),
		).toEqual(["shop-x1"]);
		// The control-plane stack is a compose project outside COMPOSE_PATH.
		expect(
			extractLocalContainerAppNames(
				{
					"com.docker.compose.project": "nearzero",
					"com.docker.compose.project.working_dir": "/opt/nearzero",
				},
				COMPOSE_PATH,
			),
		).toEqual([]);
		// A user-chosen appName cannot claim another app's compose directory.
		expect(
			extractLocalContainerAppNames(
				{
					"com.docker.compose.project": "victim",
					"com.docker.compose.project.working_dir": `${COMPOSE_PATH}/other/code`,
				},
				COMPOSE_PATH,
			),
		).toEqual([]);
	});

	it("never maps control-plane workloads to a user service", () => {
		for (const name of ["nearzero", "nearzero-postgres", "nearzero-redis"]) {
			expect(isReservedSystemAppName(name)).toBe(true);
			expect(
				extractLocalContainerAppNames(
					{ "com.docker.swarm.service.name": name },
					COMPOSE_PATH,
				),
			).toEqual([]);
		}
	});
});

describe("host-level access checks stay in place", () => {
	it("requires an instance administrator for the local host terminal", () => {
		const source = platformSource("wss/terminal.ts");
		expect(source).toContain("isInstanceAdministrator(user.id)");
		expect(source).toMatch(/user\.role !== "owner" && user\.role !== "admin"/);
	});

	it("checks local container ownership before exec and logs", () => {
		expect(platformSource("wss/docker-container-terminal.ts")).toContain(
			"canAccessLocalContainer(",
		);
		expect(platformSource("wss/docker-container-logs.ts")).toContain(
			"canAccessLocalContainer(",
		);
	});

	it("checks ownership in every Docker router procedure", () => {
		const source = platformSource("api/routers/docker.ts");
		expect(source).not.toContain(
			"if (server.organizationId !== ctx.session?.activeOrganizationId)",
		);
		const procedures = source.match(/\n\t[a-zA-Z]+: withPermission/g) ?? [];
		const checks =
			source.match(
				/await assert(?:DockerHost|Container|AppName)Access\(ctx,/g,
			) ?? [];
		expect(procedures.length).toBeGreaterThan(0);
		expect(checks.length).toBe(procedures.length);
	});

	it("never returns the host SSH key or metrics token from settings", () => {
		const source = platformSource("api/routers/settings.ts");
		expect(source).toContain("return toPublicWebServerSettings(settings);");
		expect(platformSource("api/routers/admin.ts")).toContain(
			"return toPublicWebServerSettings(settings);",
		);
	});
});
