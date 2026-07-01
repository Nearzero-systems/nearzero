import path from "node:path";
import {
	ExecError,
	execAsync,
	execAsyncRemote,
} from "@nearzero/server/utils/process/execAsync";
import { nanoid } from "nanoid";
import { quote } from "shell-quote";
import {
	getRepairableServerCapabilities,
	repairServerCapabilities,
} from "../setup/server-capability-repair";
import { serverValidate } from "../setup/server-validate";
import { sanitizeOperationalLogLine } from "./operational-log";

export type DeploymentPhaseErrorCode =
	| "server_not_ready"
	| "docker_missing"
	| "docker_daemon_unreachable"
	| "swarm_not_ready"
	| "builder_missing"
	| "builder_repair_failed"
	| "unsupported_architecture"
	| "insufficient_disk"
	| "registry_access_failed"
	| "phase_timeout"
	| "deployment_cancelled"
	| "detection_failed"
	| "build_plan_failed"
	| "source_fetch_failed"
	| "build_path_missing"
	| "build_script_invalid"
	| "app_build_failed"
	| "image_build_failed"
	| "service_deploy_failed"
	| "managed_dns_not_ready"
	| "deploy_health_failed";

export interface BuildPhase {
	id: string;
	label: string;
	script: string;
	errorCode?: DeploymentPhaseErrorCode;
	retryPolicy?: "none" | "transient";
	requiredCapabilities?: string[];
	timeoutSeconds?: number;
}

export interface DeploymentPhaseContext {
	deploymentId: string;
	logPath: string;
	serverId?: string | null;
	logServerId?: string | null;
	executionMode: "cloud" | "community";
	executionLocation: "local" | "remote";
	capabilityScope?: "build" | "deploy";
	phases: BuildPhase[];
}

export class DeploymentPhaseError extends Error {
	public readonly code: DeploymentPhaseErrorCode;
	public readonly phaseId: string;
	public readonly phaseLabel: string;
	public readonly cause?: unknown;

	constructor(input: {
		code: DeploymentPhaseErrorCode;
		phaseId: string;
		phaseLabel: string;
		message?: string;
		cause?: unknown;
	}) {
		super(
			input.message ??
				`Deployment phase "${input.phaseLabel}" failed with ${input.code}.`,
		);
		this.name = "DeploymentPhaseError";
		this.code = input.code;
		this.phaseId = input.phaseId;
		this.phaseLabel = input.phaseLabel;
		this.cause = input.cause;
	}

	toUserMessage() {
		return `${this.message} (${this.code})`;
	}
}

function safePhaseFileName(phase: BuildPhase, index: number) {
	const safeId = phase.id.replace(/[^a-zA-Z0-9_.-]/g, "-") || "phase";
	return `${String(index + 1).padStart(2, "0")}-${safeId}.sh`;
}

function normalizeScript(script: string) {
	return script.replace(/\r\n/g, "\n").trim();
}

function assertExecutionPlacementContext(context: DeploymentPhaseContext) {
	if (context.executionMode === "cloud") {
		if (context.executionLocation !== "remote" || !context.serverId) {
			throw new DeploymentPhaseError({
				code: "server_not_ready",
				phaseId: "placement",
				phaseLabel: "Resolve execution placement",
				message:
					"Nearzero Cloud deployments must execute on the selected remote application server.",
			});
		}
	}

	if (context.executionLocation === "remote" && !context.serverId) {
		throw new DeploymentPhaseError({
			code: "server_not_ready",
			phaseId: "placement",
			phaseLabel: "Resolve execution placement",
			message: "Remote execution requires a selected server.",
		});
	}

	if (context.executionLocation === "local" && context.serverId) {
		throw new DeploymentPhaseError({
			code: "server_not_ready",
			phaseId: "placement",
			phaseLabel: "Resolve execution placement",
			message: "Local execution cannot target a remote server.",
		});
	}
}

