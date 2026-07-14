import { Agent } from "node:http";
import { getDocker } from "@nearzero/server/constants";
import { findServerById } from "@nearzero/server/services/server";
import Dockerode from "dockerode";
import { Client, type ConnectConfig } from "ssh2";
import { createSshHostVerification } from "./ssh-host-verification";

const getPositiveTimeout = (value: string | undefined, fallback: number) => {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const REMOTE_DOCKER_SSH_READY_TIMEOUT_MS = getPositiveTimeout(
	process.env.REMOTE_DOCKER_SSH_READY_TIMEOUT_MS,
	15_000,
);
const REMOTE_DOCKER_REQUEST_TIMEOUT_MS = getPositiveTimeout(
	process.env.REMOTE_DOCKER_REQUEST_TIMEOUT_MS,
	30_000,
);

/**
 * The stream returned by `ssh2`'s `conn.exec` is a Duplex channel, NOT a
 * `net.Socket`. Node's HTTP client assumes the object returned from an agent's
 * `createConnection` is socket-shaped and calls `socket.setTimeout`,
 * `socket.setNoDelay`, `socket.setKeepAlive`, `socket.ref`, and `socket.unref`
 * on it. Since `setTimeout` (in particular) is missing on the ssh2 channel,
 * setting a request `timeout` on Dockerode makes Node throw
 * `TypeError: sock.setTimeout is not a function` from inside an event tick,
 * which surfaces as an UNCAUGHT exception and crashes the whole platform
 * process right when a remote deploy starts talking to Docker.
 *
 * Decorating the stream with these socket-method shims keeps Node's HTTP client
 * happy. `setTimeout` is implemented with a real timer that emits the `timeout`
 * event so Dockerode's request timeout still works as intended.
 */
function decorateSshStreamAsSocket<T>(stream: T): T {
	const sock = stream as unknown as {
		setTimeout?: (msecs: number, callback?: () => void) => unknown;
		setNoDelay?: () => unknown;
		setKeepAlive?: () => unknown;
		ref?: () => unknown;
		unref?: () => unknown;
		emit: (event: string, ...args: unknown[]) => boolean;
		once: (event: string, listener: (...args: unknown[]) => void) => unknown;
		__nzTimeoutTimer?: ReturnType<typeof setTimeout>;
	};

	const clearTimeoutTimer = () => {
		if (sock.__nzTimeoutTimer) {
			clearTimeout(sock.__nzTimeoutTimer);
			sock.__nzTimeoutTimer = undefined;
		}
	};

	if (typeof sock.setTimeout !== "function") {
		sock.setTimeout = (msecs: number, callback?: () => void) => {
			clearTimeoutTimer();
			if (msecs && msecs > 0) {
				sock.__nzTimeoutTimer = setTimeout(() => {
					sock.emit("timeout");
				}, msecs);
				if (typeof sock.__nzTimeoutTimer.unref === "function") {
					sock.__nzTimeoutTimer.unref();
				}
			}
			if (callback) {
				sock.once("timeout", callback);
			}
			return sock;
		};
	}
	if (typeof sock.setNoDelay !== "function") {
		sock.setNoDelay = () => sock;
	}
	if (typeof sock.setKeepAlive !== "function") {
		sock.setKeepAlive = () => sock;
	}
	if (typeof sock.ref !== "function") {
		sock.ref = () => sock;
	}
	if (typeof sock.unref !== "function") {
		sock.unref = () => sock;
	}

	sock.once("close", clearTimeoutTimer);

	return stream;
}

/**
 * docker-modem builds its request URL from a bare host with `url.parse`, which
 * for a plain IP/hostname (no scheme) produces a malformed URL like
 * `ssh:1.2.3.4:221.2.3.4`. On strict runtimes (Bun, newer Node) this throws
 * `Invalid port in url`, so Dockerode's built-in `protocol: "ssh"` transport is
 * unusable for remote Docker operations.
 *
 * The robust fix: build the exact same SSH-backed HTTP agent docker-modem uses
 * internally (which tunnels via `docker system dial-stdio`) and hand it to
 * Dockerode over a normal slashed `http` URL pointed at a dummy local host. The
 * dummy host only feeds docker-modem's URL building; the agent's
 * `createConnection` does the real work over SSH.
 *
 * We construct the agent here with `ssh2` directly instead of `require`-ing
 * docker-modem's internal `lib/ssh` module. That internal path is not reliably
 * resolvable once the server is bundled (esbuild, `packages: "external"`, ESM
 * output), and when it failed to load the old code silently fell back to the
 * broken `protocol: "ssh"` transport — which is exactly what produced the
 * `Invalid port in url` deployment failures. Building the agent ourselves means
 * there is no fallback to the broken transport.
 */
function createSshDockerAgent(
	connectOptions: ConnectConfig,
	hostVerification: ReturnType<typeof createSshHostVerification>,
): Agent {
	const agent = new Agent();

	// docker-modem-style custom connection factory: every HTTP request issued by
	// Dockerode is tunnelled through `docker system dial-stdio` on the remote.
	// @ts-ignore - overriding the agent's connection factory like docker-modem does
	agent.createConnection = (
		_options: unknown,
		fn: (err: Error | null, stream?: unknown) => void,
	) => {
		// A Dockerode operation can issue several HTTP requests (inspect, update,
		// task polling). Reusing one ssh2 Client lets the first request close the
		// transport underneath the next one, which presents as a long pause or a
		// raw socket hang up. Each HTTP request therefore owns its SSH session.
		const conn = new Client();
		let callbackSettled = false;

		const handleError = (err: Error) => {
			conn.end();
			if (callbackSettled) return;
			callbackSettled = true;
			fn(err);
		};

		try {
			conn
				.once("ready", () => {
					try {
						hostVerification.commit();
					} catch (error) {
						handleError(error as Error);
						return;
					}
					conn.exec("docker system dial-stdio", (err, stream) => {
						if (err) {
							handleError(err);
							return;
						}
						callbackSettled = true;
						fn(null, decorateSshStreamAsSocket(stream));
						stream.addListener("error", () => {
							// The request already owns the stream at this point, so
							// only close its SSH session. Calling the connection
							// callback twice corrupts Node's HTTP request lifecycle.
							conn.end();
						});
						stream.once("close", () => {
							conn.end();
						});
					});
				})
				.once("error", (err: Error) => {
					handleError(err);
				})
				.once("close", () => {
					if (!callbackSettled) {
						handleError(
							new Error(
								"SSH connection closed before the remote Docker stream was ready",
							),
						);
					}
				})
				.connect({
					...connectOptions,
					readyTimeout:
						connectOptions.readyTimeout ??
						REMOTE_DOCKER_SSH_READY_TIMEOUT_MS,
				});
		} catch (err) {
			handleError(err as Error);
		}
	};

	return agent;
}

export const getRemoteDocker = async (serverId?: string | null) => {
	if (!serverId) return getDocker();
	const server = await findServerById(serverId);
	if (!server.sshKeyId || !server.sshKey?.privateKey) {
		throw new Error(
			`Server "${server.name}" is missing an SSH key and cannot be used for remote Docker operations`,
		);
	}

	const parsedPort = Number(server.port);
	const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 22;
	const hostVerification = createSshHostVerification({
		ipAddress: server.ipAddress,
		port,
	});

	const agent = createSshDockerAgent({
		host: server.ipAddress,
		port,
		username: server.username,
		privateKey: server.sshKey.privateKey,
		hostVerifier: hostVerification.hostVerifier,
	}, hostVerification);

	return new Dockerode({
		protocol: "http",
		// Dummy local target — only used so docker-modem builds a valid request
		// URL. The SSH agent above ignores it and tunnels to the real server.
		host: "127.0.0.1",
		port: 2375,
		// @ts-ignore docker-modem accepts a custom http agent
		agent,
		timeout: REMOTE_DOCKER_REQUEST_TIMEOUT_MS,
	});
};
