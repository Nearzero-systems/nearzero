import type { ApplicationNested } from "@nearzero/server/utils/builders";
import { mechanizeDockerContainer } from "@nearzero/server/utils/builders";
import { beforeEach, describe, expect, it, vi } from "vitest";

type MockCreateServiceOptions = {
	TaskTemplate?: {
		ContainerSpec?: {
			StopGracePeriod?: number;
			Ulimits?: Array<{ Name: string; Soft: number; Hard: number }>;
		};
	};
	[key: string]: unknown;
};

const {
	inspectMock,
	getServiceMock,
	createServiceMock,
	listTasksMock,
	getRemoteDockerMock,
	execAsyncRemoteMock,
} = vi.hoisted(() => {
	const inspect = vi.fn<() => Promise<unknown>>();
	const update = vi.fn(async () => undefined);
	const getService = vi.fn(() => ({ inspect, update }));
	const createService = vi.fn<
		(opts: MockCreateServiceOptions) => Promise<void>
	>(async () => undefined);
	const listTasks = vi.fn(async () => [
		{
			DesiredState: "running",
			Status: { State: "running" },
		},
	]);
	const getRemoteDocker = vi.fn(async () => ({
		getService,
		createService,
		listTasks,
	}));
	const execAsyncRemote = vi.fn(async () => ({
		stdout: "UFW allowed Docker published ports: 8080/tcp\n",
		stderr: "",
	}));
	return {
		inspectMock: inspect,
		getServiceMock: getService,
		createServiceMock: createService,
		listTasksMock: listTasks,
		getRemoteDockerMock: getRemoteDocker,
		execAsyncRemoteMock: execAsyncRemote,
	};
});

vi.mock("@nearzero/server/utils/servers/remote-docker", () => ({
	getRemoteDocker: getRemoteDockerMock,
}));

vi.mock("@nearzero/server/utils/process/execAsync", async () => {
	const actual = await vi.importActual<
		typeof import("@nearzero/server/utils/process/execAsync")
	>("@nearzero/server/utils/process/execAsync");
	return {
		...actual,
		execAsyncRemote: execAsyncRemoteMock,
	};
});

const createApplication = (
	overrides: Partial<ApplicationNested> = {},
): ApplicationNested =>
	({
		appName: "test-app",
		buildType: "dockerfile",
		env: null,
		mounts: [],
		cpuLimit: null,
		memoryLimit: null,
		memoryReservation: null,
		cpuReservation: null,
		command: null,
		ports: [],
		sourceType: "docker",
		dockerImage: "example:latest",
		registry: null,
		environment: {
			project: { env: null },
			env: null,
		},
		replicas: 1,
		stopGracePeriodSwarm: 0,
		ulimitsSwarm: null,
		serverId: "server-id",
		...overrides,
	}) as unknown as ApplicationNested;

const deployForTest = (
	application: ApplicationNested,
	onProgress?: Parameters<typeof mechanizeDockerContainer>[1]["onProgress"],
) =>
	mechanizeDockerContainer(application, {
		onProgress,
		stabilityOptions: {
			timeoutMs: 100,
			pollMs: 1,
			stableMs: 0,
		},
	});

