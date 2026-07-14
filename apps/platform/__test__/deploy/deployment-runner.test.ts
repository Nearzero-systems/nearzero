import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import {
	assertApplicationDeployCapabilities,
	DeploymentPhaseError,
	runDeploymentPhases,
} from "@nearzero/server/services/deployment-runner";
import * as repairUtils from "@nearzero/server/setup/server-capability-repair";
import * as validateUtils from "@nearzero/server/setup/server-validate";
import * as processUtils from "@nearzero/server/utils/process/execAsync";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@nearzero/server/setup/server-capability-repair", async () => {
	const actual = await vi.importActual<
		typeof import("@nearzero/server/setup/server-capability-repair")
	>("@nearzero/server/setup/server-capability-repair");
	return {
		...actual,
		repairServerCapabilities: vi.fn(),
	};
});

vi.mock("@nearzero/server/setup/server-validate", () => ({
	serverValidate: vi.fn(),
}));

vi.mock("@nearzero/server/utils/process/execAsync", async () => {
	const actual = await vi.importActual<
		typeof import("@nearzero/server/utils/process/execAsync")
	>("@nearzero/server/utils/process/execAsync");
	return {
		...actual,
		execAsync: vi.fn(),
		execAsyncRemote: vi.fn(),
	};
});

const successfulResult = { stdout: "", stderr: "" } as Awaited<
	ReturnType<typeof processUtils.execAsync>
>;

const isRunnerExecution = (command: string) =>
	command.startsWith("bash -Eeuo pipefail ") && command.includes(".runner");

const isCancellationCheck = (command: string) =>
	command.startsWith("test -f ") && command.includes("/cancelled");

const isBuildLogTail = (command: string) =>
	command.startsWith("tail -c 131072 ");

const healthyValidation = {
	docker: { version: "28.5.0", enabled: true },
	rclone: { version: "1.74.2", enabled: true },
	nixpacks: { version: "1.40.0", enabled: true },
	buildpacks: { version: "0.38.2", enabled: true },
	railpack: { version: "0.15.0", enabled: true },
	isNearzeroNetworkInstalled: true,
	isSwarmInstalled: true,
	isSwarmManager: true,
	isMainDirectoryInstalled: true,
	privilegeMode: "sudo",
	dockerGroupMember: true,
};

