import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	connectOptions,
	findServerByIdMock,
	forwardTargets,
	hostVerificationCommit,
	hostVerifier,
	requests,
	FakeSshClient,
} = vi.hoisted(() => {
	const connections: unknown[] = [];
	const forwards: unknown[][] = [];
	const writtenRequests: string[] = [];
	const commit = vi.fn();
	const verifier = vi.fn(() => true);

	class FakeChannel {
		private handlers = new Map<string, Array<(...args: unknown[]) => void>>();

		on(event: string, handler: (...args: unknown[]) => void) {
			this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
			return this;
		}

		once(event: string, handler: (...args: unknown[]) => void) {
			const wrapped = (...args: unknown[]) => {
				this.handlers.set(
					event,
					(this.handlers.get(event) ?? []).filter((entry) => entry !== wrapped),
				);
				handler(...args);
			};
			return this.on(event, wrapped);
		}

		private emit(event: string, ...args: unknown[]) {
			for (const handler of [...(this.handlers.get(event) ?? [])])
				handler(...args);
		}

		write(request: string) {
			writtenRequests.push(request);
			queueMicrotask(() => {
				const body = '[{"cpu":"1"}]';
				this.emit(
					"data",
					Buffer.from(
						`HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
					),
				);
				this.emit("end");
			});
			return true;
		}

		destroy() {}
	}

	class FakeClient {
		private handlers = new Map<string, (...args: unknown[]) => void>();

		once(event: string, handler: (...args: unknown[]) => void) {
			this.handlers.set(event, handler);
			return this;
		}

		connect(options: unknown) {
			connections.push(options);
			queueMicrotask(() => this.handlers.get("ready")?.());
			return this;
		}

		forwardOut(
			sourceHost: string,
			sourcePort: number,
			destinationHost: string,
			destinationPort: number,
			callback: (error: Error | null, channel: FakeChannel) => void,
		) {
			forwards.push([sourceHost, sourcePort, destinationHost, destinationPort]);
			callback(null, new FakeChannel());
		}

		end() {}
	}

	return {
		connectOptions: connections,
		findServerByIdMock: vi.fn(),
		forwardTargets: forwards,
		hostVerificationCommit: commit,
		hostVerifier: verifier,
		requests: writtenRequests,
		FakeSshClient: FakeClient,
	};
});

vi.mock("@nearzero/server/services/server", () => ({
	findServerById: findServerByIdMock,
}));

vi.mock("@nearzero/server/services/web-server-settings", () => ({
	getWebServerSettings: vi.fn(),
}));

vi.mock("@nearzero/server/utils/servers/ssh-host-verification", () => ({
	createSshHostVerification: () => ({
		commit: hostVerificationCommit,
		hostVerifier,
	}),
}));

vi.mock("ssh2", () => ({ Client: FakeSshClient }));

describe("monitoring transport", () => {
	beforeEach(() => {
		connectOptions.length = 0;
		forwardTargets.length = 0;
		requests.length = 0;
		hostVerificationCommit.mockClear();
		hostVerifier.mockClear();
		findServerByIdMock.mockReset();
		findServerByIdMock.mockResolvedValue({
			serverId: "server-1",
			ipAddress: "198.51.100.10",
			port: 2222,
			username: "nearzero",
			sshKeyId: "key-1",
			sshKey: { privateKey: "test-private-key" },
			metricsConfig: {
				server: { port: 4500, token: "monitoring-token" },
			},
		});
	});

	it("reads remote metrics only through a verified SSH loopback forward", async () => {
		const { requestMonitoring } = await import(
			"@nearzero/server/services/monitoring-client"
		);
		const response = await requestMonitoring({
			serverId: "server-1",
			endpoint: { kind: "server" },
			limit: "50",
		});

		expect(response.status).toBe(200);
		expect(response.body).toBe('[{"cpu":"1"}]');
		expect(forwardTargets).toEqual([["127.0.0.1", 0, "127.0.0.1", 4500]]);
		expect(hostVerificationCommit).toHaveBeenCalledOnce();
		expect(connectOptions[0]).toMatchObject({
			host: "198.51.100.10",
			port: 2222,
			username: "nearzero",
			privateKey: "test-private-key",
			hostVerifier,
		});
		expect(requests[0]).toContain("GET /metrics?limit=50 HTTP/1.1");
		expect(requests[0]).toContain("Authorization: Bearer monitoring-token");
	});

	it("rejects unbounded or malformed metric limits", async () => {
		const { normalizeMonitoringLimit } = await import(
			"@nearzero/server/services/monitoring-client"
		);
		expect(normalizeMonitoringLimit("all")).toBe("all");
		expect(normalizeMonitoringLimit("9999")).toBe("9999");
		expect(() => normalizeMonitoringLimit("0")).toThrow();
		expect(() => normalizeMonitoringLimit("10000")).toThrow();
		expect(() => normalizeMonitoringLimit("50&appName=other")).toThrow();
	});

	it("parses chunked SSH-forwarded HTTP responses", async () => {
		const { parseMonitoringHttpResponse } = await import(
			"@nearzero/server/services/monitoring-client"
		);
		const response = parseMonitoringHttpResponse(
			Buffer.from(
				"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\ntest\r\n0\r\n\r\n",
			),
		);
		expect(response).toEqual({ status: 200, statusText: "OK", body: "test" });
	});
});