async function execOnTarget(
	serverId: string | null | undefined,
	command: string,
) {
	return serverId ? execAsyncRemote(serverId, command) : execAsync(command);
}

function heredocCommand(input: {
	filePath: string;
	content: string;
	mode?: string;
	append?: boolean;
}) {
	const delimiter = `NZ_HEREDOC_${nanoid(12).replace(/-/g, "_")}`;
	const quotedPath = quote([input.filePath]);
	const dirPath = quote([path.posix.dirname(input.filePath)]);
	const chmod = input.mode ? `chmod ${input.mode} ${quotedPath}` : "";
	const redirect = input.append ? ">>" : ">";
	return [
		`mkdir -p ${dirPath}`,
		`cat ${redirect} ${quotedPath} <<'${delimiter}'`,
		input.content,
		delimiter,
		chmod,
	]
		.filter(Boolean)
		.join("\n");
}

export async function appendDeploymentLog(input: {
	logPath: string;
	serverId?: string | null;
	message: string;
}) {
	const content = sanitizeOperationalLogLine(input.message);
	await execOnTarget(
		input.serverId,
		heredocCommand({
			filePath: input.logPath,
			content,
			append: true,
		}),
	);
}

function normalizeCapability(capability: string) {
	switch (capability) {
		case "heroku_buildpacks":
		case "paketo_buildpacks":
			return "buildpacks";
		case "dockerfile":
		case "static":
			return "docker";
		default:
			return capability;
	}
}

export function getRequiredDeploymentCapabilities(
	scope: "build" | "deploy",
	phases: BuildPhase[],
) {
	const capabilities = new Set<string>(
		scope === "deploy"
			? ["docker", "swarm", "swarm-manager", "network", "mainDirectory"]
			: ["docker", "buildx", "disk", "architecture"],
	);
	for (const phase of phases) {
		for (const capability of phase.requiredCapabilities ?? []) {
			const normalized = normalizeCapability(capability);
			if (normalized === "builder") continue;
			capabilities.add(normalized);
		}
	}
	return [...capabilities];
}

function getLogServerId(context: DeploymentPhaseContext) {
	return context.logServerId === undefined
		? context.serverId
		: context.logServerId;
}

async function assertCommandCapability(input: {
	context: DeploymentPhaseContext;
	capability: string;
	command: string;
	code: DeploymentPhaseErrorCode;
	message: string;
}) {
	try {
		await execOnTarget(input.context.serverId, input.command);
	} catch (cause) {
		throw new DeploymentPhaseError({
			code: input.code,
			phaseId: "server-preflight",
			phaseLabel: "Server capability preflight",
			message: input.message,
			cause,
		});
	}
}

async function assertPortableCapabilities(
	context: DeploymentPhaseContext,
	capabilities: string[],
) {
	if (capabilities.includes("git")) {
		await assertCommandCapability({
			context,
			capability: "git",
			command: "command -v git >/dev/null 2>&1",
			code: "server_not_ready",
			message: "Git is not installed on the build server.",
		});
	}

	if (capabilities.includes("buildx")) {
		await assertCommandCapability({
			context,
			capability: "buildx",
			command: "docker buildx version >/dev/null 2>&1",
			code: "docker_missing",
			message: "Docker Buildx is not available on the build server.",
		});
	}

	if (capabilities.includes("swarm-manager")) {
		await assertCommandCapability({
			context,
			capability: "swarm-manager",
			command:
				"test \"$(docker info --format '{{.Swarm.ControlAvailable}}' 2>/dev/null)\" = \"true\"",
			code: "swarm_not_ready",
			message: "The selected server is not a Docker Swarm manager.",
		});
	}

	if (capabilities.includes("architecture")) {
		await assertCommandCapability({
			context,
			capability: "architecture",
			command:
				"case \"$(uname -m)\" in x86_64|amd64|aarch64|arm64) exit 0 ;; *) exit 1 ;; esac",
			code: "unsupported_architecture",
			message: "The build server architecture is not supported.",
		});
	}

	if (capabilities.includes("disk")) {
		await assertCommandCapability({
			context,
			capability: "disk",
			command:
				"available_kb=$(df -Pk /tmp | awk 'NR==2 {print $4}'); test \"${available_kb:-0}\" -ge 2097152",
			code: "insufficient_disk",
			message:
				"The build server needs at least 2 GB of free disk space in /tmp.",
		});
	}
}

