import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	clientInstances,
	dockerOptions,
	findServerByIdMock,
	FakeSshClient,
	FakeDockerode,
} = vi.hoisted(() => {
	const clients: Array<{ ended: boolean }> = [];
	const options: unknown[] = [];

	class FakeStream {
		addListener() {
			return this;
		}

		once() {
			return this;
		}
	}

	class FakeClient {
		private handlers = new Map<string, (...args: unknown[]) => void>();
		ended = false;

		constructor() {
			clients.push(this);
		}

		once(event: string, handler: (...args: unknown[]) => void) {
			this.handlers.set(event, handler);
			return this;
		}

		connect() {
			this.handlers.get("ready")?.();
			return this;
		}

		exec(
			_command: string,
			callback: (error: Error | null, stream: FakeStream) => void,
		) {
			callback(null, new FakeStream());
			return this;
		}

		end() {
			this.ended = true;
		}
	}

	class DockerodeMock {
		constructor(input: unknown) {
			options.push(input);
		}
	}

	return {
		clientInstances: clients,
		dockerOptions: options,
		findServerByIdMock: vi.fn(),
		FakeSshClient: FakeClient,
		FakeDockerode: DockerodeMock,
	};
});

vi.mock("@nearzero/server/constants", () => ({
	getDocker: vi.fn(),
}));

vi.mock("@nearzero/server/services/server", () => ({
	findServerById: findServerByIdMock,
}));

vi.mock("ssh2", () => ({
	Client: FakeSshClient,
}));

vi.mock("dockerode", () => ({
	default: FakeDockerode,
}));

describe("remote Docker SSH transport", () => {
	beforeEach(() => {
		clientInstances.length = 0;
		dockerOptions.length = 0;
		findServerByIdMock.mockReset();
		findServerByIdMock.mockResolvedValue({
			name: "remote",
			ipAddress: "192.0.2.10",
			port: 22,
			username: "ubuntu",
			sshKeyId: "key-1",
			sshKey: {
				privateKey: "test-private-key",
			},
		});
	});

	it("creates a fresh SSH client for every Docker HTTP request", async () => {
		const { getRemoteDocker } = await import(
			"@nearzero/server/utils/servers/remote-docker"
		);
		await getRemoteDocker("server-1");

		const options = dockerOptions[0] as {
			agent: {
				createConnection: (
					options: unknown,
					callback: (error: Error | null, stream?: unknown) => void,
				) => void;
			};
		};

		const connect = () =>
			new Promise<void>((resolve, reject) => {
				options.agent.createConnection({}, (error, stream) => {
					if (error) {
						reject(error);
						return;
					}
					expect(stream).toBeDefined();
					resolve();
				});
			});

		await connect();
		await connect();

		expect(clientInstances).toHaveLength(2);
		expect(clientInstances[0]).not.toBe(clientInstances[1]);
	});
});
