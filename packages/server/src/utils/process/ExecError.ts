export interface ExecErrorDetails {
	command: string;
	stdout?: string;
	stderr?: string;
	exitCode?: number;
	originalError?: Error;
	serverId?: string | null;
}

export class ExecError extends Error {
	public readonly command: string;
	public readonly stdout?: string;
	public readonly stderr?: string;
	public readonly exitCode?: number;
	public readonly originalError?: Error;
	public readonly serverId?: string | null;

	constructor(message: string, details: ExecErrorDetails) {
		super(message);
		this.name = "ExecError";
		this.command = details.command;
		this.stdout = details.stdout;
		this.stderr = details.stderr;
		this.exitCode = details.exitCode;
		this.originalError = details.originalError;
		this.serverId = details.serverId;

		// Maintains proper stack trace for where our error was thrown (only available on V8)
		if (Error.captureStackTrace) {
			Error.captureStackTrace(this, ExecError);
		}
	}

	/**
	 * Get a formatted error message with all details
	 */
	getDetailedMessage(): string {
		const parts = [
			`Command: ${this.command}`,
			this.exitCode !== undefined ? `Exit Code: ${this.exitCode}` : null,
			this.serverId ? `Server ID: ${this.serverId}` : "Location: Local",
			this.stderr ? `Stderr: ${this.stderr}` : null,
			this.stdout ? `Stdout: ${this.stdout}` : null,
		].filter(Boolean);

		return `${this.message}\n${parts.join("\n")}`;
	}

	/**
	 * Check if this error is from a remote execution
	 */
	isRemote(): boolean {
		return !!this.serverId;
	}

	/** Message suitable for API clients (includes stderr when present). */
	toUserMessage(maxStderrLength = 400): string {
		const stderr = this.stderr?.trim();
		if (stderr) {
			const snippet =
				stderr.length > maxStderrLength
					? `${stderr.slice(0, maxStderrLength)}…`
					: stderr;
			return `${this.message}: ${snippet}`;
		}
		return this.message;
	}
}

export type ServiceScaleErrorCode =
	| "local_docker_unreachable"
	| "local_service_scale_failed"
	| "server_missing_ssh_key"
	| "ssh_auth_failed"
	| "remote_docker_unreachable"
	| "swarm_service_missing"
	| "remote_service_scale_failed";

interface ServiceScaleErrorDetails {
	code: ServiceScaleErrorCode;
	appName: string;
	serverId?: string | null;
	serverName?: string | null;
	serverHost?: string | null;
	guidance?: string;
	detail?: string;
	cause?: unknown;
}

export class ServiceScaleError extends Error {
	public readonly code: ServiceScaleErrorCode;
	public readonly appName: string;
	public readonly serverId?: string | null;
	public readonly serverName?: string | null;
	public readonly serverHost?: string | null;
	public readonly guidance?: string;
	public readonly detail?: string;
	public override readonly cause?: unknown;

	constructor(message: string, details: ServiceScaleErrorDetails) {
		super(message);
		this.name = "ServiceScaleError";
		this.code = details.code;
		this.appName = details.appName;
		this.serverId = details.serverId;
		this.serverName = details.serverName;
		this.serverHost = details.serverHost;
		this.guidance = details.guidance;
		this.detail = details.detail;
		this.cause = details.cause;

		if (Error.captureStackTrace) {
			Error.captureStackTrace(this, ServiceScaleError);
		}
	}

	toUserMessage(): string {
		const targetParts = [
			this.serverName ? `server "${this.serverName}"` : null,
			this.serverHost ? `(${this.serverHost})` : null,
		].filter(Boolean);
		const parts = [
			this.message,
			targetParts.length ? `Target: ${targetParts.join(" ")}.` : null,
			this.guidance ? `Next step: ${this.guidance}` : null,
			this.detail ? `Details: ${this.detail}` : null,
			`Code: ${this.code}.`,
		].filter(Boolean);

		return parts.join("\n");
	}
}

export function formatServiceScaleError(
	error: unknown,
	action: "start" | "stop",
): string {
	if (error instanceof ServiceScaleError) {
		return `Failed to ${action} service. ${error.toUserMessage()}`;
	}
	if (error instanceof ExecError) {
		const combined = `${error.message}\n${error.stderr ?? ""}\n${error.stdout ?? ""}`;
		if (/permission denied/i.test(combined) && /docker\.sock/i.test(combined)) {
			return `Failed to ${action} service. Nearzero could not access the local Docker socket. Next step: restart Docker Desktop or run Nearzero from a shell that can access Docker. Code: local_docker_unreachable.`;
		}
		if (/socket hang up|ECONNRESET|connection reset/i.test(combined)) {
			return `Failed to ${action} service. Docker dropped the connection while Nearzero was changing the service state. Next step: verify Docker Desktop is running and Docker Swarm is healthy, then try again. Code: local_service_scale_failed.`;
		}
		return `Failed to ${action} service. ${error.toUserMessage()}`;
	}
	if (error instanceof Error) {
		if (/socket hang up|ECONNRESET|connection reset/i.test(error.message)) {
			return `Failed to ${action} service. Docker dropped the connection while Nearzero was changing the service state. Next step: verify Docker Desktop is running and Docker Swarm is healthy, then try again. Code: local_service_scale_failed.`;
		}
		return `Failed to ${action} service. ${error.message}`;
	}
	return `Failed to ${action} service.`;
}