async function assertRemoteCapabilities(context: DeploymentPhaseContext) {
	if (!context.serverId) return;

	const capabilities = getRequiredDeploymentCapabilities(
		context.capabilityScope ?? "build",
		context.phases,
	);
	try {
		let validation = await serverValidate(context.serverId);
		let failures = collectRemoteCapabilityFailures(validation, capabilities);

		const repairable = getRepairableServerCapabilities(
			failures.map((failure) => failure.capability),
		);
		if (repairable.length > 0) {
			await appendDeploymentLog({
				logPath: context.logPath,
				serverId: getLogServerId(context),
				message: `Server capability repair started: ${repairable.join(", ")}.\n`,
			});
			let repairFailed = false;
			try {
				await repairServerCapabilities({
					serverId: context.serverId,
					capabilities: repairable,
				});
			} catch {
				repairFailed = true;
			}

			validation = await serverValidate(context.serverId);
			failures = collectRemoteCapabilityFailures(validation, capabilities);
			await appendDeploymentLog({
				logPath: context.logPath,
				serverId: getLogServerId(context),
				message:
					failures.length === 0
						? "Server capability repair completed and validation passed.\n"
						: `Server capability repair ${repairFailed ? "failed" : "did not satisfy validation"}; setup is required.\n`,
			}).catch(() => undefined);
		}

		if (failures.length === 0) {
			await assertPortableCapabilities(context, capabilities);
			await appendDeploymentLog({
				logPath: context.logPath,
				serverId: getLogServerId(context),
				message: `Server capability preflight passed: ${capabilities.join(", ")}.\n`,
			});
			return;
		}

		const first = failures[0]!;
		await appendDeploymentLog({
			logPath: context.logPath,
			serverId: getLogServerId(context),
			message: [
				"Server capability preflight failed.",
				`Code: ${first.code}`,
				...failures.map((failure) => `- ${failure.message}`),
				"Next step: run server setup/validate, then retry the deployment.",
				"",
			].join("\n"),
		}).catch(() => undefined);
		throw new DeploymentPhaseError({
			code: first.code,
			phaseId: "server-preflight",
			phaseLabel: "Server capability preflight",
			message: first.message,
		});
	} catch (error) {
		if (error instanceof DeploymentPhaseError) throw error;
		const message = error instanceof Error ? error.message : String(error);
		await appendDeploymentLog({
			logPath: context.logPath,
			serverId: getLogServerId(context),
			message: [
				"Server capability preflight failed.",
				"Code: server_not_ready",
				message,
				"Next step: open the server setup logs, validate SSH access, and rerun setup if needed.",
				"",
			].join("\n"),
		}).catch(() => undefined);
		throw new DeploymentPhaseError({
			code: "server_not_ready",
			phaseId: "server-preflight",
			phaseLabel: "Server capability preflight",
			message: "The selected server is not ready for deployment.",
			cause: error,
		});
	}
}

type RemoteCapabilityFailure = {
	code: DeploymentPhaseErrorCode;
	capability: string;
	message: string;
};

