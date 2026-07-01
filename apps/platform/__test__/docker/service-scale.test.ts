import {
	ExecError,
	ServiceScaleError,
	formatServiceScaleError,
	scaleServiceReplicas,
} from "@nearzero/server";
import * as serverService from "@nearzero/server/services/server";
import * as processUtils from "@nearzero/server/utils/process/execAsync";
import * as remoteDocker from "@nearzero/server/utils/servers/remote-docker";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@nearzero/server/services/server", () => ({
	findServerById: vi.fn(),
}));

vi.mock("@nearzero/server/utils/process/execAsync", async () => {
	const actual =
		await vi.importActual<typeof import("@nearzero/server/utils/process/execAsync")>(
			"@nearzero/server/utils/process/execAsync",
		);
	return {
		...actual,
		execAsync: vi.fn(),
		execAsyncRemote: vi.fn(),
	};
});

vi.mock("@nearzero/server/utils/servers/remote-docker", () => ({
	getRemoteDocker: vi.fn(),
}));

describe("scaleServiceReplicas", () => {
	const activeSwarmInfo = () => ({
		ServerVersion: "test",
		Swarm: { LocalNodeState: "active" },
	});
	const update = vi.fn().mockResolvedValue(undefined);
	const inspect = vi.fn().mockResolvedValue({
		Version: { Index: "42" },
		Spec: { Mode: { Replicated: { Replicas: 0 } } },
	});

	beforeEach(() => {
		vi.clearAllMocks();
		(serverService.findServerById as ReturnType<typeof vi.fn>).mockResolvedValue({
			serverId: "server-1",
			name: "Deploy Server",
			ipAddress: "10.0.0.2",
			port: 22,
			username: "root",
			sshKeyId: "ssh-1",
			sshKey: {
				privateKey: "test-private-key",
			},
		});
		(processUtils.execAsyncRemote as ReturnType<typeof vi.fn>).mockResolvedValue({
			stdout: "ok",
			stderr: "",
		});
		(processUtils.execAsync as ReturnType<typeof vi.fn>).mockResolvedValue({
			stdout: "ok",
			stderr: "",
		});
		(
			remoteDocker.getRemoteDocker as ReturnType<typeof vi.fn>
		).mockResolvedValue({
			info: vi.fn().mockResolvedValue(activeSwarmInfo()),
			getService: () => ({
				inspect,
				update,
			}),
		});
	});

	it("uses Dockerode service.update (same path as reload), not shell docker scale", async () => {
		await scaleServiceReplicas("app-test-abc", 1, "server-1");

		expect(serverService.findServerById).toHaveBeenCalledWith("server-1");
		expect(processUtils.execAsyncRemote).toHaveBeenCalledWith(
			"server-1",
			"docker info --format '{{json .ServerVersion}}'",
		);
		expect(processUtils.execAsyncRemote).toHaveBeenCalledWith(
			"server-1",
			"docker service inspect app-test-abc --format '{{.ID}}'",
		);
		expect(remoteDocker.getRemoteDocker).toHaveBeenCalledWith("server-1");
		expect(inspect).toHaveBeenCalled();
		expect(update).toHaveBeenCalledWith({
			version: 42,
			Mode: { Replicated: { Replicas: 1 } },
		});
	});

	it("rejects global-mode services", async () => {
		inspect
			.mockResolvedValueOnce({
				Version: { Index: "1" },
				Spec: { Mode: { Replicated: { Replicas: 1 } } },
			})
			.mockResolvedValueOnce({
				Version: { Index: "1" },
				Spec: { Mode: { Global: {} } },
			});
		await expect(
			scaleServiceReplicas("traefik-global", 1, null),
		).rejects.toThrow(/global mode/i);
	});

	it("blocks remote scaling before Dockerode when the server has no SSH key", async () => {
		(serverService.findServerById as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
			{
				serverId: "server-1",
				name: "Deploy Server",
				ipAddress: "10.0.0.2",
				port: 22,
				username: "root",
				sshKeyId: null,
				sshKey: null,
			},
		);

		await expect(
			scaleServiceReplicas("app-test-abc", 1, "server-1"),
		).rejects.toMatchObject({
			code: "server_missing_ssh_key",
		});
		expect(processUtils.execAsyncRemote).not.toHaveBeenCalled();
		expect(remoteDocker.getRemoteDocker).not.toHaveBeenCalled();
	});

	it("maps SSH authentication failures to a typed service scale error", async () => {
		(processUtils.execAsyncRemote as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new ExecError("Authentication failed: Invalid SSH private key", {
				command: "docker info",
				serverId: "server-1",
			}),
		);

		await expect(
			scaleServiceReplicas("app-test-abc", 1, "server-1"),
		).rejects.toMatchObject({
			code: "ssh_auth_failed",
		});
		expect(remoteDocker.getRemoteDocker).not.toHaveBeenCalled();
	});

	it("maps Docker preflight failures to a typed service scale error", async () => {
		(processUtils.execAsyncRemote as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new ExecError("Remote command failed with exit code 1", {
				command: "docker info",
				stderr: "Cannot connect to the Docker daemon",
				exitCode: 1,
				serverId: "server-1",
			}),
		);

		await expect(
			scaleServiceReplicas("app-test-abc", 1, "server-1"),
		).rejects.toMatchObject({
			code: "remote_docker_unreachable",
		});
		expect(remoteDocker.getRemoteDocker).not.toHaveBeenCalled();
	});

	it("maps missing swarm services before scaling", async () => {
		(processUtils.execAsyncRemote as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce({ stdout: "ok", stderr: "" })
			.mockRejectedValueOnce(
				new ExecError("Remote command failed with exit code 1", {
					command: "docker service inspect app-test-abc",
					stderr: "Error: no such service: app-test-abc",
					exitCode: 1,
					serverId: "server-1",
				}),
			);

		await expect(
			scaleServiceReplicas("app-test-abc", 1, "server-1"),
		).rejects.toMatchObject({
			code: "swarm_service_missing",
		});
		expect(remoteDocker.getRemoteDocker).not.toHaveBeenCalled();
	});

	it("retries remote Dockerode socket hang ups with docker service scale", async () => {
		inspect.mockRejectedValueOnce(new Error("socket hang up"));

		await scaleServiceReplicas("app-test-abc", 1, "server-1");

		expect(update).not.toHaveBeenCalled();
		expect(processUtils.execAsyncRemote).toHaveBeenCalledWith(
			"server-1",
			"docker service scale app-test-abc\\=1",
		);
	});

	it("retries 'mismatched Runtime and *Spec fields' errors with docker service scale", async () => {
		update.mockRejectedValueOnce(
			new Error(
				"(HTTP code 400) unexpected - mismatched Runtime and *Spec fields",
			),
		);

		await scaleServiceReplicas("app-test-abc", 0, "server-1");

		expect(update).toHaveBeenCalled();
		expect(processUtils.execAsyncRemote).toHaveBeenCalledWith(
			"server-1",
			"docker service scale app-test-abc\\=0",
		);
	});

	it("falls back to 'docker service update --force --replicas' when both spec update and scale hit the mismatch error (Docker 29.x)", async () => {
		update.mockRejectedValueOnce(
			new Error(
				"(HTTP code 400) unexpected - mismatched Runtime and *Spec fields",
			),
		);
		// First CLI attempt (docker service scale) also fails with the mismatch.
		(processUtils.execAsyncRemote as ReturnType<typeof vi.fn>).mockImplementation(
			(_serverId: string, command: string) => {
				if (command === "docker service scale app-test-abc\\=0") {
					return Promise.reject(
						new Error(
							"(HTTP code 400) unexpected - mismatched Runtime and *Spec fields",
						),
					);
				}
				return Promise.resolve({ stdout: "ok", stderr: "" });
			},
		);

		await scaleServiceReplicas("app-test-abc", 0, "server-1");

		expect(processUtils.execAsyncRemote).toHaveBeenCalledWith(
			"server-1",
			"docker service scale app-test-abc\\=0",
		);
		expect(processUtils.execAsyncRemote).toHaveBeenCalledWith(
			"server-1",
			"docker service update --detach --force --replicas 0 app-test-abc",
		);
	});

	it("sends the full existing spec when scaling so Swarm keeps the TaskTemplate", async () => {
		inspect.mockResolvedValueOnce({
			Version: { Index: "42" },
			Spec: {
				Name: "app-test-abc",
				TaskTemplate: { ContainerSpec: { Image: "mongo:8" } },
				Mode: { Replicated: { Replicas: 1 } },
			},
		});

		await scaleServiceReplicas("app-test-abc", 0, "server-1");

		expect(update).toHaveBeenCalledWith({
			version: 42,
			Name: "app-test-abc",
			TaskTemplate: { ContainerSpec: { Image: "mongo:8" } },
			Mode: { Replicated: { Replicas: 0 } },
		});
	});

	it("preflights local Docker before scaling local services", async () => {
		const info = vi.fn().mockResolvedValue(activeSwarmInfo());
		(
			remoteDocker.getRemoteDocker as ReturnType<typeof vi.fn>
		).mockResolvedValueOnce({
			info,
			getService: () => ({
				inspect,
				update,
			}),
		});

		await scaleServiceReplicas("mongo-test-local", 0, null);

		expect(remoteDocker.getRemoteDocker).toHaveBeenCalledWith(null);
		expect(info).toHaveBeenCalled();
		expect(inspect).toHaveBeenCalled();
		expect(update).toHaveBeenCalledWith({
			version: 42,
			Mode: { Replicated: { Replicas: 0 } },
		});
	});

	it("maps local Docker info failures to a typed service scale error", async () => {
		const inspectDuringPreflight = vi.fn();
		(
			remoteDocker.getRemoteDocker as ReturnType<typeof vi.fn>
		).mockResolvedValueOnce({
			info: vi
				.fn()
				.mockRejectedValue(
					new Error("permission denied while trying to connect to the docker API"),
				),
			getService: () => ({
				inspect: inspectDuringPreflight,
				update,
			}),
		});

		await expect(
			scaleServiceReplicas("mongo-test-local", 0, null),
		).rejects.toMatchObject({
			code: "local_docker_unreachable",
			detail: "permission denied while trying to connect to the docker API",
		});
		expect(inspectDuringPreflight).not.toHaveBeenCalled();
		expect(update).not.toHaveBeenCalled();
	});

	it("maps inactive local Docker Swarm to a typed service scale error", async () => {
		const inspectDuringPreflight = vi.fn();
		(
			remoteDocker.getRemoteDocker as ReturnType<typeof vi.fn>
		).mockResolvedValueOnce({
			info: vi.fn().mockResolvedValue({
				ServerVersion: "test",
				Swarm: { LocalNodeState: "inactive" },
			}),
			getService: () => ({
				inspect: inspectDuringPreflight,
				update,
			}),
		});

		await expect(
			scaleServiceReplicas("mongo-test-local", 0, null),
		).rejects.toMatchObject({
			code: "local_docker_unreachable",
			detail: "Docker Swarm is inactive on the local Docker engine",
		});
		expect(inspectDuringPreflight).not.toHaveBeenCalled();
		expect(update).not.toHaveBeenCalled();
	});

	it("maps missing local swarm services before scaling", async () => {
		(
			remoteDocker.getRemoteDocker as ReturnType<typeof vi.fn>
		).mockResolvedValueOnce({
			info: vi.fn().mockResolvedValue(activeSwarmInfo()),
			getService: () => ({
				inspect: vi
					.fn()
					.mockRejectedValue(new Error("no such service: mongo-test-local")),
				update,
			}),
		});

		await expect(
			scaleServiceReplicas("mongo-test-local", 0, null),
		).rejects.toMatchObject({
			code: "swarm_service_missing",
			detail: "no such service: mongo-test-local",
		});
		expect(update).not.toHaveBeenCalled();
	});

	it("maps local Docker socket hang ups to a typed service scale error", async () => {
		(
			remoteDocker.getRemoteDocker as ReturnType<typeof vi.fn>
		).mockResolvedValueOnce({
			info: vi.fn().mockResolvedValue(activeSwarmInfo()),
			getService: () => ({
				inspect: vi.fn().mockRejectedValue(new Error("socket hang up")),
				update,
			}),
		});

		await expect(
			scaleServiceReplicas("mongo-test-local", 0, null),
		).rejects.toMatchObject({
			code: "local_docker_unreachable",
			detail: "socket hang up",
		});
		expect(update).not.toHaveBeenCalled();
	});

	it("maps local Docker socket permission failures to a typed service scale error", async () => {
		(
			remoteDocker.getRemoteDocker as ReturnType<typeof vi.fn>
		).mockResolvedValueOnce({
			info: vi.fn().mockResolvedValue(activeSwarmInfo()),
			getService: () => ({
				inspect: vi
					.fn()
					.mockRejectedValue(
						new Error("permission denied while trying to connect to the docker API"),
					),
				update,
			}),
		});

		await expect(
			scaleServiceReplicas("mongo-test-local", 0, null),
		).rejects.toMatchObject({
			code: "local_docker_unreachable",
			detail: "permission denied while trying to connect to the docker API",
		});
		expect(update).not.toHaveBeenCalled();
	});

	it("retries local Dockerode socket hang ups with docker service scale", async () => {
		const preflightInspect = vi.fn().mockResolvedValue({
			Version: { Index: "42" },
			Spec: { Mode: { Replicated: { Replicas: 1 } } },
		});
		const scaleInspect = vi.fn().mockRejectedValue(new Error("socket hang up"));
		(remoteDocker.getRemoteDocker as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce({
				info: vi.fn().mockResolvedValue(activeSwarmInfo()),
				getService: () => ({
					inspect: preflightInspect,
					update,
				}),
			})
			.mockResolvedValueOnce({
				info: vi.fn().mockResolvedValue(activeSwarmInfo()),
				getService: () => ({
					inspect: scaleInspect,
					update,
				}),
			});

		await scaleServiceReplicas("mongo-test-local", 0, null);

		expect(update).not.toHaveBeenCalled();
		expect(processUtils.execAsync).toHaveBeenCalledWith(
			"docker service scale mongo-test-local\\=0",
		);
	});
});

describe("formatServiceScaleError", () => {
	it("includes stderr for ExecError", () => {
		const err = new ExecError("Remote command failed with exit code 127", {
			command: "docker service scale app=1",
			stderr: "docker: command not found",
			exitCode: 127,
			serverId: "srv-1",
		});
		expect(formatServiceScaleError(err, "start")).toContain(
			"Failed to start service",
		);
		expect(formatServiceScaleError(err, "start")).toContain(
			"docker: command not found",
		);
	});

	it("handles generic errors", () => {
		expect(formatServiceScaleError(new Error("no such service"), "stop")).toBe(
			"Failed to stop service. no such service",
		);
	});

	it("renders typed service scale errors without secret material", () => {
		const err = new ServiceScaleError(
			'Nearzero could not authenticate to the server for service "app-test-abc".',
			{
				code: "ssh_auth_failed",
				appName: "app-test-abc",
				serverId: "server-1",
				serverName: "Deploy Server",
				serverHost: "10.0.0.2:22",
				guidance: "Verify the server SSH key.",
				detail: "All configured authentication methods failed",
			},
		);

		const message = formatServiceScaleError(err, "start");
		expect(message).toContain("Code: ssh_auth_failed");
		expect(message).toContain("Deploy Server");
		expect(message).not.toContain("private");
		expect(message).not.toContain("BEGIN");
	});

	it("renders local Docker scale errors as actionable messages", () => {
		const err = new ServiceScaleError(
			'Nearzero could not reach the local Docker engine for service "mongo-test-local".',
			{
				code: "local_docker_unreachable",
				appName: "mongo-test-local",
				serverId: null,
				serverName: "local Docker",
				guidance: "Make sure Docker Desktop is running.",
				detail: "socket hang up",
			},
		);

		const message = formatServiceScaleError(err, "stop");
		expect(message).toContain("Failed to stop service");
		expect(message).toContain("local_docker_unreachable");
		expect(message).toContain("Docker Desktop");
		expect(message).toContain("socket hang up");
	});
});