describe("mechanizeDockerContainer", () => {
	beforeEach(() => {
		inspectMock.mockReset();
		inspectMock
			.mockRejectedValueOnce(new Error("service not found"))
			.mockResolvedValue({
				Spec: {
					Mode: {
						Replicated: { Replicas: 1 },
					},
				},
			});
		getServiceMock.mockClear();
		createServiceMock.mockClear();
		listTasksMock.mockClear();
		getRemoteDockerMock.mockClear();
		execAsyncRemoteMock.mockClear();
		getRemoteDockerMock.mockResolvedValue({
			getService: getServiceMock,
			createService: createServiceMock,
			listTasks: listTasksMock,
		});
	});

	it("passes stopGracePeriodSwarm as a number and keeps zero values", async () => {
		const application = createApplication({ stopGracePeriodSwarm: 0 });

		await deployForTest(application);

		expect(createServiceMock).toHaveBeenCalledTimes(1);
		const call = createServiceMock.mock.calls[0] as
			| [MockCreateServiceOptions]
			| undefined;
		if (!call) {
			throw new Error("createServiceMock should have been called once");
		}
		const [settings] = call;
		expect(settings.TaskTemplate?.ContainerSpec?.StopGracePeriod).toBe(0);
		expect(typeof settings.TaskTemplate?.ContainerSpec?.StopGracePeriod).toBe(
			"number",
		);
	});

	it("omits StopGracePeriod when stopGracePeriodSwarm is null", async () => {
		const application = createApplication({ stopGracePeriodSwarm: null });

		await deployForTest(application);

		expect(createServiceMock).toHaveBeenCalledTimes(1);
		const call = createServiceMock.mock.calls[0] as
			| [MockCreateServiceOptions]
			| undefined;
		if (!call) {
			throw new Error("createServiceMock should have been called once");
		}
		const [settings] = call;
		expect(settings.TaskTemplate?.ContainerSpec).not.toHaveProperty(
			"StopGracePeriod",
		);
	});

	it("passes ulimits to ContainerSpec when ulimitsSwarm is defined", async () => {
		const ulimits = [
			{ Name: "nofile", Soft: 10000, Hard: 20000 },
			{ Name: "nproc", Soft: 4096, Hard: 8192 },
		];
		const application = createApplication({ ulimitsSwarm: ulimits });

		await deployForTest(application);

		expect(createServiceMock).toHaveBeenCalledTimes(1);
		const call = createServiceMock.mock.calls[0];
		if (!call) {
			throw new Error("createServiceMock should have been called once");
		}
		const [settings] = call;
		expect(settings.TaskTemplate?.ContainerSpec?.Ulimits).toEqual(ulimits);
	});

	it("omits Ulimits when ulimitsSwarm is null", async () => {
		const application = createApplication({ ulimitsSwarm: null });

		await deployForTest(application);

		expect(createServiceMock).toHaveBeenCalledTimes(1);
		const call = createServiceMock.mock.calls[0];
		if (!call) {
			throw new Error("createServiceMock should have been called once");
		}
		const [settings] = call;
		expect(settings.TaskTemplate?.ContainerSpec).not.toHaveProperty("Ulimits");
	});

	it("omits Ulimits when ulimitsSwarm is an empty array", async () => {
		const application = createApplication({ ulimitsSwarm: [] });

		await deployForTest(application);

		expect(createServiceMock).toHaveBeenCalledTimes(1);
		const call = createServiceMock.mock.calls[0];
		if (!call) {
			throw new Error("createServiceMock should have been called once");
		}
		const [settings] = call;
		expect(settings.TaskTemplate?.ContainerSpec).not.toHaveProperty("Ulimits");
	});

	it("waits for the created Swarm task and reports stable progress", async () => {
		const onProgress = vi.fn();

		await deployForTest(createApplication(), onProgress);

		expect(listTasksMock).toHaveBeenCalledWith({
			filters: JSON.stringify({
				service: ["test-app"],
			}),
		});
		expect(onProgress).toHaveBeenCalledWith({
			stage: "create",
			message: "Creating the remote Swarm service.",
		});
		expect(onProgress).toHaveBeenCalledWith({
			stage: "stable",
			message: "Swarm service is stable (1/1 running).",
		});
		expect(getRemoteDockerMock).toHaveBeenCalledTimes(1);
	});

	it("publishes configured app ports and opens the same remote firewall ports", async () => {
		const onProgress = vi.fn();
		const application = createApplication({
			ports: [
				{
					portId: "port-1",
					applicationId: "app-1",
					targetPort: 3000,
					publishedPort: 8080,
					protocol: "tcp",
					publishMode: "host",
				},
			],
		});

		await deployForTest(application, onProgress);

		expect(createServiceMock).toHaveBeenCalledTimes(1);
		const call = createServiceMock.mock.calls[0];
		if (!call) {
			throw new Error("createServiceMock should have been called once");
		}
		const [settings] = call;
		expect(settings.EndpointSpec).toEqual({
			Ports: [
				{
					PublishMode: "host",
					Protocol: "tcp",
					TargetPort: 3000,
					PublishedPort: 8080,
				},
			],
		});
		expect(execAsyncRemoteMock).toHaveBeenCalledWith(
			"server-id",
			expect.stringContaining('PORT_SPECS="8080/tcp"'),
		);
		expect(onProgress).toHaveBeenCalledWith({
			stage: "firewall",
			message: "Configuring remote firewall for published ports: 8080/tcp.",
		});
		expect(onProgress).toHaveBeenCalledWith({
			stage: "firewall",
			message: "UFW allowed Docker published ports: 8080/tcp",
		});
	});
});