function collectRemoteCapabilityFailures(
	validation: Awaited<ReturnType<typeof serverValidate>>,
	capabilities: string[],
) {
	const failures: RemoteCapabilityFailure[] = [];

	if (capabilities.includes("docker")) {
		if (validation.docker.version === "0.0.0") {
			failures.push({
				code: "docker_missing",
				capability: "docker",
				message: "Docker CLI is not installed on the selected server.",
			});
		} else if (!validation.docker.enabled) {
			failures.push({
				code: "docker_daemon_unreachable",
				capability: "docker-daemon",
				message: "Docker daemon is not reachable on the selected server.",
			});
		}

		if (
			validation.privilegeMode !== "root" &&
			!validation.dockerGroupMember
		) {
			failures.push({
				code: "server_not_ready",
				capability: "docker-group",
				message:
					"The SSH user cannot run Docker directly. Docker group membership is required for deployment phases.",
			});
		}
	}

	if (capabilities.includes("swarm") && !validation.isSwarmInstalled) {
		failures.push({
			code: "swarm_not_ready",
			capability: "swarm",
			message: "Docker Swarm is not active on the selected server.",
		});
	}

	if (capabilities.includes("swarm-manager") && !validation.isSwarmManager) {
		failures.push({
			code: "swarm_not_ready",
			capability: "swarm-manager",
			message: "The selected server is not a Docker Swarm manager.",
		});
	}

	if (
		capabilities.includes("network") &&
		!validation.isNearzeroNetworkInstalled
	) {
		failures.push({
			code: "server_not_ready",
			capability: "nearzero-network",
			message: "Nearzero Docker network is missing on the selected server.",
		});
	}

	if (
		capabilities.includes("mainDirectory") &&
		!validation.isMainDirectoryInstalled
	) {
		failures.push({
			code: "server_not_ready",
			capability: "main-directory",
			message: "/etc/nearzero is missing on the selected server.",
		});
	}

	for (const capability of ["nixpacks", "railpack", "buildpacks"] as const) {
		if (capabilities.includes(capability) && !validation[capability].enabled) {
			failures.push({
				code: "builder_missing",
				capability,
				message: `${capability} is not installed on the selected server.`,
			});
		}
	}

	return failures;
}

async function assertLocalCapabilities(context: DeploymentPhaseContext) {
	if (context.serverId || context.executionLocation !== "local") return;

	const capabilities = getRequiredDeploymentCapabilities(
		context.capabilityScope ?? "build",
		context.phases,
	);
	const checks: Array<{
		capability: string;
		command: string;
		code: DeploymentPhaseErrorCode;
		message: string;
	}> = [];

	if (capabilities.includes("docker")) {
		checks.push(
			{
				capability: "docker",
				command: "command -v docker >/dev/null 2>&1",
				code: "docker_missing",
				message: "Docker CLI is not installed on the Nearzero host.",
			},
			{
				capability: "docker-daemon",
				command: "docker info >/dev/null 2>&1",
				code: "docker_daemon_unreachable",
				message: "Docker daemon is not reachable on the Nearzero host.",
			},
		);
	}

	if (capabilities.includes("swarm")) {
		checks.push({
			capability: "swarm",
			command:
				"test \"$(docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null)\" = \"active\"",
			code: "swarm_not_ready",
			message: "Docker Swarm is not active on the Nearzero host.",
		});
	}

	if (capabilities.includes("network")) {
		checks.push({
			capability: "network",
			command: "docker network inspect nearzero-network >/dev/null 2>&1",
			code: "server_not_ready",
			message: "The Nearzero Docker network is missing on the Nearzero host.",
		});
	}

	for (const capability of ["nixpacks", "railpack", "buildpacks"] as const) {
		if (!capabilities.includes(capability)) continue;
		checks.push({
			capability,
			command: `command -v ${capability === "buildpacks" ? "pack" : capability} >/dev/null 2>&1`,
			code: "builder_missing",
			message: `${capability} is not installed on the Nearzero host.`,
		});
	}

	try {
		for (const check of checks) {
			await assertCommandCapability({ context, ...check });
		}
		await assertPortableCapabilities(context, capabilities);
		await appendDeploymentLog({
			logPath: context.logPath,
			serverId: getLogServerId(context),
			message: `Local capability preflight passed: ${capabilities.join(", ")}.\n`,
		});
	} catch (error) {
		if (error instanceof DeploymentPhaseError) throw error;
		throw new DeploymentPhaseError({
			code: "server_not_ready",
			phaseId: "server-preflight",
			phaseLabel: "Server capability preflight",
			message: "The local Nearzero runtime is not ready for deployment.",
			cause: error,
		});
	}
}

