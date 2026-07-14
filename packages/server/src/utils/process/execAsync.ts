import { exec, execFile } from "node:child_process";
import util from "node:util";
import { findServerById } from "@nearzero/server/services/server";
import { Client } from "ssh2";
import { createSshHostVerification } from "../servers/ssh-host-verification";
import { ExecError } from "./ExecError";

// Re-export process errors for easier imports.
export {
	ExecError,
	formatServiceScaleError,
	ServiceScaleError,
} from "./ExecError";

const execAsyncBase = util.promisify(exec);

export const execAsync = async (
	command: string,
	options?: {
		cwd?: string;
		env?: NodeJS.ProcessEnv;
		shell?: string;
		input?: string;
	},
): Promise<{ stdout: string; stderr: string }> => {
	try {
		if (options?.input !== undefined) {
			const { input, ...execOptions } = options;
			return await new Promise((resolve, reject) => {
				const child = exec(command, execOptions, (error, stdout, stderr) => {
					if (error) {
						reject(
							new ExecError(`Command execution failed: ${error.message}`, {
								command,
								stdout: stdout.toString(),
								stderr: stderr.toString(),
								// @ts-ignore - child process errors expose their exit code.
								exitCode: error.code,
								originalError: error,
							}),
						);
						return;
					}
					resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
				});
				if (!child.stdin) {
					child.kill();
					reject(new Error("Command stdin is unavailable"));
					return;
				}
				child.stdin.end(input);
			});
		}
		const result = await execAsyncBase(command, options);
		return {
			stdout: result.stdout.toString(),
			stderr: result.stderr.toString(),
		};
	} catch (error) {
		if (error instanceof ExecError) throw error;
		if (error instanceof Error) {
			// @ts-ignore - exec error has these properties
			const exitCode = error.code;
			// @ts-ignore
			const stdout = error.stdout?.toString() || "";
			// @ts-ignore
			const stderr = error.stderr?.toString() || "";

			throw new ExecError(`Command execution failed: ${error.message}`, {
				command,
				stdout,
				stderr,
				exitCode,
				originalError: error,
			});
		}
		throw error;
	}
};

export interface PreparedShellCommand {
	command: string;
	input?: string;
}

interface ExecOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
}

export const execAsyncStream = (
	command: string,
	onData?: (data: string) => void,
	options: ExecOptions = {},
): Promise<{ stdout: string; stderr: string }> => {
	return new Promise((resolve, reject) => {
		let stdoutComplete = "";
		let stderrComplete = "";

		const childProcess = exec(command, options, (error) => {
			if (error) {
				reject(
					new ExecError(`Command execution failed: ${error.message}`, {
						command,
						stdout: stdoutComplete,
						stderr: stderrComplete,
						// @ts-ignore
						exitCode: error.code,
						originalError: error,
					}),
				);
				return;
			}
			resolve({ stdout: stdoutComplete, stderr: stderrComplete });
		});

		childProcess.stdout?.on("data", (data: Buffer | string) => {
			const stringData = data.toString();
			stdoutComplete += stringData;
			if (onData) {
				onData(stringData);
			}
		});

		childProcess.stderr?.on("data", (data: Buffer | string) => {
			const stringData = data.toString();
			stderrComplete += stringData;
			if (onData) {
				onData(stringData);
			}
		});

		childProcess.on("error", (error) => {
			console.log(error);
			reject(
				new ExecError(`Command execution error: ${error.message}`, {
					command,
					stdout: stdoutComplete,
					stderr: stderrComplete,
					originalError: error,
				}),
			);
		});
	});
};

export const execFileAsync = async (
	command: string,
	args: string[],
	options: { input?: string } = {},
): Promise<{ stdout: string; stderr: string }> => {
	const child = execFile(command, args);

	if (options.input && child.stdin) {
		child.stdin.write(options.input);
		child.stdin.end();
	}

	return new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";

		child.stdout?.on("data", (data) => {
			stdout += data.toString();
		});

		child.stderr?.on("data", (data) => {
			stderr += data.toString();
		});

		child.on("close", (code) => {
			if (code === 0) {
				resolve({ stdout, stderr });
			} else {
				reject(
					new Error(`Command failed with code ${code}. Stderr: ${stderr}`),
				);
			}
		});

		child.on("error", reject);
	});
};