describe("runDeploymentPhases", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(repairUtils.repairServerCapabilities).mockResolvedValue({
			attempted: [],
		});
		vi.mocked(validateUtils.serverValidate).mockResolvedValue(
			healthyValidation,
		);
		vi.mocked(processUtils.execAsync).mockImplementation(async (command) => {
			if (isCancellationCheck(command)) {
				throw new Error("not cancelled");
			}
			return successfulResult;
		});
		vi.mocked(processUtils.execAsyncRemote).mockResolvedValue(successfulResult);
	});

	it("validates generated phase scripts before executing them", async () => {
		await runDeploymentPhases({
			deploymentId: "deployment-syntax-check",
			logPath: "/tmp/deployment-syntax-check.log",
			executionMode: "community",
			executionLocation: "local",
			phases: [
				{
					id: "build",
					label: "Build application",
					script: "printf '%s\\n' ready",
					errorCode: "app_build_failed",
				},
			],
		});

		const commands = vi
			.mocked(processUtils.execAsync)
			.mock.calls.map(([command]) => command);
		const syntaxCheckIndex = commands.findIndex(
			(command) =>
				command.startsWith("bash -n ") &&
				command.includes("01-build.sh") &&
				!command.includes(".runner"),
		);
		const executionIndex = commands.findIndex(isRunnerExecution);

		expect(syntaxCheckIndex).toBeGreaterThan(-1);
		expect(executionIndex).toBeGreaterThan(syntaxCheckIndex);
	});

	it("delivers sensitive phase input only to the active runner", async () => {
		const secret = "phase-input-secret-never-in-command-metadata";
		await runDeploymentPhases({
			deploymentId: "deployment-sensitive-input",
			logPath: "/tmp/deployment-sensitive-input.log",
			executionMode: "community",
			executionLocation: "local",
			phases: [
				{
					id: "source",
					label: "Fetch private source",
					script: 'cat > "$HOME/.temporary-deploy-key"',
					input: secret,
					errorCode: "source_fetch_failed",
				},
			],
		});

		const calls = vi.mocked(processUtils.execAsync).mock.calls;
		expect(calls.every(([command]) => !command.includes(secret))).toBe(true);
		const runnerExecution = calls.find(([command]) =>
			isRunnerExecution(command),
		);
		expect(runnerExecution?.[1]?.input).toBe(
			`I|${Buffer.from(secret, "utf8").toString("base64")}|\n`,
		);
		expect(runnerExecution?.[1]?.input).not.toContain(secret);
		const runnerProvision = calls.find(
			([command]) =>
				command.includes("envelope_file=") &&
				command.includes(".runner.envelope"),
		);
		expect(runnerProvision?.[0]).toContain('chmod 600 "$envelope_file"');
		expect(runnerProvision?.[0]).toContain('chmod 600 "$input_file"');
		expect(runnerProvision?.[0]).toContain(
			'rm -f "$pid_file" "$envelope_file" "$input_file"',
		);
	});

	it("redacts raw and encoded protected values before durable log append", async () => {
		const deploymentId = "deployment-output-redaction";
		const logPath = "/tmp/deployment-output-redaction.log";
		const secret = "phase-output-canary-'-$-3a17d94f";
		const encodedSecret = Buffer.from(secret, "utf8").toString("base64");
		const workDir = `/tmp/nearzero-deployments/${deploymentId}`;
		rmSync(logPath, { force: true });
		rmSync(workDir, { recursive: true, force: true });

		try {
			await runDeploymentPhases({
				deploymentId,
				logPath,
				executionMode: "community",
				executionLocation: "local",
				phases: [
					{
						id: "redact",
						label: "Redact build output",
						script: [
							"payload=$(cat)",
							"printf '%s\\n' \"$payload\"",
							"printf '%s' \"$payload\" | base64",
						].join("\n"),
						input: secret,
						sensitiveValues: [secret],
						errorCode: "app_build_failed",
					},
				],
			});

			const calls = vi.mocked(processUtils.execAsync).mock.calls;
			const phaseProvision = calls.find(
				([command]) =>
					command.includes("01-redact.sh") &&
					command.includes("NZ_HEREDOC_") &&
					!command.includes(".runner"),
			);
			const runnerProvision = calls.find(
				([command]) =>
					command.includes("01-redact.sh.runner") &&
					command.includes("NZ_HEREDOC_"),
			);
			const runnerExecution = calls.find(([command]) =>
				isRunnerExecution(command),
			);
			expect(phaseProvision).toBeDefined();
			expect(runnerProvision).toBeDefined();
			expect(runnerExecution).toBeDefined();

			execFileSync("bash", ["-Eeuo", "pipefail", "-c", phaseProvision![0]]);
			execFileSync("bash", ["-Eeuo", "pipefail", "-c", runnerProvision![0]]);
			execFileSync("bash", ["-Eeuo", "pipefail", "-c", runnerExecution![0]], {
				input: runnerExecution![1]?.input,
			});

			const durableLog = readFileSync(logPath, "utf8");
			expect(durableLog).toContain("[REDACTED]");
			expect(durableLog).not.toContain(secret);
			expect(durableLog).not.toContain(encodedSecret);
			expect(
				calls.every(([command]) =>
					[secret, encodedSecret].every((value) => !command.includes(value)),
				),
			).toBe(true);
		} finally {
			rmSync(logPath, { force: true });
			rmSync(workDir, { recursive: true, force: true });
		}
	});

	it("returns build_script_invalid without executing an invalid phase", async () => {
		vi.mocked(processUtils.execAsync).mockImplementation(async (command) => {
			if (
				command.startsWith("bash -n ") &&
				command.includes("01-invalid.sh") &&
				!command.includes(".runner")
			) {
				throw new Error("syntax error near unexpected token");
			}
			return successfulResult;
		});

		await expect(
			runDeploymentPhases({
				deploymentId: "deployment-invalid-script",
				logPath: "/tmp/deployment-invalid-script.log",
				executionMode: "community",
				executionLocation: "local",
				phases: [
					{
						id: "invalid",
						label: "Generate build",
						script: "broken=(",
						errorCode: "app_build_failed",
					},
				],
			}),
		).rejects.toMatchObject({
			code: "build_script_invalid",
			phaseId: "invalid",
		});

		expect(
			vi
				.mocked(processUtils.execAsync)
				.mock.calls.some(([command]) => isRunnerExecution(command)),
		).toBe(false);
	});

	it("retries transient phase failures and then succeeds", async () => {
		let executions = 0;
		vi.mocked(processUtils.execAsync).mockImplementation(async (command) => {
			if (isCancellationCheck(command)) {
				throw new Error("not cancelled");
			}
			if (isRunnerExecution(command)) {
				executions += 1;
				if (executions === 1) {
					throw new Error("socket hang up");
				}
			}
			return successfulResult;
		});

		await runDeploymentPhases({
			deploymentId: "deployment-transient-retry",
			logPath: "/tmp/deployment-transient-retry.log",
			executionMode: "community",
			executionLocation: "local",
			phases: [
				{
					id: "source",
					label: "Fetch source",
					script: "git clone https://example.com/repository.git",
					errorCode: "source_fetch_failed",
					retryPolicy: "transient",
				},
			],
		});

		expect(executions).toBe(2);
	});

	it("does not retry application failures without a retry policy", async () => {
		let executions = 0;
		vi.mocked(processUtils.execAsync).mockImplementation(async (command) => {
			if (isCancellationCheck(command)) {
				throw new Error("not cancelled");
			}
			if (isRunnerExecution(command)) {
				executions += 1;
				throw new Error("socket hang up during application compilation");
			}
			return successfulResult;
		});

		await expect(
			runDeploymentPhases({
				deploymentId: "deployment-app-failure",
				logPath: "/tmp/deployment-app-failure.log",
				executionMode: "community",
				executionLocation: "local",
				phases: [
					{
						id: "build",
						label: "Compile application",
						script: "npm run build",
						errorCode: "app_build_failed",
					},
				],
			}),
		).rejects.toBeInstanceOf(DeploymentPhaseError);

		expect(executions).toBe(1);
	});

	it("classifies npm peer conflicts from the bounded deployment log tail", async () => {
		vi.mocked(processUtils.execAsync).mockImplementation(async (command) => {
			if (isCancellationCheck(command)) {
				throw new Error("not cancelled");
			}
			if (isRunnerExecution(command)) {
				throw new processUtils.ExecError("Command execution failed", {
					command,
					exitCode: 1,
				});
			}
			if (isBuildLogTail(command)) {
				return {
					stdout: [
						"#8 3.659 npm error code ERESOLVE",
						"#8 3.659 npm error ERESOLVE could not resolve",
						"#8 3.659 npm error While resolving: next-auth@4.24.11",
						"#8 3.659 npm error Found: next@16.1.7",
						"#8 3.659 npm error Could not resolve dependency:",
						'#8 3.659 npm error peer next@"^12.2.5 || ^13 || ^14 || ^15" from next-auth@4.24.11',
					].join("\n"),
					stderr: "",
				} as Awaited<ReturnType<typeof processUtils.execAsync>>;
			}
			return successfulResult;
		});

		await expect(
			runDeploymentPhases({
				deploymentId: "deployment-npm-peer-conflict",
				logPath: "/tmp/deployment-npm-peer-conflict.log",
				executionMode: "community",
				executionLocation: "local",
				phases: [
					{
						id: "build",
						label: "Build image with dockerfile",
						script: "docker build .",
						errorCode: "app_build_failed",
					},
				],
			}),
		).rejects.toMatchObject({
			code: "app_build_failed",
			diagnostic: {
				code: "npm_eresolve_peer_dependency_conflict",
				packageManager: "npm",
				resolving: "next-auth@4.24.11",
				found: "next@16.1.7",
				requiredBy: "next-auth@4.24.11",
			},
		});

		expect(
			vi
				.mocked(processUtils.execAsync)
				.mock.calls.some(([command]) => isBuildLogTail(command)),
		).toBe(true);
	});

	it("does not mislabel a generic npm ERESOLVE as a peer conflict", async () => {
		vi.mocked(processUtils.execAsync).mockImplementation(async (command) => {
			if (isCancellationCheck(command)) {
				throw new Error("not cancelled");
			}
			if (isRunnerExecution(command)) {
				throw new processUtils.ExecError("Command execution failed", {
					command,
					exitCode: 1,
				});
			}
			if (isBuildLogTail(command)) {
				return {
					stdout:
						"npm error code ERESOLVE\nnpm error ERESOLVE unable to resolve dependency tree\nnpm error Could not resolve dependency:\n",
					stderr: "",
				} as Awaited<ReturnType<typeof processUtils.execAsync>>;
			}
			return successfulResult;
		});

		const failure = await runDeploymentPhases({
			deploymentId: "deployment-generic-eresolve",
			logPath: "/tmp/deployment-generic-eresolve.log",
			executionMode: "community",
			executionLocation: "local",
			phases: [
				{
					id: "build",
					label: "Build application",
					script: "npm run build",
					errorCode: "app_build_failed",
				},
			],
		}).catch((error: unknown) => error);

		expect(failure).toMatchObject({ code: "app_build_failed" });
		expect((failure as DeploymentPhaseError).diagnostic).toBeUndefined();
	});

	it("does not inspect a build log for a failed non-build phase", async () => {
		vi.mocked(processUtils.execAsync).mockImplementation(async (command) => {
			if (isCancellationCheck(command)) {
				throw new Error("not cancelled");
			}
			if (isRunnerExecution(command)) {
				throw new processUtils.ExecError("Command execution failed", {
					command,
					exitCode: 1,
				});
			}
			if (isBuildLogTail(command)) {
				throw new Error("a patch failure must not inspect the build log");
			}
			return successfulResult;
		});

		const failure = await runDeploymentPhases({
			deploymentId: "deployment-patch-failure",
			logPath: "/tmp/deployment-patch-failure.log",
			executionMode: "community",
			executionLocation: "local",
			phases: [
				{
					id: "patches",
					label: "Apply patches",
					script: "false",
					errorCode: "app_build_failed",
				},
			],
		}).catch((error: unknown) => error);

		expect(failure).toMatchObject({ code: "app_build_failed" });
		expect((failure as DeploymentPhaseError).diagnostic).toBeUndefined();
		expect(
			vi
				.mocked(processUtils.execAsync)
				.mock.calls.some(([command]) => isBuildLogTail(command)),
		).toBe(false);
	});

	it("reports phase timeouts without misclassifying them as app failures", async () => {
		vi.mocked(processUtils.execAsync).mockImplementation(async (command) => {
			if (isCancellationCheck(command)) {
				throw new Error("not cancelled");
			}
			if (isRunnerExecution(command)) {
				throw new processUtils.ExecError("Command execution failed", {
					command,
					exitCode: 124,
				});
			}
			return successfulResult;
		});

		await expect(
			runDeploymentPhases({
				deploymentId: "deployment-timeout",
				logPath: "/tmp/deployment-timeout.log",
				executionMode: "community",
				executionLocation: "local",
				phases: [
					{
						id: "build",
						label: "Compile application",
						script: "npm run build",
						errorCode: "app_build_failed",
						timeoutSeconds: 60,
					},
				],
			}),
		).rejects.toMatchObject({
			code: "phase_timeout",
			phaseId: "build",
		});
		expect(
			vi
				.mocked(processUtils.execAsync)
				.mock.calls.some(([command]) => isBuildLogTail(command)),
		).toBe(false);
	});

	it("repairs safe remote capabilities once and revalidates before deploy", async () => {
		vi.mocked(validateUtils.serverValidate)
			.mockResolvedValueOnce({
				...healthyValidation,
				isNearzeroNetworkInstalled: false,
				isSwarmInstalled: false,
				isSwarmManager: false,
				isMainDirectoryInstalled: false,
				dockerGroupMember: false,
			})
			.mockResolvedValueOnce(healthyValidation);

		await assertApplicationDeployCapabilities({
			deploymentId: "deployment-safe-repair",
			logPath: "/tmp/deployment-safe-repair.log",
			buildServerId: "server-1",
			deployServerId: "server-1",
			executionMode: "cloud",
		});

		expect(repairUtils.repairServerCapabilities).toHaveBeenCalledOnce();
		expect(repairUtils.repairServerCapabilities).toHaveBeenCalledWith({
			serverId: "server-1",
			capabilities: expect.arrayContaining([
				"docker-group",
				"main-directory",
				"nearzero-network",
				"swarm",
				"swarm-manager",
			]),
		});
		expect(validateUtils.serverValidate).toHaveBeenCalledTimes(2);
	});

	it("repairs a missing selected builder once without switching builders", async () => {
		vi.mocked(validateUtils.serverValidate).mockResolvedValue({
			...healthyValidation,
			railpack: { version: "0.0.0", enabled: false },
		});

		await expect(
			runDeploymentPhases({
				deploymentId: "deployment-missing-builder",
				logPath: "/tmp/deployment-missing-builder.log",
				serverId: "server-1",
				logServerId: "server-1",
				executionMode: "cloud",
				executionLocation: "remote",
				phases: [
					{
						id: "build",
						label: "Build with Railpack",
						script: "railpack build",
						errorCode: "app_build_failed",
						requiredCapabilities: ["railpack"],
					},
				],
			}),
		).rejects.toMatchObject({
			code: "builder_missing",
			phaseId: "server-preflight",
		});

		expect(repairUtils.repairServerCapabilities).toHaveBeenCalledOnce();
		expect(repairUtils.repairServerCapabilities).toHaveBeenCalledWith({
			serverId: "server-1",
			capabilities: ["railpack"],
		});
		expect(validateUtils.serverValidate).toHaveBeenCalledTimes(2);
	});

	it("executes Cloud deployment phases only on the selected remote server", async () => {
		await runDeploymentPhases({
			deploymentId: "deployment-cloud-remote",
			logPath: "/tmp/deployment-cloud-remote.log",
			serverId: "server-1",
			logServerId: "server-1",
			executionMode: "cloud",
			executionLocation: "remote",
			phases: [
				{
					id: "source",
					label: "Fetch source",
					script: "git status",
					errorCode: "source_fetch_failed",
					requiredCapabilities: ["git"],
				},
			],
		});

		expect(processUtils.execAsync).not.toHaveBeenCalled();
		expect(processUtils.execAsyncRemote).toHaveBeenCalled();
		expect(
			vi
				.mocked(processUtils.execAsyncRemote)
				.mock.calls.every(([serverId]) => serverId === "server-1"),
		).toBe(true);
	});

	it("rejects mismatched Cloud build and deploy servers before preflight", async () => {
		await expect(
			assertApplicationDeployCapabilities({
				deploymentId: "deployment-invalid-cloud-placement",
				logPath: "/tmp/deployment-invalid-cloud-placement.log",
				buildServerId: "server-build",
				deployServerId: "server-deploy",
				executionMode: "cloud",
			}),
		).rejects.toMatchObject({
			code: "server_not_ready",
			phaseId: "placement",
		});

		expect(validateUtils.serverValidate).not.toHaveBeenCalled();
		expect(processUtils.execAsync).not.toHaveBeenCalled();
		expect(processUtils.execAsyncRemote).not.toHaveBeenCalled();
	});
});