function getFailureText(cause: unknown) {
	if (cause instanceof ExecError) {
		return [cause.message, cause.stderr, cause.stdout]
			.filter(Boolean)
			.join("\n");
	}
	return cause instanceof Error ? cause.message : String(cause);
}

function isTransientFailure(cause: unknown) {
	const text = getFailureText(cause).toLowerCase();
	return [
		"econnreset",
		"etimedout",
		"socket hang up",
		"connection reset",
		"connection closed",
		"connection timed out",
		"network is unreachable",
		"temporary failure",
		"tls handshake timeout",
		"i/o timeout",
		"unexpected eof",
		"too many requests",
		"status code 429",
		"status code 500",
		"status code 502",
		"status code 503",
		"status code 504",
		"ssh connection error",
	].some((pattern) => text.includes(pattern));
}

function isPhaseTimeout(cause: unknown) {
	if (cause instanceof ExecError && cause.exitCode === 124) {
		return true;
	}
	const text = getFailureText(cause).toLowerCase();
	return (
		text.includes("timed out") ||
		text.includes("timeout exceeded") ||
		text.includes("terminated after timeout")
	);
}

function getPhaseAttemptCount(phase: BuildPhase) {
	return phase.retryPolicy === "transient" ? 3 : 1;
}

function getPhaseExecutionCommand(phase: BuildPhase, scriptPath: string) {
	const command = `bash -Eeuo pipefail ${quote([scriptPath])}`;
	if (!phase.timeoutSeconds) return command;
	return [
		"if command -v timeout >/dev/null 2>&1; then",
		`  timeout --signal=TERM ${Math.max(1, Math.floor(phase.timeoutSeconds))}s ${command}`,
		"else",
		`  ${command}`,
		"fi",
	].join("\n");
}

export function getDeploymentWorkDir(deploymentId: string) {
	return path.posix.join(
		"/tmp/nearzero-deployments",
		deploymentId.replace(/[^a-zA-Z0-9_.-]/g, "-"),
	);
}

function getDeploymentProcessFilePath(deploymentId: string) {
	return path.posix.join(getDeploymentWorkDir(deploymentId), "active.pid");
}

function getDeploymentCancellationFilePath(deploymentId: string) {
	return path.posix.join(getDeploymentWorkDir(deploymentId), "cancelled");
}

function getPhaseRunnerScript(input: {
	deploymentId: string;
	executionCommand: string;
	logPath: string;
}) {
	const pidPath = quote([getDeploymentProcessFilePath(input.deploymentId)]);
	const cancellationPath = quote([
		getDeploymentCancellationFilePath(input.deploymentId),
	]);
	const logPath = quote([input.logPath]);
	const childCommand = `bash -c ${quote([input.executionCommand])}`;

	return [
		"#!/usr/bin/env bash",
		"set -Eeuo pipefail",
		`pid_file=${pidPath}`,
		`cancel_file=${cancellationPath}`,
		"if test -f \"$cancel_file\"; then exit 130; fi",
		"cleanup() { rm -f \"$pid_file\"; }",
		"trap cleanup EXIT",
		"if command -v setsid >/dev/null 2>&1; then",
		`  setsid ${childCommand} >> ${logPath} 2>&1 &`,
		"  child_pid=$!",
		"  printf -- '-%s\\n' \"$child_pid\" > \"$pid_file\"",
		"else",
		`  ${childCommand} >> ${logPath} 2>&1 &`,
		"  child_pid=$!",
		"  printf '%s\\n' \"$child_pid\" > \"$pid_file\"",
		"fi",
		"set +e",
		"wait \"$child_pid\"",
		"status=$?",
		"set -e",
		"if test -f \"$cancel_file\"; then",
		"  exit 130",
		"fi",
		"exit \"$status\"",
	].join("\n");
}

