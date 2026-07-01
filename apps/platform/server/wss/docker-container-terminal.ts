import type http from "node:http";
import { findServerById, getRemoteDocker, validateRequest } from "@nearzero/server";
import { isCommunityMode } from "@nearzero/server/services/runtime-mode";
import { WebSocketServer } from "ws";
import { isValidContainerId, isValidShell } from "./utils";

function resolveShellPath(shell: string): string {
	if (shell.startsWith("/")) return shell;
	const map: Record<string, string> = {
		sh: "/bin/sh",
		bash: "/bin/bash",
		zsh: "/bin/zsh",
		ash: "/bin/ash",
	};
	return map[shell] ?? `/bin/${shell}`;
}

export const setupDockerContainerTerminalWebSocketServer = (
	server: http.Server<typeof http.IncomingMessage, typeof http.ServerResponse>,
) => {
	const wssTerm = new WebSocketServer({
		noServer: true,
		path: "/docker-container-terminal",
	});

	server.on("upgrade", (req, socket, head) => {
		const { pathname } = new URL(req.url || "", `http://${req.headers.host}`);

		if (pathname === "/_next/webpack-hmr") {
			return;
		}
		if (pathname === "/docker-container-terminal") {
			wssTerm.handleUpgrade(req, socket, head, function done(ws) {
				wssTerm.emit("connection", ws, req);
			});
		}
	});

	// eslint-disable-next-line @typescript-eslint/no-misused-promises
	wssTerm.on("connection", async (ws, req) => {
		const url = new URL(req.url || "", `http://${req.headers.host}`);
		const containerId = url.searchParams.get("containerId");
		const activeWay = url.searchParams.get("activeWay");
		const serverId = url.searchParams.get("serverId");
		const { user, session } = await validateRequest(req);

		if (!containerId) {
			ws.close(4000, "containerId not provided");
			return;
		}

		if (!isValidContainerId(containerId)) {
			ws.close(4000, "Invalid container ID format");
			return;
		}

		if (activeWay && !isValidShell(activeWay)) {
			ws.close(4000, "Invalid shell specified");
			return;
		}

		const shell = resolveShellPath(activeWay || "sh");

		if (!user || !session) {
			ws.close();
			return;
		}

		if (!isCommunityMode() && !serverId) {
			ws.close(4000, "A remote server is required in Cloud mode.");
			return;
		}

		try {
			if (serverId) {
				const remoteServer = await findServerById(serverId);
				if (remoteServer.organizationId !== session.activeOrganizationId) {
					ws.close();
					return;
				}
			}

			const dockerClient = await getRemoteDocker(serverId || null);
			const container = dockerClient.getContainer(containerId);
			const execInstance = await container.exec({
				Cmd: [shell],
				AttachStdin: true,
				AttachStdout: true,
				AttachStderr: true,
				Tty: true,
				WorkingDir: "/",
			});

			const stream = await execInstance.start({ hijack: true, stdin: true });

			stream.on("data", (chunk: Buffer) => {
				if (ws.readyState === ws.OPEN) ws.send(chunk);
			});

			stream.on("end", () => {
				if (ws.readyState === ws.OPEN) ws.close();
			});

			stream.on("error", (err: Error) => {
				if (ws.readyState === ws.OPEN) {
					ws.send(`\nTerminal error: ${err.message}\n`);
					ws.close();
				}
			});

			ws.on("message", (message) => {
				try {
					const command =
						Buffer.isBuffer(message) ?
							message.toString("utf8")
						:	String(message);
					stream.write(command);
				} catch (error) {
					const errorMessage =
						error instanceof Error ? error.message : String(error);
					ws.send(errorMessage);
				}
			});

			ws.on("close", () => {
				try {
					stream.end();
				} catch {
					// stream already closed
				}
			});
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			if (ws.readyState === ws.OPEN) {
				ws.send(`\n${errorMessage}\n`);
				ws.close();
			}
		}
	});
};
