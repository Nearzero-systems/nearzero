import {
	ApplicationExecutionPlacementError,
	assertApplicationExecutionPlacement,
	assertApplicationExecutionPlacementSnapshot,
	resolveApplicationExecutionPlacement,
} from "@nearzero/server/services/build-execution";
import { afterEach, describe, expect, it } from "vitest";

const originalCommunity = process.env.COMMUNITY;

afterEach(() => {
	if (originalCommunity === undefined) {
		delete process.env.COMMUNITY;
	} else {
		process.env.COMMUNITY = originalCommunity;
	}
});

const application = (
	overrides: Partial<{
		buildExecutionTarget: "deploy_server" | "nearzero_host";
		serverId: string | null;
		sourceType: string;
		registryId: string | null;
	}> = {},
) => ({
	buildExecutionTarget: "deploy_server" as const,
	serverId: null,
	sourceType: "github",
	registryId: null,
	...overrides,
});

describe("resolveApplicationExecutionPlacement", () => {
	it("forces Cloud builds and deploys onto the selected application server", () => {
		process.env.COMMUNITY = "false";

		expect(
			assertApplicationExecutionPlacement(
				application({
					buildExecutionTarget: "nearzero_host",
					serverId: "server-1",
				}),
			),
		).toEqual({
			mode: "cloud",
			buildServerId: "server-1",
			deployServerId: "server-1",
			buildLocation: "remote",
			requiresRegistryTransfer: false,
		});
	});

	it("rejects Cloud deployments without an application server", () => {
		process.env.COMMUNITY = "false";

		expect(() =>
			assertApplicationExecutionPlacement(application()),
		).toThrowError(
			expect.objectContaining<ApplicationExecutionPlacementError>({
				code: "server_required",
			}),
		);
	});

	it("runs Community applications locally when no server is selected", () => {
		process.env.COMMUNITY = "true";

		expect(
			assertApplicationExecutionPlacement(application()),
		).toEqual({
			mode: "community",
			buildServerId: null,
			deployServerId: null,
			buildLocation: "local",
			requiresRegistryTransfer: false,
		});
	});

	it("builds and deploys on the selected server in Community mode", () => {
		process.env.COMMUNITY = "true";

		expect(
			assertApplicationExecutionPlacement(
				application({ serverId: "server-1" }),
			),
		).toEqual({
			mode: "community",
			buildServerId: "server-1",
			deployServerId: "server-1",
			buildLocation: "remote",
			requiresRegistryTransfer: false,
		});
	});

	it("requires a registry for Community local-build remote-deploy placement", () => {
		process.env.COMMUNITY = "true";
		const input = application({
			buildExecutionTarget: "nearzero_host",
			serverId: "server-1",
		});

		expect(resolveApplicationExecutionPlacement(input)).toEqual({
			mode: "community",
			buildServerId: null,
			deployServerId: "server-1",
			buildLocation: "local",
			requiresRegistryTransfer: true,
		});
		expect(() => assertApplicationExecutionPlacement(input)).toThrowError(
			expect.objectContaining<ApplicationExecutionPlacementError>({
				code: "registry_required",
			}),
		);
		expect(
			assertApplicationExecutionPlacement({
				...input,
				registryId: "registry-1",
			}),
		).toEqual(
			expect.objectContaining({
				buildServerId: null,
				deployServerId: "server-1",
				requiresRegistryTransfer: true,
			}),
		);
	});

	it("runs Docker image preparation on the selected deploy server", () => {
		process.env.COMMUNITY = "true";

		expect(
			assertApplicationExecutionPlacement(
				application({
					buildExecutionTarget: "nearzero_host",
					serverId: "server-1",
					sourceType: "docker",
				}),
			),
		).toEqual({
			mode: "community",
			buildServerId: "server-1",
			deployServerId: "server-1",
			buildLocation: "remote",
			requiresRegistryTransfer: false,
		});
	});

	it("rejects a stale queued placement snapshot", () => {
		expect(() =>
			assertApplicationExecutionPlacementSnapshot(
				{
					mode: "community",
					buildServerId: "server-2",
					deployServerId: "server-2",
					buildLocation: "remote",
					requiresRegistryTransfer: false,
				},
				{
					mode: "community",
					buildServerId: "server-1",
					deployServerId: "server-1",
					buildLocation: "remote",
					requiresRegistryTransfer: false,
				},
			),
		).toThrowError(
			expect.objectContaining<ApplicationExecutionPlacementError>({
				code: "placement_changed",
			}),
		);
	});
});