export const execAsyncRemote = async (
	serverId: string | null,
	command: string,
	onData?: (data: string) => void,
	options: { input?: string } = {},
): Promise<{ stdout: string; stderr: string }> => {
	if (!serverId) return { stdout: "", stderr: "" };
	const server = await findServerById(serverId);
	if (!server.sshKeyId) throw new Error("No SSH key available for this server");

	let stdout = "";
	let stderr = "";
	return new Promise((resolve, reject) => {
		const conn = new Client();
		const hostVerification = createSshHostVerification(server);

		conn
			.once("ready", () => {
				try {
					hostVerification.commit();
				} catch (error) {
					conn.end();
					reject(error);
					return;
				}
				conn.exec(command, (err, stream) => {
					if (err) {
						conn.end();
						onData?.(err.message);
						reject(
							new ExecError(`Remote command execution failed: ${err.message}`, {
								command,
								serverId,
								originalError: err,
							}),
						);
						return;
					}
					stream
						.on("close", (code: number, _signal: string) => {
							conn.end();
							if (code === 0) {
								resolve({ stdout, stderr });
							} else {
								reject(
									new ExecError(
										`Remote command failed with exit code ${code}`,
										{
											command,
											stdout,
											stderr,
											exitCode: code,
											serverId,
										},
									),
								);
							}
						})
						.on("data", (data: string) => {
							stdout += data.toString();
							onData?.(data.toString());
						})
						.stderr.on("data", (data) => {
							stderr += data.toString();
							onData?.(data.toString());
						});

					if (options.input !== undefined) {
						stream.end(options.input);
					}
				});
			})
			.on("error", (err) => {
				conn.end();
				if (err.level === "client-authentication") {
					const technicalDetail = `Error: ${err.message} ${err.level}`;
					const friendlyMessage = [
						"",
						"❌ Couldn't connect to your server — the SSH key was not accepted.",
						"",
						"This usually means the key doesn't match what's on the server, or the key format is invalid.",
						"",
						`Technical details: ${technicalDetail}`,
						"",
						"💡 Hints:",
						"  • Check that the SSH key you added in Nearzero is the same one installed on the server (e.g. in ~/.ssh/authorized_keys).",
						"  • Try generating a new SSH key in Nearzero and add only the public key to the server, then try again.",
						"  • Make sure to follow the instructions on the Setup Server Button on the SSH Keys tab and then click on deployments tab and check the logs for more details.",
					].join("\n");
					const errorMsg = `Authentication failed: Invalid SSH private key. ❌ Error: ${err.message} ${err.level}`;
					onData?.(friendlyMessage);
					reject(
						new ExecError(
							`Authentication failed: Invalid SSH private key. ${friendlyMessage}`,
							{
								command,
								serverId,
								originalError: err,
							},
						),
					);
				} else {
					const errorMsg = `SSH connection error: ${err.message}`;
					onData?.(errorMsg);
					reject(
						new ExecError(errorMsg, {
							command,
							serverId,
							originalError: err,
						}),
					);
				}
			})
			.connect({
				host: server.ipAddress,
				port: server.port,
				username: server.username,
				privateKey: server.sshKey?.privateKey,
				hostVerifier: hostVerification.hostVerifier,
				readyTimeout: 30_000,
			});
	});
};

export const executePreparedShellCommand = (
	prepared: PreparedShellCommand,
	serverId?: string | null,
	onData?: (data: string) => void,
) =>
	serverId
		? execAsyncRemote(serverId, prepared.command, onData, {
				input: prepared.input,
			})
		: execAsync(prepared.command, { input: prepared.input });

export const SENSITIVE_SHELL_COMMAND = "bash -se";

export interface SensitiveShellScriptOptions {
	serverId?: string | null;
	script: string;
	sensitiveValues: readonly string[];
}

const redactSensitiveText = (
	value: string | undefined,
	sensitiveValues: readonly string[],
): string | undefined => {
	if (value === undefined) return undefined;

	const redactions = new Set<string>();
	for (const sensitiveValue of sensitiveValues) {
		if (!sensitiveValue) continue;
		redactions.add(sensitiveValue);
		redactions.add(JSON.stringify(sensitiveValue).slice(1, -1));
		redactions.add(sensitiveValue.replaceAll("'", "''"));
		redactions.add(sensitiveValue.replaceAll("'", `'"'"'`));
		redactions.add(
			sensitiveValue.replaceAll("\\", "\\\\").replaceAll('"', '\\"'),
		);
		redactions.add(Buffer.from(sensitiveValue, "utf8").toString("base64"));
		redactions.add(Buffer.from(sensitiveValue, "utf8").toString("base64url"));
		redactions.add(encodeURIComponent(sensitiveValue));
	}

	let redacted = value;
	for (const secret of [...redactions].sort((a, b) => b.length - a.length)) {
		redacted = redacted.replaceAll(secret, "[REDACTED]");
	}
	return redacted;
};

/**
 * Runs a shell script through stdin so its source never becomes the shell's
 * command metadata or argv. Callers must still avoid expanding secrets into
 * child-process arguments and must list every secret that could be echoed;
 * output and thrown errors are scrubbed before they leave this boundary.
 */
export const executeSensitiveShellScript = async ({
	serverId = null,
	script,
	sensitiveValues,
}: SensitiveShellScriptOptions): Promise<{
	stdout: string;
	stderr: string;
}> => {
	try {
		const result = serverId
			? await execAsyncRemote(serverId, SENSITIVE_SHELL_COMMAND, undefined, {
					input: script,
				})
			: await execFileAsync("/bin/bash", ["-se"], { input: script });

		return {
			stdout: redactSensitiveText(result.stdout, sensitiveValues) ?? "",
			stderr: redactSensitiveText(result.stderr, sensitiveValues) ?? "",
		};
	} catch (error) {
		// Do not retain the raw error, stdout, or stderr. Database clients and
		// shells can echo source lines on failure, which would copy the stdin-only
		// script (including credentials) back into durable error metadata.
		throw new ExecError("Sensitive shell script failed", {
			command: SENSITIVE_SHELL_COMMAND,
			exitCode: error instanceof ExecError ? error.exitCode : undefined,
			serverId:
				error instanceof ExecError ? (error.serverId ?? serverId) : serverId,
		});
	}
};

export const sleep = (ms: number) => {
	return new Promise((resolve) => setTimeout(resolve, ms));
};