async function wasDeploymentCancelled(
	deploymentId: string,
	serverId?: string | null,
) {
	try {
		await execOnTarget(
			serverId,
			`test -f ${quote([getDeploymentCancellationFilePath(deploymentId)])}`,
		);
		return true;
	} catch {
		return false;
	}
}

export async function cancelDeploymentProcess(input: {
	deploymentId: string;
	serverId?: string | null;
}) {
	const workDir = getDeploymentWorkDir(input.deploymentId);
	const pidPath = getDeploymentProcessFilePath(input.deploymentId);
	const cancellationPath = getDeploymentCancellationFilePath(input.deploymentId);
	const command = [
		`mkdir -p ${quote([workDir])}`,
		`touch ${quote([cancellationPath])}`,
		`if test -s ${quote([pidPath])}; then`,
		`  target="$(cat ${quote([pidPath])})"`,
		'  kill -TERM -- "$target" 2>/dev/null || true',
		"  for _ in 1 2 3 4 5; do",
		'    kill -0 -- "$target" 2>/dev/null || break',
		"    sleep 1",
		"  done",
		'  kill -KILL -- "$target" 2>/dev/null || true',
		`  rm -f ${quote([pidPath])}`,
		"fi",
	].join("\n");

	await execOnTarget(input.serverId, command);
}

const sleep = (milliseconds: number) =>
	new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function runDeploymentPhases(context: DeploymentPhaseContext) {
	assertExecutionPlacementContext(context);

	const workDir = getDeploymentWorkDir(context.deploymentId);

	try {
		await assertRemoteCapabilities(context);
		await assertLocalCapabilities(context);

		for (const [index, phase] of context.phases.entries()) {
			const script = normalizeScript(phase.script);
			const scriptPath = path.posix.join(
				workDir,
				safePhaseFileName(phase, index),
			);
			const runnerPath = path.posix.join(
				workDir,
				`${safePhaseFileName(phase, index)}.runner`,
			);
			const logPrefix = [
				"",
				`--- ${phase.label} ---`,
				phase.requiredCapabilities?.length
					? `Required capabilities: ${phase.requiredCapabilities.join(", ")}`
					: null,
			]
				.filter(Boolean)
				.join("\n");

			await appendDeploymentLog({
				logPath: context.logPath,
				serverId: getLogServerId(context),
				message: `${logPrefix}\n`,
			});

			await execOnTarget(
				context.serverId,
				heredocCommand({ filePath: scriptPath, content: script, mode: "700" }),
			);

			try {
				await execOnTarget(
					context.serverId,
					`bash -n ${quote([scriptPath])} >> ${quote([context.logPath])} 2>&1`,
				);
			} catch (cause) {
				await appendDeploymentLog({
					logPath: context.logPath,
					serverId: getLogServerId(context),
					message:
						"\nNearzero generated an invalid deployment script. Code: build_script_invalid\n",
				}).catch(() => undefined);
				throw new DeploymentPhaseError({
					code: "build_script_invalid",
					phaseId: phase.id,
					phaseLabel: phase.label,
					message: `Nearzero generated an invalid deployment script during ${phase.label}.`,
					cause,
				});
			}

			const attempts = getPhaseAttemptCount(phase);
			for (let attempt = 1; attempt <= attempts; attempt += 1) {
				const startedAt = Date.now();
				const runnerScript = getPhaseRunnerScript({
					deploymentId: context.deploymentId,
					executionCommand: getPhaseExecutionCommand(phase, scriptPath),
					logPath: context.logPath,
				});
				await execOnTarget(
					context.serverId,
					heredocCommand({
						filePath: runnerPath,
						content: runnerScript,
						mode: "700",
					}),
				);
				try {
					await execOnTarget(
						context.serverId,
						`bash -n ${quote([runnerPath])}`,
					);
				} catch (cause) {
					throw new DeploymentPhaseError({
						code: "build_script_invalid",
						phaseId: phase.id,
						phaseLabel: phase.label,
						message: `Nearzero generated an invalid phase runner during ${phase.label}.`,
						cause,
					});
				}
				await appendDeploymentLog({
					logPath: context.logPath,
					serverId: getLogServerId(context),
					message: `Attempt ${attempt}/${attempts} started.\n`,
				});

				try {
					await execOnTarget(
						context.serverId,
						`bash -Eeuo pipefail ${quote([runnerPath])}`,
					);
					await appendDeploymentLog({
						logPath: context.logPath,
						serverId: getLogServerId(context),
						message: `Attempt ${attempt}/${attempts} completed in ${Date.now() - startedAt}ms.\n`,
					});
					break;
				} catch (cause) {
					if (
						await wasDeploymentCancelled(
							context.deploymentId,
							context.serverId,
						)
					) {
						throw new DeploymentPhaseError({
							code: "deployment_cancelled",
							phaseId: phase.id,
							phaseLabel: phase.label,
							message: "Deployment cancelled by the user.",
							cause,
						});
					}
					const timedOut = isPhaseTimeout(cause);
					const code = timedOut
						? "phase_timeout"
						: (phase.errorCode ?? "app_build_failed");
					const retryable =
						attempt < attempts &&
						(timedOut || isTransientFailure(cause));
					await appendDeploymentLog({
						logPath: context.logPath,
						serverId: getLogServerId(context),
						message: [
							`Attempt ${attempt}/${attempts} failed after ${Date.now() - startedAt}ms.`,
							`Code: ${code}`,
							timedOut && phase.timeoutSeconds
								? `Timeout: ${phase.timeoutSeconds}s`
								: null,
							`Retryable: ${retryable ? "yes" : "no"}`,
							retryable
								? `Retrying in ${attempt}s.`
								: "No further attempts will be made.",
							"",
						]
							.filter(Boolean)
							.join("\n"),
					}).catch(() => undefined);

					if (retryable) {
						await sleep(attempt * 1000);
						continue;
					}

					throw new DeploymentPhaseError({
						code,
						phaseId: phase.id,
						phaseLabel: phase.label,
						message: timedOut
							? `Deployment phase "${phase.label}" exceeded its ${phase.timeoutSeconds ?? "configured"} second timeout.`
							: `Deployment phase "${phase.label}" failed.`,
						cause,
					});
				}
			}
		}
	} finally {
		await execOnTarget(
			context.serverId,
			`rm -rf ${quote([workDir])}`,
		).catch(() => undefined);
	}
}

export async function assertApplicationDeployCapabilities(input: {
	deploymentId: string;
	logPath: string;
	buildServerId: string | null;
	deployServerId: string | null;
	executionMode: "cloud" | "community";
}) {
	if (
		input.executionMode === "cloud" &&
		(!input.buildServerId ||
			!input.deployServerId ||
			input.buildServerId !== input.deployServerId)
	) {
		throw new DeploymentPhaseError({
			code: "server_not_ready",
			phaseId: "placement",
			phaseLabel: "Resolve execution placement",
			message:
				"Nearzero Cloud must build and deploy on the same selected application server.",
		});
	}

	const context: DeploymentPhaseContext = {
		deploymentId: input.deploymentId,
		logPath: input.logPath,
		serverId: input.deployServerId,
		logServerId: input.buildServerId,
		executionMode: input.executionMode,
		executionLocation: input.deployServerId ? "remote" : "local",
		capabilityScope: "deploy",
		phases: [],
	};

	assertExecutionPlacementContext(context);
	await assertRemoteCapabilities(context);
	await assertLocalCapabilities(context);
}
